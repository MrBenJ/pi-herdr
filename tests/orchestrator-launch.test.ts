import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { HerdrToolError } from "../src/errors.ts";
import type { GitRunner, HerdrExecutor, OrchestratorDependencies, TaskLaunchInput } from "../src/orchestrator/contracts.ts";
import { formatOrchestratorError } from "../src/orchestrator/errors.ts";
import { inspectTask, launchTask } from "../src/orchestrator/launch.ts";
import { buildProfileCommand, MAX_PROFILE_COMMAND_BYTES } from "../src/orchestrator/profile.ts";

const exec = promisify(execFile);
const cleanup: string[] = [];
const git: GitRunner = async (command, args, options) => {
  try {
    const value = await exec(command, args, { cwd: options.cwd, signal: options.signal, timeout: options.deadlineMs });
    return { code: 0, stdout: value.stdout, stderr: value.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, killed: failure.killed };
  }
};

async function makeRepo(existingWorktree = true) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-launch-")); cleanup.push(created);
  const root = await fs.realpath(created);
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, ".gitignore"), "/.worktrees/\n");
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "initial"], { cwd: root });
  const worktree = path.join(root, ".worktrees", "review");
  if (existingWorktree) await exec("git", ["worktree", "add", worktree, "-b", "feat/review"], { cwd: root });
  return { root, worktree };
}

