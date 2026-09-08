# Safe Task Orchestrator Extension Design

Status: approved architecture, pending human review of this written specification.

## Purpose

Add an opinionated task-orchestration extension to the `pi-herdr` package while
keeping the existing low-level Herdr tools independent and unchanged in purpose.
The orchestrator turns a repository-bound task into exactly one repository-local
git worktree, one tab in the repository's existing Herdr workspace, and one
worker. It prevents the controller model from inventing workspace topology or
filesystem placement.

This design responds to an observed dogfood failure. A Pi worker launched in the
existing `aria-actions` workspace created a second Herdr workspace and placed its
worktree at `/Users/bjunya/code/aria-actions-pi-harness`, outside the canonical
repository. It then persisted that path into Todo prompts and attempted further
agent fan-out. The duplicate workspace was closed, and the interrupted
`aria-actions` worktree is explicitly outside this change: do not move, resume,
clean, or delete it while its owner is working with it.

## Fixed Invariants

1. A canonical git repository has at most one Herdr workspace.
2. A workspace is rooted at the canonical main checkout, never at a linked
   worktree.
3. Every linked worktree path is exactly
   `<canonical-repo-root>/.worktrees/<name>`.
4. No sibling, `/tmp`, `.claude/worktrees`, `worktrees`, or configurable
   alternative is accepted.
5. A task launch creates or reuses exactly one worktree, creates exactly one
   no-focus tab, and starts exactly one worker.
6. The launched worker may not create workspaces, worktrees, tabs, panes, or
   additional agents. It reports a blocker instead.
7. Todo records track work; their prose does not authorize infrastructure
   mutations.
8. Existing workspaces, tabs, worktrees, and agents are never closed, moved, or
   deleted automatically.

These are fail-closed rules, not recommendations. There is no bypass flag for an
external worktree path.

## Package and Extension Separation

The package exposes two extension entry points:

- `src/index.ts`: the existing low-level `herdr_workspace`, `herdr_tab`,
  `herdr_pane`, and `herdr_agent` tools. Its contracts remain primitive and do
  not acquire git, Todo, or orchestration behavior.
- `src/orchestrator/index.ts`: the new policy layer. It registers the safe task
  launch tool and guards unsafe direct orchestration while enabled.

Both entry points may share internal transport and result-normalization modules,
but the orchestrator does not invoke another registered Pi tool through an
undocumented API. It composes typed internal operations and explicit `git` argv
calls directly. Package filtering can disable the orchestrator entry point while
leaving low-level tools available, or vice versa.

The package manifest lists both entry points explicitly. Documentation must make
clear that installing the package normally enables both; resource filtering is
the supported way to keep only the primitive extension.

## Public Orchestrator Contract

Register one narrow tool, tentatively named `herdr_task`, with these actions:

### `inspect`

Read-only. Given an absolute `repoRoot`, return:

- canonical main-checkout root;
- current registered worktrees under `.worktrees/`;
- matching Herdr workspace ID, if present;
- tabs and agents associated with that workspace;
- policy violations detected in the inventory.

It performs no repair or cleanup.

### `launch`

Required inputs:

- `repoRoot`: absolute path to the canonical main checkout;
- `worktreeName`: one safe path segment;
- `branch`: explicit non-default branch name;
- `baseRef`: explicit existing commit/ref;
- `tabLabel`: explicit label;
- `agentName`: explicit unique agent name;
- `agentKind`: one supported Herdr agent kind;
- `prompt`: worker task text.

Optional native agent arguments remain a literal string array. Focus is always
false in v1; callers cannot opt into focus during launch.

The caller never supplies a worktree path, workspace ID, tab ID, or pane ID.
Those are derived or returned by the orchestrator. This removes the degrees of
freedom that produced the dogfood failure.

V1 deliberately omits parallel launch, worker pools, retries, workspace cleanup,
worktree removal, merging, queue watching, and automatic task lifecycle changes.

## Canonical Repository and Path Validation

Resolve repository identity using `git` with argv arrays and finite deadlines:

1. `repoRoot` must be absolute, exist, and resolve through `realpath`.
2. `git -C <repoRoot> rev-parse --show-toplevel` must equal the real path.
3. `git -C <repoRoot> rev-parse --git-common-dir` must identify this checkout as
   the main/common checkout rather than a linked worktree.
4. The default branch is resolved for refusal checks, but `baseRef` remains
   explicit.
5. `.worktrees` must already be ignored according to
   `git -C <repoRoot> check-ignore -q .worktrees`. The orchestrator fails with a
   remediation message rather than editing `.gitignore` implicitly.
