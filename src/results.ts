import fs from "node:fs/promises";
import { dirname } from "node:path";
import type { Capture, Details, Failure, FailureKind, Json, Operation, RunResult, ToolResult } from "./contracts.ts";
import { formatFailure } from "./errors.ts";
import { present } from "./transport/capture.ts";

const PARSE_BYTES = 1024 * 1024;
const PRESENT_BYTES = 51200;
const PRESENT_LINES = 2000;
class ResponseTooLarge extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
function errorEnvelope(value: unknown): { code: string; message: string } | undefined {
  if (!record(value) || typeof value.id !== "string" || "result" in value || !record(value.error)) return;
  if (typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { code: value.error.code, message: value.error.message };
  }
}
export function remoteOutcome(op: Operation, spawned: boolean): Failure["remoteOutcome"] {
  return !spawned ? "not_attempted" : op.mutation ? "unknown" : "not_applicable";
}
async function paths(run: RunResult): Promise<Pick<Details, "stdoutPath" | "stderrPath">> {
  const result: Pick<Details, "stdoutPath" | "stderrPath"> = {};
  await Promise.all((["stdout", "stderr"] as const).map(async stream => {
    try { if ((await fs.stat(run[stream].path)).isFile()) result[`${stream}Path`] = run[stream].path; } catch { /* absent artifacts are not advertised */ }
  }));
  return result;
}
async function fail(op: Operation, run: RunResult, kind: FailureKind, message: string, herdrCode?: string): Promise<never> {
  throw formatFailure({ kind, message, remoteOutcome: remoteOutcome(op, run.spawned), exitCode: run.exitCode, ...(herdrCode === undefined ? {} : { herdrCode }), ...await paths(run) }, op.sensitive);
}
async function readBounded(capture: Capture): Promise<string> {
  if (capture.bytes > PARSE_BYTES) throw new ResponseTooLarge();
  const file = await fs.open(capture.path, "r");
  try {
    // Read at most limit+1 even if an artifact changed since capture finished.
    const buffer = Buffer.alloc(PARSE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > PARSE_BYTES) throw new ResponseTooLarge();
    return buffer.subarray(0, offset).toString("utf8");
  } finally { await file.close(); }
}
async function responseText(op: Operation, run: RunResult, capture: Capture): Promise<string> {
  try { return await readBounded(capture); } catch (error) {
    return fail(op, run, error instanceof ResponseTooLarge ? "response_too_large" : "transport_failed",
      error instanceof ResponseTooLarge ? "CLI response exceeds the 1 MiB parsing limit; inspect the private artifact." : "Could not read the captured CLI response.");
  }
}
async function herdrFailure(op: Operation, run: RunResult, error: { code: string; message: string }): Promise<never> {
  const kind = error.code === "server_not_running" ? "server_unavailable" : error.code === "timeout" ? "timeout" : "operation_failed";
  return fail(op, run, kind, error.message, error.code);
}
const requiredHandles: Record<string, ReadonlyArray<readonly [string, string]>> = {
  "workspace/create": [["workspace", "workspace_id"], ["tab", "tab_id"], ["root_pane", "pane_id"]],
  "tab/create": [["tab", "tab_id"], ["root_pane", "pane_id"]],
  "pane/split": [["pane", "pane_id"]],
  "agent/start": [["agent", "pane_id"]],
};
function hasHandles(op: Operation, result: Record<string, unknown>): boolean {
  return (requiredHandles[`${op.group}/${op.action}`] ?? []).every(([field, id]) => {
    const value = result[field];
    return record(value) && typeof value[id] === "string" && value[id].length > 0;
  });
}
function tooLong(text: string): boolean {
  if (Buffer.byteLength(text) > PRESENT_BYTES) return true;
  return (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0) > PRESENT_LINES;
}
async function cleanup(run: RunResult): Promise<Pick<Details, "stdoutPath" | "stderrPath">> {
  // Cleanup must never replace a known remote result. Await every deletion;
  // expose only paths that still exist if a filesystem cleanup fails.
  await Promise.allSettled([fs.rm(run.stdout.path, { force: true }), fs.rm(run.stderr.path, { force: true })]);
  await Promise.allSettled([...new Set([dirname(run.stdout.path), dirname(run.stderr.path)])].map(path => fs.rmdir(path)));
  return paths(run);
}

export async function normalize(op: Operation, run: RunResult): Promise<ToolResult> {
  if (run.stop) return fail(op, run, run.stop, `Local CLI stopped: ${run.stop}. Captures may be partial; no remote rollback is implied.`);
  if (!run.spawned || !run.stdout.complete || !run.stderr.complete || run.stdout.ioFailed || run.stderr.ioFailed) {
    return fail(op, run, "transport_failed", "The CLI response capture is incomplete.");
  }

  const diagnostic = parse(await responseText(op, run, run.stderr));
  const stderrError = errorEnvelope(diagnostic);
  if (stderrError) return herdrFailure(op, run, stderrError);

  let result: Record<string, unknown> | undefined;
  if (op.output === "json") {
    const envelope = parse(await responseText(op, run, run.stdout));
    const stdoutError = errorEnvelope(envelope);
    if (stdoutError) return herdrFailure(op, run, stdoutError);
    if (run.exitCode !== 0) return fail(op, run, run.exitCode === 2 ? "invalid_input" : "operation_failed", "Herdr CLI exited unsuccessfully; inspect private diagnostics.");
    if (!record(envelope) || typeof envelope.id !== "string" || "error" in envelope || !record(envelope.result) || !hasHandles(op, envelope.result)) {
      return fail(op, run, "malformed_output", "Herdr returned an invalid success envelope or missing creation handle.");
    }
    result = { ...envelope.result };
    if (op.group === "agent" && op.action === "start") delete result.argv;
  } else if (run.exitCode !== 0) {
    return fail(op, run, run.exitCode === 2 ? "invalid_input" : "operation_failed", "Herdr CLI exited unsuccessfully; inspect private diagnostics.");
  }

  const text = result === undefined ? run.stdout.preview : `${op.group}/${op.action} result\n${JSON.stringify(result, null, 2)}`;
  const details: Details = { group: op.group, action: op.action, truncated: run.stdout.truncated || tooLong(text) };
  if (result !== undefined) {
    // Reserve metadata/path overhead too, not just the result's own JSON.
    const candidate = { ...details, result, stdoutPath: run.stdout.path, stderrPath: run.stderr.path };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= PRESENT_BYTES) details.result = result as Json;
    else { details.resultOmitted = true; details.truncated = true; }
  }
  const keep = details.truncated || run.stderr.bytes > 0;
  const retained = keep ? await paths(run) : await cleanup(run);
  Object.assign(details, retained);
  if (keep && !retained.stdoutPath) return fail(op, run, "transport_failed", "The full captured output is no longer available.");
  // Text reads within bounds are returned literally, with no summary wrapper
  // and no duplicate potentially-large output in details.
  const notice = details.truncated ? `Output truncated. Full output: ${retained.stdoutPath}` : "";
  return { content: [{ type: "text", text: present(text, notice) }], details };
}
