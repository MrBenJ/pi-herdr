import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Json, ToolResult } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";
import { PROFILE_POLL_INTERVAL_MS, PROFILE_READY_POLLS, PROFILE_STARTUP_DEADLINE_MS } from "./contracts.ts";
import type { LaunchResources, LaunchResult, OrchestratorDependencies, RepositoryIdentity, TaskInspectInput, TaskLaunchInput, WorkspaceMatch } from "./contracts.ts";
import { OrchestratorError } from "./errors.ts";
import { inventoryHerdr, selectWorkspace } from "./herdr-inventory.ts";
import { buildProfileCommand, isPiProfileName } from "./profile.ts";
import { buildWorkerPrompt } from "./prompt.ts";
import { ensureWorktree, inspectWorktrees, validateRepository } from "./repository.ts";

function snapshot(resources: LaunchResources): LaunchResources {
  return {
    ...(resources.worktree ? { worktree: { ...resources.worktree } } : {}),
    ...(resources.workspace ? { workspace: { ...resources.workspace } } : {}),
    ...(resources.tab ? { tab: { ...resources.tab } } : {}),
    ...(resources.launcher ? { launcher: { ...resources.launcher } } : {}),
    ...(resources.agent ? { agent: { ...resources.agent } } : {}),
    promptSubmitted: resources.promptSubmitted,
  };
}

function cancellation(signal: AbortSignal | undefined, stage: string, resources: LaunchResources): void {
  if (signal?.aborted) throw new OrchestratorError({ code: "cancelled", message: "Orchestration was cancelled before the next operation.", stage, confirmed: snapshot(resources) });
}

function augment(error: unknown, resources: LaunchResources): never {
  if (error instanceof OrchestratorError) {
    throw new OrchestratorError({ code: error.code, message: error.message, stage: error.stage, confirmed: snapshot(resources), ambiguous: error.ambiguous });
  }
  throw new OrchestratorError({ code: "herdr_failed", message: "Orchestration failed unexpectedly.", stage: "unknown", confirmed: snapshot(resources) });
}

function object(value: Json | undefined, stage: string): { [key: string]: Json } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrchestratorError({ code: "herdr_failed", message: `Herdr returned malformed data during ${stage}.`, stage, ambiguous: true });
  return value;
}

function mutationResult(result: ToolResult, group: "workspace" | "tab" | "pane" | "agent", action: string, expectedType: string, stage: string): { [key: string]: Json } {
  if (result.details.group !== group || result.details.action !== action || result.details.truncated || result.details.resultOmitted) {
    throw new OrchestratorError({ code: "herdr_failed", message: `Herdr returned incomplete data during ${stage}.`, stage, ambiguous: true });
  }
  const value = object(result.details.result, stage);
  if (value["type"] !== expectedType) throw new OrchestratorError({ code: "herdr_failed", message: `Herdr returned an unexpected result during ${stage}.`, stage, ambiguous: true });
  return value;
}

function idFrom(parent: Json, key: string, stage: string): string {
  const value = object(parent, stage)[key];
  if (typeof value !== "string" || !value) throw new OrchestratorError({ code: "herdr_failed", message: `Herdr omitted ${key} during ${stage}.`, stage, ambiguous: true });
  return value;
}

async function herdrMutation(
  deps: OrchestratorDependencies,
  repository: RepositoryIdentity,
  group: "workspace" | "tab" | "pane" | "agent",
  input: Record<string, unknown>,
  stage: string,
  resources: LaunchResources,
  signal?: AbortSignal,
): Promise<ToolResult> {
  cancellation(signal, stage, resources);
  try {
    return await deps.herdr(group, input, { cwd: repository.repoRoot, env: deps.env, signal });
  } catch (error) {
    if (error instanceof HerdrToolError) {
      throw new OrchestratorError({ code: "herdr_failed", message: `Herdr failed during ${stage}.`, stage, confirmed: snapshot(resources), ambiguous: error.failure.remoteOutcome === "unknown" });
    }
    if (error instanceof OrchestratorError) throw error;
    throw new OrchestratorError({ code: "herdr_failed", message: `Herdr failed during ${stage}.`, stage, confirmed: snapshot(resources), ambiguous: true });
  }
}

function acknowledged(result: ToolResult, group: "pane" | "agent", action: string, stage: string): void {
  if (result.details.group !== group || result.details.action !== action) {
    throw new OrchestratorError({ code: "herdr_failed", message: `Herdr returned an unexpected result during ${stage}.`, stage, ambiguous: true });
  }
}

