import type { Failure } from "./contracts.ts";

const MAX_BYTES = 51200;
const MESSAGE_CHARS = 4096;
const BASE_BYTES = MAX_BYTES - 6 * MESSAGE_CHARS;
const NOTICE = " [truncated]";

function clipped(text: string, chars: number): string {
  if (text.length <= chars) return text;
  let prefix = text.slice(0, chars - NOTICE.length);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + NOTICE;
}
function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

function bounded(failure: Failure): Failure {
  const result: Failure = { kind: failure.kind, remoteOutcome: failure.remoteOutcome, message: "" };
  if (failure.exitCode !== undefined) result.exitCode = failure.exitCode;
  if (failure.herdrCode !== undefined) result.herdrCode = clipped(failure.herdrCode, 256);
  // Preserve paths exactly or omit them; truncating a path invents a location.
  for (const key of ["stdoutPath", "stderrPath"] as const) {
    const path = failure[key];
    if (path !== undefined && path.length <= MAX_BYTES && size({ ...result, [key]: path }) <= BASE_BYTES) result[key] = path;
  }
  // JSON can escape each UTF16 code unit to six ASCII bytes. Reserve that
  // worst case before serialization, so even NUL-heavy messages stay valid
  // bounded JSON instead of being byte-truncated into a malformed envelope.
  result.message = clipped(failure.message, MESSAGE_CHARS);
  return result;
}

export class HerdrToolError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    const safe = bounded(failure);
    super(JSON.stringify(safe));
    this.name = "HerdrToolError";
    this.failure = safe;
  }
}

export function redact(message: string, sensitive: string[]): string {
  return [...new Set(sensitive.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .reduce((text, value) => text.split(value).join("[redacted]"), message);
}
export function formatFailure(failure: Failure, sensitive: string[]): HerdrToolError {
  return new HerdrToolError({
    ...failure,
    message: redact(failure.message, sensitive),
    ...(failure.herdrCode === undefined ? {} : { herdrCode: redact(failure.herdrCode, sensitive) }),
  });
}
