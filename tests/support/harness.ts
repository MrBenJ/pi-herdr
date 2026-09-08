import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunResult } from "../../src/contracts.ts";
import { createCapture, type CaptureSink } from "../../src/transport/capture.ts";

export async function captured(stdout: string, stderr: string, exitCode: number): Promise<RunResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-results-test-"));
  const budget = { remaining: 64 * 1024 * 1024 };
  const sinks: CaptureSink[] = [];
  try {
    const out = await createCapture(directory, "stdout", budget); sinks.push(out);
    const err = await createCapture(directory, "stderr", budget); sinks.push(err);
    await Promise.all([out.write(Buffer.from(stdout)), err.write(Buffer.from(stderr))]);
    return { exitCode, spawned: true, stdout: await out.finish(true), stderr: await err.finish(true) };
  } catch (error) {
    await Promise.all(sinks.map(sink => sink.finish(false)));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function cleanupCaptured(result: RunResult): Promise<void> {
  await Promise.all([...new Set([dirname(result.stdout.path), dirname(result.stderr.path)])].map(path => rm(path, { recursive: true, force: true })));
}

type Shutdown = (event: SessionShutdownEvent, context: ExtensionContext) => void | Promise<void>;
type Handler = (...args: unknown[]) => unknown;
export function registrationHarness(options: { allowedEvents?: string[] } = {}) {
  const allowedEvents = new Set(options.allowedEvents ?? ["session_shutdown"]);
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>([...allowedEvents].map(event => [event, []]));
  const registerTool: ExtensionAPI["registerTool"] = tool => {
    if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    tools.set(tool.name, tool as ToolDefinition);
  };
  const surface = {
    registerTool,
    on(event: string, handler: Handler) {
      if (!allowedEvents.has(event)) throw new Error(`Unexpected lifecycle hook: ${event}`);
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
  };
  const api = new Proxy(surface, {
    get(target, property) {
      if (!(property in target)) throw new Error(`Unexpected pi API access: ${String(property)}`);
      return Reflect.get(target, property);
    },
  }) as unknown as ExtensionAPI;
  const shutdown = (handlers.get("session_shutdown") ?? []) as Shutdown[];
  return { api, tools, handlers, shutdown };
}