// Reads never mutate, so a missing agent is an answer rather than a failure.
async function findAgent(deps: OrchestratorDependencies, repository: RepositoryIdentity, target: string, stage: string, resources: LaunchResources, ambiguous: boolean, signal?: AbortSignal): Promise<{ [key: string]: Json } | undefined> {
  cancellation(signal, stage, resources);
  let result: ToolResult;
  try {
    result = await deps.herdr("agent", { action: "inspect", target }, { cwd: repository.repoRoot, env: deps.env, signal });
  } catch (error) {
    if (error instanceof HerdrToolError && error.failure.herdrCode === "agent_not_found") return undefined;
    throw new OrchestratorError({ code: "herdr_failed", message: `Herdr failed during ${stage}.`, stage, ambiguous });
  }
  try {
    return object(mutationResult(result, "agent", "inspect", "agent_info", stage)["agent"], stage);
  } catch {
    throw new OrchestratorError({ code: "herdr_failed", message: `Herdr returned malformed data during ${stage}.`, stage, ambiguous });
  }
}

async function pause(deps: OrchestratorDependencies, signal?: AbortSignal): Promise<void> {
  if (deps.sleep) return deps.sleep(PROFILE_POLL_INTERVAL_MS, signal);
  // An abort ends the pause early; the next cancellation check reports it.
  await delay(PROFILE_POLL_INTERVAL_MS, undefined, { signal }).catch(() => {});
}

// `herdr agent start` only runs a kind's canonical executable, so a profiled
// worker is typed into the tab's shell as one fixed pi-profile command and then
// adopted: detected in the exact pane, named, and verified before any prompt.
async function startProfiledWorker(input: TaskLaunchInput & { piProfile: string }, command: string, deps: OrchestratorDependencies, repository: RepositoryIdentity, paneId: string, resources: LaunchResources, signal?: AbortSignal): Promise<void> {
  resources.launcher = { kind: "pi-profile", profile: input.piProfile, commandSubmitted: false };
  const runResponse = await herdrMutation(deps, repository, "pane", { action: "run", paneId, command }, "profile-run", resources, signal);
  // Herdr accepted the command, so it was typed even if the reply is malformed.
  resources.launcher.commandSubmitted = true;
  acknowledged(runResponse, "pane", "run", "profile-run");

  const started = Date.now();
  const attempts = Math.ceil(PROFILE_STARTUP_DEADLINE_MS / PROFILE_POLL_INTERVAL_MS);
  let ready = 0;
  for (let attempt = 0; ready < PROFILE_READY_POLLS; attempt++) {
    if (attempt >= attempts || Date.now() - started > PROFILE_STARTUP_DEADLINE_MS) {
      throw new OrchestratorError({ code: "herdr_failed", message: "No ready Pi worker was detected in the worker pane before the startup deadline.", stage: "profile-detect", ambiguous: true });
    }
    if (attempt > 0) await pause(deps, signal);
    const agent = await findAgent(deps, repository, paneId, "profile-detect", resources, true, signal);
    if (agent && (agent["pane_id"] !== paneId || agent["agent"] !== "pi")) {
      throw new OrchestratorError({ code: "herdr_failed", message: "Herdr detected an unexpected agent in the worker pane.", stage: "profile-detect", ambiguous: true });
    }
    if (agent?.["agent_status"] === "blocked") {
      throw new OrchestratorError({ code: "herdr_failed", message: "The profiled Pi worker is blocked during startup and needs owner attention.", stage: "profile-detect", ambiguous: true });
    }
    ready = agent?.["agent_status"] === "idle" ? ready + 1 : 0;
  }

  const renameResponse = await herdrMutation(deps, repository, "agent", { action: "rename", target: paneId, name: input.agentName }, "agent-name", resources, signal);
  acknowledged(renameResponse, "agent", "rename", "agent-name");
  const named = await findAgent(deps, repository, input.agentName, "agent-name", resources, true, signal);
  if (!named || named["name"] !== input.agentName || named["pane_id"] !== paneId || named["agent"] !== "pi") {
    throw new OrchestratorError({ code: "herdr_failed", message: "Herdr did not confirm the requested name on the worker pane.", stage: "agent-name", ambiguous: true });
  }
}

export async function inspectTask(input: TaskInspectInput, deps: OrchestratorDependencies, signal?: AbortSignal): Promise<LaunchResult> {
  const resources: LaunchResources = { promptSubmitted: false };
  cancellation(signal, "repository", resources);
  const repository = await validateRepository(input.repoRoot, deps, signal);
  const worktrees = await inspectWorktrees(repository, deps.git, signal);
  const herdrInventory = await inventoryHerdr(repository, deps, signal);
  const workspace = selectWorkspace(herdrInventory);
  return {
    action: "inspect",
    repository,
    resources,
    inventory: { worktrees, ...(workspace ? { workspace } : {}) },
    violations: herdrInventory.violations,
  };
}

