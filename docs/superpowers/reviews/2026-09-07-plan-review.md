# Initial plan review and dispositions

Review baseline: `fda97b3356d3f511d4ad52261ae3780a83322d6f`, draft PR [#1](https://github.com/MrBenJ/pi-herdr/pull/1), branch `docs/approved-design-plan`. Reviewed plan SHA-256: `dd9e787ea0b7c50bac6ff9b85fe7a6d32cf086fad9ac88bd7547e0cc79435482`.

Both original reviews were read completely. Claude approved beginning implementation with localized clarifications; Aria requested changes. Their verdicts apply to that original revision, not to the corrections below. No pi-herdr implementation exists yet.

## Accepted corrections

| Finding | Disposition in the revised plan |
|---|---|
| Aria: agent startup permits invalid low timeouts | Agent start now validates integer 3001–300000 ms, while ordinary waits retain 1–300000 ms. Both default to 30000. Spec, helper, field table, and positive/negative tests agree. Installed Herdr 0.8.2 schema and startup error text establish the server-side lower bound; CLI parser acceptance is insufficient evidence. |
| Aria: unclear capture/runner/normalizer failure flow | A single ownership contract now separates pre-spawn typed rejections from post-spawn returned stops. Capture uses an internal limit error; the runner catches it, terminates only its child, finalizes partial captures and returns a stopped result; normalization creates the public tool failure. Capture I/O failures, partial counters, finalization, artifact retention, and unexpected runner rejection are explicit. |
| Aria: confirm flag is not human authorization | Owner explicitly retained target + confirm=true for trusted automation on 2026-09-07. Spec and plan now describe this as deliberate caller opt-in, not independent human authorization or a sandbox. No per-close human dialog or approval broker is introduced. |
| Claude: missing clear field rule | Agent rename accepts either name with clear absent, or clear=true with name absent. Explicit false/null/coercions and both forms together are rejected. |
| Claude: kind/direction/wait rules implicit | Added explicit field definitions with per-action restrictions and exact enum/boolean behavior. |
| Claude: signal forwarding ambiguous | Tool closure explicitly forwards its third positional execute argument, not ctx.signal, with a registration-level cancellation test. |
| Claude: KB/KiB wording ambiguous | Spec and plan use 50 KiB = 51200 UTF-8 bytes. The installed pi DEFAULT_MAX_BYTES is exactly 50*1024, so no default mismatch exists. |

## Evidence-based clarifications

- **Aria's stale-spec observation concerns historical main.** The original baseline was intentionally pushed as main; the approved spec, public repository decision, and MIT license were already in the actual PR head under review. The plan now names the branch/PR source explicitly and marks completed remote/review setup gates. A future merge must bring those approved documents into main; main is not silently rewritten for a review.
- **Repeated --until is supported.** Installed CLI help specifies repeated state flags. Disposable fake-server probes observed agent.wait with until=[idle,done] and agent.prompt with wait.until=[idle,blocked]. This is now recorded in the evidence table and required in the CLI contract tests. Pane wait-output has match/regex, not lifecycle-until states.
- **The pi loader shape is verified.** The public SDK exports and a real installed-loader harness confirm getExtensions().errors/extensions, each extension's tools Map, explicit paths with noExtensions=true, and two reload cycles. Keep the independent package-loader acceptance test in Task 6. This compatibility probe is not a claim that unimplemented pi-herdr passes tests.

## Next gate

Request independent re-review of the revised plan, carrying the original findings forward and recording the new plan hash and PR head. Resolve genuine remaining blockers before implementation. Keep the PR draft; no merge, version tag, release, or npm publication is authorized by repository setup or reviewer approval.
