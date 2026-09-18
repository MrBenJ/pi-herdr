# Owner-authorized manual smoke

**Status: not run.** Automated fixtures/CLI parser probes do not establish real worker launch, focus preservation, or provider behavior. This checklist is never wired to `npm test` or CI.

Run only after the owner approves the concrete hosting-server targets and commands below. A supplied workspace is not automatically disposable property: closing it needs separate authorization. Never repurpose an existing user/Claude session or select a different server as a shortcut.

Before loading a candidate, run `pi list`. Remove or filter out every older pi-herdr checkout so only one source registers each primitive tool. Start a fresh Pi process and confirm there are no extension-conflict diagnostics before testing worker launch; an agent-start failure caused by duplicate package sources is invalid environment evidence and must be corrected before rerunning the affected test.

## Authorization record

Record these without credentials:

- Exact candidate commit and pi/Herdr/Node/platform versions.
- Hosting socket identity (do not change it), original active workspace/tab IDs.
- Approved disposable workspace ID, or separate permission to create one.
- Existing absolute working directory.
- Worker name, kind, and native argument array; omit credentials from evidence.
- Harmless prompt and one specifically authorized key, if key coverage is desired.
- Permission to split/focus/close the **new test** pane/tab; workspace closure is separately approved or prohibited.
- Checksums/snapshots for the separate managed lifecycle reporter and existing task/Todos storage, where present. Do not modify them to make this test pass.

Do not use the interrupted `aria-actions` worktree as smoke-test material. A future repository-bound dogfood must reuse the sole canonical-repository workspace, create a new no-focus tab at `<repo>/.worktrees/<name>`, and receive separate explicit authorization.

## Orchestrator checks

1. **No-mutation inspection.** With both entry points loaded, call `herdr_task inspect` for the candidate's canonical main checkout. Record canonical root, complete worktree inventory, matching workspace ID (if any), and violations. Confirm no workspace, worktree, tab, pane, or agent was created.
2. **Disposable repository preparation.** Only after owner approval, create or select a disposable canonical Git repository, commit `/.worktrees/` in `.gitignore`, and record a non-default feature branch/name. Do not point the launch smoke at an active client or product repository.
3. **Single launch.** Call `herdr_task launch` once. Verify the exact path is `<repo>/.worktrees/<name>`, one canonical repository workspace exists, one no-focus tab was created, one worker was started, and the original focus did not change.
4. **Boundary observation.** Inspect the worker prompt/session without publishing it. Confirm it names the returned topology and forbids worktree/layout/subagent fan-out.
5. **Failure preservation.** Do not manufacture a live ambiguous mutation. Use automated evidence for this behavior. If a real ambiguity occurs, stop, record confirmed handles, and obtain separate cleanup authorization; never retry automatically.
6. **No automatic cleanup.** Leave all successful/partial resources in place until the owner explicitly authorizes exact branch/worktree/tab/agent cleanup.

## Profiled launch checks (`piProfile`)