export async function launchTask(input: TaskLaunchInput, deps: OrchestratorDependencies, signal?: AbortSignal): Promise<LaunchResult> {
  const resources: LaunchResources = { promptSubmitted: false };
  try {
    let profileCommand: string | undefined;
    if (input.piProfile !== undefined) {
      if (input.agentKind !== "pi" || !isPiProfileName(input.piProfile)) {
        throw new OrchestratorError({ code: "invalid_input", message: "piProfile must be a safe logical profile name and requires agentKind pi.", stage: "validate" });
      }
      try {
        profileCommand = buildProfileCommand(input.piProfile, input.args ?? []);
      } catch {
        throw new OrchestratorError({ code: "invalid_input", message: "args are not usable for a profiled launch.", stage: "validate" });
      }
    }
    cancellation(signal, "repository", resources);
    const repository = await validateRepository(input.repoRoot, deps, signal);
    const initialWorktrees = await inspectWorktrees(repository, deps.git, signal);
    const herdrInventory = await inventoryHerdr(repository, deps, signal);
    const existingWorkspace = selectWorkspace(herdrInventory);
    if (existingWorkspace) resources.workspace = { workspaceId: existingWorkspace.workspaceId, disposition: "existing" };

    // A profiled worker is named only after it is running, so a taken name
    // must be found before the worktree or any topology is created.
    if (input.piProfile !== undefined && await findAgent(deps, repository, input.agentName, "agent-name-check", resources, false, signal)) {
      throw new OrchestratorError({ code: "herdr_failed", message: "The requested agent name is already in use.", stage: "agent-name-check" });
    }

    resources.worktree = await ensureWorktree({ worktreeName: input.worktreeName, branch: input.branch, baseRef: input.baseRef }, repository, deps, signal);

    let workspace: WorkspaceMatch;
    if (existingWorkspace) {
      workspace = existingWorkspace;
    } else {
      const response = await herdrMutation(deps, repository, "workspace", { action: "create", cwd: repository.repoRoot, label: path.basename(repository.repoRoot), focus: false }, "workspace-create", resources, signal);
      const result = mutationResult(response, "workspace", "create", "workspace_created", "workspace-create");
      const workspaceId = idFrom(result["workspace"], "workspace_id", "workspace-create");
      workspace = { workspaceId, paneIds: [], canonicalRepoRoot: repository.repoRoot };
      resources.workspace = { workspaceId, disposition: "created" };
    }

    const tabResponse = await herdrMutation(deps, repository, "tab", { action: "create", workspaceId: workspace.workspaceId, cwd: resources.worktree.path, label: input.tabLabel, focus: false }, "tab-create", resources, signal);
    const tabResult = mutationResult(tabResponse, "tab", "create", "tab_created", "tab-create");
    const tabId = idFrom(tabResult["tab"], "tab_id", "tab-create");
    const paneId = idFrom(tabResult["root_pane"], "pane_id", "tab-create");
    resources.tab = { tabId, paneId };

    if (input.piProfile !== undefined && profileCommand !== undefined) {
      await startProfiledWorker({ ...input, piProfile: input.piProfile }, profileCommand, deps, repository, paneId, resources, signal);
    } else {
      const startResponse = await herdrMutation(deps, repository, "agent", { action: "start", name: input.agentName, kind: input.agentKind, paneId, args: input.args ?? [] }, "agent-start", resources, signal);
      const startResult = mutationResult(startResponse, "agent", "start", "agent_started", "agent-start");
      const startedAgent = object(startResult["agent"], "agent-start");
      if (startedAgent["name"] !== input.agentName || startedAgent["pane_id"] !== paneId) {
        throw new OrchestratorError({ code: "herdr_failed", message: "Herdr started an agent with unexpected identity.", stage: "agent-start", ambiguous: true });
      }
    }
    resources.agent = { name: input.agentName, paneId };

    const text = buildWorkerPrompt({
      task: input.prompt,
      fenceToken: randomBytes(16).toString("hex"),
      repository,
      worktree: resources.worktree,
      workspaceId: workspace.workspaceId,
      tabId,
      paneId,
      agentName: input.agentName,
    });
    const promptResponse = await herdrMutation(deps, repository, "agent", { action: "prompt", target: input.agentName, text }, "agent-prompt", resources, signal);
    const promptResult = mutationResult(promptResponse, "agent", "prompt", "agent_prompted", "agent-prompt");
    const promptedAgent = object(promptResult["agent"], "agent-prompt");
    if (promptedAgent["name"] !== input.agentName || promptedAgent["pane_id"] !== paneId) {
      throw new OrchestratorError({ code: "herdr_failed", message: "Herdr prompted an agent with unexpected identity.", stage: "agent-prompt", ambiguous: true });
    }
    resources.promptSubmitted = true;

    const finalWorktrees = resources.worktree.disposition === "created"
      ? await inspectWorktrees(repository, deps.git, signal)
      : initialWorktrees;
    return {
      action: "launch",
      repository,
      resources: snapshot(resources),
      inventory: { worktrees: finalWorktrees, workspace },
      violations: herdrInventory.violations,
    };
  } catch (error) {
    augment(error, resources);
  }
}
