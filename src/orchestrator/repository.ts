import path from "node:path";
import type { GitRunner, OrchestratorDependencies, RepositoryIdentity, WorktreeState } from "./contracts.ts";
import { ORCHESTRATOR_DEADLINE_MS, WORKTREE_DIR } from "./contracts.ts";
import { OrchestratorError } from "./errors.ts";

export interface RegisteredWorktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
}

export interface EnsureWorktreeInput {
  worktreeName: string;
  branch: string;
  baseRef: string;
}

function fail(code: "repository_invalid" | "worktree_policy" | "worktree_collision" | "git_failed" | "cancelled" | "invalid_input", message: string, stage: string, ambiguous = false): never {
  throw new OrchestratorError({ code, message, stage, ambiguous });
}

function cancellation(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) fail("cancelled", "Orchestration was cancelled before the next mutation.", stage);
}

async function runGit(git: GitRunner, args: string[], cwd: string, stage: string, signal?: AbortSignal) {
  cancellation(signal, stage);
  try {
    return await git("git", args, { cwd, deadlineMs: ORCHESTRATOR_DEADLINE_MS, signal });
  } catch {
    fail("git_failed", "Git could not be executed.", stage);
  }
}

async function gitChecked(git: GitRunner, args: string[], cwd: string, stage: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(git, args, cwd, stage, signal);
  if (result.code !== 0) fail("git_failed", `Git failed during ${stage}.`, stage, result.killed === true);
  return result.stdout.trim();
}

async function existingLstat(deps: OrchestratorDependencies, target: string): Promise<Awaited<ReturnType<OrchestratorDependencies["paths"]["lstat"]>> | undefined> {
  try {
    return await deps.paths.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("worktree_policy", "The requested worktree path could not be inspected safely.", "worktree-policy");
  }
}

function resolveGitPath(root: string, value: string): string {
  return path.resolve(root, value);
}

export function validateWorktreeName(name: string): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === ".." || name === ".claude") {
    fail("invalid_input", "worktreeName must be 1-80 safe filename characters and may not contain a path.", "validate");
  }
  return name;
}

export function desiredWorktreePath(repository: RepositoryIdentity, name: string): string {
  return path.join(repository.worktreeRoot, validateWorktreeName(name));
}

export async function validateRepository(repoRoot: string, deps: OrchestratorDependencies, signal?: AbortSignal): Promise<RepositoryIdentity> {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot) || repoRoot.includes("\0")) {
    fail("repository_invalid", "repoRoot must be an absolute canonical repository path.", "repository");
  }
  let requested: string;
  try {
    requested = await deps.paths.realpath(repoRoot);
  } catch {
    fail("repository_invalid", "repoRoot does not exist or cannot be resolved.", "repository");
  }
  let top: string;
  try {
    top = await gitChecked(deps.git, ["rev-parse", "--show-toplevel"], requested, "repository", signal);
  } catch (error) {
    if (error instanceof OrchestratorError && error.code === "cancelled") throw error;
    fail("repository_invalid", "repoRoot is not a Git repository.", "repository");
  }
  const canonicalTop = await deps.paths.realpath(top);
  if (canonicalTop !== requested) fail("repository_invalid", "repoRoot must name the repository root, not a nested directory.", "repository");

  const gitDirText = await gitChecked(deps.git, ["rev-parse", "--git-dir"], requested, "repository", signal);
  const commonText = await gitChecked(deps.git, ["rev-parse", "--git-common-dir"], requested, "repository", signal);
  const gitDir = await deps.paths.realpath(resolveGitPath(requested, gitDirText));
  const commonDir = await deps.paths.realpath(resolveGitPath(requested, commonText));
  if (gitDir !== commonDir) fail("repository_invalid", "repoRoot must be the canonical main checkout, not a linked worktree.", "repository");

  let defaultBranch = "";
  const remoteHead = await runGit(deps.git, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], requested, "repository", signal);
  if (remoteHead.code === 0) defaultBranch = remoteHead.stdout.trim().replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    if (defaultBranch) break;
    const found = await runGit(deps.git, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], requested, "repository", signal);
    if (found.code === 0) defaultBranch = candidate;
  }
  if (!defaultBranch) fail("repository_invalid", "The repository has no resolvable default branch.", "repository");

  const ignored = await runGit(deps.git, ["check-ignore", "--quiet", `${WORKTREE_DIR}/`], requested, "worktree-policy", signal);
  if (ignored.code !== 0) fail("worktree_policy", `The repository must ignore /${WORKTREE_DIR}/ before orchestration.`, "worktree-policy");
  const worktreeRoot = path.join(requested, WORKTREE_DIR);
  const rootStat = await existingLstat(deps, worktreeRoot);
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) fail("worktree_policy", `/${WORKTREE_DIR}/ must be a real directory when it exists.`, "worktree-policy");

  return { repoRoot: requested, gitCommonDir: commonDir, defaultBranch, worktreeRoot };
}

