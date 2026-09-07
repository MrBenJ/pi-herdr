# Tool contract

Human-readable reference for the four agent-callable tools this package registers: `herdr_workspace`, `herdr_tab`, `herdr_pane`, `herdr_agent`. Each tool takes one flat object; `action` is always required. Fields not required by the chosen action are rejected, not silently ignored — this includes fields that are valid for a different action in the same tool.

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

`agent start`'s timeout floor (3001 ms) is stricter than every other wait (floor 1 ms). Startup and prompt-wait/agent-wait deadlines always include a fixed 1000 ms local response-drain allowance beyond the requested/default Herdr timeout. `agent start` performs a preparatory pane lookup before requesting the launch; this package does not claim that as proof of a completed launch — only the manual smoke test verifies actual agent forwarding.

## `herdr_workspace` and `herdr_tab`

See Task 1: `list`/`inspect`/`create`/`focus`/`close` (workspace) and `list`/`inspect`/`create`/`rename`/`focus`/`close` (tab), with the same `cwd`/`env`/`focus`/`confirm` rules as above.

## Errors

Every rejected call throws with a JSON-encoded `Failure` body (kind, message, `remoteOutcome`). Validation failures are always `kind: "invalid_input"` with `remoteOutcome: "not_attempted"` — no subprocess is spawned. Unknown or action-inapplicable fields are rejected the same way, even when only one field is out of place.
