import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner, OrchestratorDependencies } from "../src/orchestrator/contracts.ts";
import { OrchestratorError } from "../src/orchestrator/errors.ts";
import { desiredWorktreePath, ensureWorktree, inspectWorktrees, validateRepository, validateWorktreeName } from "../src/orchestrator/repository.ts";

const exec = promisify(execFile);
const cleanup: string[] = [];

const git: GitRunner = async (command, args, options) => {
  try {
    const result = await exec(command, args, { cwd: options.cwd, timeout: options.deadlineMs, signal: options.signal, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, killed: failure.killed };
  }
};

const paths = { realpath: fs.realpath, lstat: fs.lstat, access: fs.access };
const deps = (runner: GitRunner = git): OrchestratorDependencies => ({
  git: runner,
  paths,
  env: {},
  herdr: async () => { throw new Error("Herdr must not be called by repository policy tests."); },
});

async function makeRepo(ignore = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-orchestrator-repo-"));
  cleanup.push(root);
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, ".gitignore"), ignore ? "/.worktrees/\n" : "node_modules/\n");
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "initial"], { cwd: root });
  return fs.realpath(root);
}

afterEach(async () => {
  for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("validateRepository", () => {
  it("accepts only an ignored canonical main checkout", async () => {
    const root = await makeRepo();
    const identity = await validateRepository(root, deps());
    expect(identity).toEqual({ repoRoot: root, gitCommonDir: path.join(root, ".git"), defaultBranch: "main", worktreeRoot: path.join(root, ".worktrees") });
  });

  it("rejects relative, non-repository, nested, linked-worktree and unignored inputs", async () => {
    await expect(validateRepository("relative/path", deps())).rejects.toMatchObject({ code: "repository_invalid" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-not-repo-")); cleanup.push(outside);
    await expect(validateRepository(outside, deps())).rejects.toMatchObject({ code: "repository_invalid" });
    const root = await makeRepo();
    await fs.mkdir(path.join(root, "nested"));
    await expect(validateRepository(path.join(root, "nested"), deps())).rejects.toMatchObject({ code: "repository_invalid" });
    const linked = path.join(root, ".worktrees", "linked");
    await exec("git", ["worktree", "add", linked, "-b", "linked"], { cwd: root });
    await expect(validateRepository(linked, deps())).rejects.toMatchObject({ code: "repository_invalid" });
    const unignored = await makeRepo(false);
    await expect(validateRepository(unignored, deps())).rejects.toMatchObject({ code: "worktree_policy" });
  });
});

describe("worktree naming and reconciliation", () => {
  it.each(["pi-harness", "fix_123", "review.2"])("accepts %s", name => expect(validateWorktreeName(name)).toBe(name));
  it.each(["", ".", "..", "a/b", "a\\b", "/tmp/x", ".claude", "-bad", "two words", "bad\0name", "x".repeat(81)])("rejects %j", name => {
    expect(() => validateWorktreeName(name)).toThrow(OrchestratorError);
  });

  it("derives and creates only the exact repo-local path", async () => {
    const root = await makeRepo();
    const repository = await validateRepository(root, deps());
    expect(desiredWorktreePath(repository, "pi-harness")).toBe(path.join(root, ".worktrees", "pi-harness"));
    const state = await ensureWorktree({ worktreeName: "pi-harness", branch: "feat/pi-harness", baseRef: "main" }, repository, deps());
    expect(state).toMatchObject({ path: path.join(root, ".worktrees", "pi-harness"), branch: "feat/pi-harness", disposition: "created" });
    const existing = await ensureWorktree({ worktreeName: "pi-harness", branch: "feat/pi-harness", baseRef: "main" }, repository, deps());
    expect(existing).toMatchObject({ path: state.path, branch: state.branch, disposition: "existing" });
    expect(await inspectWorktrees(repository, git)).toContainEqual(expect.objectContaining({ path: state.path, branch: state.branch }));
  });

  it("rejects branch/path/filesystem collisions and the default branch", async () => {
    const root = await makeRepo();
    const repository = await validateRepository(root, deps());
    await exec("git", ["worktree", "add", path.join(root, ".worktrees", "other"), "-b", "feat/shared"], { cwd: root });
    await expect(ensureWorktree({ worktreeName: "wanted", branch: "feat/shared", baseRef: "main" }, repository, deps())).rejects.toMatchObject({ code: "worktree_collision" });
    await expect(ensureWorktree({ worktreeName: "other", branch: "feat/different", baseRef: "main" }, repository, deps())).rejects.toMatchObject({ code: "worktree_collision" });
    await fs.mkdir(path.join(root, ".worktrees", "plain"));
    await expect(ensureWorktree({ worktreeName: "plain", branch: "feat/plain", baseRef: "main" }, repository, deps())).rejects.toMatchObject({ code: "worktree_collision" });
    await expect(ensureWorktree({ worktreeName: "main-copy", branch: "main", baseRef: "main" }, repository, deps())).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a registered exact worktree replaced by a symlink", async () => {
    const root = await makeRepo();
    const repository = await validateRepository(root, deps());
    const desired = path.join(root, ".worktrees", "registered-link");
    await exec("git", ["worktree", "add", desired, "-b", "feat/registered-link"], { cwd: root });
    await fs.rm(desired, { recursive: true, force: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-registered-escape-")); cleanup.push(outside);
    await fs.symlink(outside, desired);
    await expect(ensureWorktree({ worktreeName: "registered-link", branch: "feat/registered-link", baseRef: "main" }, repository, deps())).rejects.toMatchObject({ code: "worktree_policy" });
  });

  it("rejects symlink escapes, missing base refs, and pre-cancellation without mutation", async () => {
    const root = await makeRepo();
    const repository = await validateRepository(root, deps());
    await fs.mkdir(repository.worktreeRoot, { recursive: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-escape-")); cleanup.push(outside);
    await fs.symlink(outside, path.join(repository.worktreeRoot, "escape"));
    await expect(ensureWorktree({ worktreeName: "escape", branch: "feat/escape", baseRef: "main" }, repository, deps())).rejects.toMatchObject({ code: "worktree_policy" });
    await expect(ensureWorktree({ worktreeName: "missing", branch: "feat/missing", baseRef: "does-not-exist" }, repository, deps())).rejects.toMatchObject({ code: "git_failed" });
    const calls: string[][] = [];
    const recording: GitRunner = async (command, args, options) => { calls.push(args); return git(command, args, options); };
    await expect(ensureWorktree({ worktreeName: "cancelled", branch: "feat/cancelled", baseRef: "main" }, repository, deps(recording), AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toEqual([]);
  });
});
