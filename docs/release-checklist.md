# Release evidence and gates

Repository: public `MrBenJ/pi-herdr`, MIT, draft [PR #1](https://github.com/MrBenJ/pi-herdr/pull/1). The original `main` baseline is intentionally preserved until an approved merge.

**No release is approved.** Merge, tag/release and npm publication are separate owner decisions. A finished review process, passing unit suite, or idle worker is not release approval.

## Recorded development evidence

Local baseline: macOS arm64, Node 26.8.1, npm 11.19.0, pi/pi-ai 0.85.1, TypeBox 1.3.7, Herdr 0.8.2/protocol20. Source/package peer versions are deliberately separate from claims of platform support.

At implementation commit `b9fb447`:

- `npm run verify`: typecheck clean; 328 unit/integration tests passed, 10 CLI tests skipped by default.
- `npm run test:cli`: 10/10 passed with installed Herdr 0.8.2 against fake sockets only.
- `npm pack --dry-run --json`: all 14 runtime source modules present; no bundled dependencies or test/private-artifact directories.
- Real pi loader: sole explicit package, two reloads and repeated shutdown, no hosting environment or subprocess/capture creation.
- Independent per-task reviews completed, with direct regression fixes and re-reviews. Task5's review requested extra line-only truncation/incomplete-capture tests; those were added with observed mutation failures before final approval.

Task7 additionally tests loading a copy of the **packed source** with no package `node_modules`/devDependencies, not just the development checkout. Final command results, CI run URLs, reviewer identities and exact candidate SHAs belong in the PR evidence record so a documentation commit need not claim its own unknowable hash.

## Candidate gates

- [ ] Final `npm run verify`, `npm run test:cli`, `npm pack --dry-run --json`, and `git diff --check` recorded against the candidate.
- [ ] Fake-only CI passed on Node22.19.0 and26.8.1; until observed, the engine floor is a requirement, not a tested-platform claim.
- [ ] Independent final Claude review of actual candidate source/diff, no unresolved blockers.
- [ ] Independent final Aria review of actual candidate PR, no unresolved blockers.
- [ ] Accepted findings receive a regression test, observed failure, minimal fix, full verification and scoped re-review.
- [ ] [Manual smoke](manual-smoke.md) explicitly authorized and completed on final affected behavior. **Currently not run.**
- [ ] Package includes only intended source/docs/license; no private outputs, credentials, or unintended lifecycle scripts.
- [ ] Owner reviews the final PR and explicitly approves shipping.

## After owner approval only

- [ ] Merge according to the agreed repository policy; do not overwrite the original baseline/history.
- [ ] Create the specifically approved immutable version tag/release.
- [ ] Verify pi installation at that exact Git ref in a clean environment; update README with the real released install command.
- [ ] Publish to npm only if the owner separately selects npm distribution and approves the package name/account. Git distribution alone is sufficient; never implicitly publish both.
- [ ] Record release ref, verification evidence and remaining supported-platform limitations.

## Rollback/removal

Use `pi remove` with the installed source, then `/reload`, or reinstall a previously reviewed immutable ref. Do not use remote closes as an uninstall/rollback mechanism. Local package installs reference their checkout, so retain it until the install is removed/repointed. Retained private capture files survive removal/reload unless separately cleaned by the user/OS.

## Still deliberately outside this package

No Todos execution API, worker orchestration, worktree/port/model policy, or managed lifecycle reporter replacement. Private `/jobs`, Jump and future `/btw` work are separate harness projects and must not enter the public package.