afterEach(async () => { for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function tool(group: "workspace" | "pane" | "tab" | "agent", action: string, value: unknown) {
  return { content: [{ type: "text" as const, text: "fixture" }], details: { group, action, result: value as never, truncated: false } };
}
const workspaceList = (ids: string[]) => tool("workspace", "list", { type: "workspace_list", workspaces: ids.map(workspace_id => ({ workspace_id })) });
const paneList = (workspaceId: string, cwd: string) => tool("pane", "list", { type: "pane_list", panes: [{ pane_id: `${workspaceId}:p1`, workspace_id: workspaceId, cwd }] });
const createdWorkspace = () => tool("workspace", "create", { type: "workspace_created", workspace: { workspace_id: "wN" }, root_pane: { pane_id: "wN:p1" } });
const createdTab = (workspaceId: string) => tool("tab", "create", { type: "tab_created", tab: { tab_id: `${workspaceId}:t2` }, root_pane: { pane_id: `${workspaceId}:p2` } });
const agentResult = (type: "agent_started" | "agent_prompted", paneId: string) => tool("agent", type === "agent_started" ? "start" : "prompt", { type, agent: { name: "reviewer", pane_id: paneId } });

function deps(queue: Array<ReturnType<typeof tool> | Error>, calls: Array<[string, Record<string, unknown>]>, gitRunner: GitRunner = git, envExtra: NodeJS.ProcessEnv = {}): OrchestratorDependencies {
  const herdr: HerdrExecutor = async (group, input) => {
    calls.push([group, input]);
    const next = queue.shift();
    if (!next) throw new Error("Unexpected Herdr call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { git: gitRunner, herdr, paths: { realpath: fs.realpath, lstat: fs.lstat, access: fs.access }, env: { HERDR_ENV: "1", ...envExtra }, sleep: async () => {} };
}

function request(root: string): TaskLaunchInput {
  return { action: "launch", repoRoot: root, worktreeName: "review", branch: "feat/review", baseRef: "main", tabLabel: "review", agentName: "reviewer", agentKind: "pi", prompt: "Do the work.", args: [] };
}

it("inspects repository and Herdr topology without mutation", async () => {
  const { root, worktree } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await inspectTask({ action: "inspect", repoRoot: root }, deps([workspaceList(["wE"]), paneList("wE", root)], calls));
  expect(result.action).toBe("inspect");
  expect(result.inventory.worktrees).toContainEqual(expect.objectContaining({ path: worktree, branch: "feat/review" }));
  expect(result.inventory.workspace?.workspaceId).toBe("wE");
  expect(calls).toEqual([["workspace", { action: "list" }], ["pane", { action: "list", workspaceId: "wE" }]]);
});

it("reuses the exact worktree and sole workspace, then creates one tab and worker serially", async () => {
  const { root, worktree } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await launchTask(request(root), deps([
    workspaceList(["wE"]), paneList("wE", root), createdTab("wE"), agentResult("agent_started", "wE:p2"), agentResult("agent_prompted", "wE:p2"),
  ], calls));
  expect(result.resources).toMatchObject({ worktree: { path: worktree, disposition: "existing" }, workspace: { workspaceId: "wE", disposition: "existing" }, tab: { tabId: "wE:t2", paneId: "wE:p2" }, agent: { name: "reviewer", paneId: "wE:p2" }, promptSubmitted: true });
  expect(calls.slice(2).map(([group, input]) => [group, input.action])).toEqual([["tab", "create"], ["agent", "start"], ["agent", "prompt"]]);
  expect(calls.some(([group, input]) => group === "workspace" && input.action === "create")).toBe(false);
  // Default env: the worker prompt carries the prohibition, no grant.
  const submitted = String(calls.find(([group, input]) => group === "agent" && input.action === "prompt")![1].text);
  expect(submitted).toContain("Do not create Herdr workspaces, tabs, panes, or agents unless this run was explicitly authorized to; none was granted.");
  expect(submitted).toContain("Do not dispatch subagents or background work unless this run was explicitly authorized to; none was granted.");
  expect(calls[2]![1]).toEqual({ action: "create", workspaceId: "wE", cwd: worktree, label: "review", focus: false });
  expect(calls[3]![1]).toEqual({ action: "start", name: "reviewer", kind: "pi", paneId: "wE:p2", args: [] });
  expect(calls[4]![1].text).toContain("Authorized worktree: " + worktree);
});

it("authorizes the worker prompt from the operator HERDR_ALLOW_* env, not from any caller input", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await launchTask(request(root), deps([
    workspaceList(["wE"]), paneList("wE", root), createdTab("wE"), agentResult("agent_started", "wE:p2"), agentResult("agent_prompted", "wE:p2"),
  ], calls, git, { HERDR_ALLOW_WORKSPACES: "1", HERDR_ALLOW_DISPATCH: "1" }));
  const submitted = String(calls.find(([group, input]) => group === "agent" && input.action === "prompt")![1].text);
  expect(submitted).toContain("Creating execution topology (Herdr workspaces, tabs, panes, or agents) is authorized for this run via herdr_task launch");
  expect(submitted).toContain("Dispatching subagents or background work is authorized for this run");
  expect(submitted).not.toContain("none was granted.");
});

it("creates one no-focus main-repository workspace only when inventory has no match", async () => {
  const { root } = await makeRepo(false); const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await launchTask(request(root), deps([workspaceList([]), createdWorkspace(), createdTab("wN"), agentResult("agent_started", "wN:p2"), agentResult("agent_prompted", "wN:p2")], calls));
  expect(result.resources.worktree?.disposition).toBe("created");
  expect(result.resources.workspace).toEqual({ workspaceId: "wN", disposition: "created" });
  expect(calls[1]).toEqual(["workspace", { action: "create", cwd: root, label: path.basename(root), focus: false }]);
  expect(calls.filter(([group, input]) => group === "agent" && input.action === "start")).toHaveLength(1);
});

it("lands the worker in the spawning workspace when several workspaces match the repository", async () => {
  const { root, worktree } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  // The same inventory that fails closed as ambiguous without affinity.
  await expect(launchTask(request(root), deps([
    workspaceList(["wR", "w0"]), paneList("wR", root), paneList("w0", root),
  ], []))).rejects.toMatchObject({ code: "workspace_ambiguous" });
  const result = await launchTask(request(root), deps([
    workspaceList(["wR", "w0"]), paneList("wR", root), paneList("w0", root), createdTab("w0"), agentResult("agent_started", "w0:p2"), agentResult("agent_prompted", "w0:p2"),
  ], calls, git, { HERDR_WORKSPACE_ID: "w0" }));
  expect(result.resources.workspace).toEqual({ workspaceId: "w0", disposition: "existing" });
  expect(calls[3]).toEqual(["tab", { action: "create", workspaceId: "w0", cwd: worktree, label: "review", focus: false }]);
  expect(calls.some(([group, input]) => group === "workspace" && input.action === "create")).toBe(false);
});

it("fails closed before any mutation when the spawning workspace is not repo-bound", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask(request(root), deps([
    workspaceList(["wR", "w0"]), paneList("wR", root), paneList("w0", os.tmpdir()),
  ], calls, git, { HERDR_WORKSPACE_ID: "w0" }))).rejects.toMatchObject({ code: "workspace_origin_mismatch", stage: "workspace-inventory" });
  // Inventory reads only: no worktree, workspace, tab, agent, or prompt.
  expect(calls.map(([group, input]) => [group, input.action])).toEqual([["workspace", "list"], ["pane", "list"], ["pane", "list"]]);
});

it("preserves the inventoried workspace when worktree creation is ambiguous", async () => {
  const { root } = await makeRepo(false); const calls: Array<[string, Record<string, unknown>]> = [];
  const failingGit: GitRunner = async (command, args, options) => args[0] === "worktree" && args[1] === "add"
    ? { code: 1, stdout: "", stderr: "timed out", killed: true }
    : git(command, args, options);
  await expect(launchTask(request(root), deps([workspaceList(["wE"]), paneList("wE", root)], calls, failingGit))).rejects.toMatchObject({
    code: "git_failed", stage: "worktree-create", ambiguous: true,
    confirmed: { workspace: { workspaceId: "wE", disposition: "existing" }, promptSubmitted: false },
  });
  expect(calls).toHaveLength(2);
});

it("stops after an ambiguous tab failure, preserves confirmed resources, and never retries or cleans up", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const failure = new HerdrToolError({ kind: "transport_failed", message: "secret prompt and args", remoteOutcome: "unknown" });
  await expect(launchTask(request(root), deps([workspaceList(["wE"]), paneList("wE", root), failure], calls))).rejects.toMatchObject({
    code: "herdr_failed", stage: "tab-create", ambiguous: true,
    confirmed: { worktree: expect.objectContaining({ disposition: "existing" }), workspace: { workspaceId: "wE", disposition: "existing" }, promptSubmitted: false },
  });
  expect(calls.filter(([group, input]) => group === "tab" && input.action === "create")).toHaveLength(1);
  expect(calls.some(([, input]) => ["close", "remove"].includes(String(input.action)))).toBe(false);
  try { await launchTask(request(root), deps([workspaceList(["wE"]), paneList("wE", root), failure], [])); } catch (error) { expect((error as Error).message).not.toContain("secret"); }
});

