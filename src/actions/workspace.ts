import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Input, Operation } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";
import { assertAllowed, assertRecord, boolean, buildOperation, envFlags, requiredString } from "./shared.ts";

const DEADLINE_MS = 30000;

const EnvEntrySchema = Type.Object({
  name: Type.String({ description: "Environment variable name." }),
  value: Type.String({ description: "Environment variable value." }),
});

export const WorkspaceSchema = Type.Object({
  action: StringEnum(["list", "inspect", "create", "focus", "close"], {
    description: "Workspace operation to perform.",
  }),
  workspaceId: Type.Optional(Type.String({ description: "Opaque workspace ID." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a new workspace." })),
  label: Type.Optional(Type.String({ description: "Optional label for a new workspace." })),
  env: Type.Optional(Type.Array(EnvEntrySchema, { description: "Launch environment for a new workspace." })),
  focus: Type.Optional(Type.Boolean({ description: "Focus the new workspace once created." })),
  confirm: Type.Optional(Type.Boolean({ description: "Must be true to close a workspace." })),
});

function requireConfirmTrue(input: Input): void {
  if (boolean(input, "confirm", false) !== true) {
    throw new HerdrToolError({
      kind: "invalid_input",
      message: "confirm must be true to close a workspace.",
      remoteOutcome: "not_attempted",
    });
  }
}

export function compileWorkspace(input: Input): Operation {
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
      assertAllowed(input, []);
      return buildOperation({
        group: "workspace",
        action,
        argv: ["workspace", "list"],
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "inspect": {
      assertAllowed(input, ["workspaceId"]);
      const workspaceId = requiredString(input, "workspaceId", "id");
      return buildOperation({
        group: "workspace",
        action,
        argv: ["workspace", "get", workspaceId],
        output: "json",
        mutation: false,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "create": {
      assertAllowed(input, ["cwd", "label", "env", "focus"]);
      const cwd = requiredString(input, "cwd", "literal");
      const argv = ["workspace", "create", "--cwd", cwd];
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
        group: "workspace",
        action,
        argv,
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive,
      });
    }
    case "focus": {
      assertAllowed(input, ["workspaceId"]);
      const workspaceId = requiredString(input, "workspaceId", "id");
      return buildOperation({
        group: "workspace",
        action,
        argv: ["workspace", "focus", workspaceId],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    case "close": {
      assertAllowed(input, ["workspaceId", "confirm"]);
      const workspaceId = requiredString(input, "workspaceId", "id");
      requireConfirmTrue(input);
      return buildOperation({
        group: "workspace",
        action,
        argv: ["workspace", "close", workspaceId],
        output: "json",
        mutation: true,
        deadlineMs: DEADLINE_MS,
        sensitive: [],
      });
    }
    default:
      throw new HerdrToolError({
        kind: "invalid_input",
        message: `Unsupported workspace action "${action}".`,
        remoteOutcome: "not_attempted",
      });
  }
}
