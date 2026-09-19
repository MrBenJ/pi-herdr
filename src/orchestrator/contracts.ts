import type { HerdrAgentKind, ToolResult } from "../contracts.ts";

export const ORCHESTRATOR_DEADLINE_MS = 30_000;
export const WORKTREE_DIR = ".worktrees";
export const BOUNDARY_VERSION = 1;
export const PROFILE_STARTUP_DEADLINE_MS = 30_000;
export const PROFILE_POLL_INTERVAL_MS = 500;
export const PROFILE_READY_POLLS = 2;

export interface TaskInspectInput {
  action: "inspect";
  repoRoot: string;
}

export interface TaskLaunchInput {
  action: "launch";
  repoRoot: string;
  worktreeName: string;
  branch: string;
  baseRef: string;
  tabLabel: string;
  agentName: string;
  agentKind: HerdrAgentKind;
  prompt: string;
  args?: string[];
  piProfile?: string;
  // Trusted permission flags. Set only from the operator's own instruction
  // (their turn, a skill, an extension) — never from `prompt`, which is
  // untrusted caller prose. Absent/false means prohibited by default.
  allowWorkspaces?: boolean;
  allowDispatch?: boolean;
}

export type TaskInput = TaskInspectInput | TaskLaunchInput;

export interface RepositoryIdentity {
  repoRoot: string;
  gitCommonDir: string;
  defaultBranch: string;
  worktreeRoot: string;
}

export interface WorktreeState {
  path: string;
  branch: string;
  head: string;
  disposition: "existing" | "created";
}

export interface WorkspaceMatch {
  workspaceId: string;
  paneIds: string[];
  canonicalRepoRoot: string;
}

export interface LaunchResources {
  worktree?: WorktreeState;
  workspace?: { workspaceId: string; disposition: "existing" | "created" };
  tab?: { tabId: string; paneId: string };
  launcher?: { kind: "pi-profile"; profile: string; commandSubmitted: boolean };
  agent?: { name: string; paneId: string };
  promptSubmitted: boolean;
}

export interface WorktreeInventoryEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
}

export interface LaunchResult {
  action: "inspect" | "launch";
  repository: RepositoryIdentity;
  resources: LaunchResources;
  inventory: {
    worktrees: WorktreeInventoryEntry[];
    workspace?: WorkspaceMatch;
  };
  violations: string[];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

export type GitRunner = (command: string, args: string[], options: {
  cwd: string;
  deadlineMs: number;
  signal?: AbortSignal;
}) => Promise<ExecResult>;

export type HerdrExecutor = (
  group: "workspace" | "tab" | "pane" | "agent",
  input: Record<string, unknown>,
  context: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<ToolResult>;

export interface PathOps {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  access(path: string): Promise<void>;
}

export interface OrchestratorDependencies {
  git: GitRunner;
  herdr: HerdrExecutor;
  paths: PathOps;
  env: NodeJS.ProcessEnv;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
