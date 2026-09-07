import type { Group, Input, Operation } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";

export type StringMode = "id" | "name" | "literal" | "text";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
