import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { GitRunner, OrchestratorDependencies } from "../src/orchestrator/contracts.ts";
import { guardToolCall } from "../src/orchestrator/guards.ts";

const exec = promisify(execFile);
const cleanup: string[] = [];
const git: GitRunner = async (command, args, options) => {
  try { const out = await exec(command, args, { cwd: options.cwd, timeout: options.deadlineMs }); return { code: 0, stdout: out.stdout, stderr: out.stderr }; }
  catch (error) { const failure = error as Error & { code?: number; stdout?: string; stderr?: string }; return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message }; }
};
async function repo() {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "pi-herdr-guard-")); cleanup.push(created); const root = await fs.realpath(created);
  await exec("git", ["init", "-b", "main"], { cwd: root }); await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root }); await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, ".gitignore"), "/.worktrees/\n"); await fs.writeFile(path.join(root, "README.md"), "x\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "initial"], { cwd: root });
  const linked = path.join(root, ".worktrees", "linked"); await exec("git", ["worktree", "add", linked, "-b", "linked"], { cwd: root });
  return { root, linked };
}
afterEach(async () => { for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const dependencies = (): OrchestratorDependencies => ({ git, paths: { realpath: fs.realpath, lstat: fs.lstat, access: fs.access }, env: {}, herdr: async () => { throw new Error("unused"); } });
const event = (toolName: string, input: Record<string, unknown>) => ({ type: "tool_call", toolCallId: "x", toolName, input }) as ToolCallEvent & { input: Record<string, unknown> };

it.each([
  ["herdr_workspace", { action: "create", cwd: "/repo" }],
  ["herdr_tab", { action: "create", workspaceId: "wE", cwd: "/repo" }],
  ["herdr_pane", { action: "split", paneId: "wE:p1", cwd: "/repo", direction: "right" }],
  ["herdr_agent", { action: "start", name: "x", kind: "pi", paneId: "wE:p1" }],
])("blocks direct topology mutation through %s", async (toolName, input) => {
  await expect(guardToolCall(event(toolName as string, input), { cwd: "/repo" }, dependencies())).resolves.toMatchObject({ block: true, reason: expect.stringContaining("herdr_task") });
});

it.each([
  ["herdr_workspace", { action: "list" }], ["herdr_workspace", { action: "close", workspaceId: "wE", confirm: true }],
  ["herdr_tab", { action: "rename", tabId: "wE:t1", label: "x" }], ["herdr_pane", { action: "read", paneId: "wE:p1" }],
  ["herdr_agent", { action: "prompt", target: "x", text: "continue" }], ["herdr_agent", { action: "wait", target: "x" }],
])("allows non-creation primitive call %s", async (toolName, input) => {
  await expect(guardToolCall(event(toolName as string, input), { cwd: "/repo" }, dependencies())).resolves.toBeUndefined();
});

it.each([
  "git worktree add .worktrees/x -b x",
  "git -C /repo worktree add /repo/.worktrees/x -b x",
  "command git worktree move old new",
  "env FOO=1 git worktree remove old",
  "echo safe\ngit worktree add .worktrees/x -b x",
])("blocks direct Bash worktree mutation: %s", async command => {
  await expect(guardToolCall(event("bash", { command }), { cwd: "/repo" }, dependencies())).resolves.toMatchObject({ block: true });
});

it.each(["git worktree list --porcelain", "git status", "printf 'git worktree add'", "rg 'git worktree add' docs"])("allows non-mutating Bash: %s", async command => {
  await expect(guardToolCall(event("bash", { command }), { cwd: "/repo" }, dependencies())).resolves.toBeUndefined();
});

it("requires a prompt for enqueued Todo calls and leaves ordinary Todos unchanged", async () => {
  const { root } = await repo();
  await expect(guardToolCall(event("todo", { action: "add", taskname: "x", tags: ["enqueue"] }), { cwd: root }, dependencies())).resolves.toMatchObject({ block: true });
  const ordinary = event("todo", { action: "add", taskname: "x", description: "track only" });
  await expect(guardToolCall(ordinary, { cwd: root }, dependencies())).resolves.toBeUndefined();
  expect(ordinary.input).toEqual({ action: "add", taskname: "x", description: "track only" });
});

it("rejects foreign absolute paths and appends one idempotent repository boundary from main or linked CWD", async () => {
  const { root, linked } = await repo();
  const foreign = event("todo", { action: "add", taskname: "x", tags: ["enqueue"], prompt: "Read /Users/example/other/plan.md" });
  await expect(guardToolCall(foreign, { cwd: root }, dependencies())).resolves.toMatchObject({ block: true, reason: expect.stringContaining("outside") });

  const local = event("todo", { action: "update", id: "abc", tags: ["enqueue"], prompt: `Read ${root}/README.md and https://example.com/a/b` });
  await expect(guardToolCall(local, { cwd: linked }, dependencies())).resolves.toBeUndefined();
  const once = String(local.input.prompt);
  expect(once).toContain(`Canonical repository: ${root}`);
  expect(once).toContain(`Worktrees: ${root}/.worktrees/<name> only`);
  expect(once.match(/BEGIN REPOSITORY EXECUTION BOUNDARY v1/g)).toHaveLength(1);
  await expect(guardToolCall(local, { cwd: linked }, dependencies())).resolves.toBeUndefined();
  expect(String(local.input.prompt).match(/BEGIN REPOSITORY EXECUTION BOUNDARY v1/g)).toHaveLength(1);
});
