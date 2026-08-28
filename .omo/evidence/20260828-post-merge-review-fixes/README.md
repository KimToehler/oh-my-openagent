# Post-merge review fixes: rules-injector, blocked expiry coverage, notification sanitization

Base `d59ca317a` -> merged `dev` `3ca83323f`. Three `--no-ff` merges:

| Merge | Commit | Scope |
|---|---|---|
| `b212e8ff2` | `98d451ebe` | `fix(rules-injector): isolate resurfacing state` |
| `100a71127` | `7889bd3c4` | `test(background-agent): cover running blocked expiry` |
| `3ca83323f` | `7cc4d385b` | `fix(background-agent): sanitize final task summaries` |

Origin: a five-lane review of the four already-merged PRs of `.omo/plans/2026-08-27-harness-findings-top3.md`. Lanes returned `confirmed`, `needs-fix`, `risk-found`, `reproduced`, `gaps-found`. Every defect below was adjudicated against source before being accepted, because the lanes contradicted each other on one item (see WHAT WAS OBSERVED).

# WHAT WAS TESTED

Defects addressed, and the surface driven for each:

1. **Order-dependent test failure at clean `d59ca317a`** (defect in our own test, not the product). Driven by running two directories in one process: `bun test packages/omo-opencode/src/features/background-agent/abort-with-timeout.test.ts packages/omo-opencode/src/hooks/rules-injector/resurfacing.test.ts`.
2. **`expireBlockedTask` `wasRunning === true` branch had zero coverage.** Driven by a new test registering a blocked *running* task plus a running sibling under one parent, asserting the expiry notification accounts for the survivor.
3. **False comment at `manager.ts:2689-2690`** asserting a statement-order guarantee the code does not provide.
4. **Three unsanitized child-authored interpolations** in `background-task-notification-template.ts` (`attempt.error:48`, `task.description:60`, `task.error:65`), reachable on the `allComplete` path which bypasses the sanitized `errorInfo`.
5. **Note: `buildRuleReminder` computed before its guard** (`resurfacing.ts`), wasted on the common refusal path.
6. **Note: `ContextCollector` never cleared by rules-injector** on `session.deleted`.
7. **Regression introduced while fixing item 4**, caught during verification (see below).

Verification commands run on merged `dev` @ `3ca83323f`:

- `bun test packages/omo-opencode/src/features/background-agent/abort-with-timeout.test.ts packages/omo-opencode/src/hooks/rules-injector/resurfacing.test.ts` -> `artifacts/after-orderdep-green.txt`
- `bun test packages/omo-opencode/src/hooks/rules-injector/ packages/omo-opencode/src/tools/background-task/` -> `artifacts/after-injector-and-consumer.txt`
- `bun test packages/omo-opencode/src/features/background-agent/` -> `artifacts/after-background-agent.txt`
- `bun run typecheck` -> `artifacts/typecheck.txt`
- `artifacts/pairing-envelope-repro.ts`, output `artifacts/pairing-envelope-repro.txt`

Every fix was mutation-tested: production code was mutated to reintroduce the defect, the test was shown red, then the source was restored and the tree confirmed clean.

# WHAT WAS OBSERVED

**Before (the reproduction that opened this work), `artifacts/before-orderdep-failure.txt`:**

```
EXIT=1
Received: 40
(fail) rule resurfacing > #given no watermark and a genuine zero gap #when each suppressed rule is evaluated #then their log payloads are distinguishable
 9 pass
 1 fail
```

The same file alone passed (`111 pass`). Cause: `spyOn(shared, "log")` observed call history accumulated by earlier files that used `mock.module` + `mock.restore`, so `decisions[1].gap` read a leaked `40` instead of `0`. Fixed by filtering captured decisions to the test's own `sessionID`; the original ordered `gap: null` then `gap: 0` assertions were preserved, not weakened.

**After, `artifacts/after-orderdep-green.txt`:**

```
ORDERDEP_EXIT=0
 11 pass
 0 fail
```

**Suites on merged `dev`:**

```
rules-injector + background-task consumer   187 pass  0 fail
background-agent                            929 pass  0 fail   Ran 929 tests across 82 files. [31.21s]
bun run typecheck                           TYPECHECK_EXIT=0
```

`929` against the `922` baseline is 7 net new tests, each pinning previously uncovered behavior.

**Regression found during verification, and fixed.** The sanitization fix initially applied `sanitizeUntrustedText(task.description, 200)` at line 60. That sanitizer appends `\n[truncated N characters]` on overflow (`untrusted-text.ts:13-14`), and `task.description` renders *before* the `| session:` segment. The parent-transcript pairing regex at `packages/omo-opencode/src/tools/background-task/parent-transcript-pairing.ts:95` uses `[^\n]{0,512}`, which cannot cross a newline. Reproduction:

