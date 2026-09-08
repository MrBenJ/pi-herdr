import type { LaunchResources } from "./contracts.ts";

export type OrchestratorErrorCode =
  | "invalid_input"
  | "repository_invalid"
  | "worktree_policy"
  | "worktree_collision"
  | "workspace_ambiguous"
  | "git_failed"
  | "herdr_failed"
  | "cancelled";

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly stage: string;
  readonly confirmed: LaunchResources;
  readonly ambiguous: boolean;

  constructor(input: {
    code: OrchestratorErrorCode;
    message: string;
    stage: string;
    confirmed?: LaunchResources;
    ambiguous?: boolean;
  }) {
    super(input.message.slice(0, 4096));
    this.name = "OrchestratorError";
    this.code = input.code;
    this.stage = input.stage;
    this.confirmed = input.confirmed ?? { promptSubmitted: false };
    this.ambiguous = input.ambiguous ?? false;
  }
}

export function formatOrchestratorError(error: OrchestratorError): string {
  const text = JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      stage: error.stage,
      confirmed: error.confirmed,
      ambiguous: error.ambiguous,
    },
  });
  return Buffer.byteLength(text, "utf8") <= 8192
    ? text
    : JSON.stringify({ error: { code: error.code, message: "Orchestration failed; diagnostics exceeded the public output limit.", stage: error.stage, ambiguous: error.ambiguous } });
}
