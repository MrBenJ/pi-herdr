# Safe Task Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use subagents, background jobs, detached processes, parallel task execution, or additional Herdr workers.

**Goal:** Add a separately registered, policy-enforcing orchestrator extension that launches exactly one worker in `<canonical-repo-root>/.worktrees/<name>` and reuses the repository's sole existing Herdr workspace.

**Architecture:** Keep `src/index.ts` and its four primitive Herdr tools unchanged in responsibility. Add `src/orchestrator/index.ts` as a second Pi extension entry point, backed by focused repository-policy, Herdr-inventory, launch-state-machine, boundary-prompt, and tool-call-guard modules. The orchestrator composes injected git and Herdr runners directly, constructs every topology path itself, and blocks models from bypassing it through raw creation/start tools or direct Bash worktree mutations while the orchestrator is loaded.

**Tech Stack:** TypeScript 7, Node.js >=22.19, Pi Extension API 0.85.1, TypeBox 1.3.7, Vitest 5, Herdr CLI 0.8.2, Node standard library, argument-array subprocess execution.

**Spec:** `docs/superpowers/specs/2026-09-08-safe-task-orchestrator-design.md`

## Global Constraints

- Execute this plan serially in this session; do not dispatch subagents or background work.
- Work only in `/Users/bjunya/code/hbai/opensource/pi-herdr/.worktrees/orchestrator-constraints` on `feat/orchestrator-constraints`.
- Do not touch, resume, move, clean, or delete `/Users/bjunya/code/aria-actions-pi-harness` or any active `aria-actions` state.
- Do not change the low-level schemas or semantics of `herdr_workspace`, `herdr_tab`, `herdr_pane`, or `herdr_agent`.
- The orchestrator is a second extension entry point inside this package, not a new repository or package.
- Every orchestrated worktree path is exactly `<canonical-repo-root>/.worktrees/<name>`.
- Reject sibling paths, `/tmp` worktrees, `.claude/worktrees`, visible `worktrees`, configurable worktree roots, and symlink escapes.
- One canonical repository may map to zero or one Herdr workspace. Zero permits one no-focus workspace creation; one is reused; more than one fails closed.
- One launch creates or exactly reuses one worktree, creates one no-focus tab, starts one worker, and submits one bounded prompt.
- No automatic retries, cleanup, close, branch deletion, worktree removal, merge, or rollback.
- Todo prose tracks work and never grants topology or delegation authority.
- Use executable/argv arrays for git and Herdr; never shell-interpolate caller input.
- Preserve hosting-socket selection, cancellation, output bounds, redaction, and conservative ambiguous-mutation semantics.

## File Map

### Existing files modified

- `package.json` — declare both Pi extension entry points and keep package contents/runtime peers correct.
- `src/contracts.ts` — export the supported Herdr agent-kind tuple for reuse without duplicating values.
- `src/actions/agent.ts` — import the shared tuple; no public schema or argv change.
- `tests/support/harness.ts` — support orchestrator `tool_call` registration while preserving strict unexpected-API detection.
- `tests/package.test.ts` — prove independent primitive/orchestrator discovery from the packed package.
- `README.md` — explain primitive versus orchestrator installation and safe launch behavior.
- `docs/tool-contract.md` — document `herdr_task` actions and policy hooks.
- `docs/compatibility.md` — record git and Herdr assumptions used by the orchestrator.
- `docs/manual-smoke.md` — add read-only inventory and explicitly authorized disposable launch procedures.
- `docs/release-checklist.md` — add orchestrator safety checks.

### New implementation files

- `src/orchestrator/contracts.ts` — public input/result types, injected dependency interfaces, stage/state types, constants.
- `src/orchestrator/errors.ts` — typed orchestrator failures and bounded public formatting.
- `src/orchestrator/repository.ts` — canonical git-root validation, `.worktrees` policy, branch/ref checks, and exact worktree reconciliation.
- `src/orchestrator/herdr-inventory.ts` — list/canonicalize workspaces through their pane CWDs and enforce zero/one/many matching behavior.
- `src/orchestrator/prompt.ts` — append the fixed worker boundary envelope.
- `src/orchestrator/launch.ts` — ordered launch transaction with confirmed-state reporting and no rollback/retry.
- `src/orchestrator/guards.ts` — block direct topology mutations, direct agent starts, worktree Bash mutations, and unsafe enqueued Todo prompts.
- `src/orchestrator/index.ts` — register `herdr_task`, register guards, own/dispose runners.

### New test files

- `tests/orchestrator-repository.test.ts` — temporary git repository tests for canonical root and worktree policy.
- `tests/orchestrator-inventory.test.ts` — fake Herdr/git identity tests for workspace reuse and duplicates.
- `tests/orchestrator-prompt.test.ts` — exact boundary-envelope tests.
- `tests/orchestrator-launch.test.ts` — state-machine success, reuse, and every-stage failure tests.
- `tests/orchestrator-guards.test.ts` — direct-tool and Todo policy-hook tests.
- `tests/orchestrator-extension.test.ts` — schema, registration, execution, cancellation, and disposal tests.

---