**Status: partially run (2026-09-18, owner-driven, Herdr 0.9.0, Pi 0.85.1, pi-profile 0.1.0, macOS, zsh).** In a disposable repository with a disposable profile, three profiled launches were made. The first exposed a result-layer bug (Herdr's silent `pane run` acknowledgement was reported as a `profile-run` failure although the worker had started); after the fix, two launches succeeded end to end: one no-focus tab, foreground processes `pi-profile --cwd <worktree> <profile>` plus its `pi` child, the profile indicator shown, the requested name confirmed on the exact pane, and a three-line prompt delivered once and intact with the boundary, answered correctly by the worker. `agent_session`, `interactive_ready`, and `launch_pending` were absent for the profiled worker. Not yet run: steps 1, 6–8, the default-directory variant of step 3, and the remaining repetitions of step 5.

These need the same owner authorization as the orchestrator checks, plus approval of the exact profile used.

Additional authorization record: the disposable profile name (create one with `pi-profile create`, for example `smoke-a`; do not use a real work or client profile), confirmation that `pi-profile` and `pi` resolve on the `PATH` of a freshly opened Herdr tab, the tab shell (bash or zsh), and the native argument array. Never record the profile's `.env` contents.

1. **Pre-mutation rejection.** Call `herdr_task launch` with `piProfile: "../x"`, then with a valid `piProfile` and `agentKind: "claude"`. Both must fail as `invalid_input`; `herdr_task inspect` must show no new worktree, tab, or agent.
2. **Single profiled launch.** In the approved disposable repository, launch once with `agentKind: "pi"`, the disposable `piProfile`, and harmless `args` that include a value with a space. Verify one no-focus tab, unchanged original focus, and a result containing `launcher: {kind: "pi-profile", profile, commandSubmitted: true}` and the requested agent name on the returned pane.
3. **Real launcher.** If approved, first give the disposable profile a different `--default-cwd` and confirm the worker still starts in the worktree. With `herdr pane process-info --pane <returned pane>`, confirm the foreground processes are `pi-profile --cwd <worktree> <profile> …` and its `pi` child with the native arguments intact. In the worker, confirm the profile indicator/`PI_PROFILE_NAME` and that `pi-profile show <profile>` lists an active lease. Do not publish environment values.
4. **Detection and naming.** `herdr_agent inspect` by the requested name must return that exact pane with agent `pi`. Confirm the boundary prompt arrived once, intact, and only after the worker was idle.
5. **Readiness.** Repeat the profiled launch at least five times with a multi-line prompt, including a cold first launch of the profile. Record whether any prompt was dropped or split, and whether `herdr agent get <pane>` ever reports `agent_session`, `interactive_ready`, or `launch_pending` for a profiled Pi (with and without the Herdr Pi integration installed into the profile root). A single dropped prompt means the two-idle readiness rule is insufficient and must be replaced before release.
6. **Unprofiled regression.** Launch once without `piProfile` and confirm the worker is plain `pi` started by `agent start`, with no `launcher` in the result.
7. **Failure observation (optional, separately approved).** Launch with a well-formed but nonexistent profile name. Expect stage `profile-detect`, `ambiguous: true`, the tab handle, `commandSubmitted: true`, no `agent`, and the `pi-profile` error visible only in the pane. Confirm nothing was retried or closed. Clean up the tab only with explicit authorization.
8. **Blocked startup.** If the worker stops at a trust or approval dialog, the launch must fail at `profile-detect` without answering it. Do not answer it on the owner's behalf.

## Primitive checklist

1. **Independent load.** Filter the package to `+src/index.ts`, reload pi without requiring Todos, and confirm exactly `herdr_workspace`, `herdr_tab`, `herdr_pane`, and `herdr_agent` are discoverable. Registration alone must not create layout or contact/start a server.
2. **Read baseline.** Use list/inspect tools to record the original active context and the exact approved target workspace. Never derive IDs from numbers or examples in README.
3. **Create no-focus tab.** Call `herdr_tab` create with the approved `workspaceId`, real `cwd`, and a harmless label. Record actual returned `tab.tab_id` and `root_pane.pane_id`. Verify the original active tab remains active.
4. **Rename.** Rename only that recorded new tab using a label containing spaces. Inspect to verify only its label changed.
5. **Start worker.** In the returned root pane, verify an interactive shell is ready, then start the approved agent with its explicit name/kind/native args. Inspect readiness. If blocked, surface it; do not answer an approval dialog or restart automatically.
6. **Prompt/read.** Send the approved harmless prompt requesting a short fixed reply. Read the visible snapshot, explicitly request recent output, then send a second prompt. Inspect the actual text rather than treating idle/done as proof of success.
7. **Wait/cancel.** Exercise a short bounded agent wait and a deliberately unmatched pane output wait. Cancel a local wait and confirm the remote worker remains inspectable. Record timeout/cancel outcome; never retry a mutation merely because its local call timed out.
8. **Secondary primitives.** If specifically authorized, send the harmless key only to this worker. Split only the new test tab using an explicit source pane/direction/cwd. Inspect the new pane, exercise focus-neighbor with an explicit source/direction, then restore the original focus explicitly. Close the test split pane only with its recorded ID and `confirm: true`.
9. **Confirmation guard.** Attempt to close the new tab without `confirm`; confirm an `invalid_input` failure and that the tab still exists. Then close only the recorded new test tab with `confirm: true`. Close the workspace only if its removal was separately approved.
10. **Preservation.** Recheck original active context, unrelated terminals/tools, worktrees, existing task data, and managed reporter checksum. The only intended changes are the approved test resources and worker-local session output. Explain any difference before calling smoke successful.

## Evidence and cleanup

Record each requested operation, returned IDs, observed state/text and failure kind/outcome, plus any remaining test-resource IDs. Never publish native credential-bearing argv, environment values, raw terminal secrets, or private artifact contents.

A failed/ambiguous mutation is not proof that no resource was created. Inspect before deciding cleanup; do not repeat creates/starts blindly. Cleanup itself is a targeted authorized mutation, not a blanket "close everything" operation.

Retained capture paths may be inspected locally if needed. Treat them as private temporary data, not durable release evidence. After relevant code changes, repeat affected smoke steps on the final candidate; evidence from an earlier candidate is not approval of a later one.
