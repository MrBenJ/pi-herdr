# Tool contract

Human-readable reference for the five agent-callable tools this package registers across two entry points: primitive `herdr_workspace`, `herdr_tab`, `herdr_pane`, `herdr_agent`, and opinionated `herdr_task`. Each tool takes one flat object; `action` is always required. Fields not allowed by the chosen action are rejected, not silently ignored — this includes fields that are valid for a different action in the same tool.

V1 controls only the Herdr server hosting the current pi session. Creation and splitting default to `--no-focus`. Every close requires an explicit target ID and `confirm: true`.

## Common fields

| Field | Rule |
|---|---|
| `workspaceId`, `tabId`, `paneId` | Nonempty string, no NUL/whitespace/leading `-`; opaque, never derived |
| `target` (agent) | Agent name or pane ID; same shape rule as the ID fields above |
| `name` (agent) | `^[a-z][a-z0-9_-]{0,31}$` |
| `clear` (agent rename only) | Optional; when present must be exactly `true`, and `name` must be absent |
| `kind` (agent start only) | One of the frozen 0.8.2 kinds (see `docs/compatibility.md`) |
| `direction` | Pane split: `right`/`down`. Pane focus-neighbor: `left`/`right`/`up`/`down` |
| `wait` (agent prompt only) | Boolean, default `false`; `until`/`timeoutMs` require `wait: true` |
| `cwd` | Nonempty string, no NUL; passed literally, no shell/tilde/home expansion |
| `label`, `text`, `command`, `match`, `regex` | String, no NUL; nonempty except `text` (which may be empty) |
| `args` (agent start only) | String array, no NUL, default `[]`; empty items/order preserved, forwarded verbatim after `--` only when nonempty |
| `keys` | Nonempty string array, no NUL, no empty items; Herdr validates the key vocabulary |
| `env` | Array of `{ name, value }`; `name` matches `^[A-Za-z_][A-Za-z0-9_]*$`; no duplicate names; no `HERDR_*` names |
| `focus` | Boolean, default `false`; create/split only |
| `confirm` | Must be exactly `true` to close |
| `timeoutMs` | Integer; 3001–300000 on agent start, 1–300000 elsewhere; default 30000; rejects `null`, non-integers, and numeric strings |
| `source` | `visible` (default), `recent`, `recent-unwrapped`, or (reads only) `detection`; wait-output excludes `detection` |
| `lines` | Optional positive integer, capped at 1000000 |
| `format` | `text` (default) or `ansi`; reads only |
| `raw` | Boolean, default `false`; pane wait-output only |
| `until` | Nonempty array of `idle`, `working`, `blocked`, `done`, `unknown`; no duplicates; omit for Herdr's settled-state default |
| `ratio` | Optional finite number strictly between 0 and 1 (both endpoints rejected) |

## `herdr_pane`

| Action | Required | Optional | Mutation? |
|---|---|---|---|
| list | — | workspaceId | no |
| inspect | paneId | — | no |
| split | paneId, cwd, direction | ratio, env, focus | yes |
| run | paneId, command | — | yes |
| send-text | paneId, text | — | yes |
| send-keys | paneId, keys | — | yes |
| read | paneId | source, lines, format | no |
| wait-output | paneId, exactly one of match/regex | source (no `detection`), lines, raw, timeoutMs | no |
| focus-neighbor | paneId, direction | — | yes |
| close | paneId, confirm=true | — | yes |

`run` executes shell syntax literally in the remote terminal — it is not safe argv-based execution. `focus-neighbor` never guesses a source pane; `paneId` is always required.

## `herdr_agent`

| Action | Required | Optional | Mutation? |
|---|---|---|---|
| list | — | — | no |
| inspect | target | — | no |
| start | name, kind, paneId | args, timeoutMs (floor 3001) | yes |
| rename | target, exactly one of name/clear=true | — | yes |
| prompt | target, text | wait, until, timeoutMs (only with wait) | yes |
| send-keys | target, keys | — | yes |
| read | target | source, lines, format | no |
| wait | target | until, timeoutMs | no |
| focus | target | — | yes |

`agent start`'s timeout floor (3001 ms) is stricter than every other wait (floor 1 ms). Startup and prompt-wait/agent-wait deadlines always include a fixed 1000 ms local response-drain allowance beyond the requested/default Herdr timeout. `agent start` performs a preparatory pane lookup before requesting the launch; this package does not claim that as proof of a completed launch — actual agent forwarding still requires the owner-authorized manual smoke, which has not yet run.

## `herdr_workspace` and `herdr_tab`

### Workspace

| Action | Required | Optional | Mutation? |
|---|---|---|---|
| list | — | — | no |
| inspect | workspaceId | — | no |
| create | cwd | label, env, focus | yes |
| focus | workspaceId | — | yes |
| close | workspaceId, confirm=true | — | yes |

### Tab

| Action | Required | Optional | Mutation? |
|---|---|---|---|
| list | — | workspaceId | no |
| inspect | tabId | — | no |
| create | workspaceId, cwd | label, env, focus | yes |
| rename | tabId, label | — | yes |
| focus | tabId | — | yes |
| close | tabId, confirm=true | — | yes |

