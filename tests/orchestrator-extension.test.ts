import type { ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { beforeEach, expect, it, vi } from "vitest";
import { HERDR_AGENT_KINDS } from "../src/contracts.ts";
import type { Runner } from "../src/contracts.ts";
import orchestrator, { TaskSchema, validateTaskInput } from "../src/orchestrator/index.ts";
import { launchTask } from "../src/orchestrator/launch.ts";
import { createRunner } from "../src/transport/runner.ts";
import { registrationHarness } from "./support/harness.ts";

vi.mock("../src/transport/runner.ts", () => ({ createRunner: vi.fn() }));
vi.mock("../src/orchestrator/launch.ts", () => ({ inspectTask: vi.fn(), launchTask: vi.fn() }));

const launchInput = { action: "launch" as const, repoRoot: "/repo", worktreeName: "x", branch: "feat/x", baseRef: "main", tabLabel: "x", agentName: "worker", agentKind: "pi" as const, prompt: "work", args: [] };
const launchResult = { action: "launch" as const, repository: { repoRoot: "/repo", gitCommonDir: "/repo/.git", defaultBranch: "main", worktreeRoot: "/repo/.worktrees" }, resources: { worktree: { path: "/repo/.worktrees/x", branch: "feat/x", head: "abc", disposition: "created" as const }, workspace: { workspaceId: "wE", disposition: "existing" as const }, tab: { tabId: "wE:t2", paneId: "wE:p2" }, agent: { name: "worker", paneId: "wE:p2" }, promptSubmitted: true }, inventory: { worktrees: [] }, violations: [] };

beforeEach(() => {
  vi.mocked(createRunner).mockReset();
  vi.mocked(createRunner).mockReturnValue({ run: vi.fn<Runner>(), dispose: vi.fn(async () => {}) });
  vi.mocked(launchTask).mockReset();
  vi.mocked(launchTask).mockResolvedValue(launchResult);
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
