import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { RunRequest, RunResult, Runner } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";
import { CaptureLimitError, createCapture, type CaptureSink } from "./capture.ts";

const CAPTURE_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 250;

function cancelled(): HerdrToolError {
  return new HerdrToolError({ kind: "cancelled", message: "Cancelled before invocation.", remoteOutcome: "not_attempted" });
}
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function invoke(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
  if (signal.aborted) throw cancelled();
  let directory: string | undefined;
  let stdout: CaptureSink | undefined;
  let stderr: CaptureSink | undefined;
  let child: ChildProcess | undefined;
  let spawned = false;
  let spawning = false;
  let spawnError: unknown;
  let stop: RunResult["stop"];
  let terminating = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let onSpawn: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  let onClose: ((code: number | null) => void) | undefined;

  function terminate() {
    if (terminating || !child || child.exitCode !== null || child.signalCode !== null) return;
    terminating = true;
    // Register before kill, so synchronous error/close handling cannot orphan
    // the timer. Repeated stop reasons never reset the escalation deadline.
    escalation = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* await the owned child's close */ }
      }
    }, KILL_GRACE_MS);
    try { child.kill("SIGTERM"); } catch { /* escalation is still armed */ }
  }
  function stopWith(reason: NonNullable<RunResult["stop"]>) {
    stop ??= reason;
    if (spawned) terminate();
  }
  function onAbort() { stopWith("cancelled"); }

  async function drain(stream: Readable | null, sink: CaptureSink): Promise<void> {
    if (!stream) { stopWith("transport_failed"); return; }
    try {
      for await (const chunk of stream) {
        await sink.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (error) {
      stopWith(error instanceof CaptureLimitError ? "resource_limit" : "transport_failed");
    }
  }

  try {
    directory = await fs.mkdtemp(join(tmpdir(), "pi-herdr-"));
    await fs.chmod(directory, 0o700);
    const budget = { remaining: CAPTURE_BYTES };
    stdout = await createCapture(directory, "stdout", budget);
    stderr = await createCapture(directory, "stderr", budget);
    if (signal.aborted) throw cancelled();

    spawning = true;
    child = childProcess.spawn(request.executable, request.argv, {
      cwd: request.cwd, env: request.env, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<number | null>(resolveClose => {
      onSpawn = () => {
        spawned = true;
        deadline = setTimeout(() => stopWith("timeout"), request.deadlineMs);
        if (stop) terminate();
      };
      onError = error => {
        if (!spawned) spawnError = error;
        else stopWith("transport_failed");
      };
      onClose = code => {
        if (deadline) clearTimeout(deadline);
        if (escalation) clearTimeout(escalation);
        resolveClose(code);
      };
      child!.once("spawn", onSpawn);
      child!.on("error", onError);
      child!.once("close", onClose);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    // Attach both drains immediately. Awaited writes provide backpressure;
    // their catch handlers record a stop and terminate, never float rejection.
    const drains = [drain(child.stdout, stdout), drain(child.stderr, stderr)];
    const exitCode = await closed;
    await Promise.all(drains);
    if (!spawned) throw spawnError ?? new Error("Process closed before spawn");
    const [out, err] = await Promise.all([stdout.finish(!stop), stderr.finish(!stop)]);
    if (out.ioFailed || err.ioFailed) stop ??= "transport_failed";
    return {
      exitCode, ...(stop ? { stop } : {}), spawned: true,
      stdout: { ...out, complete: out.complete && !stop },
      stderr: { ...err, complete: err.complete && !stop },
    };
  } catch (error) {
    // Expected post-spawn failures are caught by drains/event handlers above.
    // An unexpected contract violation is left to execute's defensive catch.
    if (spawned) throw error;
    await Promise.all([stdout?.finish(false), stderr?.finish(false)]);
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof HerdrToolError) throw error;
    if (signal.aborted) throw cancelled();
    const missing = spawning && isMissing(error);
    throw new HerdrToolError({
      kind: missing ? "missing_executable" : "transport_failed",
      message: missing ? "Herdr executable was not found on PATH." : "Could not prepare or start the local Herdr CLI.",
      remoteOutcome: "not_attempted",
    });
  } finally {
    if (deadline) clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener("abort", onAbort);
    if (child) {
      if (onSpawn) child.removeListener("spawn", onSpawn);
      if (onError) child.removeListener("error", onError);
      if (onClose) child.removeListener("close", onClose);
    }
  }
}

export function createRunner(): { run: Runner; dispose(): Promise<void> } {
  const active = new Map<AbortController, Promise<RunResult>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const run: Runner = request => {
    if (disposed || request.signal?.aborted) return Promise.reject(cancelled());
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const pending = invoke(request, signal);
    active.set(controller, pending);
    const remove = () => { active.delete(controller); };
    void pending.then(remove, remove);
    return pending;
  };
  return {
    run,
    dispose() {
      if (!disposal) {
        disposed = true;
        const pending = [...active.values()];
        for (const controller of active.keys()) controller.abort();
        disposal = Promise.allSettled(pending).then(() => {});
      }
      return disposal;
    },
  };
}