6. `worktreeName` must be a single conservative slug with no separators, dot
   segments, control characters, or leading dash.
7. The only constructed path is
   `path.join(repoRoot, ".worktrees", worktreeName)`.
8. Existing paths and symlinks are resolved and checked again before use. A
   symlink that escapes `.worktrees` is rejected.

The branch must not be the resolved default branch. Existing branch/worktree
state is handled idempotently only when it exactly matches the requested branch
and constructed path. Any partial collision fails with an inventory report; it
is never overwritten or guessed around.

## Workspace Reuse and Duplicate Prevention

The orchestrator inventories Herdr before mutation:

1. List workspaces using the hosting Herdr server selected by the existing
   transport.
2. For every workspace, list panes and inspect their reported CWDs.
3. Canonicalize git-backed pane CWDs to their main repository root.
4. Match workspaces by canonical repository identity, not label text.

Outcomes:

- Exactly one matching workspace: reuse it.
- No matching workspace: create one rooted at the canonical main checkout, with
  no focus, then use its returned handles.
- More than one matching workspace: fail closed and report the conflicting IDs;
  never choose one or close either.

A worktree never receives its own Herdr workspace. After obtaining the one
repository workspace, create a no-focus tab whose CWD is the constructed
`.worktrees/<name>` path. Use the returned root-pane ID to start the worker.

If any mutation has an ambiguous transport result, stop and return the inventory
needed for reconciliation. Do not retry workspace, worktree, tab, agent-start,
or prompt mutations automatically.

## Launch Transaction and Failure Semantics

The ordered launch is:

1. Validate repository, name, branch, base ref, and `.worktrees` ignore state.
2. Inventory git worktrees and Herdr workspaces.
3. Create or exactly reuse the git worktree.
4. Reuse the matching workspace, or create the sole workspace at `repoRoot`.
5. Create one no-focus tab at the constructed worktree path.
6. Start one named worker in the returned root pane.
7. Submit the bounded worker prompt.
8. Return canonical paths plus actual workspace, tab, pane, and agent handles.

This is not an atomic transaction. On a later failure, earlier accepted
resources remain in place. The result identifies every confirmed mutation and
labels ambiguous outcomes. No automatic rollback occurs because closing a tab,
removing a worktree, or deleting a branch could destroy useful state.

## Worker Boundary Envelope

The orchestrator appends a fixed, clearly delimited policy envelope to the task
prompt. Caller prose cannot weaken it. It states:

- canonical repository root;
- exact worktree CWD;
- existing workspace/tab/pane identity;
- work only in the supplied worktree;
- do not run `git worktree add`, `git worktree move`, or `git worktree remove`;
- do not call Herdr workspace/tab/pane creation or agent-start tools;
- do not dispatch subagents or reviewers unless a future explicit capability
  adds that authorization;
- do not rewrite Todo execution boundaries;
- report blockers instead of inventing directories or infrastructure.

The task prompt is treated as work instructions inside those fixed boundaries,
not as authority to modify the boundaries themselves.

## Guarding Direct Tool Use

While the orchestrator extension is enabled, a `tool_call` policy hook blocks:

- direct `herdr_workspace create`;
- direct `herdr_tab create`;
- direct `herdr_pane split` used to create worker layout;
- direct `herdr_agent start`;
- built-in Bash commands containing `git worktree add`, `git worktree move`, or
  `git worktree remove`.

The error directs the model to `herdr_task launch`. Read-only Herdr operations,
prompting/reading an existing agent, and explicit close operations retain their
low-level contracts. The hook exists in the orchestrator entry point, not the
primitive entry point, preserving independent low-level use when the
orchestrator is filtered out.

The Bash guard is intentionally conservative and is defense in depth, not a
shell parser. Safe orchestration does not depend on recognizing arbitrary shell
obfuscation: normal task launch never asks a worker to create its own worktree,
and the orchestrator itself invokes `git` without a shell.

## Todo Integration

The current Todo store is already repository-scoped through the git common
directory. The orchestrator uses that property rather than importing or
reimplementing Todo storage.

When enabled, the orchestrator's `tool_call` hook observes `todo add` and
`todo update` calls:

- A task tagged `enqueue` must have a standalone prompt.
- Absolute filesystem paths in an enqueue prompt must resolve inside the Todo
  board's canonical repository root. External paths are rejected.
- The orchestrator appends a deterministic execution-boundary footer naming the
  canonical repository root and the required `.worktrees/<name>` policy.
