# Compatibility

Observed versions, parser findings, and tested capabilities. Only actually executed commands/tests are recorded here.

## Observed versions

| Component | Version / evidence |
|---|---|
| Herdr CLI | `herdr --version` → `herdr 0.8.2` |
| Herdr wire protocol | `herdr api schema --json` → `protocol: 20`, `schema_version: 1` |
| pi / pi-ai / pi-coding-agent | `0.85.1` (devDependencies pin used for tests; peer dependency, not bundled) |
| TypeBox | `1.3.7` |
| Development runtime | macOS arm64, Node `26.8.1`, npm `11.19.0`, Vitest `5.0.0`; engine floor `>=22.19.0` (CI evidence tracked separately) |

## Parser findings (native CLI, not a generic POSIX parser)

- `--workspace=w9`-style `=` joined flags are rejected; flags and values must be separate argv entries.
- Only `agent start` treats `--` as a native-argument separator. Elsewhere, an inserted `--` becomes a literal positional argument (for example the tab/pane ID), not a separator.
- `agent prompt` expects `TARGET TEXT` as positional operands before any of its own options (`--wait`, `--until`, `--timeout`).
- `agent rename` accepts `--clear` as an option; when clearing, no name operand is emitted.
- An argv array (as built by this package, `shell: false`) prevents local shell expansion but does not by itself guarantee correct CLI parsing — argv order must still match the exact per-action shapes below.

## Protocol-20 request/response shapes actually observed

All findings below were produced by pointing `HERDR_SOCKET_PATH` at a disposable fake Unix-domain-socket server (`tests/support/fake-server.ts`) that answers `ping` with a schema-valid `pong` and every other method with `{ error: { code: "probe_only" } }`. No real Herdr server, layout, or agent was ever created, read, or mutated to gather this evidence.

- The CLI always opens one connection to send a `ping` handshake (`method: "ping"`, id `api-client:status`) before opening a **second**, separate connection to send the actual requested method. A fake server must accept more than one connection per invocation.
- Both `pane read` and `agent read`'s `--source recent-unwrapped` are transmitted on the wire as `source: "recent_unwrapped"` (underscore, not hyphen). `visible`, `recent`, and `detection` are transmitted unchanged. This package's public field keeps the CLI's hyphenated spelling (`recent-unwrapped`); only the wire form differs, and only the native CLI performs that translation.
- `pane split`'s wire parameter for the source pane is `target_pane_id`, not `pane_id` (the public field is still `paneId`; the CLI performs the rename).
- `pane focus --pane ID --direction DIR` is transmitted as method `pane.focus_direction` with params `{ pane_id, direction }`.
- `pane wait-output` is transmitted as method `pane.wait_for_output`; `--match TEXT` becomes `match: { type: "substring", value: TEXT }` and `--regex PATTERN` becomes `match: { type: "regex", value: PATTERN }`; `--raw` becomes `strip_ansi: false` (its absence is `strip_ansi: true`).
- `workspace/tab/pane close ID` are transmitted as `{workspace,tab,pane}.close` with a single opaque-ID field (`workspace_id`, `tab_id`, `pane_id` respectively). The CLI has no wire- or flag-level confirmation step; `confirm: true` is enforced entirely by this package before the CLI is ever invoked.
- `workspace create`/`tab create --env NAME=VALUE ...` (repeated flags) are transmitted as a single wire `env` **object** (`{ NAME: "VALUE", ... }`), not an array.
- `agent start` performs an explicit **preparatory** `pane.get { pane_id }` request over its own connection before the `agent.start` request. This is native CLI behavior confirmed by the fake-server probe in `tests/cli-contract.test.ts`; it is not something this package implements, and this package does not treat it as an end-to-end launch verification — actual agent-launch forwarding still requires the owner-run manual smoke test, which has not yet run.
- `agent wait`/`agent prompt --wait --until ...` transmit **repeated** `--until STATE` flags as a single wire `until` array in the given order (for example `["idle", "blocked"]`); `agent.prompt`'s wait options nest under a single `wait: { until, timeout_ms }` object, present only when `--wait` was supplied.
- `agent rename TARGET --clear` is transmitted as `agent.rename { target }` only (no separate wire flag for clearing).

## Frozen agent `kind` enumeration (0.8.2 `agent start --help`)

`pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `qwen`, `maki`. This is the set of kinds the installed CLI accepts; it is not a claim that every corresponding executable/provider has been integration-tested by this package.

## Tested capabilities

- Pure argv/schema compilers for all four tool groups (`workspace`, `tab`, `pane`, `agent`) are covered by an exhaustive table-driven unit-test matrix in `tests/actions.test.ts` (`npm test`), independent of any installed Herdr binary.
- Opt-in tests in `tests/cli-contract.test.ts` (`npm run test:cli`, gated on `HERDR_CLI_CONTRACT=1`) run the actual installed `herdr` binary's argument parser and protocol-20 client against the fake socket above, and assert on recorded wire requests for: tab rename, workspace/tab/pane close, tab create (cwd/env), pane split (source pane/direction/ratio/env), pane focus-neighbor, pane read (all four sources), agent read (`recent-unwrapped`), pane wait-output (match/source/lines/timeout/raw), agent start's preparatory pane lookup, and repeated `--until` state arrays on both `agent wait` and `agent prompt --wait`. These tests exercise the CLI's real argument parser and confirm wire encoding; they cannot mutate a real layout or agent because they only ever talk to the temporary fake socket, and they never proxy a request to a real server.
- Real fake-executable subprocess tests exercise capture backpressure/resource caps, local timeout/cancellation, first-stop-wins, shutdown ownership and concurrent isolation. They do not start a real worker.
- Real isolated pi-loader tests load the sole package twice and dispose it repeatedly without hosting context, a model/provider call, or runtime subprocess/capture creation. Packed-source loading also omits the package's devDependencies.
- Earlier planning performed read-only hosting `workspace list` and an explicit nonexistent-socket probe to verify selection/no fallback. `--version`, `--help`, and `api schema --json` are local CLI research, not live launch tests. No real workspace/tab/pane/agent was created, focused or closed by this implementation work. Manual smoke remains unrun.
