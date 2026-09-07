import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRunner } from "../src/transport/runner.ts";
import type { RunRequest, RunResult } from "../src/contracts.ts";

const runners: ReturnType<typeof createRunner>[] = [];
const directories = new Set<string>();
const realSpawn = childProcess.spawn.bind(childProcess);
const realMkdtemp = fs.mkdtemp.bind(fs);
const realOpen = fs.open.bind(fs);
function runner() {
  const instance = createRunner(); runners.push(instance); return instance;
}
function request(mode = "echo", extra: Partial<RunRequest> = {}): RunRequest {
  return {
    executable: process.execPath, argv: [resolve("tests/support/fake-herdr.mjs"), mode],
    env: { ...process.env, HERDR_SOCKET_PATH: "/tmp/fixture.sock", HERDR_SESSION: undefined },
    cwd: process.cwd(), deadlineMs: 2000, ...extra,
  };
}
function retain(result: RunResult) {
  directories.add(dirname(result.stdout.path)); return result;
}
function observeDirectory() {
  return vi.spyOn(fs, "mkdtemp").mockImplementation((async (...args: Parameters<typeof realMkdtemp>) => {
    const path = await realMkdtemp(...args); directories.add(String(path)); return path;
  }) as typeof fs.mkdtemp);
}
function readyChild() {
  let ready!: (child: childProcess.ChildProcess) => void;
  const promise = new Promise<childProcess.ChildProcess>(resolveReady => { ready = resolveReady; });
  vi.spyOn(childProcess, "spawn").mockImplementationOnce((...args) => {
    const child = realSpawn(...args);
    child.stdout?.once("data", () => ready(child));
    return child;
  });
  return promise;
}
beforeEach(() => { observeDirectory(); });
afterEach(async () => {
  await Promise.all(runners.splice(0).map(instance => instance.dispose()));
  vi.restoreAllMocks();
  await Promise.all([...directories].map(path => fs.rm(path, { recursive: true, force: true })));
  directories.clear();
});

