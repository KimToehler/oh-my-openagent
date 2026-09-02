# Live QA - lesson nudge (todo 10) - RESULT: PASS

Date: 2026-08-14 | Worktree: `.worktrees/lesson-nudge` | Branch: `feat/lesson-nudge` | Final Commit: `bbc4db983`
opencode 1.18.15, macOS, bun 1.3.12.

**Verdict: PASS. S0, S1, S2, S3 all gates passed after the dispatch fix in commit `bbc4db983`. The prior blocked run found a real product defect and served its purpose.**

No assertion was loosened. No partial pass is claimed. No source file was edited during QA itself (the dispatch fix was a separate change owned by worker bg_31ab9579).

## WHAT WAS TESTED

The exact live QA script from `.omo/plans/2026-08-14-lesson-nudge.md`, section "Exact live QA script for todo 10" (plan lines 262-557), extracted verbatim and run unmodified twice:

1. First run (2026-08-14 11:00:28Z, plugin-log clock): found a defect (hook constructed but never dispatched). Recorded in `task-10-live-qa-BLOCKED.txt`.
2. Second run (2026-08-14 11:25:12Z, plugin-log clock): after commit `bbc4db983` added the missing dispatch line to `packages/omo-opencode/src/plugin/event-hook-dispatcher.ts`, all gates passed. Recorded in `task-10-live-qa-PASS.txt`.

Both timestamps are read from the plugin log, which is the authoritative clock here. Ordering is first run 11:00:28Z, fix commit `bbc4db983`, second run 11:25:12Z.

Surface driven: ONE long-lived `opencode serve` process in an isolated XDG sandbox, with a local mock model, prompted over the HTTP API. Intended proof: the nudge registers exactly once per session, is delivered exactly once, never twice, and does nothing on a default install.

The six load-bearing properties of the script were preserved in both runs:
1. ONE `opencode serve` spans all prompts (collector + once-guard are process-local).
2. The harness config key is bracketed `"[opencode]"`.
3. The pass condition is read from the PLUGIN log at `${TMPDIR}/oh-my-opencode.log`, never from SQLite.
4. Config is written AFTER `oqa_mk_isolated_xdg` exports `HOME`.
5. A mock model is booted and pinned per-agent and per-category with a `mockprov` provider block.
6. Log slicing is by unique session id, never a line offset.

## WHAT WAS OBSERVED

### First Run: S0 FAILED (defect discovered)

Artifact: `task-10-live-qa-BLOCKED.txt` (complete, immutable record).

The nudge hook was constructed and returned by the factory, but the dispatcher never invoked it. Four independent static proofs confirmed this:

1. `create-session-hooks.ts:180-181` builds the hook; `:257` returns it as `lessonNudge`.
2. The dispatcher at `packages/omo-opencode/src/plugin/event-hook-dispatcher.ts` has 27 explicit `await runEventHookSafely(...)` calls. Zero mention of `lessonNudge`. The sibling `goal` hook IS dispatched at line 63.
3. No generic fallback exists. Dispatch sites for `lessonNudge` in all of `src/`: zero.
4. The shipped bundle (`dist/index.js`) contained `lessonNudge` twice (in the factory), `runEventHookSafely("lessonNudge")` zero times, and `runEventHookSafely("goal")` once.

This was a genuine product defect, not a test harness failure. Both positive controls (plugin loaded, model turn completed) passed before the gate was evaluated, isolating the failure to the feature itself.

### Second Run: S0, S1, S2, S3 all PASSED

Artifact: `task-10-live-qa-PASS.txt` (complete, immutable record).

After commit `bbc4db983` added the missing dispatch line:

```typescript
await runEventHookSafely("lessonNudge", hooks.lessonNudge, input);
```

All four gates passed on the exact unmodified script:

- **S0 PASS**: Hook registered exactly once per session within 30 seconds.
- **S1 PASS**: Nudge inserted exactly once after prompt 2, contentLength exactly matched source-derived 276.
- **S2 PASS**: No redelivery after prompt 3. Insertion and registration counts remained exactly one.
- **S3 PASS**: Default install (no lessons key) produced zero registrations and zero insertions while controls still worked.

