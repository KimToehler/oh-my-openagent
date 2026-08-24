# Review blockers - resolution evidence

A 5-lane `review-work` review FAILED on the code-quality lane with 3 MAJOR blockers.
All three were independently reproduced by the orchestrator before any fix was made,
and re-verified after. Two documentation inaccuracies surfaced by other lanes were
fixed in the same pass.

## WHAT WAS TESTED

Blocker 1 (cache invalidation on an unknown epoch) was reproduced by executing the REAL
`createTranscriptHydrationStore` against a client whose `session.messages` throws, then
applying the processor's reset predicate to the resulting epoch.

Blocker 2 (compaction-marker detection) was tested against the live opencode SQLite
database rather than argued from the diff, counting marker distribution and ordering.

Blocker 3 (a test passing for the wrong reason) was confirmed by reading the fixture and
computing the scan window offset by hand, plus grepping for any assertion on
`getCompactionEpoch`.

## WHAT WAS OBSERVED

Blocker 1, BEFORE the fix:
```
fetch FAILED -> relativePaths: [] | epoch: undefined
stored epoch: msg_compaction_1 | observed epoch: undefined
=> cache reset fires? true
```
A transient transcript-fetch failure produced `undefined`, which was indistinguishable
from "this session never compacted", so the whole dedup cache was discarded and every
matching rule would re-inject. `hydrateSession` sets `hydrated = true` even on the error
path, so the condition persists for the process lifetime.

Blocker 1, AFTER the fix:
```
observed epoch after fetch failure: undefined
cache reset fires? false
FIXED: transient failure no longer wipes the dedup cache
genuine new epoch still resets? true
```
Both halves of the contract hold: no reset without positive evidence, and a genuinely
new epoch still invalidates.

Blocker 2, live DB measurement:
- 91 parts with `type = "compaction"`, 95 messages with `agent = "compaction"`.
- The two marker sets are DISJOINT: no message carries both.
- They are PAIRED per session: 0 sessions have one marker without the other.
- Ordering: in 94 of 95 nearest pairs the part marker comes first; 1 outlier had the
  agent marker first by 6292 ms (session `ses_0720173b8ffeutMWjzP5O3nOI9`).

So the original parts-only check was not reachable-broken on today's data. It was still
changed to the shared `isCompactionMessage`, for consistency with the four other
consumers of `shared/compaction-marker.ts` and for resilience if the SDK ever emits only
one marker. The ordering outlier means the residual doc comment was NOT rewritten to
claim the summary is always excluded; it was narrowed to state accurately that the
part-first shape can still leave summary text inside the scanned window.

Blocker 3: the caps fixture placed the compaction at index 0 of 202 messages, so
`start = 202 - 200 = 2` and the compaction was never reached. The test asserted `[]`,
which held for reasons unrelated to its name, including under the Blocker 1 defect.
Replaced with two tests (compaction inside the window, compaction outside the window),
both asserting the `getCompactionEpoch` value, plus a case pinning the `undefined`
fallback when a compaction message has no `info.id`.

Full gate after the fixes: 15620 pass / 5 skip / 14 fail / 2021 files, typecheck EXIT=0.
Failure set compared against the pre-change baseline with `comm` in both directions:
empty. Zero failures in rules-injector, the shared helper, or the directory injectors.
Artifacts: `gate2-fulltest.txt`, `gate2-typecheck.txt`.

## WHY IT IS ENOUGH

Each blocker has a reproduction that failed before the fix and passes after, and the
riskiest one (Blocker 1) was verified by driving the real module rather than by reading
the diff. Blocker 2 was settled with a measurement over 95 real compaction events instead
of an argument. The regression surface is covered by the unchanged 14-failure baseline.

## WHAT WAS OMITTED

No live model-backed session with a real OpenCode-emitted compaction was driven; that
limitation is unchanged from the original QA and is stated in `README.md`. The
`createTeamSendMessageTool` timeout observed in one QA run is a load-dependent flake,
green 3 of 3 in isolation, unrelated to this change; `gate-comparison.txt` carries a
correction noting the baseline is 14 plus or minus that flake rather than a fixed count.

## Re-review follow-ups (second pass)

The scoped re-review of the fix delta returned PASS with no blocking issues, and named
four MINOR cleanups. Three were applied, one was recorded rather than coded.

Applied:
1. **Restored a null guard that the Blocker-2 fix silently dropped.** The previous
   `hasCompactionPart(getMessageParts(message))` was null-safe because `getMessageParts`
   returned `undefined` for a null or non-object entry. `isCompactionMessage` is not: it
   evaluates `message.info?.agent ?? message.agent`, where the optional chain protects
   `info`, not `message`. Reproduced by driving the real store with a null element in
   `data`:
   ```
   with a null element in data -> paths: []
   CONFIRMED: one bad element aborts the ENTIRE scan (marker lost)
   ```
   The throw was caught by `hydrateSession`, so it degraded to empty paths and an
   undefined epoch, which is fail-open and therefore not a blocker. The cost was that one
   malformed entry discarded the whole scan for that session for the process lifetime.
   Fixed with an `isCompactionRecord` wrapper that narrows before delegating.
   Guarded by a new test, which was mutation-proved: reverting the wrapper to a direct
   `isCompactionMessage` call turns the suite red on exactly that case, and restoring it
   returns 17 pass / 0 fail.
2. **Removed dead code in `injection-processor.ts`.** `shouldReset` already guarantees
   `compactionEpoch !== undefined`, so the `compactionEpoch === undefined ? {} : ...`
   spread and the `delete loadedCache.compactionEpoch` arm were both unreachable. Their
   presence implied a reset could clear the epoch, which it cannot.
3. **Removed the now-unused `getMessageParts` helper.** Its only call site was the
   expression replaced by the Blocker-2 fix. No lint rule would have caught it, since
   `noUnusedLocals` is not enabled for this package.

Recorded, not coded:
4. **Row 4 of the epoch truth table is the one direction this fix trades into.** If a
   real compaction occurs, hydration cannot observe it (transcript fetch error, or the
   compaction scrolled past `HYDRATION_MAX_MESSAGES`), AND a dedup cache survives, then
   rules stay suppressed. Two things bound it. The in-process path does not rely on the
   epoch at all: `hook.ts` handles `session.compacted` by clearing both the in-memory
   entry and the persisted file. And in the fetch-failure sub-case hydration also returns
   an empty path set, so transcript-based suppression is simultaneously lost. This is
   also the pre-branch baseline behavior, so the fix declines to add a new fail-open path
   rather than introducing a new fail-closed one.