- The footer states that the Todo prompt does not authorize workspace,
  worktree, layout, or subagent creation.
- Child/subtasks created from a linked worktree resolve through the git common
  directory to the same canonical repository.

A cross-repository task must be created from a Pi session whose CWD belongs to
the target repository, so it lands on that repository's board. The orchestrator
must not mutate another repository's Todo file by accepting an arbitrary board
path.

Todo remains an independent extension. Pi Herdr does not import it, require it,
or own its lifecycle. If Todo is absent, `herdr_task launch` still works from
explicit structured input.

## Security and Authorization

- Use `pi.exec` or the existing subprocess runner with executable/argv arrays;
  never interpolate caller data into shell commands.
- Preserve the hosting Herdr socket selection and no-fallback behavior.
- Apply finite deadlines and Pi cancellation to every local operation.
- Never expose environment credentials in results or prompts.
- Never infer successful task completion from agent state.
- Never answer worker approval dialogs.
- Headless mode follows the same deterministic path rules and never prompts.
- Interactive confirmation is not used to bypass fixed path invariants.
- No action deletes or closes existing resources.

## Alternatives Rejected

### Prompt guidance only

Rejected because the observed worker ignored both repository conventions and the
worktree skill's own project-local default.

### Harden only the primitive Herdr tools

Rejected because git worktree creation occurs outside Herdr, and adding Todo and
git policy to primitive tools would destroy their low-level separation.

### Add policy directly to Todo

Rejected because Todo tracks state but does not execute Herdr or git operations.
It cannot guarantee workspace or worktree topology by itself.

### Separate repository/package

Rejected by owner decision. The orchestrator is a separate extension entry point
inside the existing `pi-herdr` package so transport code and integration tests
remain shared without creating another repository.

## Testing Strategy

Automated tests use fake git/Herdr runners and temporary repositories. They must
cover:

1. Package discovery exposes primitive and orchestrator entry points separately.
2. Primitive tools retain their existing schemas and behavior when the
   orchestrator is not loaded.
3. Canonical root validation rejects linked-worktree roots, relative paths,
   symlink escapes, non-repositories, and mismatched top-level paths.
4. Only `<repo>/.worktrees/<name>` is constructed and accepted.
5. `/Users/bjunya/code/aria-actions-pi-harness`, `/tmp/x`,
   `<repo>/.claude/worktrees/x`, and `<repo>/worktrees/x` are rejected.
6. Existing exact worktrees are reused; branch/path collisions fail closed.
7. An existing repository workspace is reused and no workspace-create call is
   emitted.
8. No matching workspace creates exactly one root workspace.
9. Duplicate matching workspaces fail without mutation.
10. Launch creates one no-focus tab, starts one worker in its returned pane, and
    submits one boundary-wrapped prompt.
11. Failures at every stage report confirmed state and perform no retries or
    cleanup.
12. Policy hooks block direct layout/agent creation and Bash git-worktree
    mutations while leaving reads and ordinary Bash intact.
13. Enqueued Todo prompts reject external absolute paths and receive the fixed
    repository boundary footer.
14. Todo activity from a linked worktree binds to the common repository root.
15. Cancellation stops only owned local calls and does not claim remote rollback.
16. Output remains bounded and secrets are not reflected.
17. The full existing `npm run verify` suite remains green.

An opt-in smoke test may inspect existing Herdr state without mutation. A later
manual disposable-repository test may exercise launch only with explicit owner
approval. Automated tests never create real Herdr workspaces, tabs, agents, or
worktrees outside temporary repositories.

## Documentation and Packaging

Update the package manifest, README, tool contract, compatibility notes, manual
smoke guide, and release checklist. Document:

- the two entry points and Pi package filtering examples;
- the one-workspace-per-repository rule;
- the mandatory `.worktrees/<name>` path;
- the safe launch sequence and non-atomic failure behavior;
- Todo's tracking-only role;
- blocked direct mutations while the orchestrator is active;
- no cleanup, merge, queue watcher, or completion claims in v1.

## Acceptance Criteria

The change is complete when a caller can launch one bounded worker from
structured task data without supplying topology IDs or a worktree path; an
existing matching workspace is always reused; every created worktree is beneath
`<repo>/.worktrees/`; direct model attempts to recreate the observed failure are
blocked; Todo handoffs cannot persist an external execution path; primitive
Pi-Herdr tools remain independently usable when the orchestrator entry point is
disabled; and all focused plus full verification tests pass.
