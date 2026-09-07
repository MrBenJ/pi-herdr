import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CaptureLimitError, createCapture as openCapture, present, type CaptureSink } from "../src/transport/capture.ts";

const directories: string[] = [];
const sinks: CaptureSink[] = [];
async function createCapture(...args: Parameters<typeof openCapture>) {
  const sink = await openCapture(...args);
  sinks.push(sink);
  return sink;
}
async function directory() {
  const path = await fs.mkdtemp(join(tmpdir(), "pi-herdr-capture-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(sinks.splice(0).map(sink => sink.finish(false)));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

it.each([
  { name: "empty", text: "", lines: 0, truncated: false },
  { name: "one character", text: "a", lines: 1, truncated: false },
  { name: "trailing newline", text: "a\n", lines: 1, truncated: false },
  { name: "2000 lines", text: "a\n".repeat(2000), lines: 2000, truncated: false },
  { name: "2001 lines", text: "a\n".repeat(2001), lines: 2001, truncated: true },
  { name: "byte boundary", text: "a".repeat(51200), lines: 1, truncated: false },
  { name: "byte overflow", text: "a".repeat(51201), lines: 1, truncated: true },
  { name: "long line", text: "a".repeat(102400), lines: 1, truncated: true },
  { name: "ansi", text: "\x1b[31mred\x1b[0m\n", lines: 1, truncated: false },
  { name: "straddling emoji", text: "a".repeat(51199) + "🦙more", lines: 1, truncated: true },
])("captures $name with persisted-byte counters and bounded presentation", async ({ text, lines, truncated }) => {
  const dir = await directory();
  const sink = await createCapture(dir, "stdout", { remaining: 64 * 1024 * 1024 });
  const bytes = Buffer.from(text);
  await sink.write(bytes);
  const result = await sink.finish(true);
  expect(await fs.readFile(result.path)).toEqual(bytes);
  expect(result.bytes).toBe(bytes.length);
  expect(result.lines).toBe(lines);
  expect(result.complete).toBe(true);
  expect(result.ioFailed).toBe(false);
  expect(result.truncated).toBe(truncated);
  expect(Buffer.byteLength(result.preview)).toBeLessThanOrEqual(51204);
  expect(result.preview).not.toContain("\uFFFD");
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
  const shown = present(result.preview, truncated ? `Full output: ${result.path}` : "");
  expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(51200);
  expect(shown === "" ? 0 : shown.split("\n").length - Number(shown.endsWith("\n"))).toBeLessThanOrEqual(2000);
  if (!truncated) expect(shown).toBe(text);
  else { expect(shown).toContain(result.path); expect(shown.startsWith("a")).toBe(true); }
});

it("preserves a UTF8 character split across chunks while streaming the full artifact", async () => {
  const sink = await createCapture(await directory(), "stdout", { remaining: 1000000 });
  const bytes = Buffer.from("🦙line\n".repeat(10000));
  await sink.write(bytes.subarray(0, 3));
  await sink.write(bytes.subarray(3));
  const result = await sink.finish(true);
  expect(await fs.readFile(result.path)).toEqual(bytes);
  expect(result.preview.startsWith("🦙line\n")).toBe(true);
  expect(result.preview).not.toContain("\uFFFD");
  expect(result.lines).toBe(10000);
  expect(result.truncated).toBe(true);
});

it("reserves the shared budget synchronously across concurrent stdout/stderr writes", async () => {
  const dir = await directory(); const budget = { remaining: 10 };
  const stdout = await createCapture(dir, "stdout", budget);
  const stderr = await createCapture(dir, "stderr", budget);
  const writes = await Promise.allSettled([stdout.write(Buffer.from("12345678")), stderr.write(Buffer.from("abcd"))]);
  expect(writes[0]?.status).toBe("fulfilled");
  expect(writes[1]).toMatchObject({ status: "rejected", reason: expect.any(CaptureLimitError) });
  const [out, err] = await Promise.all([stdout.finish(false), stderr.finish(false)]);
  expect(await fs.readFile(out.path, "utf8")).toBe("12345678");
  expect(await fs.readFile(err.path, "utf8")).toBe("ab");
  expect(out.bytes + err.bytes).toBe(10);
  expect(budget.remaining).toBe(0);
  expect(out.complete || err.complete || out.ioFailed || err.ioFailed).toBe(false);
});

it("allows exact exhaustion but rejects the next nonempty chunk, without losing the prefix", async () => {
  const sink = await createCapture(await directory(), "stdout", { remaining: 2 });
  await sink.write(Buffer.from("ab"));
  await sink.write(Buffer.alloc(0));
  await expect(sink.write(Buffer.from("c"))).rejects.toBeInstanceOf(CaptureLimitError);
  const result = await sink.finish(true);
  expect(result.bytes).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.ioFailed).toBe(false);
});

it("serializes same-sink writes and finish waits for queued data and closes once", async () => {
  const dir = await directory(); const handle = await fs.open(join(dir, "stdout"), "wx", 0o600);
  const close = vi.spyOn(handle, "close");
  vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  const sink = await createCapture(dir, "stdout", { remaining: 100 });
  const writes = [sink.write(Buffer.from("one")), sink.write(Buffer.from("two"))];
  const first = sink.finish(true); const second = sink.finish(false);
  await Promise.all(writes);
  const result = await first;
  expect(await second).toBe(result);
  expect(await fs.readFile(result.path, "utf8")).toBe("onetwo");
  expect(close).toHaveBeenCalledTimes(1);
  await expect(sink.write(Buffer.from("late"))).rejects.toThrow();
});

it("keeps only the actually persisted prefix after a partial write failure", async () => {
  const dir = await directory(); const handle = await fs.open(join(dir, "stdout"), "wx", 0o600);
  const realWrite = handle.write.bind(handle);
  vi.spyOn(handle, "write").mockImplementationOnce((async () => {
    await realWrite(Buffer.from("a\n"));
    return { bytesWritten: 2, buffer: Buffer.from("a\ncd") };
  }) as unknown as typeof handle.write).mockRejectedValueOnce(new Error("disk failure"));
  const close = vi.spyOn(handle, "close");
  vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  const sink = await createCapture(dir, "stdout", { remaining: 100 });
  await expect(sink.write(Buffer.from("a\ncd"))).rejects.toThrow("disk failure");
  const result = await sink.finish(true);
  expect(result).toMatchObject({ bytes: 2, lines: 1, preview: "a\n", ioFailed: true, complete: false });
  expect(await fs.readFile(result.path, "utf8")).toBe("a\n");
  expect(close).toHaveBeenCalledTimes(1);
  expect(await sink.finish(true)).toBe(result);
});

it("finalization resolves with ioFailed on close failure, without closing twice", async () => {
  const dir = await directory(); const handle = await fs.open(join(dir, "stdout"), "wx", 0o600);
  const realClose = handle.close.bind(handle);
  const close = vi.spyOn(handle, "close").mockImplementationOnce(async () => { await realClose(); throw new Error("close failure"); });
  vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  const sink = await createCapture(dir, "stdout", { remaining: 100 });
  await sink.write(Buffer.from("kept"));
  const result = await sink.finish(true);
  expect(result).toMatchObject({ bytes: 4, preview: "kept", ioFailed: true, complete: false });
  expect(await sink.finish(true)).toBe(result);
  expect(close).toHaveBeenCalledTimes(1);
});

it("rejects zero-progress writes and still finalizes", async () => {
  const dir = await directory(); const handle = await fs.open(join(dir, "stdout"), "wx", 0o600);
  vi.spyOn(handle, "write").mockImplementationOnce((async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) })) as unknown as typeof handle.write);
  vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  const sink = await createCapture(dir, "stdout", { remaining: 100 });
  await expect(sink.write(Buffer.from("x"))).rejects.toThrow(/progress/);
  expect(await sink.finish(true)).toMatchObject({ bytes: 0, ioFailed: true, complete: false });
});

it("never overwrites an existing capture", async () => {
  const dir = await directory(); await fs.writeFile(join(dir, "stdout"), "existing");
  await expect(createCapture(dir, "stdout", { remaining: 100 })).rejects.toThrow();
  expect(await fs.readFile(join(dir, "stdout"), "utf8")).toBe("existing");
});

it("bounds even oversized notices and retains useful UTF8 text for oversized first lines", () => {
  const shown = present("🦙".repeat(30000), "Full output: /tmp/fixture");
  expect(shown.startsWith("🦙")).toBe(true);
  expect(shown).not.toContain("\uFFFD");
  expect(shown.endsWith("Full output: /tmp/fixture")).toBe(true);
  expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(51200);
  const hugeNotice = present("body", "note\n".repeat(30000));
  expect(Buffer.byteLength(hugeNotice)).toBeLessThanOrEqual(51200);
  expect(hugeNotice.split("\n").length).toBeLessThanOrEqual(2000);
});
