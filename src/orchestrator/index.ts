import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { OrchestratorError } from "./errors.ts";

const TaskSchema = Type.Object({
  action: StringEnum(["inspect", "launch"], { description: "Task operation to perform." }),
  repoRoot: Type.String({ description: "Canonical repository root." }),
});

export default function orchestrator(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "herdr_task",
    label: "Herdr task",
    description: "Safely inspect or launch one repository-bound worker.",
    promptSnippet: "Inspect or launch one repository-bound worker",
    promptGuidelines: ["Use herdr_task rather than direct topology mutations."],
    parameters: TaskSchema,
    execute: async () => {
      throw new OrchestratorError({
        code: "invalid_input",
        message: "Orchestrator implementation is not wired.",
        stage: "validate",
      });
    },
  });
  pi.on("tool_call", () => undefined);
  pi.on("session_shutdown", () => undefined);
}
