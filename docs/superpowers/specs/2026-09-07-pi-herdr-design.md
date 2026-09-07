# pi-herdr: standalone Herdr control extension

Status: draft for human review. This is a scope/design handoff, not an approved implementation plan.

## Purpose

Give a pi coding agent typed tools for controlling Herdr. Ship as an independently installable pi package in its own repository. Other extensions, including Todos, may require it; pi-herdr must not depend on them.

Repository: `/Users/bjunya/code/hbai/opensource/pi-herdr`.
No remote has been created. Do not publish, create a GitHub repository, or choose a license without the owner's approval.

## Agreed scope

Expose Herdr primitives for:

- Discovering and inspecting workspaces, tabs, panes, and agents.
- Creating workspaces, tabs, and pane splits with supplied working directories and supported launch options.
- Starting a supported agent in an existing shell pane, including pi with caller-supplied CLI arguments.
- Sending agent prompts, literal terminal text, and explicit key sequences.
- Reading terminal output and waiting for agent state or matching output.
- Focusing and closing explicitly selected terminal locations, subject to supported CLI capabilities and destructive-action safeguards.

Accept ordinary IDs, paths, prompts, and argument arrays. Return Herdr's actual IDs and state; never predict IDs or interpret terminal inactivity as successful task completion.

## Explicit non-goals

Do not implement:

- Todos storage, task discovery, enqueue tags, claims, ownership transfers, or review transitions.
- Queue watchers, orchestrator loops, automatic dispatch, concurrency policy, retries that launch duplicate workers, or worker pools.
- Git branch/worktree creation, merging, cleanup, dependency installation, or application port allocation.
- Human QA guidance or test-plan management.
- Usage tracking, subscription allowance detection, model-selection policy, or automatic provider switching.
- A worker-side pi control socket, RPC broker, messaging service, or direct access to another pi process's internal APIs.
- A replacement for Herdr's existing pi lifecycle integration.

The intended consumer may create a worktree and pass its directory to pi-herdr. That worktree lifecycle remains entirely outside this package. Sending instructions or keys to an agent is in scope; guaranteeing that a requested model switch happened internally is not.

## Architecture and alternatives

Recommended and previously agreed: a thin TypeScript adapter around the installed Herdr CLI, registered as pi tools. Execute an executable with an argument array, not a shell-built command string. Keep schemas, argument construction, transport, and result normalization separable for testing.

Alternatives considered:

1. Direct Herdr socket client: avoids CLI subprocesses and could support subscriptions, but requires owning protocol framing, endpoint handling, and compatibility. Defer unless a required operation cannot be implemented reliably through the CLI.
2. Generic shell or arbitrary CLI passthrough tool: smaller wrapper, but little benefit over bash and a weaker validated interface. Do not use as the main tool contract.

No background resource should start merely because pi loads the extension. No layout or agent mutations on load, reload, or shutdown.

## Proposed public contract

Exact names and schemas are implementation-plan work; the following is the proposed grouping, not a claim that tools already exist:

- `herdr_workspace`: list, inspect, create, focus, close as supported.
- `herdr_tab`: list, inspect, create, focus, close as supported.
- `herdr_pane`: inspect/list, split, run, send text/keys, read, wait for output, focus, close as supported.
- `herdr_agent`: list, inspect, start, rename, prompt, send keys, read, wait, focus as supported.

Validate each action against Herdr 0.8.2 CLI help before freezing the schema. Do not invent unsupported verbs. Require explicit targets for mutations; do not silently act on whichever workspace or pane happens to be focused. Prefer no-focus creation by default.

`start` takes agent kind, existing pane target, and an argument array. It does not create layout. Callers compose tab creation and agent start using returned IDs.

Calls should expose structured details alongside concise model-facing text. Preserve useful Herdr error codes and distinguish invalid input, missing executable/server, timeout, cancellation, malformed output, and Herdr operation failure. Signal tool failures using pi's documented error mechanism.

Separate extension installation is supported. Document tool discovery through pi's registered tool metadata for consumers that need to verify availability. Pi's event bus is process-local, not a cross-agent messaging channel. Do not promise that another extension can directly execute registered tools through an undocumented pi API. Programmatic integration and any bundled package dependency require an explicit supported contract before being advertised.

## Transport, safety, and lifecycle requirements

- Use argument arrays for Herdr calls. Prompts, labels, paths, and agent arguments must remain literal, including quotes, spaces, newlines, and shell metacharacters.
- Raw `pane run` deliberately executes a caller-supplied command inside a target terminal; document this distinction from safe CLI argument handling.
- Select a Herdr server consistently using documented CLI/environment behavior. Verify this behavior locally before implementation; do not silently fall back to a different server.
- Set finite waits and subprocess deadlines; propagate pi cancellation. State clearly that cancelling a wait or timing out does not terminate the remote agent or roll back an accepted mutation.
- Never automatically retry non-idempotent operations after ambiguous failures. A creation or prompt may have succeeded even if its response was lost.
- Destructive operations require an explicit target and explicit confirmation input in the tool contract. Do not rely solely on interactive dialogs; headless callers need deterministic behavior.
- Bound output by bytes and lines; provide a file location for full output when truncated, following pi's documented utilities. Avoid unbounded subprocess buffering before truncation.
- Never automatically answer an agent's approval dialog. Surface blocked state; deliberate key input is a separate caller action.
- Do not log environment credentials or echo sensitive launch arguments unnecessarily.
- Do not modify `~/.pi/agent/extensions/herdr-agent-state.ts`: it is managed by Herdr and overwritten on update.

