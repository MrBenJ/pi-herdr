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
    "Do not create Herdr workspaces, tabs, panes, or agents.",
    "Do not dispatch subagents or background work.",
    "Do not rewrite Todo execution boundaries.",
    "Report a blocker instead of inventing infrastructure.",
    `END PI-HERDR ORCHESTRATION BOUNDARY v${BOUNDARY_VERSION}`,
  ].join("\n");
}