Use actual returned creation handles; do not derive IDs from a requested name or a numbering convention. `confirm: true` is trusted caller opt-in, not independent human authorization. Every destructive target remains explicit even in headless sessions.

## `herdr_task`

`herdr_task` is registered by `src/orchestrator/index.ts`; it remains separate from the primitive entry point.

| Action | Required | Optional | Mutation? |
|---|---|---|---|
| inspect | repoRoot | — | no |
| launch | repoRoot, worktreeName, branch, baseRef, tabLabel, agentName, agentKind, prompt | args | yes |

`repoRoot` must be the absolute, real path of a canonical main checkout. Linked-worktree and nested-directory roots are rejected. `/.worktrees/` must already be ignored. `worktreeName` is a 1–80 character filename slug beginning with an alphanumeric; separators, dot segments, `.claude`, controls, whitespace, and leading dashes are rejected. The only derived path is `<repoRoot>/.worktrees/<worktreeName>`. Callers cannot submit `worktreePath`, `workspaceId`, `tabId`, `paneId`, or focus settings.

Launch order is fixed and serial:

1. validate repository, branch/ref/name, and ignore policy;
2. inventory git worktrees and every Herdr workspace's pane CWDs;
3. create or exactly reuse the branch at the derived path;
4. reuse exactly one canonical-repository workspace, create one no-focus main-root workspace if none matches, or fail closed if multiple match;
5. create one no-focus tab at the worktree;
6. start one named worker in the returned root pane;
7. submit a task prompt followed by the immutable topology boundary;
8. return canonical paths and actual handles.

An exact path/branch pair is reusable. A path-only, branch-only, filesystem, symlink, or default-branch collision fails without overwrite. No stage runs in parallel. No mutation is retried, rolled back, closed, removed, merged, or treated as task completion. Failures report every previously confirmed resource and whether the failed mutation's remote outcome is ambiguous.

The final worker boundary names the canonical root, exact worktree, workspace, tab, pane, and agent; it forbids worktree/layout/agent creation, subagents, background work, and Todo-boundary rewrites. Caller prompt prose is untrusted and cannot replace the final boundary.

While this entry point is loaded, a `tool_call` hook blocks direct `herdr_workspace create`, `herdr_tab create`, `herdr_pane split`, `herdr_agent start`, and recognizable Bash `git worktree add|move|remove` commands. Read/inspect/prompt/wait and explicitly confirmed close operations retain primitive behavior. The Bash classification is defense in depth, not a shell sandbox.

For `todo add`/`todo update` calls explicitly tagged `enqueue`, the hook requires a prompt, rejects absolute filesystem paths outside the current canonical repository, and appends an idempotent repository boundary. Todo remains tracking-only and no foreign Todo store is opened or mutated.

## Errors

Every rejected call throws with a bounded JSON-encoded `Failure` body (`kind`, `message`, `remoteOutcome`, plus applicable `herdrCode`, `exitCode`, `stdoutPath`, `stderrPath`). Pi sees a failed tool call, not a normal returned object with an `isError` field. Compiler validation failures are always `invalid_input` / `not_attempted`, before spawning; unknown/inapplicable fields are rejected identically. Even errors caused by enormous invalid input remain valid JSON within presentation bounds.

| Kind | Meaning |
|---|---|
| invalid_input | Compiler validation failure, or native CLI usage exit code 2 |
| missing_host | Missing hosting marker/socket, or a non-absolute socket path |
| missing_executable | Spawn failed with executable-not-found |
| server_unavailable | Herdr's `server_not_running` error for the explicit hosting server |
| operation_failed | Other structured Herdr error (code retained subject to bounding/redaction), or unexplained nonzero CLI exit |
| transport_failed | Local process/capture/transport failure, including incomplete capture |
| malformed_output | Invalid JSON success envelope or missing required creation handle |
| response_too_large | JSON/error stream exceeds the 1 MiB parsing limit |
| resource_limit | Combined capture exceeds the 64 MiB ceiling |
| cancelled | Local cancellation/shutdown |
| timeout | Local subprocess deadline exceeded, or Herdr reported `timeout` (retained as `herdrCode`) |

Pre-spawn failures are `remoteOutcome: "not_attempted"`. Spawned mutation failures are conservatively `"unknown"`; read-only failures are `"not_applicable"`. A timeout/readiness failure is not rollback evidence. There is no automatic mutation retry.

## Results and retention

Success text is bounded to 2000 lines/51200 UTF-8 bytes including notices. Structured details have an independent serialized JSON byte bound. Small JSON results preserve server-assigned IDs and states in `details.result`. When details cannot safely retain the full result, `resultOmitted: true` and artifact metadata replace it; text provides a bounded preview rather than fabricated creation handles. Read stdout is literal terminal text even if it resembles a JSON envelope; stderr is still checked for transport/Herdr errors.

All captures use private temporary files. Small clean successes remove them when possible; truncated/interrupted/error responses and omitted diagnostics retain real paths. Capture-limit files contain only the persisted prefix. Retention is not durability, and raw files can contain sensitive output that was redacted/omitted from normal tool output. See [README](../README.md#output-errors-and-private-artifacts).

Cancellation and extension shutdown stop only owned local CLI calls. They do not close remote layout or terminate remote workers. Reads/waits do not establish task success; inspect actual evidence, especially blocked/approval states.