### Task 1: Freeze shared contracts and build the orchestrator test harness

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/actions/agent.ts`
- Modify: `tests/support/harness.ts`
- Modify: `tests/actions.test.ts`
- Create: `src/orchestrator/contracts.ts`
- Create: `src/orchestrator/errors.ts`
- Test: `tests/orchestrator-extension.test.ts`

**Interfaces:**
- Consumes: existing `Runner`, `ToolResult`, `RunRequest`, `Json`, and Herdr 0.8.2 agent-kind values.
- Produces:
  - `HERDR_AGENT_KINDS` readonly tuple.
  - `HerdrAgentKind` union.
  - `TaskInspectInput`, `TaskLaunchInput`, `TaskInput`.
  - `RepositoryIdentity`, `WorktreeState`, `WorkspaceMatch`, `LaunchResources`, `LaunchResult`.
  - `GitRunner`, `HerdrExecutor`, `PathOps`, `OrchestratorDependencies`.
  - `OrchestratorError` with `code`, `message`, `stage`, `confirmed`, and `ambiguous`.

- [x] **Step 1: Write the failing shared-kind and registration tests**

Add `tests/orchestrator-extension.test.ts` with assertions that the orchestrator module can import a single `HERDR_AGENT_KINDS` source and that a future orchestrator factory registers one `herdr_task` tool plus one `tool_call` hook without registering primitive tools.

Use this initial test shape:

```ts
import { expect, it, vi } from "vitest";
import { HERDR_AGENT_KINDS } from "../src/contracts.ts";
import orchestrator from "../src/orchestrator/index.ts";
import { registrationHarness } from "./support/harness.ts";

it("exports the one frozen Herdr agent-kind list", () => {
  expect(HERDR_AGENT_KINDS).toContain("pi");
  expect(HERDR_AGENT_KINDS).toContain("claude");
  expect(new Set(HERDR_AGENT_KINDS).size).toBe(HERDR_AGENT_KINDS.length);
});

it("registers only the orchestration tool and its policy hook", () => {
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  expect([...harness.tools.keys()]).toEqual(["herdr_task"]);
  expect(harness.handlers.get("tool_call")).toHaveLength(1);
  expect(harness.handlers.get("session_shutdown")).toHaveLength(1);
});
```

Temporarily import `orchestrator` only after creating a minimal module stub if Vitest cannot collect a missing import. The first executable RED state must fail because the exported tuple, harness support, and orchestrator module do not exist—not because of malformed test syntax.

- [x] **Step 2: Run the focused tests and confirm RED**

Run:

```sh
npm test -- tests/orchestrator-extension.test.ts tests/actions.test.ts
```

Expected: failure naming the missing orchestrator module or `HERDR_AGENT_KINDS`. Record the exact failure in the implementation notes.

- [x] **Step 3: Export the shared Herdr agent-kind tuple**

In `src/contracts.ts`, add:

```ts
export const HERDR_AGENT_KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "qwen", "maki",
] as const;

export type HerdrAgentKind = (typeof HERDR_AGENT_KINDS)[number];
```

Replace the local `KINDS` tuple in `src/actions/agent.ts` with an import alias:

```ts
import { HERDR_AGENT_KINDS as KINDS } from "../contracts.ts";
```

Do not alter `AgentSchema`, validation text, or generated argv. Extend the existing agent-kind assertions in `tests/actions.test.ts` to prove the public schema still accepts every value and rejects a nonmember.

- [x] **Step 4: Generalize the registration harness without weakening it**

Change `registrationHarness()` to:

```ts
export function registrationHarness(options: { allowedEvents?: string[] } = {}) {
  const allowedEvents = new Set(options.allowedEvents ?? ["session_shutdown"]);
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  // registerTool remains duplicate-rejecting.
  // on rejects event names outside allowedEvents and records accepted handlers.
  // returned object exposes tools, handlers, and shutdown as the
  // session_shutdown array for existing tests.
}
```

Keep the Proxy that throws on unexpected Pi API access. Existing primitive extension tests must pass unchanged.

- [x] **Step 5: Define explicit orchestrator contracts**

Create `src/orchestrator/contracts.ts` with these exact public shapes:

```ts
import type { HerdrAgentKind, Json, ToolResult } from "../contracts.ts";

export const ORCHESTRATOR_DEADLINE_MS = 30_000;
export const WORKTREE_DIR = ".worktrees";
export const BOUNDARY_VERSION = 1;

export interface TaskInspectInput {
  action: "inspect";
  repoRoot: string;
}

export interface TaskLaunchInput {
  action: "launch";
  repoRoot: string;
  worktreeName: string;
  branch: string;
  baseRef: string;
  tabLabel: string;
  agentName: string;
  agentKind: HerdrAgentKind;
  prompt: string;
  args?: string[];
}

export type TaskInput = TaskInspectInput | TaskLaunchInput;

export interface RepositoryIdentity {
  repoRoot: string;
  gitCommonDir: string;
  defaultBranch: string;
  worktreeRoot: string;
}

export interface WorktreeState {
  path: string;
  branch: string;
  head: string;
  disposition: "existing" | "created";
}

export interface WorkspaceMatch {
  workspaceId: string;
  paneIds: string[];
  canonicalRepoRoot: string;
}

export interface LaunchResources {
  worktree?: WorktreeState;
  workspace?: { workspaceId: string; disposition: "existing" | "created" };
  tab?: { tabId: string; paneId: string };
  agent?: { name: string; paneId: string };
  promptSubmitted: boolean;
}

