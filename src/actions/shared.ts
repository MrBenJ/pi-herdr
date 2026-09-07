import { Type } from "typebox";
import type { Group, Input, Operation } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";

export type StringMode = "id" | "name" | "literal" | "text";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const READ_SOURCES = ["visible", "recent", "recent-unwrapped", "detection"] as const;

function invalidInput(message: string): HerdrToolError {
  return new HerdrToolError({
    kind: "invalid_input",
    message,
    remoteOutcome: "not_attempted",
  });
}

export function assertRecord(input: unknown): asserts input is Input {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput("Input must be a non-null object.");
  }
}

export function assertAllowed(input: Input, fields: readonly string[]): void {
  assertRecord(input);
  const allowed = new Set(["action", ...fields]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw invalidInput("Input contains a field that does not apply to this action.");
    }
  }
}

export function requiredString(input: Input, key: string, mode: StringMode): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw invalidInput(`Field "${key}" is required and must be a string.`);
  }
  if (value.includes("\0")) {
    throw invalidInput(`Field "${key}" must not contain a NUL character.`);
  }
  switch (mode) {
    case "id":
      if (value.length === 0) {
        throw invalidInput(`Field "${key}" must not be empty.`);
      }
      if (/\s/.test(value)) {
        throw invalidInput(`Field "${key}" must not contain whitespace.`);
      }
      if (value.startsWith("-")) {
        throw invalidInput(`Field "${key}" must not start with '-'.`);
      }
      return value;
    case "name":
      if (!NAME_PATTERN.test(value)) {
        throw invalidInput(`Field "${key}" does not match the required name pattern.`);
      }
      return value;
    case "literal":
      if (value.length === 0) {
        throw invalidInput(`Field "${key}" must not be empty.`);
      }
      return value;
    case "text":
      return value;
  }
}

export function boolean(input: Input, key: string, fallback: boolean): boolean {
  if (!(key in input)) {
    return fallback;
  }
  const value = input[key];
  if (typeof value !== "boolean") {
    throw invalidInput(`Field "${key}" must be a boolean.`);
  }
  return value;
}

export function envFlags(input: Input): string[] {
  const raw = input["env"];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw invalidInput('Field "env" must be an array.');
  }
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalidInput('Each "env" entry must be an object with name and value.');
    }
    const { name, value } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
      throw invalidInput('Each "env" entry name must be a valid environment variable name.');
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw invalidInput('Each "env" entry value must be a string without a NUL character.');
    }
    if (name.startsWith("HERDR_")) {
      throw invalidInput('Env entries may not use a reserved "HERDR_" name.');
    }
    if (seen.has(name)) {
      throw invalidInput('Env entries must not repeat the same name.');
    }
    seen.add(name);
    flags.push(`${name}=${value}`);
  }
  return flags;
}

export function timeout(input: Input, minimum: 1 | 3001 = 1): number {
  const value = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > 300000) {
    throw invalidInput(`timeoutMs must be an integer from ${minimum} to 300000.`);
  }
  return value;
}

export function readFlags(input: Input): string[] {
  const source = input["source"] === undefined ? "visible" : input["source"];
  if (typeof source !== "string" || !READ_SOURCES.includes(source as (typeof READ_SOURCES)[number])) {
    throw invalidInput(`Field "source" must be one of ${READ_SOURCES.join(", ")}.`);
  }
  const flags = ["--source", source];
  if ("lines" in input) {
    flags.push("--lines", String(positiveInteger(input, "lines")));
  }
  const format = input["format"] === undefined ? "text" : input["format"];
  if (format !== "text" && format !== "ansi") {
    throw invalidInput('Field "format" must be "text" or "ansi".');
  }
  flags.push("--format", format);
  return flags;
}

export function positiveInteger(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 1000000) {
    throw invalidInput(`Field "${key}" must be a positive integer up to 1000000.`);
  }
  return value;
}

export function keysArray(input: Input, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidInput(`Field "${key}" must be a nonempty array of strings.`);
  }
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.includes("\0")) {
      throw invalidInput(`Field "${key}" must contain nonempty strings without a NUL character.`);
    }
    keys.push(item);
  }
  return keys;
}

export function requireConfirmTrue(input: Input, group: Group): void {
  if (boolean(input, "confirm", false) !== true) {
    throw invalidInput(`confirm must be true to close a ${group}.`);
  }
}

export const EnvEntrySchema = Type.Object({
  name: Type.String({ description: "Environment variable name." }),
  value: Type.String({ description: "Environment variable value." }),
});

export function buildOperation(params: {
  group: Group;
  action: string;
  argv: string[];
  output: "json" | "text";
  mutation: boolean;
  deadlineMs: number;
  sensitive: string[];
}): Operation {
  return { ...params };
}