it("treats malformed success data after a mutation as ambiguous", async () => {
  const { root } = await makeRepo();
  const malformed = tool("tab", "create", { type: "tab_created", tab: {}, root_pane: {} });
  await expect(launchTask(request(root), deps([workspaceList(["wE"]), paneList("wE", root), malformed], []))).rejects.toMatchObject({
    stage: "tab-create", ambiguous: true,
    confirmed: { worktree: expect.any(Object), workspace: expect.any(Object), promptSubmitted: false },
  });
});

it("reports each later confirmed stage when agent prompt fails", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const failure = new HerdrToolError({ kind: "operation_failed", message: "prompt rejected", remoteOutcome: "unknown" });
  await expect(launchTask(request(root), deps([workspaceList(["wE"]), paneList("wE", root), createdTab("wE"), agentResult("agent_started", "wE:p2"), failure], calls))).rejects.toMatchObject({
    stage: "agent-prompt", ambiguous: true,
    confirmed: { tab: { tabId: "wE:t2", paneId: "wE:p2" }, agent: { name: "reviewer", paneId: "wE:p2" }, promptSubmitted: false },
  });
  expect(calls).toHaveLength(5);
});

it("honors pre-cancellation before any git or Herdr call", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask(request(root), deps([], calls), AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
  expect(calls).toEqual([]);
});

