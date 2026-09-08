import path from "node:path";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { OrchestratorDependencies } from "./contracts.ts";
import { BOUNDARY_VERSION, ORCHESTRATOR_DEADLINE_MS, WORKTREE_DIR } from "./contracts.ts";

const TOPOLOGY_MUTATIONS = new Map([
  ["herdr_workspace", "create"],
  ["herdr_tab", "create"],
  ["herdr_pane", "split"],
  ["herdr_agent", "start"],
]);

function blocked(reason: string): ToolCallEventResult {
  return { block: true, reason };
}

function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const finishWord = () => { if (word) { words.push(word); word = ""; } };
  const finishSegment = () => { finishWord(); if (words.length) segments.push(words); words = []; };
  for (const character of command) {
    if (escaped) { word += character; escaped = false; continue; }
    if (quote === "single") { if (character === "'") quote = undefined; else word += character; continue; }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else if (character === "\\") escaped = true;
      else word += character;
      continue;
    }
    if (character === "'") { quote = "single"; continue; }
    if (character === '"') { quote = "double"; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (/\s/.test(character)) { if (character === "\n") finishSegment(); else finishWord(); continue; }
    if (";&|()".includes(character)) { finishSegment(); continue; }
    word += character;
  }
  finishSegment();
  return segments;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function mutatesWorktrees(words: string[]): boolean {
  let index = 0;
  if (words[index] === "command") index++;
  if (words[index] === "sudo") {
    index++;
    while (words[index]?.startsWith("-")) index++;
  }
  if (words[index] === "env") {
    index++;
    while (words[index] && (isAssignment(words[index]!) || words[index]!.startsWith("-"))) index++;
  }
  while (words[index] && isAssignment(words[index]!)) index++;
  if (words[index] !== "git") return false;
  index++;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") { index += 2; continue; }
    if (word.startsWith("-")) { index++; continue; }
    break;
  }
  if (words[index] !== "worktree") return false;
  return ["add", "move", "remove"].includes(words[index + 1] ?? "");
}

export function containsWorktreeMutation(command: string): boolean {
  return shellSegments(command).some(mutatesWorktrees);
}

async function canonicalRepositoryFromCwd(cwd: string, deps: OrchestratorDependencies): Promise<string | undefined> {
  try {
    const canonicalCwd = await deps.paths.realpath(cwd);
    const response = await deps.git("git", ["rev-parse", "--git-common-dir"], { cwd: canonicalCwd, deadlineMs: ORCHESTRATOR_DEADLINE_MS });
    if (response.code !== 0 || !response.stdout.trim()) return undefined;
    const common = await deps.paths.realpath(path.resolve(canonicalCwd, response.stdout.trim()));
    if (path.basename(common) !== ".git") return undefined;
    return deps.paths.realpath(path.dirname(common));
  } catch {
    return undefined;
  }
}

function absolutePaths(prompt: string): string[] {
  const withoutUrls = prompt.replace(/https?:\/\/[^\s'"`<>]+/g, "");
  return [...withoutUrls.matchAll(/\/[A-Za-z0-9._~+@%=-][^\s'"`<>]*/g)]
    .map(match => match[0].replace(/[),.:;!?]+$/g, ""));
}

async function resolvedCandidate(candidate: string, deps: OrchestratorDependencies): Promise<string> {
  let cursor = candidate;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await deps.paths.realpath(cursor);
      return path.resolve(canonical, ...suffix.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(candidate);
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function boundary(root: string): string {
  return [
    `BEGIN REPOSITORY EXECUTION BOUNDARY v${BOUNDARY_VERSION}`,
    `Canonical repository: ${root}`,
    `Worktrees: ${root}/${WORKTREE_DIR}/<name> only`,
    "This Todo prompt does not authorize creating Herdr workspaces, worktrees, tabs, panes, agents, subagents, or background jobs.",
    "Use herdr_task launch for execution topology.",
    `END REPOSITORY EXECUTION BOUNDARY v${BOUNDARY_VERSION}`,
  ].join("\n");
}

async function guardTodo(event: ToolCallEvent, cwd: string, deps: OrchestratorDependencies): Promise<ToolCallEventResult | undefined> {
  const input = event.input as Record<string, unknown>;
  if (!(["add", "update"].includes(String(input.action)))) return undefined;
  const tags = input.tags;
  if (!Array.isArray(tags) || !tags.includes("enqueue")) return undefined;
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.includes("\0")) {
    return blocked("An enqueued Todo requires a standalone prompt without NUL characters.");
  }
  const root = await canonicalRepositoryFromCwd(cwd, deps);
  if (!root) return blocked("An enqueued Todo requires a canonical Git repository context.");
  for (const candidate of absolutePaths(input.prompt)) {
    if (!inside(root, await resolvedCandidate(candidate, deps))) {
      return blocked(`Enqueued Todo prompt path is outside the canonical repository ${root}.`);
    }
  }
  const footer = boundary(root);
  if (!input.prompt.trimEnd().endsWith(footer)) input.prompt = `${input.prompt.trimEnd()}\n\n${footer}`;
  return undefined;
}

export async function guardToolCall(event: ToolCallEvent, context: { cwd: string }, deps: OrchestratorDependencies): Promise<ToolCallEventResult | undefined> {
  const mutation = TOPOLOGY_MUTATIONS.get(event.toolName);
  const input = event.input as Record<string, unknown>;
  if (mutation && input.action === mutation) {
    return blocked(`Direct topology mutation is disabled while the orchestrator is enabled. Use herdr_task launch instead of ${event.toolName} ${mutation}.`);
  }
  if (event.toolName === "bash" && typeof event.input.command === "string" && containsWorktreeMutation(event.input.command)) {
    return blocked("Direct git worktree mutation is disabled while the orchestrator is enabled. Use herdr_task launch.");
  }
  if (event.toolName === "todo") return guardTodo(event, context.cwd, deps);
  return undefined;
}
