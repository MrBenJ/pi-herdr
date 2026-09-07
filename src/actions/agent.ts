import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Input, Operation } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";
import { assertAllowed, assertRecord, boolean, buildOperation, keysArray, readFlags, requiredString, timeout } from "./shared.ts";

const DEADLINE_MS = 30000;
const WAIT_DRAIN_MS = 1000;

const KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "qwen", "maki",
] as const;

const STATES = ["idle", "working", "blocked", "done", "unknown"] as const;

function invalidInput(message: string): HerdrToolError {
  return new HerdrToolError({ kind: "invalid_input", message, remoteOutcome: "not_attempted" });
}

export const AgentSchema = Type.Object({
  action: StringEnum(["list", "inspect", "start", "rename", "prompt", "send-keys", "read", "wait", "focus"], {
    description: "Agent operation to perform.",
  }),
  target: Type.Optional(Type.String({ description: "Agent name or pane ID." })),
  name: Type.Optional(Type.String({ description: "Agent name." })),
  clear: Type.Optional(Type.Boolean({ description: "Clear the agent's name on rename." })),
  kind: Type.Optional(StringEnum(KINDS, { description: "Supported agent kind." })),
  paneId: Type.Optional(Type.String({ description: "Existing pane at an interactive shell prompt." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "Native arguments forwarded after the launch separator." })),
  wait: Type.Optional(Type.Boolean({ description: "Wait for a settled state after a prompt." })),
  until: Type.Optional(Type.Array(Type.String(), { description: "States to match: idle, working, blocked, done, unknown." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
  text: Type.Optional(Type.String({ description: "Prompt text to submit to the agent." })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "Key presses to send to the agent." })),
  source: Type.Optional(Type.String({ description: "Terminal snapshot source." })),
  lines: Type.Optional(Type.Number({ description: "Restrict the snapshot to this many lines." })),
  format: Type.Optional(Type.String({ description: "Read format: text or ansi." })),
});

function agentName(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw invalidInput(`Field "${key}" does not match the required agent name pattern.`);
  }
  return value;
}

function agentKind(input: Input): string {
  const kind = input["kind"];
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    throw invalidInput(`Field "kind" must be one of ${KINDS.join(", ")}.`);
  }
  return kind;
}

function nativeArgs(input: Input): string[] {
  if (!("args" in input)) {
    return [];
  }
  const value = input["args"];
  if (!Array.isArray(value)) {
    throw invalidInput('Field "args" must be an array of strings.');
  }
  const args: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.includes("\0")) {
      throw invalidInput('Field "args" must contain strings without a NUL character.');
    }
    args.push(item);
  }
  return args;
}

function untilFlags(input: Input): string[] {
  if (!("until" in input)) {
    return [];
  }
  const value = input["until"];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidInput('Field "until" must be a nonempty array of states.');
  }
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const state of value) {
    if (typeof state !== "string" || !(STATES as readonly string[]).includes(state)) {
      throw invalidInput(`Field "until" entries must be one of ${STATES.join(", ")}.`);
    }
    if (seen.has(state)) {
      throw invalidInput('Field "until" must not repeat the same state.');
    }
    seen.add(state);
    flags.push("--until", state);
  }
  return flags;
}

export function compileAgent(input: Input): Operation {
  assertRecord(input);
  const action = input["action"];
  if (typeof action !== "string") {
    throw invalidInput("action is required and must be a string.");
  }

  switch (action) {
    case "list": {
      assertAllowed(input, []);
      return buildOperation({ group: "agent", action, argv: ["agent", "list"], output: "json", mutation: false, deadlineMs: DEADLINE_MS, sensitive: [] });
    }
    case "inspect": {
      assertAllowed(input, ["target"]);
      const target = requiredString(input, "target", "id");
      return buildOperation({
        group: "agent",
        action,
        argv: ["agent", "get", target],
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "start": {
      assertAllowed(input, ["name", "kind", "paneId", "args", "timeoutMs"]);
      const name = agentName(input, "name");
      const kind = agentKind(input);
      const paneId = requiredString(input, "paneId", "id");
      const timeoutMs = timeout(input, 3001);
      const args = nativeArgs(input);
      const argv = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs)];
      if (args.length > 0) {
        argv.push("--", ...args);
      }
      return buildOperation({
        group: "agent",
        action,
        argv,
        output: "json",
        mutation: true,
        deadlineMs: timeoutMs + WAIT_DRAIN_MS,
        sensitive: args,
      });
    }
    case "rename": {
      assertAllowed(input, ["target", "name", "clear"]);
      const target = requiredString(input, "target", "id");
      const hasName = "name" in input;
      const hasClear = "clear" in input;
      if (hasName === hasClear) {
        throw invalidInput('Exactly one of "name" or "clear" is required.');
      }
      let argv: string[];
      if (hasName) {
        argv = ["agent", "rename", target, agentName(input, "name")];
      } else {
        if (input["clear"] !== true) {
          throw invalidInput('Field "clear" must be true when supplied.');
        }
        argv = ["agent", "rename", target, "--clear"];
      }
      return buildOperation({ group: "agent", action, argv, output: "json", mutation: true, deadlineMs: DEADLINE_MS, sensitive: [] });
    }
    case "prompt": {
      assertAllowed(input, ["target", "text", "wait", "until", "timeoutMs"]);
      const target = requiredString(input, "target", "id");
      const text = requiredString(input, "text", "text");
      const wait = boolean(input, "wait", false);
      if (!wait && ("until" in input || "timeoutMs" in input)) {
        throw invalidInput('"until" and "timeoutMs" require "wait": true.');
      }
      const argv = ["agent", "prompt", target, text];
      let deadlineMs = DEADLINE_MS;
      if (wait) {
        argv.push("--wait", ...untilFlags(input));
        const timeoutMs = timeout(input);
        argv.push("--timeout", String(timeoutMs));
        deadlineMs = timeoutMs + WAIT_DRAIN_MS;
      }
      return buildOperation({ group: "agent", action, argv, output: "json", mutation: true, deadlineMs, sensitive: [text] });
    }
    case "send-keys": {
      assertAllowed(input, ["target", "keys"]);
      const target = requiredString(input, "target", "id");
      const keys = keysArray(input, "keys");
      return buildOperation({
        group: "agent",
        action,
        argv: ["agent", "send-keys", target, ...keys],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "read": {
      assertAllowed(input, ["target", "source", "lines", "format"]);
      const target = requiredString(input, "target", "id");
      return buildOperation({
        group: "agent",
        action,
        argv: ["agent", "read", target, ...readFlags(input)],
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "wait": {
      assertAllowed(input, ["target", "until", "timeoutMs"]);
      const target = requiredString(input, "target", "id");
      const timeoutMs = timeout(input);
      const argv = ["agent", "wait", target, ...untilFlags(input), "--timeout", String(timeoutMs)];
      return buildOperation({
        group: "agent",
        action,
        argv,
        output: "json",
        mutation: false,
        deadlineMs: timeoutMs + WAIT_DRAIN_MS,
        sensitive: [],
      });
    }
    case "focus": {
      assertAllowed(input, ["target"]);
      const target = requiredString(input, "target", "id");
      return buildOperation({
        group: "agent",
        action,
        argv: ["agent", "focus", target],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    default:
      throw invalidInput(`Unsupported agent action "${action}".`);
  }
}
