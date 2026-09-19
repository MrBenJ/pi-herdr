import type { ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { beforeEach, expect, it, vi } from "vitest";
import { HERDR_AGENT_KINDS } from "../src/contracts.ts";
import type { Runner } from "../src/contracts.ts";
import orchestrator, { TaskSchema, validateTaskInput } from "../src/orchestrator/index.ts";
import { inspectTask, launchTask } from "../src/orchestrator/launch.ts";
import { createRunner } from "../src/transport/runner.ts";
import { registrationHarness } from "./support/harness.ts";

vi.mock("../src/transport/runner.ts", () => ({ createRunner: vi.fn() }));
vi.mock("../src/orchestrator/launch.ts", () => ({ inspectTask: vi.fn(), launchTask: vi.fn() }));

const launchInput = { action: "launch" as const, repoRoot: "/repo", worktreeName: "x", branch: "feat/x", baseRef: "main", tabLabel: "x", agentName: "worker", agentKind: "pi" as const, prompt: "work", args: [] };
const launchResult = { action: "launch" as const, repository: { repoRoot: "/repo", gitCommonDir: "/repo/.git", defaultBranch: "main", worktreeRoot: "/repo/.worktrees" }, resources: { worktree: { path: "/repo/.worktrees/x", branch: "feat/x", head: "abc", disposition: "created" as const }, workspace: { workspaceId: "wE", disposition: "existing" as const }, tab: { tabId: "wE:t2", paneId: "wE:p2" }, agent: { name: "worker", paneId: "wE:p2" }, promptSubmitted: true }, inventory: { worktrees: [] }, violations: [] };
const inspectResult = { action: "inspect" as const, repository: launchResult.repository, resources: { promptSubmitted: false }, inventory: { worktrees: [{ path: "/repo", branch: "main", head: "abc123", detached: false }, { path: "/repo/.worktrees/x", branch: "feat/x", head: "def456", detached: false }], workspace: { workspaceId: "wG", paneIds: ["wG:p1"], canonicalRepoRoot: "/repo" } }, violations: [] };

beforeEach(() => {
  vi.mocked(createRunner).mockReset();
  vi.mocked(createRunner).mockReturnValue({ run: vi.fn<Runner>(), dispose: vi.fn(async () => {}) });
  vi.mocked(launchTask).mockReset();
  vi.mocked(launchTask).mockResolvedValue(launchResult);
  vi.mocked(inspectTask).mockReset();
  vi.mocked(inspectTask).mockResolvedValue(inspectResult);
});

it("exports the one frozen Herdr agent-kind list", () => {
  expect(HERDR_AGENT_KINDS).toContain("pi");
  expect(HERDR_AGENT_KINDS).toContain("claude");
  expect(new Set(HERDR_AGENT_KINDS).size).toBe(HERDR_AGENT_KINDS.length);
  expect(Object.isFrozen(HERDR_AGENT_KINDS)).toBe(true);
});

it("registers only the orchestration tool and its policy hooks", () => {
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  expect([...harness.tools.keys()]).toEqual(["herdr_task"]);
  expect(harness.handlers.get("tool_call")).toHaveLength(1);
  expect(harness.handlers.get("session_shutdown")).toHaveLength(1);
  expect(harness.tools.get("herdr_task")?.description).toContain(".worktrees/<name>");
});

it("publishes a strict schema without caller topology handles", () => {
  expect(Value.Check(TaskSchema, { action: "inspect", repoRoot: "/repo" })).toBe(true);
  expect(Value.Check(TaskSchema, { action: "inspect", repoRoot: "/repo", workspaceId: "wE" })).toBe(false);
  expect(Value.Check(TaskSchema, { action: "launch", repoRoot: "/repo", worktreeName: "x", branch: "feat/x", baseRef: "main", tabLabel: "x", agentName: "worker", agentKind: "pi", prompt: "work", args: ["--model", "x"] })).toBe(true);
  expect(Value.Check(TaskSchema, { action: "launch", repoRoot: "/repo", worktreePath: "/tmp/x" })).toBe(false);
  expect(Value.Check(TaskSchema, { action: "launch", repoRoot: "/repo", args: [1] })).toBe(false);
});

it("runtime validation rejects action-inapplicable and missing fields before dependencies", () => {
  expect(() => validateTaskInput({ action: "inspect", repoRoot: "/repo", branch: "x" })).toThrow();
  expect(() => validateTaskInput({ action: "launch", repoRoot: "/repo" })).toThrow();
  expect(() => validateTaskInput({ action: "launch", repoRoot: "/repo", worktreeName: "x", branch: "feat/x", baseRef: "main", tabLabel: "x", agentName: "worker", agentKind: "bogus", prompt: "work" })).toThrow();
});

const grantEnv = { HERDR_ALLOW_WORKSPACES: "1", HERDR_ALLOW_DISPATCH: "1" };

it("honors allow* grants only with a matching operator env var, then passes them through", () => {
  // Schema accepts the booleans (shape only); env enforcement is runtime.
  expect(Value.Check(TaskSchema, { ...launchInput, allowWorkspaces: true, allowDispatch: true })).toBe(true);
  expect(Value.Check(TaskSchema, { ...launchInput, allowWorkspaces: "yes" })).toBe(false);
  // Payload grant + operator env -> passes through.
  expect(validateTaskInput({ ...launchInput, allowWorkspaces: true, allowDispatch: true }, grantEnv)).toMatchObject({ allowWorkspaces: true, allowDispatch: true });
  expect(validateTaskInput({ ...launchInput, allowWorkspaces: true }, { HERDR_ALLOW_WORKSPACES: "1" })).toMatchObject({ allowWorkspaces: true });
  // CORE PROPERTY: a caller-supplied grant WITHOUT the operator env is rejected,
  // so untrusted task text steering the tool caller cannot escalate.
  expect(() => validateTaskInput({ ...launchInput, allowWorkspaces: true }, {})).toThrow(/HERDR_ALLOW_WORKSPACES/);
  expect(() => validateTaskInput({ ...launchInput, allowWorkspaces: true })).toThrow(/HERDR_ALLOW_WORKSPACES/);
  expect(() => validateTaskInput({ ...launchInput, allowDispatch: true }, { HERDR_ALLOW_WORKSPACES: "1" })).toThrow(/HERDR_ALLOW_DISPATCH/);
  // Absent or explicit-false grants need no env and never appear on the output.
  const bare = validateTaskInput(launchInput, grantEnv);
  expect(bare).not.toHaveProperty("allowWorkspaces");
  expect(bare).not.toHaveProperty("allowDispatch");
  expect(validateTaskInput({ ...launchInput, allowWorkspaces: false }, {})).not.toHaveProperty("allowWorkspaces");
  // Type and action guards still apply.
  expect(() => validateTaskInput({ ...launchInput, allowDispatch: "true" }, grantEnv)).toThrow(/boolean/);
  expect(() => validateTaskInput({ action: "inspect", repoRoot: "/repo", allowWorkspaces: true }, grantEnv)).toThrow();
});

it("rejects a concurrent launch within one extension instance", async () => {
  let release!: (value: typeof launchResult) => void;
  vi.mocked(launchTask).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  const tool = harness.tools.get("herdr_task")!;
  const context = { cwd: "/repo" } as ExtensionContext;
  const first = tool.execute("first", launchInput, undefined, undefined, context);
  await Promise.resolve();
  await expect(tool.execute("second", launchInput, undefined, undefined, context)).rejects.toThrow(/launch.*progress/i);
  expect(launchTask).toHaveBeenCalledTimes(1);
  release(launchResult);
  await expect(first).resolves.toMatchObject({ details: { action: "launch" } });
});

it("makes the complete inspect inventory visible in tool text", async () => {
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  const result = await harness.tools.get("herdr_task")!.execute("inspect", { action: "inspect", repoRoot: "/repo" }, undefined, undefined, { cwd: "/repo" } as ExtensionContext);
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  expect(text).toContain("Repository: /repo");
  expect(text).toContain("Workspace: wG");
  expect(text).toContain("Panes: wG:p1");
  expect(text).toContain("/repo [main] @ abc123");
  expect(text).toContain("/repo/.worktrees/x [feat/x] @ def456");
  expect(text).toContain("Violations: none");
});

it("separate instances dispose only their own runner and never remote resources", async () => {
  const first = { run: vi.fn<Runner>(), dispose: vi.fn(async () => {}) };
  const second = { run: vi.fn<Runner>(), dispose: vi.fn(async () => {}) };
  vi.mocked(createRunner).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const a = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  const b = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(a.api); orchestrator(b.api);
  const event = { type: "session_shutdown", reason: "reload" } as SessionShutdownEvent;
  const context = { cwd: "/tmp" } as ExtensionContext;
  await a.shutdown[0]!(event, context); await a.shutdown[0]!(event, context);
  expect(first.dispose).toHaveBeenCalledTimes(2);
  expect(second.dispose).not.toHaveBeenCalled();
  expect(first.run).not.toHaveBeenCalled();
});

const profiledInput = { ...launchInput, piProfile: "dj-league" };

it("accepts an optional logical Pi profile only for Pi workers", () => {
  expect(Value.Check(TaskSchema, profiledInput)).toBe(true);
  expect(validateTaskInput(profiledInput)).toMatchObject({ agentKind: "pi", piProfile: "dj-league" });
  expect(validateTaskInput(launchInput)).not.toHaveProperty("piProfile");
  for (const agentKind of HERDR_AGENT_KINDS.filter(kind => kind !== "pi")) {
    expect(() => validateTaskInput({ ...profiledInput, agentKind })).toThrow(/piProfile/);
  }
  expect(() => validateTaskInput({ action: "inspect", repoRoot: "/repo", piProfile: "work" })).toThrow();
});

it("rejects unsafe profile names and launcher-shaped fields before dependencies", async () => {
  const unsafe = ["", " ", "two words", "work ", "Work", "-work", "../work", "./work", "/usr/bin/env", "a/b", "a\\b", "~", "work;id", "work&&id", "work|id", "$(id)", "`id`", "$HOME", "FOO=bar", "FOO=bar pi", "work\nid", "work\0", "a".repeat(65), 7, null, ["work"], { name: "work" }];
  for (const piProfile of unsafe) {
    expect(Value.Check(TaskSchema, { ...launchInput, piProfile }), JSON.stringify(piProfile)).toBe(false);
    expect(() => validateTaskInput({ ...launchInput, piProfile }), JSON.stringify(piProfile)).toThrow(/piProfile/);
  }
  for (const piProfile of ["recover", "create", "list", "config", "help", "version", "nul", "work-", "a--b"]) {
    expect(() => validateTaskInput({ ...launchInput, piProfile }), piProfile).toThrow(/piProfile/);
  }
  for (const field of ["command", "executable", "shell", "launcher", "env", "piProfilePath"]) {
    expect(() => validateTaskInput({ ...launchInput, [field]: "pi-profile work" })).toThrow();
    expect(Value.Check(TaskSchema, { ...launchInput, [field]: "pi-profile work" })).toBe(false);
  }
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  await expect(harness.tools.get("herdr_task")!.execute("bad", { ...launchInput, piProfile: "work; id" }, undefined, undefined, { cwd: "/repo" } as ExtensionContext)).rejects.toThrow(/invalid_input/);
  expect(launchTask).not.toHaveBeenCalled();
});

it("rejects a profiled launch whose launcher command would exceed the bounded size", () => {
  expect(() => validateTaskInput({ ...profiledInput, args: ["x".repeat(64 * 1024)] })).toThrow(/args/);
  expect(validateTaskInput({ ...launchInput, args: ["x".repeat(64 * 1024)] })).toMatchObject({ action: "launch" });
});

it("does not echo a rejected profile value in the public error", () => {
  try { validateTaskInput({ ...launchInput, piProfile: "SECRET=hunter2 pi" }); expect.unreachable(); }
  catch (error) { expect((error as Error).message).not.toContain("hunter2"); }
});

it("documents the profile field in the tool description and guidelines", () => {
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  const tool = harness.tools.get("herdr_task")!;
  expect(tool.description).toContain("piProfile");
  expect(tool.promptGuidelines?.join("\n")).toMatch(/piProfile.*args|args.*piProfile/s);
});
