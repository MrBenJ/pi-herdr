# Owner-authorized manual smoke

**Status: not run.** Automated fixtures/CLI parser probes do not establish real worker launch, focus preservation, or provider behavior. This checklist is never wired to `npm test` or CI.

Run only after the owner approves the concrete hosting-server targets and commands below. A supplied workspace is not automatically disposable property: closing it needs separate authorization. Never repurpose an existing user/Claude session or select a different server as a shortcut.

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

For the future aria-actions dogfood, use a **new workspace and new no-focus tab** for its approved cwd. Do not reuse an existing worker tab. Task-specific work in that repository needs its own instructions/authorization beyond this smoke.

## Checklist

1. **Independent load.** Install this candidate locally and reload pi without requiring Todos. Confirm exactly `herdr_workspace`, `herdr_tab`, `herdr_pane`, and `herdr_agent` are discoverable. Registration alone must not create layout or contact/start a server.
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
