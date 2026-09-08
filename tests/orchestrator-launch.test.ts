import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { HerdrToolError } from "../src/errors.ts";
import type { GitRunner, HerdrExecutor, OrchestratorDependencies, TaskLaunchInput } from "../src/orchestrator/contracts.ts";
import { inspectTask, launchTask } from "../src/orchestrator/launch.ts";

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

function deps(queue: Array<ReturnType<typeof tool> | Error>, calls: Array<[string, Record<string, unknown>]>): OrchestratorDependencies {
  const herdr: HerdrExecutor = async (group, input) => {
    calls.push([group, input]);
    const next = queue.shift();
    if (!next) throw new Error("Unexpected Herdr call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { git, herdr, paths: { realpath: fs.realpath, lstat: fs.lstat, access: fs.access }, env: { HERDR_ENV: "1" } };
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
  expect(calls[2]![1]).toEqual({ action: "create", workspaceId: "wE", cwd: worktree, label: "review", focus: false });
  expect(calls[3]![1]).toEqual({ action: "start", name: "reviewer", kind: "pi", paneId: "wE:p2", args: [] });
  expect(calls[4]![1].text).toContain("Authorized worktree: " + worktree);
});

it("creates one no-focus main-repository workspace only when inventory has no match", async () => {
  const { root } = await makeRepo(false); const calls: Array<[string, Record<string, unknown>]> = [];
  const result = await launchTask(request(root), deps([workspaceList([]), createdWorkspace(), createdTab("wN"), agentResult("agent_started", "wN:p2"), agentResult("agent_prompted", "wN:p2")], calls));
  expect(result.resources.worktree?.disposition).toBe("created");
  expect(result.resources.workspace).toEqual({ workspaceId: "wN", disposition: "created" });
  expect(calls[1]).toEqual(["workspace", { action: "create", cwd: root, label: path.basename(root), focus: false }]);
  expect(calls.filter(([group, input]) => group === "agent" && input.action === "start")).toHaveLength(1);
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