const paneRan = () => tool("pane", "run", { type: "ok" });
const agentInfo = (paneId: string, fields: Record<string, unknown> = {}) => tool("agent", "inspect", { type: "agent_info", agent: { agent: "pi", agent_status: "idle", pane_id: paneId, ...fields } });
const renamed = (paneId: string) => tool("agent", "rename", { type: "agent_info", agent: { agent: "pi", agent_status: "idle", pane_id: paneId, name: "reviewer" } });
const notDetected = () => new HerdrToolError({ kind: "operation_failed", message: "agent target not found", herdrCode: "agent_not_found", remoteOutcome: "not_applicable" });
const profiled = (root: string, args: string[] = []): TaskLaunchInput => ({ ...request(root), piProfile: "work", args });
const SECRETS = ["Do the work.", "--api-key", "sk-native-secret", "PROFILE_ENV_SECRET", "command pi-profile", "--cwd", " work "];

function profiledQueue(root: string, ...afterRun: Array<ReturnType<typeof tool> | Error>) {
  return [workspaceList(["wE"]), paneList("wE", root), notDetected(), createdTab("wE"), paneRan(), ...afterRun];
}

it("launches a profiled worker through pi-profile, then detects, names, verifies, and prompts it in order", async () => {
  const { root, worktree } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await launchTask(profiled(root, ["--model", "x y"]), deps(profiledQueue(root,
    notDetected(), agentInfo("wE:p2", { agent_status: "unknown" }), agentInfo("wE:p2"), agentInfo("wE:p2"),
    renamed("wE:p2"), agentInfo("wE:p2", { name: "reviewer" }), agentResult("agent_prompted", "wE:p2"),
  ), calls));
  expect(calls.slice(2).map(([group, input]) => [group, input.action])).toEqual([
    ["agent", "inspect"], ["tab", "create"], ["pane", "run"],
    ["agent", "inspect"], ["agent", "inspect"], ["agent", "inspect"], ["agent", "inspect"],
    ["agent", "rename"], ["agent", "inspect"], ["agent", "prompt"],
  ]);
  expect(calls[2]![1]).toEqual({ action: "inspect", target: "reviewer" });
  expect(calls[3]![1]).toEqual({ action: "create", workspaceId: "wE", cwd: worktree, label: "review", focus: false });
  expect(calls[4]![1]).toEqual({ action: "run", paneId: "wE:p2", command: ` command pi-profile --cwd '${worktree}' work '--model' 'x y'` });
  for (const index of [5, 6, 7, 8]) expect(calls[index]![1]).toEqual({ action: "inspect", target: "wE:p2" });
  expect(calls[9]![1]).toEqual({ action: "rename", target: "wE:p2", name: "reviewer" });
  expect(calls[10]![1]).toEqual({ action: "inspect", target: "reviewer" });
  expect(calls[11]![1].target).toBe("reviewer");
  expect(calls[11]![1].text).toContain("Authorized worktree: " + worktree);
  expect(calls.some(([group, input]) => group === "agent" && input.action === "start")).toBe(false);
  expect(result.resources).toMatchObject({ tab: { tabId: "wE:t2", paneId: "wE:p2" }, launcher: { kind: "pi-profile", profile: "work", commandSubmitted: true }, agent: { name: "reviewer", paneId: "wE:p2" }, promptSubmitted: true });
});

it("keeps hostile native arguments inside single shell words of the fixed command", async () => {
  const { root, worktree } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const args = ["", "-x", "a b", "it's", "$(id)", "line\nbreak", "; rm -rf /"];
  await launchTask(profiled(root, args), deps(profiledQueue(root, agentInfo("wE:p2"), agentInfo("wE:p2"), renamed("wE:p2"), agentInfo("wE:p2", { name: "reviewer" }), agentResult("agent_prompted", "wE:p2")), calls));
  expect(calls[4]![1].command).toBe(` command pi-profile --cwd '${worktree}' work '' '-x' 'a b' 'it'\\''s' '$(id)' $'line\\012break' '; rm -rf /'`);
});

