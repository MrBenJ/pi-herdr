import type { HerdrAgentKind, ToolResult } from "../contracts.ts";

export const ORCHESTRATOR_DEADLINE_MS = 30_000;
export const WORKTREE_DIR = ".worktrees";
export const BOUNDARY_VERSION = 1;

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
  agent?: { name: string; paneId: string };
  promptSubmitted: boolean;
}

export interface LaunchResult {
  action: "inspect" | "launch";
  repository: RepositoryIdentity;
  resources: LaunchResources;
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
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  access(path: string): Promise<void>;
}

export interface OrchestratorDependencies {
  git: GitRunner;
  herdr: HerdrExecutor;
  paths: PathOps;
  env: NodeJS.ProcessEnv;
}
