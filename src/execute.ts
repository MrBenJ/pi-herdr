import type { Group, Input, Runner, ToolResult } from "./contracts.ts";
import { compile } from "./actions/index.ts";
import { resolveHost } from "./context.ts";
import { HerdrToolError } from "./errors.ts";
import { normalize } from "./results.ts";

export async function execute(group: Group, input: Input, context: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}, runner: Runner): Promise<ToolResult> {
  const operation = compile(group, input);
  if (context.signal?.aborted) {
    throw new HerdrToolError({ kind: "cancelled", message: "Cancelled before invocation.", remoteOutcome: "not_attempted" });
  }
  const host = resolveHost(context.env);
  let result;
  try {
    result = await runner({
      executable: host.executable, argv: operation.argv, env: host.env,
      cwd: context.cwd, deadlineMs: operation.deadlineMs, signal: context.signal,
    });
  } catch (error) {
    if (error instanceof HerdrToolError) throw error;
    // An unexpected rejection is a runner-contract violation. Do not assume
    // no remote mutation occurred, expose its raw diagnostic, or retry it.
    throw new HerdrToolError({
      kind: "transport_failed", message: "Unexpected local transport failure; no automatic retry was attempted.",
      remoteOutcome: operation.mutation ? "unknown" : "not_applicable",
    });
  }
  // Preserve normalization's own typed post-spawn failures and artifact paths.
  return normalize(operation, result);
}
