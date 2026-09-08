import fs from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { HERDR_AGENT_KINDS } from "../contracts.ts";
import { execute } from "../execute.ts";
import { createRunner } from "../transport/runner.ts";
import type { OrchestratorDependencies, TaskInput, TaskLaunchInput } from "./contracts.ts";
import { formatOrchestratorError, OrchestratorError } from "./errors.ts";
import { guardToolCall } from "./guards.ts";
import { inspectTask, launchTask } from "./launch.ts";

export const TaskSchema = Type.Object({
  action: StringEnum(["inspect", "launch"], { description: "Task operation to perform." }),
  repoRoot: Type.String({ description: "Absolute canonical main-checkout repository root." }),
  worktreeName: Type.Optional(Type.String({ description: "Safe name placed under <repo>/.worktrees/." })),
  branch: Type.Optional(Type.String({ description: "Feature branch to create or exactly reuse." })),
  baseRef: Type.Optional(Type.String({ description: "Existing commit-ish used only when creating the branch." })),
  tabLabel: Type.Optional(Type.String({ description: "Label for the one no-focus worker tab." })),
  agentName: Type.Optional(Type.String({ description: "Name for the one worker." })),
  agentKind: Type.Optional(StringEnum(HERDR_AGENT_KINDS, { description: "Supported worker kind." })),
  prompt: Type.Optional(Type.String({ description: "Task instructions placed inside a fixed boundary envelope." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "Literal native worker arguments." })),
}, { additionalProperties: false });

function invalid(message: string): never {
  throw new OrchestratorError({ code: "invalid_input", message, stage: "validate" });
}

function validateString(input: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && !value)) invalid(`${key} must be a ${allowEmpty ? "" : "nonempty "}string without NUL characters.`);
  return value;
}

export function validateTaskInput(value: unknown): TaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Input must be an object.");
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (action === "inspect") {
    if (Object.keys(input).some(key => !["action", "repoRoot"].includes(key))) invalid("inspect accepts only action and repoRoot.");
    return { action, repoRoot: validateString(input, "repoRoot") };
  }
  if (action !== "launch") invalid("action must be inspect or launch.");
  const allowed = new Set(["action", "repoRoot", "worktreeName", "branch", "baseRef", "tabLabel", "agentName", "agentKind", "prompt", "args"]);
  if (Object.keys(input).some(key => !allowed.has(key))) invalid("launch contains a caller-controlled topology field or unknown field.");
  const args = input.args;
  if (args !== undefined && (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0")))) invalid("args must contain only strings without NUL characters.");
  const agentKind = validateString(input, "agentKind");
  if (!(HERDR_AGENT_KINDS as readonly string[]).includes(agentKind)) invalid("agentKind is not supported.");
  const agentName = validateString(input, "agentName");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName)) invalid("agentName does not match the Herdr name pattern.");
  const prompt = validateString(input, "prompt", true);
  if (Buffer.byteLength(prompt, "utf8") > 256 * 1024) invalid("prompt exceeds the 256 KiB orchestration limit.");
  return {
    action,
    repoRoot: validateString(input, "repoRoot"),
    worktreeName: validateString(input, "worktreeName"),
    branch: validateString(input, "branch"),
    baseRef: validateString(input, "baseRef"),
    tabLabel: validateString(input, "tabLabel"),
    agentName,
    agentKind: agentKind as TaskLaunchInput["agentKind"],
    prompt,
    ...(args ? { args: [...args] as string[] } : {}),
  };
}

function dependencies(pi: ExtensionAPI, runner: ReturnType<typeof createRunner>): OrchestratorDependencies {
  return {
    git: async (command, args, options) => pi.exec(command, args, { cwd: options.cwd, timeout: options.deadlineMs, signal: options.signal }),
    herdr: (group, input, context) => execute(group, input, context, runner.run),
    paths: { realpath: fs.realpath, lstat: fs.lstat, access: fs.access },
    env: process.env,
  };
}

export default function orchestrator(pi: ExtensionAPI): void {
  const runner = createRunner();
  const deps = dependencies(pi, runner);
  pi.registerTool({
    name: "herdr_task",
    label: "Herdr task",
    description: "Safely inspect or launch one repository-bound worker. The orchestrator derives the sole workspace and exact <repo>/.worktrees/<name> path; callers cannot supply topology IDs or a worktree path. Launch is serial, no-focus, one-worker, and never retries or cleans up ambiguous mutations.",
    promptSnippet: "Inspect or launch one safely bounded repository worker",
    promptGuidelines: [
      "Use herdr_task launch for worker topology instead of direct workspace, tab, pane, agent-start, or git-worktree mutations.",
      "Use herdr_task inspect before uncertain launches; duplicate repository workspaces fail closed.",
    ],
    parameters: TaskSchema,
    execute: async (_id, rawInput, signal, _update, ctx) => {
      try {
        const input = validateTaskInput(rawInput);
        const result = input.action === "inspect"
          ? await inspectTask(input, deps, signal)
          : await launchTask(input, deps, signal);
        const text = input.action === "inspect"
          ? `Repository inspection complete: ${result.repository.repoRoot}`
          : `Worker launched in ${result.resources.worktree?.path ?? result.repository.repoRoot} (${result.resources.workspace?.workspaceId}/${result.resources.tab?.tabId}/${result.resources.agent?.name}).`;
        return { content: [{ type: "text", text }], details: result };
      } catch (error) {
        if (error instanceof OrchestratorError) throw new Error(formatOrchestratorError(error));
        throw error;
      }
    },
  });
  pi.on("tool_call", (event, ctx) => guardToolCall(event, ctx, deps));
  pi.on("session_shutdown", async () => { await runner.dispose(); });
}