## Verified Herdr semantics

Research baseline: installed Herdr 0.8.2 and its agent automation documentation.

- Creating a workspace also creates its first tab/root pane; creating a tab creates its root pane.
- Creation returns JSON IDs. Workspace creation exposes `.result.workspace`, `.result.tab`, and `.result.root_pane`; tab creation exposes `.result.tab` and `.result.root_pane`; splitting exposes `.result.pane`.
- `agent start` requires an existing available shell pane. It supports `--kind pi`; arguments after `--` pass to the agent executable.
- Startup readiness is distinct from process creation. A blocked startup can return `agent_not_ready` while leaving an agent available for inspection.
- Agent prompts can be sent while working. A blocked agent rejects normal prompting with `agent_blocked`.
- Prompt waits track lifecycle, not individual submitted turns. An already-active turn settling can satisfy a wait for a subsequently submitted prompt.
- `done` is background idle work not yet seen in the focused UI. `unknown` is not successful completion.
- CLI read operations return terminal text rather than the JSON envelope used by creation/control operations. Parse by operation, not with one universal JSON parser.
- Waits have no default timeout. The extension must supply bounded behavior.
- Recent history reads can interact with an idle alternate-screen application's viewport; visible reads are preferable when passive inspection is required.

Do not turn these observations into promises about task completion or successful code execution.

## Verification and acceptance criteria

Automated tests must use an injected runner or fake Herdr executable, without creating real tabs by default:

1. Tool registration works independently of Todos and without a running Herdr server.
2. Every supported action constructs the expected argv; hostile-looking strings remain individual literal arguments.
3. Required targets, action-specific parameters, and finite timeout ranges are validated.
4. Creation returns actual fixture IDs; read operations preserve plain text.
5. Missing binary/server, nonzero exits, structured errors, malformed JSON, cancellation, and timeouts surface accurately.
6. Output truncation bounds both bytes and lines and identifies the full-output artifact.
7. Mutations are not retried automatically; timeout errors do not claim rollback.
8. Reload/shutdown does not create or close terminals, and unrelated extensions/tools remain unaffected.
9. Close actions require explicit confirmation and targets.

Opt-in manual integration test on a disposable Herdr workspace:

1. Load pi-herdr without Todos and discover existing Herdr state.
2. Create a no-focus tab in the explicit disposable workspace and confirm the active user tab remains unchanged.
3. Use its returned root pane ID to launch pi with supplied arguments; send a harmless prompt.
4. Inspect state and output, send another prompt, and exercise a short bounded wait.
5. Cancel a wait and confirm the worker remains available; do not interpret idle as task success.
6. Exercise deliberate key input only against the disposable worker.
7. Close only the explicitly selected test tab/workspace after confirmation.
8. Confirm no worktrees, todo records, or existing Herdr integration files were changed.

## Handoff instructions

Stop after this design document until the owner reviews it. Then use Superpowers `writing-plans` to produce a separate implementation plan with concrete file paths, frozen schemas, fixture formats, and red/green verification steps. Do not describe this scope document as an executable implementation plan.

Before writing code, read the locally installed pi extension/package documentation completely, follow relevant cross-references, and inspect extension examples. Re-check Herdr CLI reference/help for every exposed action and server-selection option. Record supported versions rather than claiming untested cross-platform compatibility.

Suggested implementation order: package skeleton and test harness; CLI transport/error handling; read-only discovery; explicit layout mutations; agent/pane interaction and waits; output bounds and cancellation; independent installation documentation and opt-in smoke testing. Follow TDD. No remote creation or publication in this handoff.

## Sources and local context

- https://herdr.dev/docs/agent-automation/
- https://herdr.dev/docs/cli-reference/
- https://herdr.dev/docs/socket-api/
- https://github.com/obra/superpowers
- Pi docs: `/Users/bjunya/.nvm/versions/node/v26.8.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `packages.md`.
- Pi examples: the same package's `examples/extensions/` directory.
- Existing Todos implementation: `~/.pi/agent/extensions/todos.ts` (context only; do not couple to it).
- Existing lifecycle reporter: `~/.pi/agent/extensions/herdr-agent-state.ts` (read-only context).
- Superpowers installed globally using `pi install git:github.com/obra/superpowers`; installation verified with `pi list`. Existing sessions need `/reload` to activate newly installed resources.