it("leaves an unprofiled launch on the native agent start path without launcher state", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await launchTask({ ...request(root), args: ["--model", "x"] }, deps([workspaceList(["wE"]), paneList("wE", root), createdTab("wE"), agentResult("agent_started", "wE:p2"), agentResult("agent_prompted", "wE:p2")], calls));
  expect(calls[3]).toEqual(["agent", { action: "start", name: "reviewer", kind: "pi", paneId: "wE:p2", args: ["--model", "x"] }]);
  expect(calls.slice(2).some(([group]) => group === "pane")).toBe(false);
  expect(result.resources).not.toHaveProperty("launcher");
});

it("refuses a profile for a non-Pi worker before any git or Herdr call", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask({ ...profiled(root), agentKind: "claude" }, deps([], calls))).rejects.toMatchObject({ code: "invalid_input", stage: "validate" });
  await expect(launchTask({ ...profiled(root), piProfile: "work; id" }, deps([], calls))).rejects.toMatchObject({ code: "invalid_input", stage: "validate" });
  await expect(launchTask({ ...profiled(root), piProfile: "recover" }, deps([], calls))).rejects.toMatchObject({ code: "invalid_input", stage: "validate" });
  expect(calls).toEqual([]);
});

it("reports confirmed state when the launcher command fails and never retries or cleans up", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const failure = new HerdrToolError({ kind: "transport_failed", message: SECRETS.join(" "), remoteOutcome: "unknown" });
  const error = await launchTask(profiled(root, ["--api-key", "sk-native-secret"]), deps([workspaceList(["wE"]), paneList("wE", root), notDetected(), createdTab("wE"), failure], calls)).catch(value => value);
  expect(error).toMatchObject({
    code: "herdr_failed", stage: "profile-run", ambiguous: true,
    confirmed: { worktree: expect.objectContaining({ disposition: "existing" }), workspace: { workspaceId: "wE", disposition: "existing" }, tab: { tabId: "wE:t2", paneId: "wE:p2" }, launcher: { kind: "pi-profile", profile: "work", commandSubmitted: false }, promptSubmitted: false },
  });
  expect(error.confirmed).not.toHaveProperty("agent");
  expect(calls.filter(([group, input]) => group === "pane" && input.action === "run")).toHaveLength(1);
  expect(calls).toHaveLength(5);
});

it("stops with confirmed state when no Pi worker is detected before the startup deadline", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const polls = Array.from({ length: 200 }, () => notDetected());
  const error = await launchTask(profiled(root), deps(profiledQueue(root, ...polls), calls)).catch(value => value);
  expect(error).toMatchObject({
    code: "herdr_failed", stage: "profile-detect", ambiguous: true,
    confirmed: { tab: { tabId: "wE:t2", paneId: "wE:p2" }, launcher: { commandSubmitted: true }, promptSubmitted: false },
  });
  expect(error.confirmed).not.toHaveProperty("agent");
  const afterRun = calls.slice(5);
  expect(afterRun.length).toBeGreaterThan(1);
  expect(afterRun.length).toBeLessThanOrEqual(120);
  expect(afterRun.every(([group, input]) => group === "agent" && input.action === "inspect")).toBe(true);
  expect(calls.filter(([group, input]) => group === "pane" && input.action === "run")).toHaveLength(1);
});

it("refuses to name or prompt a different agent kind detected in the worker pane", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask(profiled(root), deps(profiledQueue(root, agentInfo("wE:p2", { agent: "claude" })), calls))).rejects.toMatchObject({ stage: "profile-detect", ambiguous: true, confirmed: { promptSubmitted: false } });
  expect(calls.some(([, input]) => ["rename", "prompt"].includes(String(input.action)))).toBe(false);
});

it("surfaces a blocked profiled worker without answering, naming, or prompting it", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask(profiled(root), deps(profiledQueue(root, agentInfo("wE:p2", { agent_status: "blocked" })), calls))).rejects.toMatchObject({ stage: "profile-detect", ambiguous: true, confirmed: { launcher: { commandSubmitted: true }, promptSubmitted: false } });
  expect(calls.some(([, input]) => ["rename", "prompt", "send-keys", "send-text"].includes(String(input.action)))).toBe(false);
});