export function parseWorktreePorcelain(output: string): RegisteredWorktree[] {
  if (!output.trim()) return [];
  return output.trim().split(/\n\n+/).map((record, index) => {
    let worktreePath: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let detached = false;
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
      else if (line === "detached") detached = true;
    }
    if (!worktreePath || !head) fail("git_failed", `Git returned a malformed worktree record at index ${index}.`, "worktree-inventory");
    return { path: path.resolve(worktreePath), head, branch, detached };
  });
}

export async function inspectWorktrees(repository: RepositoryIdentity, git: GitRunner, signal?: AbortSignal): Promise<RegisteredWorktree[]> {
  const output = await gitChecked(git, ["worktree", "list", "--porcelain"], repository.repoRoot, "worktree-inventory", signal);
  return parseWorktreePorcelain(output);
}

export async function ensureWorktree(input: EnsureWorktreeInput, repository: RepositoryIdentity, deps: OrchestratorDependencies, signal?: AbortSignal): Promise<WorktreeState> {
  cancellation(signal, "worktree");
  const name = validateWorktreeName(input.worktreeName);
  if (typeof input.branch !== "string" || input.branch.includes("\0") || typeof input.baseRef !== "string" || !input.baseRef || input.baseRef.includes("\0")) {
    fail("invalid_input", "branch and baseRef must be nonempty strings without NUL characters.", "validate");
  }
  if (input.branch === repository.defaultBranch) fail("invalid_input", "The orchestrated branch may not be the repository default branch.", "validate");
  const branchFormat = await runGit(deps.git, ["check-ref-format", "--branch", input.branch], repository.repoRoot, "worktree-validate", signal);
  if (branchFormat.code !== 0) fail("invalid_input", "branch is not a valid Git branch name.", "validate");
  const base = await runGit(deps.git, ["rev-parse", "--verify", `${input.baseRef}^{commit}`], repository.repoRoot, "worktree-validate", signal);
  if (base.code !== 0) fail("git_failed", "baseRef does not resolve to a commit.", "worktree-validate");

  const desired = desiredWorktreePath(repository, name);
  const entries = await inspectWorktrees(repository, deps.git, signal);
  const atPath = entries.find(entry => entry.path === desired);
  const onBranch = entries.find(entry => entry.branch === input.branch);
  const stat = await existingLstat(deps, desired);
  if (stat?.isSymbolicLink()) fail("worktree_policy", "The requested worktree path may not be a symbolic link.", "worktree-policy");
  if (atPath && atPath.branch === input.branch) {
    if (!stat?.isDirectory()) fail("worktree_collision", "The registered exact worktree path is missing or is not a directory.", "worktree-policy");
    return { path: desired, branch: input.branch, head: atPath.head, disposition: "existing" };
  }
  if (atPath || onBranch) fail("worktree_collision", "The requested branch or exact worktree path is already registered elsewhere.", "worktree-policy");
  if (stat) fail("worktree_collision", "The requested worktree path exists but is not a registered worktree.", "worktree-policy");

  cancellation(signal, "worktree-create");
  const created = await runGit(deps.git, ["worktree", "add", desired, "-b", input.branch, input.baseRef], repository.repoRoot, "worktree-create", signal);
  if (created.code !== 0) fail("git_failed", "Git could not create the requested worktree.", "worktree-create", created.killed === true);
  const confirmed = (await inspectWorktrees(repository, deps.git, signal)).find(entry => entry.path === desired && entry.branch === input.branch);
  if (!confirmed) fail("git_failed", "Git returned success but the exact worktree could not be confirmed.", "worktree-create", true);
  return { path: desired, branch: input.branch, head: confirmed.head, disposition: "created" };
}
