import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { GitRunner, HerdrExecutor, OrchestratorDependencies, RepositoryIdentity } from "../src/orchestrator/contracts.ts";
import { inventoryHerdr, selectWorkspace } from "../src/orchestrator/herdr-inventory.ts";

const exec = promisify(execFile);
const cleanup: string[] = [];
const git: GitRunner = async (command, args, options) => {
  try {
    const result = await exec(command, args, { cwd: options.cwd, timeout: options.deadlineMs, signal: options.signal });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
};

async function makeRepo(): Promise<{ repository: RepositoryIdentity; linked: string }> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-inventory-")); cleanup.push(created);
  const root = await fs.realpath(created);
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, ".gitignore"), "/.worktrees/\n");
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "initial"], { cwd: root });
  const linked = path.join(root, ".worktrees", "linked");
  await exec("git", ["worktree", "add", linked, "-b", "linked"], { cwd: root });
  return { repository: { repoRoot: root, gitCommonDir: path.join(root, ".git"), defaultBranch: "main", worktreeRoot: path.join(root, ".worktrees") }, linked };
}

function result(group: "workspace" | "pane", action: string, value: unknown, truncated = false) {
  return { content: [{ type: "text" as const, text: "fixture" }], details: { group, action, result: value as never, truncated } };
}
function workspaceList(ids: string[]) {
  return result("workspace", "list", { type: "workspace_list", workspaces: ids.map(workspace_id => ({ workspace_id })) });
}
function paneList(workspaceId: string, panes: Array<{ pane_id: string; cwd: string }>) {
  return result("pane", "list", { type: "pane_list", panes: panes.map(pane => ({ ...pane, workspace_id: workspaceId })) });
}
function dependencies(queue: ReturnType<typeof result>[], calls: Array<[string, Record<string, unknown>]>, signalController?: AbortController): OrchestratorDependencies {
  const herdr: HerdrExecutor = async (group, input) => {
    calls.push([group, input]);
    const next = queue.shift();
    if (!next) throw new Error("Unexpected Herdr call");
    if (group === "workspace") signalController?.abort();
    return next;
  };
  return { git, herdr, paths: { realpath: fs.realpath, lstat: fs.lstat, access: fs.access }, env: {} };
}

afterEach(async () => {
  for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("returns no match when Herdr has no workspaces", async () => {
  const { repository } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const inventory = await inventoryHerdr(repository, dependencies([workspaceList([])], calls));
  expect(selectWorkspace(inventory)).toBeUndefined();
  expect(calls).toEqual([["workspace", { action: "list" }]]);
});

it("matches root and linked-worktree pane CWDs to one canonical repository", async () => {
  const { repository, linked } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const inventory = await inventoryHerdr(repository, dependencies([
    workspaceList(["wE"]),
    paneList("wE", [{ pane_id: "wE:p1", cwd: repository.repoRoot }, { pane_id: "wE:p2", cwd: linked }]),
  ], calls));
  expect(selectWorkspace(inventory)).toEqual({ workspaceId: "wE", paneIds: ["wE:p1", "wE:p2"], canonicalRepoRoot: repository.repoRoot });
  expect(calls).toEqual([["workspace", { action: "list" }], ["pane", { action: "list", workspaceId: "wE" }]]);
});

it("ignores unrelated workspaces and records missing or non-git pane paths", async () => {
  const { repository } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-unrelated-")); cleanup.push(outside);
  const inventory = await inventoryHerdr(repository, dependencies([
    workspaceList(["w1", "w2"]),
    paneList("w1", [{ pane_id: "w1:p1", cwd: outside }]),
    paneList("w2", [{ pane_id: "w2:p1", cwd: path.join(outside, "missing") }]),
  ], calls));
  expect(selectWorkspace(inventory)).toBeUndefined();
  expect(inventory.violations).toHaveLength(2);
  expect(inventory.violations[0]).toContain("w1:p1");
});

it("fails closed when two workspace IDs map to the same canonical repository", async () => {
  const { repository, linked } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = [];
  const inventory = await inventoryHerdr(repository, dependencies([
    workspaceList(["wJ", "wE"]),
    paneList("wJ", [{ pane_id: "wJ:p1", cwd: linked }]),
    paneList("wE", [{ pane_id: "wE:p1", cwd: repository.repoRoot }]),
  ], calls));
  expect(() => selectWorkspace(inventory)).toThrow(/wE.*wJ/);
  try { selectWorkspace(inventory); } catch (error) { expect(error).toMatchObject({ code: "workspace_ambiguous" }); }
});

it("rejects malformed or truncated topology results", async () => {
  const { repository } = await makeRepo();
  await expect(inventoryHerdr(repository, dependencies([result("workspace", "list", { workspaces: "bad" })], []))).rejects.toMatchObject({ code: "herdr_failed" });
  await expect(inventoryHerdr(repository, dependencies([result("workspace", "list", { type: "workspace_list", workspaces: [] }, true)], []))).rejects.toMatchObject({ code: "herdr_failed" });
  await expect(inventoryHerdr(repository, dependencies([workspaceList(["w1"]), result("pane", "list", { panes: "bad" })], []))).rejects.toMatchObject({ code: "herdr_failed" });
});

it("stops after cancellation between workspace and pane inventory", async () => {
  const { repository } = await makeRepo(); const calls: Array<[string, Record<string, unknown>]> = []; const controller = new AbortController();
  await expect(inventoryHerdr(repository, dependencies([workspaceList(["w1"]), paneList("w1", [])], calls, controller), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(calls).toEqual([["workspace", { action: "list" }]]);
});