it("is inert until invoked and forwards literal argv/environment/cwd exactly once without a shell", async () => {
  const spawn = vi.spyOn(childProcess, "spawn"); const mkdir = observeDirectory();
  const instance = runner();
  expect(spawn).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
  const args = ["$(touch NEVER)", "'a b'\n--x"];
  const input = request("echo", { argv: [resolve("tests/support/fake-herdr.mjs"), "echo", ...args] });
  const result = retain(await instance.run(input));
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledWith(process.execPath, input.argv, expect.objectContaining({ shell: false, cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] }));
  expect(JSON.parse(result.stdout.preview)).toEqual({ args, socket: "/tmp/fixture.sock", session: null });
  expect(result).toMatchObject({ exitCode: 0, spawned: true });
  expect(result.stop).toBeUndefined();
  expect((await fs.stat(dirname(result.stdout.path))).mode & 0o777).toBe(0o700);
  expect(result.stdout.complete && result.stderr.complete).toBe(true);
});
it("preserves nonzero exit and separate stderr without inventing a local stop", async () => {
  const result = retain(await runner().run(request("fail")));
  expect(result.exitCode).toBe(1); expect(result.stop).toBeUndefined();
  expect(result.stdout.bytes).toBe(0);
  expect(JSON.parse(result.stderr.preview).error.code).toBe("agent_blocked");
});
it("rejects pre-abort without spawning or creating artifacts", async () => {
  const spawn = vi.spyOn(childProcess, "spawn"); const mkdir = observeDirectory();
  const controller = new AbortController(); controller.abort();
  await expect(runner().run(request("echo", { signal: controller.signal }))).rejects.toMatchObject({ failure: { kind: "cancelled", remoteOutcome: "not_attempted" } });
  expect(spawn).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
});
it("classifies real asynchronous spawn ENOENT and removes abandoned capture files", async () => {
  observeDirectory();
  await expect(runner().run(request("echo", { executable: "/does-not-exist/pi-herdr-fixture" }))).rejects.toMatchObject({ failure: { kind: "missing_executable", remoteOutcome: "not_attempted" } });
  for (const path of directories) await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("classifies a synchronous spawn throw without exposing argv or retaining artifacts", async () => {
  observeDirectory();
  vi.spyOn(childProcess, "spawn").mockImplementationOnce(() => { throw Object.assign(new Error("SECRET argv"), { code: "EACCES" }); });
  const pending = runner().run(request());
  await expect(pending).rejects.toMatchObject({ failure: { kind: "transport_failed", remoteOutcome: "not_attempted" } });
  await expect(pending).rejects.not.toThrow("SECRET");
  for (const path of directories) await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("closes the first capture when opening the second fails; setup ENOENT is not missing executable", async () => {
  observeDirectory(); const spawn = vi.spyOn(childProcess, "spawn");
  let close: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args); close = vi.spyOn(handle, "close"); return handle;
  }).mockRejectedValueOnce(Object.assign(new Error("private path"), { code: "ENOENT" }));
  await expect(runner().run(request())).rejects.toMatchObject({ failure: { kind: "transport_failed", remoteOutcome: "not_attempted" } });
  expect(close).toHaveBeenCalledTimes(1); expect(spawn).not.toHaveBeenCalled();
  for (const path of directories) await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rechecks cancellation after asynchronous setup, then closes and removes both artifacts", async () => {
  observeDirectory(); const spawn = vi.spyOn(childProcess, "spawn"); const controller = new AbortController();
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => { const handle = await realOpen(...args); controller.abort(); return handle; });
  await expect(runner().run(request("echo", { signal: controller.signal }))).rejects.toMatchObject({ failure: { kind: "cancelled", remoteOutcome: "not_attempted" } });
  expect(spawn).not.toHaveBeenCalled();
  for (const path of directories) await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("deadline stops a real sleeping child and retains incomplete captures", async () => {
  const result = retain(await runner().run(request("sleep", { deadlineMs: 200 })));
  expect(result).toMatchObject({ stop: "timeout", spawned: true });
  expect(result.stdout.complete || result.stderr.complete).toBe(false);
  expect(await fs.readFile(result.stdout.path, "utf8")).toBe("ready\n");
});
it("caller abort stops only the local child and preserves its captured prefix", async () => {
  const ready = readyChild(); const controller = new AbortController();
  const pending = runner().run(request("sleep", { signal: controller.signal }));
  const child = await ready; controller.abort();
  const result = retain(await pending);
  expect(result.stop).toBe("cancelled"); expect(child.signalCode).toBe("SIGTERM");
  expect(result.stdout.preview).toBe("ready\n");
});
it("escalates SIGTERM to SIGKILL for an ignoring child and settles within two seconds", async () => {
  const ready = readyChild(); const controller = new AbortController();
  const pending = runner().run(request("ignore-term", { signal: controller.signal }));
  const child = await ready; const started = Date.now(); controller.abort();
  const result = retain(await pending);
  expect(child.signalCode).toBe("SIGKILL"); expect(result.stop).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(2000);
});
it("concurrent calls own different private directories", async () => {
  const instance = runner();
  const results = (await Promise.all([instance.run(request()), instance.run(request())])).map(retain);
  expect(dirname(results[0]!.stdout.path)).not.toBe(dirname(results[1]!.stdout.path));
});
it("dispose twice aborts active local calls, waits for cleanup, and prevents later invocation", async () => {
  const ready = readyChild(); const instance = runner();
  const pending = instance.run(request("sleep")); await ready;
  await Promise.all([instance.dispose(), instance.dispose()]);
  const result = retain(await pending); expect(result.stop).toBe("cancelled");
  await expect(instance.run(request())).rejects.toMatchObject({ failure: { kind: "cancelled", remoteOutcome: "not_attempted" } });
});
it("keeps large full output on disk while bounding preview memory", async () => {
  const result = retain(await runner().run(request("large", { deadlineMs: 10000 })));
  expect(result.exitCode).toBe(0); expect(result.stop).toBeUndefined();
  expect(result.stdout.bytes).toBe(4096 * 4097);
  expect(Buffer.byteLength(result.stdout.preview)).toBeLessThanOrEqual(51204);
  expect(result.stdout.truncated).toBe(true);
}, 15000);
it("over-budget output resolves a stopped RunResult instead of throwing or exceeding 64MiB", async () => {
  const result = retain(await runner().run(request("over-budget", { deadlineMs: 15000 })));
  expect(result).toMatchObject({ stop: "resource_limit", spawned: true });
  expect(result.stdout.bytes + result.stderr.bytes).toBe(64 * 1024 * 1024);
  expect((await fs.stat(result.stdout.path)).size + (await fs.stat(result.stderr.path)).size).toBe(64 * 1024 * 1024);
  expect(result.stdout.complete || result.stderr.complete).toBe(false);
}, 20000);
it("post-spawn partial capture write failure resolves transport_failed with a real persisted prefix", async () => {
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args); const write = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementationOnce((async () => { await write(Buffer.from("{\"")); return { bytesWritten: 2, buffer: Buffer.alloc(2) }; }) as unknown as typeof handle.write).mockRejectedValueOnce(new Error("disk failure"));
    return handle;
  });
  const result = retain(await runner().run(request()));
  expect(result).toMatchObject({ stop: "transport_failed", spawned: true });
  expect(result.stdout).toMatchObject({ bytes: 2, preview: "{\"", ioFailed: true, complete: false });
  expect(await fs.readFile(result.stdout.path, "utf8")).toBe("{\"");
});
it("capture close failure becomes transport_failed without losing the known exit or artifacts", async () => {
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args); const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); throw new Error("close failed"); }); return handle;
  });
  const result = retain(await runner().run(request()));
  expect(result).toMatchObject({ exitCode: 0, stop: "transport_failed", spawned: true });
  expect(result.stdout.ioFailed).toBe(true); expect(result.stderr.complete).toBe(false);
});
it("an earlier cancellation wins over a later process I/O error", async () => {
  const ready = readyChild(); const controller = new AbortController();
  const pending = runner().run(request("sleep", { signal: controller.signal }));
  const child = await ready; controller.abort(); child.emit("error", new Error("late process error"));
  const result = retain(await pending); expect(result.stop).toBe("cancelled");
});
it("a process error after spawn resolves transport_failed and terminates its child", async () => {
  const ready = readyChild(); const pending = runner().run(request("sleep"));
  const child = await ready; child.emit("error", new Error("process I/O failure"));
  const result = retain(await pending); expect(result.stop).toBe("transport_failed");
  expect(child.signalCode).toBe("SIGTERM"); expect(result.spawned).toBe(true);
});
