# Gap 1 design decision — bound rule re-injection to the current compaction epoch

**Source:** oracle design review (session `ses_fcc636229ffeZ4lD6w7RIBUReQ`), independently
re-verified by the orchestrator against the SDK types and the live opencode DB before adoption.
**Status:** binding for the Gap 1 implementation tasks.

## The defect being fixed

`transcript-hydration.ts` scans the full session transcript for the injector's own
`[Rule: <path>]` banner and treats any bannered rule as already injected
(`injection-processor.ts:135-141` marks it injected and `continue`s). After a compaction the
banner sits in a message dropped from model context, but it is still in the DB, so the rule is
suppressed forever. `hook.ts:101-106` clears the persisted cache on `session.compacted`, but
hydration immediately re-suppresses.

## (a) How the epoch boundary is located

Stop the existing newest-to-oldest scan loop (`transcript-hydration.ts:128`) at the first
message satisfying `hasCompactionPart(message.parts)`. Because the loop already runs backwards,
the first compaction part encountered IS the last compaction in the session, by construction.
No prepass, no index map, no second traversal.

Use `hasCompactionPart` (exported, `shared/compaction-marker.ts:25`).
Do NOT use `isCompactionMessage` (`:29`) — it also matches `agent === "compaction"`, which
pulls in the summary message that follows the boundary.

## (b) Fallback when the boundary is unavailable

No compaction part in the transcript: behave byte-identically to today (scan everything).
This is the only fallback needed once `tail_start_id` is dropped, see (c).

Error direction, deliberately chosen: err toward RE-INJECTING, never toward hiding.
Duplicate injection costs some context tokens once; permanent suppression silently breaks rule
delivery, which is the HIGH bug being fixed.

The feared runaway loop cannot occur. After a re-injection `injection-processor.ts:151-152`
adds realPath + contentHash and `:158`/`:166` persists, so the next call short-circuits at
`:110`. Duplicate injection is bounded to one per (session, rule) per cache-clear event, and
cache-clear events are only `session.deleted` / `session.compacted` (`hook.ts:93-107`). It is
also self-healing: the re-injected banner lands after the boundary, so the next hydration sees
it legitimately.

## (c) Is `tail_start_id` load-bearing? NO. Drop it.

Verified by the orchestrator, not taken on trust:

1. `CompactionPart` in the installed SDK (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:338-344`)
   is `{ id, sessionID, messageID, type: "compaction", auto }`. **`tail_start_id` is NOT
   declared.** Reading it needs runtime-guarded narrowing, and `as any` is a blocking
   anti-pattern in this repo. It can also vanish on an SDK bump and silently demote us.
2. Live DB counts: 91 compaction parts total, 85 carry `tail_start_id`, 6 do not.
   The field exists at runtime but is undeclared, which is the worst combination to depend on.
3. Oracle measured the gap between the `tail_start` message and the compaction-part message
   across all 91: max 13 messages, typically 6-8, and the number of rule banners that ever
   landed inside that gap is ZERO across the entire DB.

So cutting at the compaction-part message is empirically identical to cutting at `tail_start_id`,
and is strictly conservative in the chosen error direction. Bonus: no `compaction-marker.ts`
change is needed, since `isCompactionPart` (`:17`) is module-private and would have had to be
widened only to read a field we are no longer reading.

## (d) Accessor used from shared/compaction-marker.ts

`hasCompactionPart(parts: unknown): boolean` — already exported at `:25`, already takes exactly
the `parts` array shape that `session.messages` returns
(`Array<{ info: Message; parts: Array<Part> }>`). NO new export, NO modification to that file.
Never inline a `type === "compaction"` string comparison in the hydration module.

## (e) ADDITIONAL SCOPE the review uncovered: the persisted cache must also be epoch-aware

The hydration bound ALONE is insufficient. Verified in source: `injection-processor.ts:89`
calls `getSessionCache` and `:110` checks `isDuplicateByRealPath` against it, while hydration
happens at `:93`. The persisted cache at `cache.ts:22` (`loadInjectedRules`, durable JSON via
`storage.ts:13`) therefore short-circuits BEFORE hydration matters.

Inert path: if the plugin was not running, or the hook was gated off
(`create-tool-guard-hooks.ts:104`), when `session.compacted` fired, the stale pre-compaction set
is rehydrated from disk and the rule stays suppressed. A plugin/process restart across a
compaction is the dominant real-world case. A swallowed event-handler throw
(`event-hook-dispatcher.ts:24-33`) is a second, quieter path.

Required shape:
- `storage.ts`: add an optional `compactionEpoch` to `InjectedRulesData` (which today carries
  only `updatedAt`, `:44`). Write it in `saveInjectedRules`; read it tolerantly in
  `loadInjectedRules` (`:16-33`); missing field = `undefined` = "no compaction observed".
- `injection-processor.ts`: move the hydrate call ABOVE `getSessionCache`, since the epoch check
  feeds cache validation and `:110` consumes the cache. On epoch mismatch, use empty sets
  instead of the loaded cache. Leave the `:135-141` suppression logic itself unchanged.
- Old files without the field: a session that has since compacted re-injects exactly once on
  upgrade, which is the desired behavior.

Confirm nothing else parses `InjectedRulesData` strictly: `storage.ts` and `cache.test.ts:18`
are the only readers found.

## Test requirements this decision imposes

1. Hydration stops at the LAST compaction part when several are present.
2. Banner before the boundary is re-injected; banner after the boundary stays suppressed.
3. No compaction part anywhere: behavior byte-identical to today (regression pin).
4. `HYDRATION_MAX_MESSAGES` / `HYDRATION_MAX_CHARS` still apply WITHIN the bounded window.
5. **Restart path**: persisted cache with a stale epoch, compaction present in the transcript,
   `session.compacted` never dispatched, rule still re-injects exactly once. This is the case
   that proves the read-side half; without it, item (e) is untested.

Timing caveat for test 2: `HYDRATION_MAX_MESSAGES = 200` combined with the memoization at
`transcript-hydration.ts:72` means the window is "newest 200 messages at the moment of first
hydration after `clearSession`". The regression test must hydrate immediately post-compaction.
Hydrating 200+ messages later hides the bug.

## Known residual, documented not coded

The compaction summary message sits just after the boundary and is inside the scanned window.
If a summary reproduces a `[Rule: X]` banner verbatim, hydration will suppress X. This is
defensible (the model does see that text) but it is a new suppression source that today's
unbounded scan masks. Note it in the module doc comment; do not add code for it.

Out of scope, do not make worse: `clearSessionState` (`hook.ts:61-66`) calls
`clearParsedRuleCache()`, which is process-global, so any session's compaction flushes every
session's parsed rules. Pre-existing.