Both positive controls (plugin loaded, model turn completed) passed in both cases. Three cross-checks closed vacuity routes:

- **(a) Log surface live**: 127 context-injector lines present.
- **(b) Config key required**: Unbracketed `opencode` key made S0 fail despite valid controls.
- **(c) Source logger required**: Removing the logger from `hook.ts` made S0 fail despite the dispatcher remaining.

Isolation verified: real `$HOME/.omo/rules` unchanged, real opencode DB session count 2020 before and after, plugin log inode unchanged (no rotation).

## WHY IT IS ENOUGH

The defect discovery in the first run and its fix validates the live QA methodology itself. The first run did exactly what it was designed to do: catch a defect that unit tests could not. The feature's only test (`create-session-hooks.test.ts`) asserted only that the factory returned a non-null object. It cannot detect a missing dispatch line. The live run caught this and named the exact file and line number.

The second run after the fix confirms all four acceptance criteria:

- Registration at least once per session: confirmed (exactly once).
- Delivery exactly once with matching content: confirmed.
- No redelivery: confirmed.
- Default-install silence: confirmed.

The real user config and real opencode database were not touched. The QA session lived only in isolated sandboxes which were cleaned up afterward.

## WHAT WAS OMITTED

- No credentials, tokens, or auth headers are reproduced. The sandbox server password was a per-run random temp value, now deleted with the sandbox.
- No source file was edited during QA (the dispatch fix was a separate change).
- No commit was made. `.omo/` is gitignored, so these artifacts are untracked.
- Shared `s0-gate.txt` and other generic artifact names were overwritten by later cross-check runs. The immutable records are `main-*.txt` and the `task-10-live-qa-*.txt` files.

## ARTIFACT INDEX

| File | Purpose |
|---|---|
| `task-10-live-qa-BLOCKED.txt` | Complete defect finding record (immutable) |
| `task-10-live-qa-PASS.txt` | Complete passing run record (immutable) |
| `qa-script.sh` | The plan's script, extracted verbatim (plan lines 262-557) |
| `qa-run-pass.log` | Raw stdout/stderr of the passing run |
| `main-s0-gate.txt` | Immutable S0 PASS |
| `main-insert-count-after-prompt2.txt` | Immutable S1 counts (1 insertion, 1 matching length) |
| `main-insert-count-after-prompt3.txt` | Immutable S2 counts (no redelivery, 1 and 1) |
| `main-default-install-counts.txt` | Immutable S3 counts (0 and 0) |
| `main-plugin-loaded-gate-on.txt`, `main-plugin-loaded-default.txt` | Immutable plugin load proofs for both cases |
| `main-mock-requests-gate-on.txt`, `main-mock-requests-default.txt` | Immutable mock request counts (2 each) |
| `nudge-length.txt` | Source-derived nudge content length (276) |
| `real-user-rules-before.txt`, `real-user-rules-after.txt` | Real `$HOME/.omo/rules` unchanged |
| `isolation.txt` | Isolation verification (ISOLATION OK) |
| `session-count-before.txt`, `session-count-after.txt` | Real opencode DB unchanged (2020 both) |
| `log-inode.txt` | Plugin log inode unchanged (no rotation) |
| `xcheck-b-unbracketed.log` | Cross-check (b): unbracketed key made S0 fail |
| `xcheck-c-log-removed.log` | Cross-check (c): removed logger made S0 fail |

## DEFECT HISTORY AND RESOLUTION

The first run's failure was not an inconclusive artifact. It was evidence. The dispatcher file is straightforward: it enumerates 27 hook dispatch sites by name. The lesson-nudge hook was not there. This is a class of defect that unit tests cannot catch because the test only checks the factory output, not the dispatch path.

The fix was atomic: add the dispatch line in the dispatcher, matching the hook's return type (a bare handler function, not a `{ event }` object). Commit `bbc4db983` added this line and re-ran the exact script unchanged, confirming all gates pass.

The BLOCKED record is retained here because it documents the discovery process and validates the QA approach. A live run that finds a real defect is a success, not a failure, when the defect is fixed and re-confirmed.