```
CONTAINS_NEWLINE: "xxxxx\n[truncated 50 characters]"
PAIRING_RESULT: FAILED_TO_PAIR
```

Any task with a >200-char description would silently stop resolving `bg_... -> ses_...`. The full 926-pass suite did not catch it because no fixture has a description that long. Fixed by collapsing newlines after sanitizing. The fix also closed a **pre-existing latent defect**: a raw multi-line description broke pairing by the same mechanism, independent of truncation, and was never covered.

Post-fix, on merged `dev` (`artifacts/pairing-envelope-repro.txt`):

```
long-250char     PAIR: ses_xyz | CLOSING_TAG_LEAK: false
multiline        PAIR: ses_xyz | CLOSING_TAG_LEAK: false
envelope-escape  PAIR: ses_xyz | CLOSING_TAG_LEAK: false
```

**Ordering: an adjudicated disagreement, recorded because it was nearly missed.** Three reviewers reached three conclusions about `expireBlockedTask`. One claimed a mutation proved the ordering pin bites; one reported the same mutation *survived* all 922 tests; one claimed the comment was simply false. Reading the source settled it: line 2691 is `void this.enqueueNotificationForParent(...)` (async, microtask-deferred) and line 2712 `cleanupPendingByParent` is synchronous, so cleanup always runs first regardless of statement position. The "pin bites" proof was passing for the wrong reason — its fixture used `status: "cancelled"`, so `wasRunning` was false and the cleanup never ran at all.

Resolution: **the behavior is correct, the comment was wrong.** Terminal expiry survives because the task is set `cancelled` and excluded from the recompute, not because of statement order. The comment was corrected; the code was not reordered. The implementing lane independently confirmed ordering is **not observable** and pinned the observable contract instead (expiry delivered, surviving sibling reported as `**1 task still in progress.**`) rather than fabricating an ordering assertion.

# WHY IT IS ENOUGH

- The order-dependent failure is proven fixed by running the exact command that produced it, in the same process, on the merged tree: `EXIT=1` before, `ORDERDEP_EXIT=0` after.
- Each fix carries a mutation proof: reintroducing the defect turns a specific named test red. Notably, the `buildRuleReminder` hoist is pinned by a throwing `get body()` that fires only if a suppressed rule builds a reminder, and the collector clear is pinned by asserting `collector.hasPending(SESSION_ID) === false` after `session.deleted`.
- The sanitization fix is verified against the **real consumer**, not an approximation: the new tests call `findSessionIdInParentTranscript` from `tools/background-task/`, and that suite (73 tests) was run for the first time in this work — it owns the code path the regression broke.
- The collector clear is deliberately scoped to `session.deleted` only. Clearing on `session.compacted` would destroy context that compaction must reinject; the compaction pin at `injector.test.ts:678` still passes.
- Type safety and repo invariants hold: `bun run typecheck` exit 0 across all 30 package projects, no `as any` / `@ts-ignore` / `@ts-expect-error`, no test skipped, weakened, or deleted.
- Working tree after cleanup: `packages/omo-opencode/src` dirt = 0; the 9 remaining dirty files are the known regenerated bundles under `packages/omo-codex/**` and `packages/omo-senpi/plugin/extensions/**`. All three worktrees removed, all three branches deleted.

# WHAT WAS OMITTED

- **No live opencode QA in this wave.** These are unit-level fixes to features whose live behavior was already confirmed on merged `dev` earlier the same day (`.omo/evidence/20260827-bg-completion-reason`, and the live blocked-expiry run capturing `EXPIRY_NOTIFICATION_BLOCKS=1` at 89.7s against a 90000ms knob). Residual risk: the sanitization change alters rendered notification text, and only deterministic tests plus the real pairing consumer confirm downstream scanners still parse it. A live replay would close that.
- **One reviewer note was rejected on analysis alone, with no bite proof.** The claim was that `resurfacing.ts` keys the collector id on `relativePath` while the store keys on `realPath`, so two rules with the same relative path coalesce and one reminder is dropped. It was judged unreachable because `injection-processor.ts` dedupes on `realPath` before the collector is reached. The implementing lane was explicitly invited to disprove this and did not challenge it. **This is the weakest-supported decision in this wave** and is recorded here so it is not mistaken for a verified result.
- **`attempt.error` and `task.error` were reasoned safe for pairing** (they render after `| session:` or on their own timeline lines) and confirmed by the implementing lane, but no dedicated pairing test covers them the way `task.description` now has one.
- **LSP diagnostics were unavailable** in every fresh worktree (`Could not find a valid TypeScript installation`). `bun run typecheck` was used as the substitute gate and passed. This is a known fresh-worktree limitation, already logged in `docs/troubleshooting/harness-findings.md`.
- No secrets, tokens, env dumps, or auth headers are included in any artifact; all captures are test and typecheck output from a local checkout.
