import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import extension from "../src/index.ts";
import { execute } from "../src/execute.ts";
import { createRunner } from "../src/transport/runner.ts";
import { HerdrToolError } from "../src/errors.ts";
import type { RunResult, Runner } from "../src/contracts.ts";
import { captured, cleanupCaptured, registrationHarness } from "./support/harness.ts";
import { createdTab, startedAgent } from "./support/fixtures.ts";

vi.mock("../src/transport/runner.ts", () => ({ createRunner: vi.fn() }));
const runs: RunResult[] = [];
async function capture(text = '{"id":"fixture","result":{}}'): Promise<RunResult> {
  const run = await captured(text, "", 0); runs.push(run); return run;
}
const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/pi-herdr-fixture-only.sock", HERDR_SESSION: "must-be-removed" };
const context = () => ({ cwd: "/tmp", env });
beforeEach(() => {
  vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_SOCKET_PATH", env.HERDR_SOCKET_PATH); vi.stubEnv("HERDR_SESSION", undefined);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.mocked(createRunner).mockReset();
  await Promise.all(runs.splice(0).map(cleanupCaptured));
});

it.each(["workspace", "tab", "pane"] as const)("rejects %s close before transport without confirm", async group => {
  const run = vi.fn<Runner>();
  await expect(execute(group, { action: "close", [`${group}Id`]: "w9:p7" }, context(), run)).rejects.toMatchObject({ failure: { kind: "invalid_input", remoteOutcome: "not_attempted" } });
  expect(run).not.toHaveBeenCalled();
});
it("fails closed without hosting context before calling transport", async () => {
  const run = vi.fn<Runner>();
  await expect(execute("workspace", { action: "list" }, { cwd: "/tmp", env: {} }, run)).rejects.toMatchObject({ failure: { kind: "missing_host" } });
  expect(run).not.toHaveBeenCalled();
});
it("pre-abort throws cancellation without a runner invocation", async () => {
  const signal = AbortSignal.abort(); const run = vi.fn<Runner>();
  await expect(execute("workspace", { action: "list" }, { ...context(), signal }, run)).rejects.toMatchObject({ failure: { kind: "cancelled", remoteOutcome: "not_attempted" } });
  expect(run).not.toHaveBeenCalled();
});
it("preserves the same typed pre-spawn rejection, including not_attempted for reads", async () => {
  const error = new HerdrToolError({ kind: "missing_executable", message: "Missing", remoteOutcome: "not_attempted" });
  const run = vi.fn<Runner>().mockRejectedValue(error);
  await expect(execute("workspace", { action: "list" }, context(), run)).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
});
it.each([true, false])("maps unexpected runner rejection without leaking raw data (mutation %s)", async mutation => {
  const run = vi.fn<Runner>().mockRejectedValue(new Error("SECRET argv and environment"));
  const pending = execute("tab", mutation ? { action: "create", workspaceId: "w9", cwd: "/tmp" } : { action: "list" }, context(), run);
  await expect(pending).rejects.toMatchObject({ failure: { kind: "transport_failed", remoteOutcome: mutation ? "unknown" : "not_applicable" } });
  await expect(pending).rejects.not.toThrow("SECRET");
  expect(run).toHaveBeenCalledTimes(1);
});
it.each(["timeout", "resource_limit", "transport_failed"] as const)("normalizes a returned %s stop once without retry or remote cleanup", async stop => {
  const result = await capture("partial"); result.stop = stop; result.stdout.complete = false;
  const run = vi.fn<Runner>().mockResolvedValue(result);
  await expect(execute("tab", { action: "create", workspaceId: "w9", cwd: "/tmp" }, context(), run)).rejects.toMatchObject({ failure: { kind: stop, remoteOutcome: "unknown", stdoutPath: result.stdout.path } });
  expect(run).toHaveBeenCalledTimes(1);
});
it("read-only returned stops remain not_applicable", async () => {
  const result = await capture(); result.stop = "cancelled";
  const run = vi.fn<Runner>().mockResolvedValue(result);
  await expect(execute("pane", { action: "read", paneId: "w9:p7" }, context(), run)).rejects.toMatchObject({ failure: { kind: "cancelled", remoteOutcome: "not_applicable" } });
  expect(run).toHaveBeenCalledTimes(1);
});
it("forwards literal argv, cwd and selected environment once", async () => {
  const run = vi.fn<Runner>().mockResolvedValue(await capture(JSON.stringify(createdTab)));
  const signal = new AbortController().signal;
  const result = await execute("tab", { action: "create", workspaceId: "w9", cwd: "/tmp/a b;$(x)", label: "--a\n'b'" }, { ...context(), signal }, run);
  expect(run).toHaveBeenCalledExactlyOnceWith({ executable: "herdr", argv: ["tab", "create", "--workspace", "w9", "--cwd", "/tmp/a b;$(x)", "--label", "--a\n'b'", "--no-focus"], env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH }, cwd: "/tmp", deadlineMs: 30000, signal });
  expect(result.details.result).toEqual(createdTab.result);
  expect(env.HERDR_SESSION).toBe("must-be-removed");
});
it("agent start invokes only start, never layout creation", async () => {
  const run = vi.fn<Runner>().mockResolvedValue(await capture(JSON.stringify(startedAgent)));
  await execute("agent", { action: "start", name: "reviewer", kind: "pi", paneId: "w91:p63" }, context(), run);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0].argv.slice(0, 2)).toEqual(["agent", "start"]);
});
it("blocked responses never trigger automatic keys or another action", async () => {
  const run = vi.fn<Runner>().mockResolvedValue(await capture('{"id":"x","error":{"code":"agent_blocked","message":"approval required"}}'));
  await expect(execute("agent", { action: "prompt", target: "reviewer", text: "hello" }, context(), run)).rejects.toMatchObject({ failure: { herdrCode: "agent_blocked", remoteOutcome: "unknown" } });
  expect(run).toHaveBeenCalledTimes(1);
});
it("registers exactly four discoverable tools and only its own shutdown hook", () => {
  const run = vi.fn<Runner>(); const dispose = vi.fn(async () => {});
  vi.mocked(createRunner).mockReturnValue({ run, dispose });
  const harness = registrationHarness(); extension(harness.api);
  expect([...harness.tools.keys()].sort()).toEqual(["herdr_agent", "herdr_pane", "herdr_tab", "herdr_workspace"]);
  expect(harness.shutdown).toHaveLength(1);
  for (const tool of harness.tools.values()) {
    expect(tool.description.length).toBeGreaterThan(0); expect(tool.promptSnippet?.length).toBeGreaterThan(0);
    expect(tool.promptGuidelines?.some(line => line.includes(tool.name))).toBe(true);
    expect(tool.parameters).toMatchObject({ type: "object" });
  }
  expect(run).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
});
it("each registered closure uses its own group and the third signal, not ctx.signal", async () => {
  const run = vi.fn<Runner>().mockImplementation(() => capture());
  vi.mocked(createRunner).mockReturnValue({ run, dispose: vi.fn(async () => {}) });
  const harness = registrationHarness(); extension(harness.api);
  const signal = new AbortController().signal;
  const ctx = { cwd: "/tmp", signal: AbortSignal.abort() } as unknown as ExtensionContext;
  for (const group of ["workspace", "tab", "pane", "agent"]) {
    const tool = harness.tools.get(`herdr_${group}`)!;
    await tool.execute("fixture", { action: "list" }, signal, undefined, ctx);
    expect(run.mock.lastCall![0].argv).toEqual([group, "list"]);
    expect(run.mock.lastCall![0].signal).toBe(signal);
  }
  signal.throwIfAborted();
  const aborted = AbortSignal.abort();
  await expect(harness.tools.get("herdr_workspace")!.execute("fixture", { action: "list" }, aborted, undefined, ctx)).rejects.toMatchObject({ failure: { kind: "cancelled" } });
  expect(run).toHaveBeenCalledTimes(4);
});
it("separate factory instances shut down only their own runner, with repeat shutdown safe", async () => {
  const first = { run: vi.fn<Runner>(), dispose: vi.fn(async () => {}) };
  const second = { run: vi.fn<Runner>(), dispose: vi.fn(async () => {}) };
  vi.mocked(createRunner).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const a = registrationHarness(); const b = registrationHarness(); extension(a.api); extension(b.api);
  const ctx = { cwd: "/tmp" } as ExtensionContext;
  await a.shutdown[0]!({ type: "session_shutdown", reason: "reload" }, ctx);
  await a.shutdown[0]!({ type: "session_shutdown", reason: "reload" }, ctx);
  expect(first.dispose).toHaveBeenCalledTimes(2); expect(second.dispose).not.toHaveBeenCalled();
  expect(first.run).not.toHaveBeenCalled(); expect(second.run).not.toHaveBeenCalled();
});
