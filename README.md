# pi-herdr

Agent-callable [pi](https://pi.dev) tools for controlling the **Herdr server hosting the current session**. The package has two separate extension entry points: low-level Herdr primitives and an opinionated, repository-bound task orchestrator. It requires no worker pool or separate socket service.

**Pre-release:** implementation is on [PR #1](https://github.com/MrBenJ/pi-herdr/pull/1). The default branch is not yet the implementation, and no release tag or npm publication is approved. Live worker/layout smoke testing remains an owner-run gate.

## Install

Requirements: Herdr CLI **0.8.2** on `PATH`, pi **0.85.1**, and Node **>=22.19.0**. The measured local baseline is macOS arm64 / Node 26.8.1. See [compatibility](docs/compatibility.md) for the distinction between tested behavior and supported input vocabulary.

Review the source first: pi extensions execute with your user's system access.

From a local checkout containing the implementation:

```bash
pi install /absolute/path/to/pi-herdr
```

In an existing pi session, run `/reload`. Local installs reference the directory; they do not copy it. Keep that checkout available. No production build or devDependencies are needed to load the source through pi; pi supplies the declared core peers.

The approved remote is https://github.com/MrBenJ/pi-herdr. Once a release is approved, pi's pinned Git source format is `git:github.com/MrBenJ/pi-herdr@TAG_OR_COMMIT`. No released ref is advertised yet; do not install the unqualified default branch expecting the current tools.

To remove a local installation:

```bash
pi remove /absolute/path/to/pi-herdr
```

Then `/reload`. Removal/shutdown does not close remote tabs or agents.

## Hosting context

Launch pi inside a Herdr pane so it inherits:

- `HERDR_ENV=1`
- an absolute, nonempty `HERDR_SOCKET_PATH`

Do not fabricate these values to select another server. The extension preserves the hosting socket and removes `HERDR_SESSION` from each CLI child environment. A missing hosting context fails closed; an unavailable explicit socket does not fall back to a default or named server. The extension never starts a Herdr server.

Registration/reload needs no running server. Context is checked when a tool is invoked, not when the package loads.

## Tools

| Tool | Actions |
|---|---|
| `herdr_workspace` | list, inspect, create, focus, close |
| `herdr_tab` | list, inspect, create, rename, focus, close |
| `herdr_pane` | list, inspect, split, run, send-text, send-keys, read, wait-output, focus-neighbor, close |
| `herdr_agent` | list, inspect, start, rename, prompt, send-keys, read, wait, focus |
| `herdr_task` | inspect, launch |

The model discovers these registered tools normally. `pi.getAllTools()` exposes metadata to extensions; pi-herdr does **not** provide a public cross-extension execution API.

Each tool takes a flat object with `action`; required and allowed fields vary by action. Unknown/inapplicable fields are rejected. See the complete [tool contract](docs/tool-contract.md).

### Safe repository-bound launch

`herdr_task launch` is the default way to create worker topology. It accepts a canonical main-checkout `repoRoot`, a single `worktreeName`, branch/base ref, labels, worker kind/name, native args, and task prompt. It constructs exactly `<repoRoot>/.worktrees/<worktreeName>`; callers cannot supply a worktree path, workspace ID, tab ID, or pane ID.

The launch is serial: validate repository → inventory git and Herdr → exactly create/reuse the worktree → reuse the sole matching workspace or create one no-focus workspace → create one no-focus tab → start one worker → submit the fixed boundary prompt. Duplicate matching workspaces fail closed. Partial resources remain after failure and are returned as confirmed handles; ambiguous mutations are never retried or cleaned up automatically. `/.worktrees/` must already be ignored.

```json
{"tool":"herdr_task","input":{"action":"inspect","repoRoot":"/absolute/project"}}
{"tool":"herdr_task","input":{"action":"launch","repoRoot":"/absolute/project","worktreeName":"issue-123","branch":"feat/issue-123","baseRef":"main","tabLabel":"issue-123","agentName":"issue-123","agentKind":"pi","prompt":"Implement the approved plan and report evidence.","args":[]}}
```

While the orchestrator is loaded, its policy hook blocks direct Herdr topology creation/start calls and direct Bash `git worktree add|move|remove`. It also bounds Todo calls tagged `enqueue` to the current canonical repository and appends a repository execution footer. This is defense in depth, not a shell sandbox.

To load only one layer, use Pi's package object filters in settings (paths are relative to this package):

```json
{"source":"/absolute/path/to/pi-herdr","extensions":["+src/index.ts"]}
{"source":"/absolute/path/to/pi-herdr","extensions":["+src/orchestrator/index.ts"]}
```

The first enables primitive-only operation without orchestrator guards. The second exposes `herdr_task` and its guards; its internal low-level execution does not require model access to primitive tools.

### Low-level primitive-only operation

When `src/orchestrator/index.ts` is filtered out, inspect/list to obtain actual workspace IDs. The following records illustrate tool names and inputs, not a generic router payload. **IDs and paths are examples:** replace them with the actual approved target and returned handles. Never predict IDs from their numbering.

```json
{"tool":"herdr_tab","input":{"action":"create","workspaceId":"w91","cwd":"/tmp/review","label":"reviewer"}}
{"tool":"herdr_agent","input":{"action":"start","name":"reviewer","kind":"pi","paneId":"w91:p63","args":["--model","provider/model"]}}
{"tool":"herdr_agent","input":{"action":"prompt","target":"reviewer","text":"Review the diff and report findings."}}
{"tool":"herdr_agent","input":{"action":"read","target":"reviewer"}}
{"tool":"herdr_tab","input":{"action":"rename","tabId":"w91:t27","label":"review complete"}}
{"tool":"herdr_tab","input":{"action":"close","tabId":"w91:t27","confirm":true}}
```

Creation/splitting defaults to **no focus**. `focus: true` is explicit opt-in. Creating a tab returns its root-pane ID; agent start uses that existing pane at an interactive shell and requires a name. It does not create layout. `cwd` and native `args` remain literal: no home, tilde, shell, or `@` expansion is performed by this extension.

## Safety and interpretation

- **Trusted automation, not a sandbox.** Every workspace/tab/pane close needs the exact target ID and `confirm: true`. This flag prevents accidental omission; it does not prove that a human clicked a dialog. The model can set it. Caller authorization remains the caller's responsibility, identically in interactive and headless sessions. There is no additional approval broker.
- `herdr_pane run` intentionally executes shell syntax in the remote terminal. Local CLI argv is shell-free; that does **not** make the remote command or native agent arguments safe for an untrusted caller.
- Waits default to 30000 ms, accept 1–300000 ms, and never run indefinitely. Agent **startup** requires 3001–300000 ms. A local response-drain allowance adds 1000 ms to wait/start subprocess deadlines; other commands have a 30000 ms deadline.
- Cancellation terminates only the local CLI/wait. It **does not terminate the remote agent**, undo a prompt, or close remote layout. Ambiguous mutations are never automatically retried.
- Reads and output waits default to `visible`. Request `recent` or `recent-unwrapped` explicitly when needed. History cannot recover alternate-screen output Herdr never retained.
- `idle`, `done`, `blocked`, and readiness are observations, not proof of task completion or approval. Inspect the actual response/review. Never automatically answer an approval dialog; sending keys requires deliberate authorization.
- The primitive entry point does not manage worktrees, ports, models, task queues, or lifecycle reporting. The separate orchestrator manages only repo-local worktree/worker launch; it does not merge, clean up, retry, fan out, or claim task completion. Shutdown only disposes owned local calls.

## Output, errors, and private artifacts

Returned text is limited to **2000 lines or 51200 UTF-8 bytes**, including a truncation notice. Structured details are bounded too. Small terminal reads preserve text exactly, even when the text looks like JSON. JSON operations preserve returned IDs/state; startup argv is omitted from normalized output.

Two additional limits are distinct from presentation truncation:

- **1 MiB per parsed JSON/error stream:** oversized responses fail `response_too_large`; they are not represented as successful parsed results. This includes unexpectedly oversized stderr diagnostics. Terminal stdout from read actions stays text instead of being JSON-parsed.
- **64 MiB combined raw capture per invocation:** exceeding this stops the local CLI and fails `resource_limit`. Retained files then contain only the persisted prefix, not the full output.

Artifacts use private temporary directories (0700) and files (0600). Truncated/interrupted/error output and omitted diagnostics retain real paths. Small successful captures are removed when possible; cleanup failure does not erase a known remote result. Retained files survive reload/shutdown, may contain sensitive terminal output or launch arguments, and require explicit inspection. They are **not durable storage**: you or the OS may remove them later. No background artifact janitor runs.

Failures **throw**, so pi marks the tool call as failed. The error message is bounded, valid JSON containing a `kind`, message, `remoteOutcome`, and applicable Herdr code/exit code/artifact paths. Exact sensitive values reflected in diagnostics are redacted before clipping; this is not generic secret detection.

- `not_attempted`: validation/context/pre-spawn rejection.
- `unknown`: an ambiguous spawned mutation, including readiness/prompt failures; no rollback is implied.
- `not_applicable`: a read-only failure after invocation.

See [error categories](docs/tool-contract.md#errors).

## Development and verification

Run inside this repository:

```bash
npm ci
npm run verify
npm run test:cli
npm pack --dry-run --json
```

`verify` uses fake subprocesses/sockets and isolated pi loading; no Herdr binary, provider credentials, model calls, or live layout are needed. `test:cli` separately requires exactly Herdr 0.8.2 and connects it only to disposable fake sockets. The packed-source loader test runs without the package's devDependencies.

Real worker launch, prompt/read/wait/cancel and layout behavior require the separately authorized [manual smoke checklist](docs/manual-smoke.md). It is not part of `npm test`. [Release gates](docs/release-checklist.md) require final independent reviews, manual evidence, and fresh owner approval before merge/tag/publication.

MIT. Repository visibility/license are approved; release/publication are separate decisions.