it("requires readiness in the exact worker pane before naming", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask(profiled(root), deps(profiledQueue(root, agentInfo("wE:p9")), calls))).rejects.toMatchObject({ stage: "profile-detect", ambiguous: true });
  expect(calls.some(([, input]) => input.action === "rename")).toBe(false);
});

it("does not prompt when the requested name is not confirmed on the exact pane", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const error = await launchTask(profiled(root), deps(profiledQueue(root, agentInfo("wE:p2"), agentInfo("wE:p2"), renamed("wE:p2"), agentInfo("wE:p7", { name: "reviewer" })), calls)).catch(value => value);
  expect(error).toMatchObject({ stage: "agent-name", ambiguous: true, confirmed: { launcher: { commandSubmitted: true }, promptSubmitted: false } });
  expect(error.confirmed).not.toHaveProperty("agent");
  expect(calls.some(([, input]) => input.action === "prompt")).toBe(false);
  expect(calls.filter(([, input]) => input.action === "rename")).toHaveLength(1);
});

it("does not retry a failed rename", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const failure = new HerdrToolError({ kind: "timeout", message: "late", remoteOutcome: "unknown" });
  await expect(launchTask(profiled(root), deps(profiledQueue(root, agentInfo("wE:p2"), agentInfo("wE:p2"), failure), calls))).rejects.toMatchObject({ stage: "agent-name", ambiguous: true });
  expect(calls.filter(([, input]) => input.action === "rename")).toHaveLength(1);
  expect(calls.at(-1)![1].action).toBe("rename");
});

it("refuses a profiled launch before creating any worktree or topology when the requested name is already in use", async () => {
  const { root, worktree } = await makeRepo(false); const calls: Array<[string, Record<string, unknown>]> = [];
  const error = await launchTask(profiled(root), deps([workspaceList(["wE"]), paneList("wE", root), agentInfo("wE:p5", { name: "reviewer" })], calls)).catch(value => value);
  expect(error).toMatchObject({ code: "herdr_failed", stage: "agent-name-check", ambiguous: false, confirmed: { workspace: { workspaceId: "wE", disposition: "existing" }, promptSubmitted: false } });
  for (const key of ["worktree", "tab", "launcher", "agent"]) expect(error.confirmed).not.toHaveProperty(key);
  await expect(fs.access(worktree)).rejects.toThrow();
  expect(calls).toHaveLength(3);
});

it("refuses an oversized profiled command as invalid input before any git or Herdr call", async () => {
  const { root, worktree } = await makeRepo(false); const calls: Array<[string, Record<string, unknown>]> = [];
  await expect(launchTask(profiled(root, ["x".repeat(64 * 1024)]), deps([], calls))).rejects.toMatchObject({ code: "invalid_input", stage: "validate" });
  await expect(fs.access(worktree)).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("bounds the command built from the canonical worktree path before any mutation", async () => {
  const { root, worktree } = await makeRepo(false); const calls: Array<[string, Record<string, unknown>]> = [];
  const alias = path.join(path.dirname(root), "l" + path.basename(root).slice(-6)); cleanup.push(alias);
  await fs.symlink(root, alias);
  const aliasWorktree = path.join(alias, ".worktrees", "review");
  expect(aliasWorktree.length).toBeLessThan(worktree.length);
  const room = MAX_PROFILE_COMMAND_BYTES - Buffer.byteLength(buildProfileCommand("work", aliasWorktree, [])) - 3;
  const args = ["x".repeat(room)];
  expect(() => buildProfileCommand("work", aliasWorktree, args)).not.toThrow();
  expect(() => buildProfileCommand("work", worktree, args)).toThrow();
  await expect(launchTask({ ...profiled(root, args), repoRoot: alias }, deps([workspaceList(["wE"]), paneList("wE", root), notDetected(), createdTab("wE"), paneRan()], calls))).rejects.toMatchObject({ confirmed: { promptSubmitted: false } });
  await expect(fs.access(worktree)).rejects.toThrow();
  expect(calls.some(([group, input]) => ["create", "run"].includes(String(input.action)) && group !== "agent")).toBe(false);
});

it("never starts a detection poll after the startup deadline has passed", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const dependencies = deps(profiledQueue(root, notDetected(), notDetected(), notDetected()), calls);
  const realNow = Date.now; let offset = 0;
  dependencies.sleep = async () => { offset += 31_000; };
  Date.now = () => realNow() + offset;
  try {
    await expect(launchTask(profiled(root), dependencies)).rejects.toMatchObject({ stage: "profile-detect", ambiguous: true });
  } finally { Date.now = realNow; }
  expect(calls.slice(5)).toHaveLength(1);
});

it("records the launcher command as submitted once Herdr accepted it, even if the acknowledgement is malformed", async () => {
  const { root } = await makeRepo();
  const malformed = tool("pane", "list", { type: "ok" });
  await expect(launchTask(profiled(root), deps([workspaceList(["wE"]), paneList("wE", root), notDetected(), createdTab("wE"), malformed], []))).rejects.toMatchObject({ stage: "profile-run", ambiguous: true, confirmed: { launcher: { commandSubmitted: true } } });
});

it("stops polling when a detection read fails for a reason other than absence", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const failure = new HerdrToolError({ kind: "server_unavailable", message: "gone", remoteOutcome: "not_applicable" });
  await expect(launchTask(profiled(root), deps(profiledQueue(root, failure), calls))).rejects.toMatchObject({ stage: "profile-detect", ambiguous: true, confirmed: { launcher: { commandSubmitted: true } } });
  expect(calls).toHaveLength(6);
});

