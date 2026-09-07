import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Input, Operation } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";
import {
  assertAllowed,
  assertRecord,
  boolean,
  buildOperation,
  envFlags,
  EnvEntrySchema,
  keysArray,
  positiveInteger,
  readFlags,
  requireConfirmTrue,
  requiredString,
  timeout,
} from "./shared.ts";

const DEADLINE_MS = 30000;
const WAIT_DRAIN_MS = 1000;
const SPLIT_DIRECTIONS = ["right", "down"];
const FOCUS_DIRECTIONS = ["left", "right", "up", "down"];
const WAIT_OUTPUT_SOURCES = ["visible", "recent", "recent-unwrapped"];

function invalidInput(message: string): HerdrToolError {
  return new HerdrToolError({ kind: "invalid_input", message, remoteOutcome: "not_attempted" });
}

export const PaneSchema = Type.Object({
  action: StringEnum(
    ["list", "inspect", "split", "run", "send-text", "send-keys", "read", "wait-output", "focus-neighbor", "close"],
    { description: "Pane operation to perform." },
  ),
  workspaceId: Type.Optional(Type.String({ description: "Opaque workspace ID." })),
  paneId: Type.Optional(Type.String({ description: "Opaque pane ID." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a new split." })),
  direction: Type.Optional(StringEnum(["left", "right", "up", "down"], { description: "Split direction (right/down) or focus-neighbor direction (left/right/up/down)." })),
  ratio: Type.Optional(Type.Number({ description: "Split ratio strictly between 0 and 1." })),
  env: Type.Optional(Type.Array(EnvEntrySchema, { description: "Launch environment for a split." })),
  focus: Type.Optional(Type.Boolean({ description: "Focus the new split once created." })),
  confirm: Type.Optional(Type.Boolean({ description: "Must be true to close a pane." })),
  command: Type.Optional(Type.String({ description: "Shell command to run in the pane." })),
  text: Type.Optional(Type.String({ description: "Literal text to send to the pane." })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "Key presses to send to the pane." })),
  source: Type.Optional(StringEnum(["visible", "recent", "recent-unwrapped", "detection"], { description: "Terminal snapshot source." })),
  lines: Type.Optional(Type.Number({ description: "Restrict the snapshot to this many lines." })),
  format: Type.Optional(StringEnum(["text", "ansi"], { description: "Read format: text or ansi." })),
  match: Type.Optional(Type.String({ description: "Literal substring to match." })),
  regex: Type.Optional(Type.String({ description: "Regular expression to match, validated by Herdr." })),
  raw: Type.Optional(Type.Boolean({ description: "Keep ANSI escape sequences while matching." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
});

function splitDirectionFlag(input: Input): string {
  const direction = input["direction"];
  if (typeof direction !== "string" || !SPLIT_DIRECTIONS.includes(direction)) {
    throw invalidInput('Field "direction" must be "right" or "down" for split.');
  }
  return direction;
}

function focusDirectionFlag(input: Input): string {
  const direction = input["direction"];
  if (typeof direction !== "string" || !FOCUS_DIRECTIONS.includes(direction)) {
    throw invalidInput('Field "direction" must be one of "left", "right", "up", "down".');
  }
  return direction;
}

function ratioFlag(input: Input): string | undefined {
  if (!("ratio" in input)) {
    return undefined;
  }
  const ratio = input["ratio"];
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw invalidInput('Field "ratio" must be a finite number strictly between 0 and 1.');
  }
  return String(ratio);
}

function waitOutputMatchFlags(input: Input): string[] {
  const hasMatch = "match" in input;
  const hasRegex = "regex" in input;
  if (hasMatch === hasRegex) {
    throw invalidInput('Exactly one of "match" or "regex" is required.');
  }
  if (hasMatch) {
    return ["--match", requiredString(input, "match", "literal")];
  }
  return ["--regex", requiredString(input, "regex", "literal")];
}

function waitOutputSourceAndLinesFlags(input: Input): string[] {
  const source = input["source"] === undefined ? "visible" : input["source"];
  if (typeof source !== "string" || !WAIT_OUTPUT_SOURCES.includes(source)) {
    throw invalidInput(`Field "source" must be one of ${WAIT_OUTPUT_SOURCES.join(", ")} for wait-output.`);
  }
  const flags = ["--source", source];
  if ("lines" in input) {
    flags.push("--lines", String(positiveInteger(input, "lines")));
  }
  return flags;
}

export function compilePane(input: Input): Operation {
  assertRecord(input);
  const action = input["action"];
  if (typeof action !== "string") {
    throw invalidInput("action is required and must be a string.");
  }

  switch (action) {
    case "list": {
      assertAllowed(input, ["workspaceId"]);
      const argv = ["pane", "list"];
      if ("workspaceId" in input) {
        argv.push("--workspace", requiredString(input, "workspaceId", "id"));
      }
      return buildOperation({ group: "pane", action, argv, output: "json", mutation: false, deadlineMs: DEADLINE_MS, sensitive: [] });
    }
    case "inspect": {
      assertAllowed(input, ["paneId"]);
      const paneId = requiredString(input, "paneId", "id");
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "get", paneId],
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "split": {
      assertAllowed(input, ["paneId", "cwd", "direction", "ratio", "env", "focus"]);
      const paneId = requiredString(input, "paneId", "id");
      const direction = splitDirectionFlag(input);
      const argv = ["pane", "split", "--pane", paneId, "--direction", direction];
      const ratio = ratioFlag(input);
      if (ratio !== undefined) {
        argv.push("--ratio", ratio);
      }
      const cwd = requiredString(input, "cwd", "literal");
      argv.push("--cwd", cwd);
      const envArgs = envFlags(input);
      for (const flag of envArgs) {
        argv.push("--env", flag);
      }
      argv.push(boolean(input, "focus", false) ? "--focus" : "--no-focus");
      const sensitive = envArgs.map((flag) => flag.slice(flag.indexOf("=") + 1));
      return buildOperation({ group: "pane", action, argv, output: "json", mutation: true, deadlineMs: DEADLINE_MS, sensitive });
    }
    case "run": {
      assertAllowed(input, ["paneId", "command"]);
      const paneId = requiredString(input, "paneId", "id");
      const command = requiredString(input, "command", "literal");
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "run", paneId, command],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [command],
      });
    }
    case "send-text": {
      assertAllowed(input, ["paneId", "text"]);
      const paneId = requiredString(input, "paneId", "id");
      const text = requiredString(input, "text", "text");
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "send-text", paneId, text],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [text],
      });
    }
    case "send-keys": {
      assertAllowed(input, ["paneId", "keys"]);
      const paneId = requiredString(input, "paneId", "id");
      const keys = keysArray(input, "keys");
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "send-keys", paneId, ...keys],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "read": {
      assertAllowed(input, ["paneId", "source", "lines", "format"]);
      const paneId = requiredString(input, "paneId", "id");
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "read", paneId, ...readFlags(input)],
        output: "text",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "wait-output": {
      assertAllowed(input, ["paneId", "match", "regex", "source", "lines", "raw", "timeoutMs"]);
      const paneId = requiredString(input, "paneId", "id");
      const matchFlags = waitOutputMatchFlags(input);
      const sourceAndLinesFlags = waitOutputSourceAndLinesFlags(input);
      const timeoutMs = timeout(input);
      const argv = ["pane", "wait-output", paneId, ...matchFlags, ...sourceAndLinesFlags, "--timeout", String(timeoutMs)];
      if (boolean(input, "raw", false)) {
        argv.push("--raw");
      }
      return buildOperation({
        group: "pane",
        action,
        argv,
        output: "json",
        mutation: false,
        deadlineMs: timeoutMs + WAIT_DRAIN_MS,
        sensitive: [],
      });
    }
    case "focus-neighbor": {
      assertAllowed(input, ["paneId", "direction"]);
      const paneId = requiredString(input, "paneId", "id");
      const direction = focusDirectionFlag(input);
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "focus", "--pane", paneId, "--direction", direction],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "close": {
      assertAllowed(input, ["paneId", "confirm"]);
      const paneId = requiredString(input, "paneId", "id");
      requireConfirmTrue(input, "pane");
      return buildOperation({
        group: "pane",
        action,
        argv: ["pane", "close", paneId],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    default:
      throw invalidInput(`Unsupported pane action "${action}".`);
  }
}
