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
  requireConfirmTrue,
  requiredString,
} from "./shared.ts";

const DEADLINE_MS = 30000;

export const TabSchema = Type.Object({
  action: StringEnum(["list", "inspect", "create", "rename", "focus", "close"], {
    description: "Tab operation to perform.",
  }),
  workspaceId: Type.Optional(Type.String({ description: "Opaque workspace ID." })),
  tabId: Type.Optional(Type.String({ description: "Opaque tab ID." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a new tab." })),
  label: Type.Optional(Type.String({ description: "Label for a new or renamed tab." })),
  env: Type.Optional(Type.Array(EnvEntrySchema, { description: "Launch environment for a new tab." })),
  focus: Type.Optional(Type.Boolean({ description: "Focus the new tab once created." })),
  confirm: Type.Optional(Type.Boolean({ description: "Must be true to close a tab." })),
});

export function compileTab(input: Input): Operation {
  assertRecord(input);
  const action = input["action"];
  if (typeof action !== "string") {
    throw new HerdrToolError({
      kind: "invalid_input",
      message: "action is required and must be a string.",
      remoteOutcome: "not_attempted",
    });
  }

  switch (action) {
    case "list": {
      assertAllowed(input, ["workspaceId"]);
      const argv = ["tab", "list"];
      if ("workspaceId" in input) {
        argv.push("--workspace", requiredString(input, "workspaceId", "id"));
      }
      return buildOperation({
        group: "tab",
        action,
        argv,
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "inspect": {
      assertAllowed(input, ["tabId"]);
      const tabId = requiredString(input, "tabId", "id");
      return buildOperation({
        group: "tab",
        action,
        argv: ["tab", "get", tabId],
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "create": {
      assertAllowed(input, ["workspaceId", "cwd", "label", "env", "focus"]);
      const workspaceId = requiredString(input, "workspaceId", "id");
      const cwd = requiredString(input, "cwd", "literal");
      const argv = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd];
      if ("label" in input) {
        argv.push("--label", requiredString(input, "label", "literal"));
      }
      const envArgs = envFlags(input);
      for (const flag of envArgs) {
        argv.push("--env", flag);
      }
      const focus = boolean(input, "focus", false);
      argv.push(focus ? "--focus" : "--no-focus");
      const sensitive = envArgs.map((flag) => flag.slice(flag.indexOf("=") + 1));
      return buildOperation({
        group: "tab",
        action,
        argv,
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive,
      });
    }
    case "rename": {
      assertAllowed(input, ["tabId", "label"]);
      const tabId = requiredString(input, "tabId", "id");
      const label = requiredString(input, "label", "literal");
      return buildOperation({
        group: "tab",
        action,
        argv: ["tab", "rename", tabId, label],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "focus": {
      assertAllowed(input, ["tabId"]);
      const tabId = requiredString(input, "tabId", "id");
      return buildOperation({
        group: "tab",
        action,
        argv: ["tab", "focus", tabId],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "close": {
      assertAllowed(input, ["tabId", "confirm"]);
      const tabId = requiredString(input, "tabId", "id");
      requireConfirmTrue(input, "tab");
      return buildOperation({
        group: "tab",
        action,
        argv: ["tab", "close", tabId],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    default:
      throw new HerdrToolError({
        kind: "invalid_input",
        message: `Unsupported tab action "${action}".`,
        remoteOutcome: "not_attempted",
      });
  }
}
