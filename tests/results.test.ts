import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { compileAgent } from "../src/actions/agent.ts";
import { compilePane } from "../src/actions/pane.ts";
import { compileTab } from "../src/actions/tab.ts";
import { compileWorkspace } from "../src/actions/workspace.ts";
import type { Failure, FailureKind, Operation, RunResult } from "../src/contracts.ts";
import { HerdrToolError, redact } from "../src/errors.ts";
import { normalize } from "../src/results.ts";
import { captured, cleanupCaptured } from "./support/harness.ts";
import { createdPane, createdTab, createdWorkspace, startedAgent, blockedError } from "./support/fixtures.ts";

const runs: RunResult[] = [];
async function capture(stdout: string, stderr = "", exitCode = 0) {
  const run = await captured(stdout, stderr, exitCode); runs.push(run); return run;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(runs.splice(0).map(cleanupCaptured)); });
const list = () => compileWorkspace({ action: "list" });
const create = () => compileTab({ action: "create", workspaceId: "w91", cwd: "/tmp/fixture" });
async function failure(operation: Operation, run: RunResult, kind: FailureKind, outcome: Failure["remoteOutcome"]): Promise<Failure> {
  try { await normalize(operation, run); } catch (error) {
    expect(error).toBeInstanceOf(HerdrToolError);
    const text = (error as Error).message;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(51200);
    const result = JSON.parse(text) as Failure;
    expect(result).toMatchObject({ kind, remoteOutcome: outcome });
    expect(result.stdoutPath).toBe(run.stdout.path); expect(result.stderrPath).toBe(run.stderr.path);
    await expect(fs.stat(run.stdout.path)).resolves.toBeDefined();
    await expect(fs.stat(run.stderr.path)).resolves.toBeDefined();
    return result;
  }
  throw new Error("Expected a thrown tool failure, not a success result");
}
it.each([
  { name: "workspace", op: () => compileWorkspace({ action: "create", cwd: "/tmp/fixture" }), fixture: createdWorkspace },
  { name: "tab", op: create, fixture: createdTab },
  { name: "pane", op: () => compilePane({ action: "split", paneId: "w91:p1", cwd: "/tmp/fixture", direction: "right" }), fixture: createdPane },
])("preserves actual $name creation handles and removes small successful captures", async ({ op, fixture }) => {
  const run = await capture(JSON.stringify(fixture)); const result = await normalize(op(), run);
  expect(result.details.result).toEqual(fixture.result);
  expect(result.content[0]?.text).toContain("w91:p63");
  expect(result.details.truncated).toBe(false);
  await expect(fs.stat(run.stdout.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(run.stderr.path)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([
  { op: () => compileWorkspace({ action: "create", cwd: "/tmp" }), result: { workspace: {}, tab: createdTab.result.tab, root_pane: createdTab.result.root_pane } },
  { op: create, result: { tab: createdTab.result.tab } },
  { op: create, result: { tab: { tab_id: "" }, root_pane: createdTab.result.root_pane } },
  { op: () => compilePane({ action: "split", paneId: "w91:p1", cwd: "/tmp", direction: "down" }), result: { pane: {} } },
  { op: () => compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w91:p63" }), result: { agent: {} } },
])("rejects missing/empty creation handles rather than inventing IDs ($result)", async ({ op, result }) => {
  await failure(op(), await capture(JSON.stringify({ id: "fixture", result })), "malformed_output", "unknown");
});
it.each(["", "plain text\n", '{"id":"looks-like-cli","result":{"text":"terminal content"}}', '{"id":"terminal","error":{"code":"timeout","message":"not an actual error"}}', "\x1b[31mANSI\x1b[0m\n"])("preserves text reads literally: %j", async text => {
  const run = await capture(text);
  const result = await normalize(compilePane({ action: "read", paneId: "w91:p63" }), run);
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(result.details.truncated).toBe(false);
});
it.each(["", "not JSON", "null", "[]", '"text"', '{}', '{"id":"x","result":null}', '{"id":"x","result":[]}', '{"result":{}}'])("rejects a malformed success envelope %s", async text => {
  await failure(list(), await capture(text), "malformed_output", "not_applicable");
});
it.each(["stderr", "stdout"])("surfaces a structured Herdr error from %s even with exit0", async stream => {
  const text = JSON.stringify(blockedError);
  const run = await capture(stream === "stdout" ? text : JSON.stringify({ id: "x", result: {} }), stream === "stderr" ? text : "");
  const result = await failure(create(), run, "operation_failed", "unknown");
  expect(result.herdrCode).toBe("agent_blocked"); expect(result.message).toContain("Agent is blocked");
});
it("rejects a contradictory error+result envelope", async () => {
  const run = await capture(JSON.stringify({ ...blockedError, result: {} }));
  await failure(list(), run, "malformed_output", "not_applicable");
});
it("nonzero exit wins over apparently successful stdout", async () => {
  await failure(create(), await capture(JSON.stringify(createdTab), "diagnostic", 1), "operation_failed", "unknown");
});
it("unstructured exit2 is invalid_input, not an inferred server failure", async () => {
  await failure(list(), await capture("", "server_not_running in arbitrary English", 2), "invalid_input", "not_applicable");
});
it.each([
  ["server_not_running", "server_unavailable"], ["timeout", "timeout"], ["agent_not_ready", "operation_failed"], ["agent_prompt_stalled", "operation_failed"],
] as const)("maps Herdr code %s without inventing rollback", async (code, kind) => {
  const result = await failure(compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w91:p63" }), await capture("", JSON.stringify({ id: "x", error: { code, message: "diagnostic" } }), 1), kind, "unknown");
  expect(result.herdrCode).toBe(code);
});
it.each(["timeout", "cancelled", "resource_limit", "transport_failed"] as const)("local %s wins before parsing partial or oversized captures", async stop => {
  const run = await capture("x".repeat(1024 * 1024 + 1), JSON.stringify(blockedError), 1);
  run.stop = stop; run.stdout.complete = false; run.stderr.complete = false;
  await failure(create(), run, stop, "unknown");
});
it("read-only local failures have not_applicable outcome", async () => {
  const run = await capture("partial"); run.stop = "cancelled";
  await failure(compileAgent({ action: "wait", target: "reviewer" }), run, "cancelled", "not_applicable");
});
it.each(["idle", "done", "blocked", "unknown"])("preserves lifecycle state %s without inventing task completion", async state => {
  const result = { type: "agent_waited", state };
  const normalized = await normalize(compileAgent({ action: "wait", target: "reviewer" }), await capture(JSON.stringify({ id: "fixture", result })));
  expect(normalized.details.result).toEqual(result);
});
it("omits agent-start argv from both text and structured details", async () => {
  const result = await normalize(compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w91:p63" }), await capture(JSON.stringify(startedAgent)));
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(result.details.result).toEqual({ type: "agent_started", agent: startedAgent.result.agent });
});
it("redacts exact sensitive reflected values before truncation, including large multiline messages", async () => {
  const secret = "SECRET-PREFIX\n\"" + "x".repeat(60000);
  const op = compileAgent({ action: "prompt", target: "reviewer", text: secret });
  const run = await capture("", JSON.stringify({ id: "x", error: { code: "agent_prompt_stalled", message: `Could not send ${secret}` } }), 1);
  const result = await failure(op, run, "operation_failed", "unknown");
  expect(result.message).toContain("[redacted]"); expect(JSON.stringify(result)).not.toContain("SECRET-PREFIX");
});
it("omits oversized structured details while preserving bounded content and actual artifact paths", async () => {
  const run = await capture(JSON.stringify({ id: "x", result: { text: "🦙".repeat(20000) } }));
  const result = await normalize(list(), run);
  expect(result.details.result).toBeUndefined(); expect(result.details.resultOmitted).toBe(true);
  expect(result.details.stdoutPath).toBe(run.stdout.path);
  expect(result.details.truncated).toBe(true);
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(51200);
  expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(51200);
  expect(result.content[0]!.text).toContain(run.stdout.path);
  await expect(fs.stat(run.stdout.path)).resolves.toBeDefined();
});
it("rejects JSON beyond1MiB but allows large text reads with bounded previews", async () => {
  const text = JSON.stringify({ id: "x", result: { text: "x".repeat(1024 * 1024) } });
  await failure(list(), await capture(text), "response_too_large", "not_applicable");
  const run = await capture(text);
  const result = await normalize(compilePane({ action: "read", paneId: "w91:p63" }), run);
  expect(result.details.truncated).toBe(true);
  expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(51200);
  expect(result.details.stdoutPath).toBe(run.stdout.path);
});
it("bounded artifact reads detect growth beyond the captured counter instead of allocating the whole file", async () => {
  const run = await capture('{"id":"x","result":{}}');
  await fs.writeFile(run.stdout.path, "x".repeat(1024 * 1024 + 1));
  await failure(list(), run, "response_too_large", "not_applicable");
});
it("keeps omitted successful stderr diagnostics without treating them as failure", async () => {
  const run = await capture(JSON.stringify({ id: "x", result: {} }), "warning");
  const result = await normalize(list(), run);
  expect(result.details.result).toEqual({}); expect(result.details.stderrPath).toBe(run.stderr.path);
  await expect(fs.stat(run.stderr.path)).resolves.toBeDefined();
});
it("cleanup failure cannot replace a known remote result with a pre-spawn error", async () => {
  const run = await capture(JSON.stringify(createdTab));
  vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup failure"));
  const result = await normalize(create(), run);
  expect(result.details.result).toEqual(createdTab.result);
});
it("a missing diagnostic file produces sanitized failure without returning its deleted path", async () => {
  const run = await capture(JSON.stringify(createdTab)); await fs.rm(run.stdout.path);
  const error: unknown = await normalize(create(), run).catch(caught => caught);
  expect(error).toBeInstanceOf(HerdrToolError);
  expect(error).toMatchObject({ failure: { kind: "transport_failed", remoteOutcome: "unknown" } });
  expect(JSON.parse((error as Error).message).stdoutPath).toBeUndefined();
});
it("retains the raw artifact when pretty JSON exceeds the line cap but not the byte cap", async () => {
  const result = { items: Array.from({ length: 700 }, (_, i) => ({ id: `w${i}`, n: i })) };
  const run = await capture(JSON.stringify({ id: "fixture", result }));
  expect(run.stdout.truncated).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThan(51200);
  expect(JSON.stringify(result, null, 2).split("\n").length).toBeGreaterThan(2000);
  const output = await normalize(list(), run);
  expect(output.details.truncated).toBe(true);
  expect(output.details.stdoutPath).toBe(run.stdout.path);
  expect(output.content[0]!.text).toContain(run.stdout.path);
  await expect(fs.stat(run.stdout.path)).resolves.toBeDefined();
});
it.each([
  ["stdout incomplete", (run: RunResult) => { run.stdout.complete = false; }],
  ["stderr incomplete", (run: RunResult) => { run.stderr.complete = false; }],
  ["stdout I/O failure", (run: RunResult) => { run.stdout.ioFailed = true; }],
  ["stderr I/O failure", (run: RunResult) => { run.stderr.ioFailed = true; }],
  ["unspawned", (run: RunResult) => { run.spawned = false; }],
] as const)("rejects %s without a stop even if captured JSON is valid", async (_name, damage) => {
  for (const op of [create(), list()]) {
    const run = await capture(JSON.stringify(createdTab)); damage(run);
    expect(run.stop).toBeUndefined();
    await failure(op, run, "transport_failed", !run.spawned ? "not_attempted" : op.mutation ? "unknown" : "not_applicable");
  }
});
it("oversized stderr is a deliberate bounded-response failure, not silent ignored diagnostics", async () => {
  await failure(create(), await capture(JSON.stringify(createdTab), "warning".repeat(160000)), "response_too_large", "unknown");
});
it("a mutation exit2 remains unknown after the CLI has spawned", async () => {
  await failure(create(), await capture("", "invalid arguments", 2), "invalid_input", "unknown");
});
it("redacts longest overlapping values first, ignores empty values, and deduplicates", () => {
  expect(redact("abc ab", ["ab", "abc", "", "abc"])).toBe("[redacted] [redacted]");
});
it("bounds all typed failures, including compiler errors and JSON-escaped control characters", () => {
  let error: unknown;
  try { compileTab({ action: "x".repeat(60000) }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(HerdrToolError);
  expect(Buffer.byteLength((error as Error).message)).toBeLessThanOrEqual(51200);
  expect(JSON.parse((error as Error).message).kind).toBe("invalid_input");
  const typed = new HerdrToolError({ kind: "operation_failed", remoteOutcome: "unknown", message: "\0".repeat(60000), herdrCode: "x".repeat(60000), stdoutPath: "/" + "a".repeat(60000) });
  expect(Buffer.byteLength(typed.message)).toBeLessThanOrEqual(51200);
  expect(JSON.parse(typed.message)).toEqual(typed.failure);
});
