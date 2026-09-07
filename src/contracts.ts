export type Group = "workspace" | "tab" | "pane" | "agent";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Input = Record<string, unknown>;

export interface Operation {
  group: Group;
  action: string;
  argv: string[];
  output: "json" | "text";
  mutation: boolean;
  deadlineMs: number;
  sensitive: string[];
}

export interface HostContext {
  executable: string;
  env: NodeJS.ProcessEnv;
}

export interface Capture {
  path: string;
  preview: string;
  bytes: number;
  lines: number;
  truncated: boolean;
  complete: boolean;
  ioFailed: boolean;
}

export interface RunResult {
  exitCode: number | null;
  stop?: "timeout" | "cancelled" | "resource_limit" | "transport_failed";
  stdout: Capture;
  stderr: Capture;
  spawned: boolean;
}

export interface RunRequest {
  executable: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  deadlineMs: number;
  signal?: AbortSignal;
}

export type Runner = (request: RunRequest) => Promise<RunResult>;

export interface Details {
  group: Group;
  action: string;
  result?: Json;
  resultOmitted?: boolean;
  output?: string;
  stdoutPath?: string;
  stderrPath?: string;
  truncated: boolean;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
}

export type FailureKind =
  | "invalid_input" | "missing_host" | "missing_executable"
  | "server_unavailable" | "timeout" | "cancelled"
  | "malformed_output" | "operation_failed" | "transport_failed"
  | "response_too_large" | "resource_limit";

export interface Failure {
  kind: FailureKind;
  message: string;
  herdrCode?: string;
  exitCode?: number | null;
  remoteOutcome: "not_attempted" | "unknown" | "not_applicable";
  stdoutPath?: string;
  stderrPath?: string;
}