it("keeps prompts, native arguments, profile environment, and command text out of every profiled failure", async () => {
  const { root } = await makeRepo();
  const leak = (stageQueue: Array<ReturnType<typeof tool> | Error>) => launchTask({ ...profiled(root, ["--api-key", "sk-native-secret"]), prompt: "Do the work." }, deps(stageQueue, [])).catch(value => value);
  const failure = () => new HerdrToolError({ kind: "operation_failed", message: SECRETS.join(" "), herdrCode: "PROFILE_ENV_SECRET", remoteOutcome: "unknown" });
  const errors = [
    await leak([workspaceList(["wE"]), paneList("wE", root), notDetected(), createdTab("wE"), failure()]),
    await leak(profiledQueue(root, failure())),
    await leak(profiledQueue(root, agentInfo("wE:p2", { agent_status: "blocked", terminal_title: "PROFILE_ENV_SECRET" }))),
    await leak(profiledQueue(root, agentInfo("wE:p2"), agentInfo("wE:p2"), failure())),
    await leak(profiledQueue(root, agentInfo("wE:p2"), agentInfo("wE:p2"), renamed("wE:p2"), agentInfo("wE:p2", { name: "reviewer" }), failure())),
  ];
  expect(errors.map(error => error.stage)).toEqual(["profile-run", "profile-detect", "profile-detect", "agent-name", "agent-prompt"]);
  for (const error of errors) {
    const text = formatOrchestratorError(error);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }
});

it("honors cancellation between detection polls without further Herdr calls", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const controller = new AbortController();
  const dependencies = deps(profiledQueue(root, notDetected(), notDetected()), calls);
  dependencies.sleep = async () => { controller.abort(); };
  await expect(launchTask(profiled(root), dependencies, controller.signal)).rejects.toMatchObject({ code: "cancelled", stage: "profile-detect", confirmed: { launcher: { commandSubmitted: true } } });
  expect(calls).toHaveLength(6);
});

it("reports cancellation that lands during an in-flight detection read as cancelled", async () => {
  const { root } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const controller = new AbortController();
  const dependencies = deps(profiledQueue(root), calls);
  const queued = dependencies.herdr;
  dependencies.herdr = async (group, input, context) => {
    if (calls.length >= 5) { calls.push([group, input]); controller.abort(); throw new HerdrToolError({ kind: "cancelled", message: "aborted", remoteOutcome: "not_applicable" }); }
    return queued(group, input, context);
  };
  await expect(launchTask(profiled(root), dependencies, controller.signal)).rejects.toMatchObject({ code: "cancelled", stage: "profile-detect", confirmed: { launcher: { commandSubmitted: true }, promptSubmitted: false } });
  expect(calls).toHaveLength(6);
});
