import path from "node:path";
import type { Json, ToolResult } from "../contracts.ts";
import type { OrchestratorDependencies, RepositoryIdentity, WorkspaceMatch } from "./contracts.ts";
import { ORCHESTRATOR_DEADLINE_MS } from "./contracts.ts";
import { OrchestratorError } from "./errors.ts";

export interface InventoryWorkspace {
  workspaceId: string;
  matchingPaneIds: string[];
}

export interface HerdrInventory {
  canonicalRepoRoot: string;
  workspaces: InventoryWorkspace[];
  violations: string[];
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OrchestratorError({ code: "cancelled", message: "Orchestration was cancelled during Herdr inventory.", stage: "workspace-inventory" });
}

function record(value: Json | undefined): { [key: string]: Json } {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new OrchestratorError({ code: "herdr_failed", message: "Herdr returned malformed topology data.", stage: "workspace-inventory" });
  }
  return value;
}

function completeResult(toolResult: ToolResult, group: "workspace" | "pane"): { [key: string]: Json } {
  if (toolResult.details.group !== group || toolResult.details.truncated || toolResult.details.resultOmitted) {
    throw new OrchestratorError({ code: "herdr_failed", message: "Herdr topology inventory was incomplete.", stage: "workspace-inventory" });
  }
  return record(toolResult.details.result);
}

function workspaceIds(toolResult: ToolResult): string[] {
  const result = completeResult(toolResult, "workspace");
  if (result["type"] !== "workspace_list" || !Array.isArray(result["workspaces"])) {
    throw new OrchestratorError({ code: "herdr_failed", message: "Herdr returned a malformed workspace list.", stage: "workspace-inventory" });
  }
  return result["workspaces"].map(value => {
    const workspace = record(value);
    if (typeof workspace["workspace_id"] !== "string" || !workspace["workspace_id"]) {
      throw new OrchestratorError({ code: "herdr_failed", message: "Herdr returned a workspace without an ID.", stage: "workspace-inventory" });
    }
    return workspace["workspace_id"];
  });
}

function panes(toolResult: ToolResult, workspaceId: string): Array<{ paneId: string; cwd: string }> {
  const result = completeResult(toolResult, "pane");
  if (result["type"] !== "pane_list" || !Array.isArray(result["panes"])) {
    throw new OrchestratorError({ code: "herdr_failed", message: "Herdr returned a malformed pane list.", stage: "workspace-inventory" });
  }
  return result["panes"].map(value => {
    const pane = record(value);
    if (typeof pane["pane_id"] !== "string" || !pane["pane_id"] || pane["workspace_id"] !== workspaceId || typeof pane["cwd"] !== "string" || !pane["cwd"]) {
      throw new OrchestratorError({ code: "herdr_failed", message: `Herdr returned a malformed pane for workspace ${workspaceId}.`, stage: "workspace-inventory" });
    }
    return { paneId: pane["pane_id"], cwd: pane["cwd"] };
  });
}

async function callHerdr(deps: OrchestratorDependencies, repository: RepositoryIdentity, group: "workspace" | "pane", input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  cancelled(signal);
  try {
    return await deps.herdr(group, input, { cwd: repository.repoRoot, env: deps.env, signal });
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    throw new OrchestratorError({ code: "herdr_failed", message: `Herdr failed during ${group} inventory.`, stage: "workspace-inventory" });
  }
}

async function paneBelongsToRepository(cwd: string, repository: RepositoryIdentity, deps: OrchestratorDependencies, signal?: AbortSignal): Promise<boolean> {
  cancelled(signal);
  const canonicalCwd = await deps.paths.realpath(cwd);
  const response = await deps.git("git", ["rev-parse", "--git-common-dir"], { cwd: canonicalCwd, deadlineMs: ORCHESTRATOR_DEADLINE_MS, signal });
  if (response.code !== 0) throw new Error("Pane CWD is not a Git repository.");
  const commonPath = path.resolve(canonicalCwd, response.stdout.trim());
  const canonicalCommon = await deps.paths.realpath(commonPath);
  return canonicalCommon === repository.gitCommonDir;
}

export async function inventoryHerdr(repository: RepositoryIdentity, deps: OrchestratorDependencies, signal?: AbortSignal): Promise<HerdrInventory> {
  const listed = await callHerdr(deps, repository, "workspace", { action: "list" }, signal);
  const ids = workspaceIds(listed);
  const workspaces: InventoryWorkspace[] = [];
  const violations: string[] = [];
  for (const workspaceId of ids) {
    cancelled(signal);
    const listedPanes = panes(await callHerdr(deps, repository, "pane", { action: "list", workspaceId }, signal), workspaceId);
    const matchingPaneIds: string[] = [];
    for (const pane of listedPanes) {
      try {
        if (await paneBelongsToRepository(pane.cwd, repository, deps, signal)) matchingPaneIds.push(pane.paneId);
      } catch (error) {
        if (error instanceof OrchestratorError && error.code === "cancelled") throw error;
        violations.push(`workspace ${workspaceId} pane ${pane.paneId} has no canonical git repository`);
      }
    }
    if (matchingPaneIds.length > 0) workspaces.push({ workspaceId, matchingPaneIds: matchingPaneIds.sort() });
  }
  return { canonicalRepoRoot: repository.repoRoot, workspaces, violations };
}

export function selectWorkspace(inventory: HerdrInventory): WorkspaceMatch | undefined {
  if (inventory.workspaces.length === 0) return undefined;
  if (inventory.workspaces.length > 1) {
    const ids = inventory.workspaces.map(workspace => workspace.workspaceId).sort();
    throw new OrchestratorError({ code: "workspace_ambiguous", message: `Multiple Herdr workspaces match this repository: ${ids.join(", ")}.`, stage: "workspace-inventory" });
  }
  const workspace = inventory.workspaces[0]!;
  return { workspaceId: workspace.workspaceId, paneIds: workspace.matchingPaneIds, canonicalRepoRoot: inventory.canonicalRepoRoot };
}
