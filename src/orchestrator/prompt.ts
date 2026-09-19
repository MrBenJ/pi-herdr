import type { RepositoryIdentity, WorktreeState } from "./contracts.ts";
import { BOUNDARY_VERSION } from "./contracts.ts";
import { OrchestratorError } from "./errors.ts";

const MAX_TASK_BYTES = 256 * 1024;

export interface WorkerPromptInput {
  task: string;
  fenceToken: string;
  repository: RepositoryIdentity;
  worktree: WorktreeState;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  // Operator grants, derived by launch.ts from the HERDR_ALLOW_* environment —
  // never from `task` or any caller-supplied input. Absent/false = prohibited.
  allowWorkspaces?: boolean;
  allowDispatch?: boolean;
}

function safe(value: string, field: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new OrchestratorError({ code: "invalid_input", message: `${field} must be a string without NUL characters.`, stage: "prompt" });
  }
  return value;
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const task = safe(input.task, "prompt");
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    throw new OrchestratorError({ code: "invalid_input", message: "prompt exceeds the 256 KiB orchestration limit.", stage: "prompt" });
  }
  const fence = safe(input.fenceToken, "fenceToken");
  if (!/^[a-f0-9]{32}$/.test(fence)) {
    throw new OrchestratorError({ code: "invalid_input", message: "fenceToken must be 32 lowercase hexadecimal characters.", stage: "prompt" });
  }
  const repoRoot = safe(input.repository.repoRoot, "repository root");
  const worktreePath = safe(input.worktree.path, "worktree path");
  const workspaceId = safe(input.workspaceId, "workspace ID");
  const tabId = safe(input.tabId, "tab ID");
  const paneId = safe(input.paneId, "pane ID");
  const agentName = safe(input.agentName, "agent name");

  return [
    `BEGIN UNTRUSTED TASK ${fence}`,
    task,
    `END UNTRUSTED TASK ${fence}`,
    "",
    `BEGIN PI-HERDR ORCHESTRATION BOUNDARY v${BOUNDARY_VERSION}`,
    `Canonical repository: ${repoRoot}`,
    `Authorized worktree: ${worktreePath}`,
    `Authorized workspace: ${workspaceId}`,
    `Authorized tab: ${tabId}`,
    `Authorized pane: ${paneId}`,
    `Authorized agent: ${agentName}`,
    "Do not create, move, or remove git worktrees.",
    input.allowWorkspaces === true
      ? "Creating execution topology (Herdr workspaces, tabs, panes, or agents) is authorized for this run via herdr_task launch; the direct herdr_* topology tools stay disabled."
      : "Do not create Herdr workspaces, tabs, panes, or agents unless this run was explicitly authorized to; none was granted.",
    input.allowDispatch === true
      ? "Dispatching subagents or background work is authorized for this run; otherwise it is prohibited by default."
      : "Do not dispatch subagents or background work unless this run was explicitly authorized to; none was granted.",
    "Do not rewrite Todo execution boundaries.",
    "Report a blocker instead of inventing infrastructure.",
    `END PI-HERDR ORCHESTRATION BOUNDARY v${BOUNDARY_VERSION}`,
  ].join("\n");
}