export interface LaunchResult {
  action: "inspect" | "launch";
  repository: RepositoryIdentity;
  resources: LaunchResources;
  violations: string[];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (command: string, args: string[], options: {
  cwd: string;
  deadlineMs: number;
  signal?: AbortSignal;
}) => Promise<ExecResult>;

export type HerdrExecutor = (
  group: "workspace" | "tab" | "pane" | "agent",
  input: Record<string, unknown>,
  context: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<ToolResult>;

export interface PathOps {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  access(path: string): Promise<void>;
}

export interface OrchestratorDependencies {
  git: GitRunner;
  herdr: HerdrExecutor;
  paths: PathOps;
  env: NodeJS.ProcessEnv;
}
```

Use `Json` only for helpers that parse `details.result`; remove the import if the final module does not need it.

- [x] **Step 6: Define bounded orchestrator errors**

Create `src/orchestrator/errors.ts`:

```ts
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
```

Add `formatOrchestratorError(error)` returning JSON text capped below 8 KiB and excluding raw stderr, environment, native args, and prompt content.

- [x] **Step 7: Add the minimal orchestrator entry-point skeleton**

Create `src/orchestrator/index.ts` with a default factory that registers a temporary `herdr_task` definition and `tool_call`/`session_shutdown` handlers. The temporary tool must throw `OrchestratorError({ code: "invalid_input", message: "Orchestrator implementation is not wired.", stage: "validate" })`; it must not execute git or Herdr. Later tasks replace the skeleton.

- [x] **Step 8: Run focused and primitive regression tests**

Run:

```sh
npm test -- tests/orchestrator-extension.test.ts tests/actions.test.ts tests/extension.test.ts
npm run typecheck
```

Expected: all selected tests pass and the primitive tool registration remains exactly four tools.

- [x] **Step 9: Commit Task 1**

```sh
git add src/contracts.ts src/actions/agent.ts src/orchestrator/contracts.ts src/orchestrator/errors.ts src/orchestrator/index.ts tests/support/harness.ts tests/actions.test.ts tests/orchestrator-extension.test.ts
git commit -m "feat(orchestrator): define bounded task contracts"
```

---

### Task 2: Enforce canonical repository and worktree placement

**Files:**
- Create: `src/orchestrator/repository.ts`
- Create: `tests/orchestrator-repository.test.ts`
- Modify: `src/orchestrator/contracts.ts`

**Interfaces:**
- Consumes: `GitRunner`, `PathOps`, `RepositoryIdentity`, `WorktreeState`, `WORKTREE_DIR`, cancellation signal.
- Produces:
  - `validateRepository(repoRoot, deps, signal): Promise<RepositoryIdentity>`.
  - `validateWorktreeName(name): string`.
  - `desiredWorktreePath(repository, name): string`.
  - `inspectWorktrees(repository, git, signal): Promise<RegisteredWorktree[]>`.
  - `ensureWorktree(request, repository, deps, signal): Promise<WorktreeState>`.

- [x] **Step 1: Create temporary-repository test helpers**

In `tests/orchestrator-repository.test.ts`, implement `makeRepo()` using `fs.mkdtemp`, `git init -b main`, local test identity configuration, one committed file, and `.gitignore` containing `/.worktrees/`. Return `{ root, cleanup }`. Invoke git through `execFile`, never shell strings.

- [x] **Step 2: Write failing canonical-root tests**

Add tests asserting:

```ts
await expect(validateRepository("relative/path", deps)).rejects.toMatchObject({ code: "repository_invalid" });
await expect(validateRepository(nonRepo, deps)).rejects.toMatchObject({ code: "repository_invalid" });
await expect(validateRepository(linkedWorktreePath, deps)).rejects.toMatchObject({ code: "repository_invalid" });
await expect(validateRepository(path.join(root, "subdir"), deps)).rejects.toMatchObject({ code: "repository_invalid" });
expect((await validateRepository(root, deps)).worktreeRoot).toBe(path.join(root, ".worktrees"));
```

Also remove the `.gitignore` entry in one fixture and assert a `worktree_policy` error naming `/.worktrees/` without modifying `.gitignore`.

- [x] **Step 3: Write failing worktree-name and path tests**

Accept `pi-harness`, `fix_123`, and `review.2`. Reject empty strings, `.`, `..`, `a/b`, `a\\b`, `/tmp/x`, `.claude`, leading `-`, whitespace, control characters, and names longer than 80 characters. Assert `desiredWorktreePath` always returns `path.join(root, ".worktrees", acceptedName)`.

- [x] **Step 4: Write failing exact-reuse and collision tests**

Cover:

- absent branch/path → one `git worktree add <exact-path> -b <branch> <baseRef>` call;
- exact registered path and branch → no add call and `disposition: "existing"`;
- existing requested branch at a different path → `worktree_collision`;
- existing requested path on a different branch → `worktree_collision`;
- filesystem path exists but is not a registered worktree → `worktree_collision`;
- symlink exists at the requested path and resolves outside `.worktrees` → `worktree_policy`;
- default branch requested as feature branch → `invalid_input`;
- nonexistent `baseRef` → `git_failed` before mutation;
- aborted signal → `cancelled` before mutation.

- [x] **Step 5: Run the repository tests and confirm RED**

```sh
npm test -- tests/orchestrator-repository.test.ts
```

Expected: collection or assertion failures because `repository.ts` is absent.

- [x] **Step 6: Implement repository command helpers**

In `repository.ts`, add one private helper:

```ts
async function gitChecked(
  git: GitRunner,
  args: string[],
  cwd: string,
  stage: string,
  signal?: AbortSignal,
): Promise<string>
```

It checks `signal.aborted`, calls `git("git", args, { cwd, deadlineMs: 30_000, signal })`, requires `code === 0`, trims stdout only where a scalar is expected, and throws a bounded `git_failed` error without reflecting arbitrary stderr.

- [x] **Step 7: Implement canonical main-checkout validation**

`validateRepository` must:

1. reject nonabsolute input;
2. `realpath` the input;
3. run `rev-parse --show-toplevel`, realpath the result, and require equality;
4. run `rev-parse --git-dir` and `rev-parse --git-common-dir`, resolve both against root, realpath existing directories, and require equality so a linked worktree is rejected;
5. resolve default branch using `refs/remotes/origin/HEAD`, then local `main`, then local `master`, failing if none exists;
6. run `check-ignore -q .worktrees` and require exit code zero;
7. return normalized root/common/worktree paths.

Do not create directories in validation.

- [x] **Step 8: Parse `git worktree list --porcelain` deterministically**

Add:

```ts
export interface RegisteredWorktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
}
```

Parse blank-line-separated records. Require one `worktree` and one `HEAD` line per record. Normalize `branch refs/heads/x` to `x`. Reject malformed records as `git_failed`; do not silently drop them.

- [x] **Step 9: Implement exact worktree reconciliation**

`ensureWorktree` validates branch/ref before filesystem mutation, compares canonical inventory, and invokes exactly:

```ts
await git("git", ["worktree", "add", desiredPath, "-b", branch, baseRef], {
  cwd: repository.repoRoot,
  deadlineMs: ORCHESTRATOR_DEADLINE_MS,
  signal,
});
```

After successful creation, rerun worktree inventory and require the exact path/branch record. Return its HEAD. If add returns an ambiguous timeout/cancellation result under the chosen GitRunner representation, throw with `ambiguous: true`; never retry or remove the path.

- [x] **Step 10: Run repository tests and typecheck**

```sh
npm test -- tests/orchestrator-repository.test.ts
npm run typecheck
```

Expected: all repository tests pass.

- [x] **Step 11: Commit Task 2**

```sh
git add src/orchestrator/contracts.ts src/orchestrator/repository.ts tests/orchestrator-repository.test.ts
git commit -m "feat(orchestrator): enforce repo-local worktrees"
```

---

### Task 3: Inventory Herdr workspaces by canonical repository identity

**Files:**
- Create: `src/orchestrator/herdr-inventory.ts`
- Create: `tests/orchestrator-inventory.test.ts`
- Modify: `src/orchestrator/contracts.ts`

**Interfaces:**
- Consumes: `HerdrExecutor`, `GitRunner`, `PathOps`, `RepositoryIdentity`, normalized low-level `ToolResult.details.result`.
- Produces:
  - `InventoryWorkspace` and `HerdrInventory`.
  - `inventoryHerdr(repository, deps, signal): Promise<HerdrInventory>`.
  - `selectWorkspace(inventory): WorkspaceMatch | undefined`.

- [x] **Step 1: Define fixture result builders**

In `tests/orchestrator-inventory.test.ts`, create helpers returning low-level `ToolResult` values for:

```ts
workspaceList([{ workspace_id: "wE", label: "aria-actions" }]);
paneList([{ pane_id: "wE:p1", workspace_id: "wE", cwd: repoRoot }]);
```

Include `details: { group, action, result, truncated: false }`. Use a queued fake `HerdrExecutor` that records `(group,input)` pairs.

- [x] **Step 2: Write failing inventory tests**

Cover:

- no workspaces → no match;
- one workspace with a root pane at `repoRoot` → one match;
- one workspace whose pane is at `repoRoot/.worktrees/x` → canonicalizes to the same repo;
- a workspace with multiple panes in the same repo → one workspace match with all pane IDs;
- unrelated workspace → ignored;
- two workspaces with panes canonicalizing to the same repo → `workspace_ambiguous` listing both IDs;
- malformed workspace-list or pane-list result → `herdr_failed`;
- truncated low-level result → `herdr_failed` because topology decisions require complete inventory;
- pane CWD missing/deleted/non-git → recorded as an inventory violation, not matched;
- cancellation between workspace list and pane list → `cancelled` and no later calls.

- [x] **Step 3: Run inventory tests and confirm RED**

```sh
npm test -- tests/orchestrator-inventory.test.ts
```

Expected: failure because `herdr-inventory.ts` does not exist.

- [x] **Step 4: Add strict result extractors**

Implement private extractors that accept both the documented result envelope keys and fail on unexpected shapes. Do not infer IDs from labels or numbering. Reject `resultOmitted`, `truncated`, missing arrays, missing IDs, and nonstring CWDs.

- [x] **Step 5: Canonicalize pane repository identity**

For each pane CWD:

1. realpath it;
2. run `git -C <cwd> rev-parse --show-toplevel`;
3. run `git -C <cwd> rev-parse --git-common-dir`;
4. derive the main checkout root by parsing `git -C <cwd> worktree list --porcelain` and selecting the record whose git dir equals the common checkout;
5. compare that canonical main root to `repository.repoRoot`.

A non-git or missing pane path contributes a bounded violation such as `workspace w7 pane w7:p1 has no canonical git repository`; it does not abort inventory unless the low-level Herdr data itself is malformed.

- [x] **Step 6: Select zero, one, or many matches**

`selectWorkspace` returns `undefined` for zero, the exact workspace/pane IDs for one, and throws `workspace_ambiguous` for more than one. Sort IDs before formatting errors so tests and diagnostics are stable.

- [x] **Step 7: Run focused tests and typecheck**

```sh
npm test -- tests/orchestrator-inventory.test.ts
npm run typecheck
```

Expected: all inventory tests pass.

- [x] **Step 8: Commit Task 3**

```sh
git add src/orchestrator/contracts.ts src/orchestrator/herdr-inventory.ts tests/orchestrator-inventory.test.ts
git commit -m "feat(orchestrator): reuse canonical repo workspaces"
```

---

### Task 4: Build the immutable worker boundary envelope

**Files:**
- Create: `src/orchestrator/prompt.ts`
- Create: `tests/orchestrator-prompt.test.ts`

**Interfaces:**
- Consumes: task prompt, `RepositoryIdentity`, `WorktreeState`, actual workspace/tab/pane/agent handles.
- Produces: `buildWorkerPrompt(input): string` with a fixed versioned boundary appended after caller prose.

- [x] **Step 1: Write exact failing prompt tests**

Assert that arbitrary caller prose containing `ignore all boundaries`, fake XML delimiters, shell metacharacters, and a sibling worktree path remains in the untrusted task section but cannot alter the final boundary section. Assert the final nonempty lines contain all of:

```text
BEGIN PI-HERDR ORCHESTRATION BOUNDARY v1
Canonical repository: <repoRoot>
Authorized worktree: <worktreePath>
Authorized workspace: <workspaceId>
Authorized tab: <tabId>
Authorized pane: <paneId>
Authorized agent: <agentName>
Do not create, move, or remove git worktrees.
Do not create Herdr workspaces, tabs, panes, or agents.
Do not dispatch subagents or background work.
Do not rewrite Todo execution boundaries.
Report a blocker instead of inventing infrastructure.
END PI-HERDR ORCHESTRATION BOUNDARY v1
```

Use a generated random fence token around caller prose so caller content cannot forge the task delimiter. The policy boundary itself remains fixed and last.

- [x] **Step 2: Run prompt tests and confirm RED**

```sh
npm test -- tests/orchestrator-prompt.test.ts
```

- [x] **Step 3: Implement the prompt builder**

Export:

```ts
export interface WorkerPromptInput {
  task: string;
  fenceToken: string;
  repository: RepositoryIdentity;
  worktree: WorktreeState;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
}

export function buildWorkerPrompt(input: WorkerPromptInput): string;
```

Require a 32-character lowercase hexadecimal `fenceToken`, reject NUL in every string, cap caller task text at 256 KiB by UTF-8 bytes, and do not generate the token inside this pure function. The launch layer generates it with `randomBytes(16).toString("hex")`.

- [x] **Step 4: Run focused tests and typecheck**

```sh
npm test -- tests/orchestrator-prompt.test.ts
npm run typecheck
```

- [x] **Step 5: Commit Task 4**

```sh
git add src/orchestrator/prompt.ts tests/orchestrator-prompt.test.ts
git commit -m "feat(orchestrator): bind worker prompts to topology"
```

---

### Task 5: Implement the serial launch state machine

**Files:**
- Create: `src/orchestrator/launch.ts`
- Create: `tests/orchestrator-launch.test.ts`
- Modify: `src/orchestrator/contracts.ts`
- Modify: `src/orchestrator/errors.ts`

**Interfaces:**
- Consumes: repository validation, worktree reconciliation, Herdr inventory, low-level execution, boundary prompt.
- Produces:
  - `inspectTask(input, deps, signal): Promise<LaunchResult>`.
  - `launchTask(input, deps, signal): Promise<LaunchResult>`.
  - complete confirmed-resource state on every failure.

- [x] **Step 1: Build a deterministic dependency recorder**

In `tests/orchestrator-launch.test.ts`, define injected fakes that append records to one ordered `calls` array. Provide complete success fixtures for workspace list, pane lists, workspace creation, tab creation, agent start, and agent prompt. Do not invoke real git or Herdr.

- [x] **Step 2: Write the failing read-only inspect test**

Assert `inspectTask` calls repository validation and Herdr inventory but never invokes `git worktree add`, workspace create, tab create, agent start, or agent prompt. Its result includes repository identity, current exact worktrees, matching workspace, and inventory violations.

- [x] **Step 3: Write the failing existing-workspace launch test**

For an exact existing worktree and one existing workspace, assert the ordered mutation tail is:

```ts
[
  ["herdr", "tab", { action: "create", workspaceId: "wE", cwd: worktreePath, label: "pi-harness", focus: false }],
  ["herdr", "agent", { action: "start", name: "pi-harness", kind: "pi", paneId: "wE:p2", args: [] }],
  ["herdr", "agent", { action: "prompt", target: "pi-harness", text: expect.stringContaining("Authorized worktree") }],
]
```

Assert there is no workspace-create call and no second worker.

- [x] **Step 4: Write the failing no-workspace launch test**

For zero matching workspaces, assert exactly one:

```ts
["herdr", "workspace", {
  action: "create",
  cwd: repoRoot,
  label: path.basename(repoRoot),
  focus: false,
}]
```

Use the returned workspace ID for the tab. Do not use the workspace creation's root pane as the worker pane; the worker belongs to the worktree tab created next.

- [x] **Step 5: Write failing worktree-create and exact-reuse tests**

Assert creation occurs before any Herdr mutation, exact reuse performs no git mutation, and collision errors perform no Herdr calls.

- [x] **Step 6: Write one failure test for every mutation boundary**

Cover failure after:

1. repository validation;
2. inventory;
3. `git worktree add` with ambiguous result;
4. workspace create with unknown remote outcome;
5. tab create with unknown remote outcome;
6. agent start with unknown remote outcome;
7. agent prompt with unknown remote outcome.

For each, assert:

- no failed mutation is retried;
- no close/remove/delete command is emitted;
- `confirmed` contains only resources proven by prior successful results;
- `ambiguous` is true when the underlying failure's `remoteOutcome` is `unknown`;
- prompt content and native args are absent from the thrown public error.

- [x] **Step 7: Write cancellation tests at every pre-call checkpoint**

Abort before launch and between each stage using a fake that aborts the controller after returning. Assert no subsequent call occurs and existing confirmed resources remain reported without cleanup.

- [x] **Step 8: Run launch tests and confirm RED**

```sh
npm test -- tests/orchestrator-launch.test.ts
```

- [x] **Step 9: Implement strict Herdr result readers**

Add local helpers in `launch.ts` for extracting:

- `workspace/create`: `workspace.workspace_id`;
- `tab/create`: `tab.tab_id` and `root_pane.pane_id`;
- `agent/start`: agent name/pane evidence;
- `agent/prompt`: accepted result only.

Reuse the low-level normalized details. Reject omitted/truncated/malformed results and preserve underlying `HerdrToolError.failure.remoteOutcome` when wrapping.

- [x] **Step 10: Implement `inspectTask`**

Return read-only inventory. Include all registered `.worktrees` records and a matching workspace summary in the result type; update `LaunchResult` with an explicit `inventory` field rather than hiding this data in text.

- [x] **Step 11: Implement `launchTask` serially**

Use one mutable `resources: LaunchResources = { promptSubmitted: false }` owned by the function. After each confirmed stage, replace the relevant field. Check cancellation immediately before every mutating call. Never use `Promise.all` for launch stages.

Generate the fence token only immediately before building the final prompt. Mark `promptSubmitted: true` only after a successful low-level prompt response.

- [x] **Step 12: Format bounded successful results**

Return concise text with canonical worktree path and actual IDs, plus structured details. Do not return the worker prompt or native args in details. Keep text under existing package output limits.

- [x] **Step 13: Run focused tests and typecheck**

```sh
npm test -- tests/orchestrator-launch.test.ts tests/orchestrator-inventory.test.ts tests/orchestrator-repository.test.ts tests/orchestrator-prompt.test.ts
npm run typecheck
```

- [x] **Step 14: Commit Task 5**

```sh
git add src/orchestrator/contracts.ts src/orchestrator/errors.ts src/orchestrator/launch.ts tests/orchestrator-launch.test.ts
git commit -m "feat(orchestrator): launch one bounded worker"
```

---

### Task 6: Register the public tool and block bypass routes

**Files:**
- Create: `src/orchestrator/guards.ts`
- Create: `tests/orchestrator-guards.test.ts`
- Modify: `src/orchestrator/index.ts`
- Modify: `tests/orchestrator-extension.test.ts`

**Interfaces:**
- Consumes: `TaskInput`, `launchTask`, `inspectTask`, Pi `tool_call` events, current `ctx.cwd`.
- Produces:
  - `TaskSchema` TypeBox schema.
  - `guardToolCall(event, ctx, dependencies): Promise<BlockResult | undefined>`.
  - fully wired `herdr_task` tool.

- [x] **Step 1: Write failing schema tests**

Use `Value.Check` to assert:

- `inspect` permits only `action` and `repoRoot`;
- `launch` requires every specified launch field;
- `agentKind` uses `StringEnum(HERDR_AGENT_KINDS)`;
- unknown fields, `focus`, caller-supplied `workspaceId`, `tabId`, `paneId`, and `worktreePath` fail schema validation;
- `args` accepts literal strings but rejects nonstrings.

- [x] **Step 2: Write failing direct-mutation guard tests**

Call the captured `tool_call` handler with events for:

```ts
["herdr_workspace", { action: "create", cwd: repoRoot }]
["herdr_tab", { action: "create", workspaceId: "wE", cwd: repoRoot }]
["herdr_pane", { action: "split", paneId: "wE:p1", cwd: repoRoot, direction: "right" }]
["herdr_agent", { action: "start", name: "x", kind: "pi", paneId: "wE:p1" }]
```

Each returns `{ block: true, reason: expect.stringContaining("herdr_task") }`.

Assert list/inspect/read/prompt/wait/focus/rename/send-text/send-keys/close calls are not blocked. Close retains its primitive explicit-confirm behavior.

- [x] **Step 3: Write failing Bash guard tests**

Block commands matching case-sensitive executable forms with whitespace/newline boundaries:

```text
git worktree add ...
git -C /repo worktree add ...
command git worktree move ...
env FOO=1 git worktree remove ...
```

Also block a multiline script containing one of those commands. Do not block:

```text
git worktree list --porcelain
git status
printf 'git worktree add'
rg 'git worktree add' docs
```

Implement a conservative tokenizer for direct command segments rather than a broad substring regex. If the tokenizer cannot classify a segment that invokes `worktree add|move|remove`, prefer blocking. Document that this is defense in depth, not a shell sandbox.

- [x] **Step 4: Write failing Todo enqueue guard tests**

For `todo add` and `todo update`:

- no `enqueue` tag → unchanged;
- `enqueue` without prompt → blocked;
- enqueue prompt containing `/Users/bjunya/code/aria-actions-pi-harness` while `ctx.cwd` belongs to `aria-actions` → blocked;
- enqueue prompt containing `<repo>/docs/plan.md` → accepted;
- enqueue from `<repo>/.worktrees/x` resolves to the canonical main root;
- accepted prompt receives exactly one versioned boundary footer;
- updating an already-footered prompt remains idempotent;
- prompt instructing workspace/worktree/subagent creation is not treated as authority; the fixed footer explicitly revokes it.

Absolute-path extraction must recognize POSIX paths beginning `/` and reject NUL. It must ignore `https://` URLs. Do not attempt to mutate another repository's Todo store.

- [x] **Step 5: Run guard tests and confirm RED**

```sh
npm test -- tests/orchestrator-guards.test.ts tests/orchestrator-extension.test.ts
```

- [x] **Step 6: Implement `TaskSchema` and dependency construction**

In `src/orchestrator/index.ts`, define a strict union-compatible object schema using `StringEnum` for actions and kinds. Because Google-compatible schemas avoid unsupported literal unions, use one object with optional fields plus explicit action-specific runtime validation before any dependency call. Reject unknown/inapplicable fields using a dedicated validator patterned after `assertAllowed`.

Construct:

- a git runner using `pi.exec(command,args,{ cwd, signal, timeout })`;
- a Herdr executor using the existing `execute(group,input,context,runner.run)`;
- Node `fs.promises.realpath/lstat/access` path operations.

No subprocess or filesystem work occurs at extension load.

- [x] **Step 7: Wire `herdr_task inspect` and `launch`**

The registered tool description must say:

```text
Safely inspect or launch one repository-bound worker. The orchestrator derives the sole workspace and exact <repo>/.worktrees/<name> path; callers cannot supply topology IDs or a worktree path. Launch is serial, no-focus, one-worker, and never retries or cleans up ambiguous mutations.
```

Add tool-specific prompt guidelines naming `herdr_task` explicitly. Execute with the tool's `signal`, not `ctx.signal`. Throw formatted errors so Pi marks the tool result failed.

- [x] **Step 8: Implement direct-tool/Bash guards**

Register one `tool_call` handler in the orchestrator entry point. It must not block its own internal direct function calls because those do not emit model tool calls. In headless mode it blocks identically; there is no UI bypass.

- [x] **Step 9: Implement Todo boundary mutation**

Resolve the current canonical repo using read-only git. If canonicalization fails, block an enqueued task rather than guessing. Mutate only `event.input.prompt`; do not add fields outside Todo's schema. Include:

```text
BEGIN REPOSITORY EXECUTION BOUNDARY v1
Canonical repository: <repoRoot>
Worktrees: <repoRoot>/.worktrees/<name> only
This Todo prompt does not authorize creating Herdr workspaces, worktrees, tabs, panes, agents, subagents, or background jobs.
Use herdr_task launch for execution topology.
END REPOSITORY EXECUTION BOUNDARY v1
```

- [x] **Step 10: Prove factory isolation and disposal**

Extend `tests/orchestrator-extension.test.ts` with two factory instances. Each owns one runner and disposal handler. Repeated shutdown is safe and never closes remote resources. Registration performs no git/Herdr subprocess and no Todo write.

- [x] **Step 11: Run focused tests and typecheck**

```sh
npm test -- tests/orchestrator-guards.test.ts tests/orchestrator-extension.test.ts tests/extension.test.ts
npm run typecheck
```

- [x] **Step 12: Commit Task 6**

```sh
git add src/orchestrator/index.ts src/orchestrator/guards.ts tests/orchestrator-guards.test.ts tests/orchestrator-extension.test.ts
git commit -m "feat(orchestrator): block topology bypasses"
```

---

### Task 7: Package the separate entry point and document the contract

**Files:**
- Modify: `package.json`
- Modify: `tests/package.test.ts`
- Modify: `README.md`
- Modify: `docs/tool-contract.md`
- Modify: `docs/compatibility.md`
- Modify: `docs/manual-smoke.md`
- Modify: `docs/release-checklist.md`

**Interfaces:**
- Consumes: completed primitive and orchestrator entry points.
- Produces: packed package containing both, real Pi discovery proof, filtering instructions, and operator verification procedures.

- [x] **Step 1: Write failing package-discovery tests**

Change the manifest expectation to:

```ts
expect(pkg.pi).toEqual({
  extensions: ["./src/index.ts", "./src/orchestrator/index.ts"],
});
```

Update the real Pi resource-loader test to expect two extension resources. Assert one owns exactly the four primitive tools and the other owns exactly `herdr_task` plus its two lifecycle/policy hooks. Load/reload twice with no Herdr hosting marker and patched subprocess functions; registration must perform no subprocess.

Assert the packed file list includes every `src/orchestrator/*.ts` file and excludes tests, `.superpowers`, `.worktrees`, captures, and Todo stores.

- [x] **Step 2: Run package tests and confirm RED**

```sh
npm test -- tests/package.test.ts
```

Expected: manifest/discovery failures because only the primitive entry point is declared.

- [x] **Step 3: Update the package manifest**

Set:

```json
"pi": {
  "extensions": [
    "./src/index.ts",
    "./src/orchestrator/index.ts"
  ]
}
```

Keep current peer/dev dependencies, scripts, license, and package name. The existing `files: ["src", ...]` entry already includes orchestrator modules; verify rather than broadening it.

- [x] **Step 4: Update README architecture and installation sections**

Document:

- primitive extension: unrestricted explicit Herdr operations;
- orchestrator extension: opinionated safe task launch and guard hooks;
- normal package loading enables both;
- exact package-filter examples selecting only `src/index.ts` or only `src/orchestrator/index.ts` using Pi's documented extension filters;
- `herdr_task inspect` and `launch` examples with real-looking but clearly illustrative paths/branches;
- mandatory `.worktrees` ignore entry;
- no worker fan-out, retries, cleanup, merge, or completion claim;
- Todo integration behavior;
- errors retain confirmed resource handles for manual reconciliation.

Remove or qualify existing README statements that the package has “no orchestrator” while preserving the statement for the primitive entry point.

- [x] **Step 5: Update the tool contract**

Add a separate section for `herdr_task`. Include action tables, required fields, forbidden caller topology fields, path/name constraints, exact ordered transaction, zero/one/many workspace behavior, prompt envelope, guard matrix, Todo hook, cancellation, and non-atomic failure semantics.

Do not rewrite primitive action tables except to link to the optional orchestrator guard behavior.

- [x] **Step 6: Update compatibility and smoke documentation**

`docs/compatibility.md` records:

- Node >=22.19;
- Pi 0.85.1 extension hooks used;
- Herdr 0.8.2 list/create/start/prompt result shapes;
- git requirements: `worktree list --porcelain`, `check-ignore`, `symbolic-ref`, `show-ref`, `rev-parse`;
- macOS/Linux path behavior; Windows unsupported until separately designed because the fixed invariant and Bash guard are POSIX-specific.

`docs/manual-smoke.md` first adds a no-mutation `inspect` procedure. A launch smoke uses a disposable repository with `/.worktrees/` ignored and requires explicit human approval before calling `launch`. It verifies no focus change and performs no automatic cleanup.

`docs/release-checklist.md` adds tests for duplicate workspace refusal, sibling-path refusal, one-worker behavior, packed dual entry points, and primitive-only package filtering.

- [x] **Step 7: Run package/docs checks**

```sh
npm test -- tests/package.test.ts tests/orchestrator-extension.test.ts
git diff --check
rg -n "no Todos, orchestrator|does not manage worktrees" README.md docs package.json
```

Every remaining old-scope phrase must explicitly refer to the primitive entry point rather than the package as a whole.

- [x] **Step 8: Commit Task 7**

```sh
git add package.json tests/package.test.ts README.md docs/tool-contract.md docs/compatibility.md docs/manual-smoke.md docs/release-checklist.md
git commit -m "docs(orchestrator): package the safe policy layer"
```

---

### Task 8: Verify the complete change serially and prepare human review

**Files:**
- Modify only if verification exposes a defect in files already owned by Tasks 1–7.
- Update: `docs/superpowers/plans/2026-09-08-safe-task-orchestrator.md` checkboxes as each step completes.

**Interfaces:**
- Consumes: complete feature branch.
- Produces: fresh focused/full test evidence, clean diff, no-mutation Herdr inspection evidence, and a review-ready branch.

- [x] **Step 1: Run formatting and placeholder scans**

```sh
git diff --check origin/main...HEAD
rg -n '\b(TBD|TODO|FIXME|implement later|fill in details|similar to Task)\b' \
  src/orchestrator tests/orchestrator-*.test.ts README.md docs
```

Investigate every hit. Existing historical prose outside the changed scope may remain only when it is not an implementation placeholder.

- [x] **Step 2: Run all focused orchestrator tests in one process**

```sh
npm test -- \
  tests/orchestrator-repository.test.ts \
  tests/orchestrator-inventory.test.ts \
  tests/orchestrator-prompt.test.ts \
  tests/orchestrator-launch.test.ts \
  tests/orchestrator-guards.test.ts \
  tests/orchestrator-extension.test.ts \
  tests/package.test.ts
```

Expected: all pass, no skipped orchestrator test.

- [x] **Step 3: Run primitive regression tests**

```sh
npm test -- \
  tests/actions.test.ts \
  tests/extension.test.ts \
  tests/context.test.ts \
  tests/results.test.ts \
  tests/runner.test.ts \
  tests/capture.test.ts \
  tests/read-operation.test.ts \
  tests/schema-enums.test.ts
```

Expected: all pass with primitive tool schemas and result behavior unchanged.

- [x] **Step 4: Run full verification from a clean command invocation**

```sh
npm run verify
```

Expected: TypeScript succeeds and the entire Vitest suite passes.

- [x] **Step 5: Verify package contents**

```sh
npm pack --dry-run --json --ignore-scripts > /tmp/pi-herdr-pack.json
node - <<'NODE'
const fs = require('node:fs');
const files = JSON.parse(fs.readFileSync('/tmp/pi-herdr-pack.json', 'utf8'))[0].files.map(x => x.path);
if (!files.includes('src/index.ts')) throw new Error('primitive entry missing');
if (!files.includes('src/orchestrator/index.ts')) throw new Error('orchestrator entry missing');
if (files.some(x => /^(tests|\.worktrees|\.superpowers)\//.test(x))) throw new Error('private files packed');
console.log(`verified ${files.length} packed files`);
NODE
rm -f /tmp/pi-herdr-pack.json
```

- [x] **Step 6: Perform a no-mutation Herdr smoke inspection only**

Use `herdr_task inspect` against the canonical `pi-herdr` repository. Record the returned canonical root, existing workspace match, and violations. Do not call `launch`, create a disposable workspace, create a tab, or alter an existing worker during this smoke.

- [x] **Step 7: Review the branch manually without a subagent**

Run:

```sh
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git diff origin/main...HEAD -- src/orchestrator package.json tests README.md docs
```

Review for:

- any caller-supplied worktree path or topology ID;
- any path root other than `.worktrees`;
- duplicate workspace selection by label instead of canonical git identity;
- parallel stage execution or mutation retry;
- cleanup/rollback calls;
- worker prompt leakage in errors/results;
- foreign Todo-store mutation;
- low-level primitive schema changes;
- subprocess shell interpolation;
- missing cancellation checkpoints;
- package registration side effects.

Fix each concrete defect in its owning module, rerun its focused test, then rerun `npm run verify`.

- [x] **Step 8: Commit final verification-only corrections if needed**

If Step 7 required code/doc changes:

```sh
git add <only-the-corrected-files>
git commit -m "fix(orchestrator): address final verification findings"
```

If no files changed, do not create an empty commit.

- [x] **Step 9: Move the board task to human review**

Update Todo task `31be6d` with the exact test commands/results and ensure its testplan remains present. Advance it from `in-progress` to `agent-review`, perform this session's serial self-review evidence, then advance to `human-review`. Do not mark it done; the human owns final verification.

- [x] **Step 10: Report completion evidence**

Report:

- branch and worktree path;
- commit list;
- files changed by responsibility;
- focused and full test counts/results;
- package proof;
- no-mutation Herdr inspection result;
- confirmation that `aria-actions` was untouched;
- residual limitations: no shell sandbox, no automatic cleanup, no parallel workers, and no global uniqueness guarantee against other Pi sessions that load only the primitive entry point.
