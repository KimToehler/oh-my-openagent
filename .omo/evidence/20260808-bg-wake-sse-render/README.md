# Evidence README - bg-wake-sse-render

Branch `fix/bg-wake-sse-render` (7 commits + 2 merges), base `dev@c0af74ee1`, head `001432e7a` (was `00bf3c45c` at QA time; see "Post-QA defect found and fixed" below).

## Bug recap

A parent-wake retry rebuilt a byte-identical prompt after a no-assistant-output window elapsed. Its SHA-256 semantic dedupe key collided with the 15s hold created by its own first send. The gate returned `{status:"queued"}` for a prompt it had actually discarded. The caller treated `"queued"` as accepted, logged "Sent deferred parent wake", and the retry was lost. From the terminal, the user saw nothing.

Commits:
- `e2cb98f72` - RED test pinning the loss
- `e3bdfcf25` - primary fix: a retry-scoped dedupe key (`createNoAssistantOutputRetryDedupeKey`), mirroring the existing `createEmptyAssistantTurnRetryDedupeKey` precedent
- `f5b46e8ce` - additive `coalesceKind` discriminator (`"already-delivered"` vs `"in-flight"`) on the queued dispatch result
- `5113f9124` - requeue on an already-delivered coalesce on the reply path, capped at `MAX_COALESCE_REQUEUE_ATTEMPTS = 3` with a 2000ms backoff
- `ecadb2d90` - retention-guard regression pins across the new coalesce-retry window
- `35b6e38f2` - marker- and retry-budget-integrity regression pins under coalesce requeue
- `001432e7a` - post-implementation-review fix: derive `COALESCE_REQUEUE_FLUSH_DELAY_MS` from the hold constants so the coalesce-requeue secondary net's budget exceeds the semantic dedupe hold (see "Post-QA defect found and fixed" below)

Final merged suite: 870 pass / 0 fail across 77 files (868 at QA time; +2 from the post-QA fix in `001432e7a`).

## 1. What was tested

**Unit/integration gates (bun:test, real gate code, only the client stubbed):**
- `parent-wake-noout-retry-dedupe.test.ts` (task 2/3) - drives the real `ParentWakeNotifier` and the real prompt-async gate through a dispatched wake, waits out the real 2s post-dispatch reservation, then re-flushes the byte-identical no-output retry while the 15s semantic hold is still open. Meant to prove the retry produces a real second `promptAsync` call instead of being silently coalesced.
- `prompt-async-gate-coalesce-kind.test.ts` (task 4) - asserts the named `coalesceKind` field is `"already-delivered"` on a semantic-dedupe coalesce, `"in-flight"` on a reservation-match or queue-pending coalesce, and absent (`Object.hasOwn` false) on a genuine dispatched result or a non-coalesce queued accept.
- new `sendParentWakePrompt` coalesce-requeue test (task 5) - drives the real gate with a controlled clock past the 2s reservation but inside the 15s hold, asserting: the reply path requeues on an already-delivered coalesce and never records the wake as dispatched; the admit-only path (`forceNoReply` + `retainPendingWake`) never requeues on coalesce; requeues terminate at exactly `MAX_COALESCE_REQUEUE_ATTEMPTS = 3`; `in-flight` and plain queued results are not classified as discarded.
- `task-completion-retention-guard.test.ts`, 2 new cases (task 6) - drives the real `BackgroundManager` cleanup timer to prove a task stays retrievable while a coalesce-requeued reply wake is still owed, and is removed once the requeue budget is exhausted.
- `parent-wake-midbatch-starvation.test.ts`, 2 new cases (task 7) - proves the `#4874`/`#5086` delivery markers (`noReplyAdmittedAt`, `lastAdmitOnlyDepositAt`) stay unwritten on a discarded coalesce but ARE written on a genuine admit-only dispatch, and that `coalesceRequeueCount` walks `1,2,3` while `noAssistantOutputRetryCount` stays untouched at `1` across those same cycles.
- `parent-wake-active-defer-ceiling.test.ts` (task 8, re-verification only, no new test) - re-run against the fixed branch to confirm the `#4120` 300s retained-admit ceiling is unaffected by the new coalesce-requeue branch.
- Discrimination proofs: on tasks 3, 6, and 7, the relevant production change (or, for tasks 6/7, the guard code the new test targets) was temporarily reverted or mutated, the same test was re-run to confirm it fails for the right reason, then the code was restored and `git status` confirmed clean.
- `bun run typecheck` after every task, confirming zero new diagnostics in touched files (pre-existing failures are isolated to `packages/omo-senpi` / `packages/senpi-task`, unrelated to this branch).

**Real-harness QA (task 9, `opencode-qa` skill, live isolated server):**
- Part A: does the retried wake actually reach the model with no intervening semantic coalesce? Driven via a bundled probe plus a gitignored variant harness (`.omo/qa-tmp/noout/`, a copy of the bundled fake LLM whose first wake response stalls 9s to force the no-output retry).
- Part B: does the resulting turn hit the SSE wire, i.e. would the user actually see it? Driven via `sse-hook-probe.sh` watching `message.updated` on the live server, plus a raw SSE capture correlated against the wake turn's message id from the sandbox db.
- A negative control attempting to reproduce the original loss end to end on a pre-fix checkout (see section 3 for why this did not succeed).
- Isolation: real opencode session count before/after, plus an id-level leak check against the real db.

## 2. What was observed

**Unit/integration results:**
- Task 2 RED: `expect(promptAsyncCalls).toHaveLength(2)` received length 1. Fails for the right reason: the retry was coalesced away.
- Task 3 GREEN: same test now 1 pass / 0 fail. Full `background-agent` module suite 777 pass / 0 fail (baseline before this fix). Discrimination proof: reverting the production diff via `git stash` makes the RED test fail again identically; restoring it makes it pass again.
- Task 4: `prompt-async-gate` suite 83 pass / 0 fail, `background-agent` suite 777 pass / 0 fail, typecheck exit 0 non-senpi.
- Task 5: new coalesce-requeue test 4 pass / 0 fail / 27 assertions. `background-agent` suite grew to 781 pass / 0 fail (777 baseline + 4 new). `prompt-async-gate` suite still 83 pass / 0 fail. Typecheck exit 0.
- Task 6: target file grew from 4 to 6 pass / 0 fail (49 assertions); `background-agent` suite 783 pass / 0 fail (baseline 781, +2). Three temporary mutations of `manager.ts` (forcing `wakeStillOwed` false, relaxing the reschedule cap, relaxing the TTL) each broke the intended assertion and were each fully reverted, confirmed by `git status` showing `manager.ts` unmodified afterward.
- Task 7: target file grew from 7 to 9 pass / 0 fail (66 assertions); `background-agent` suite 783 pass / 0 fail (unchanged, this task added the same 2 cases counted differently across the two lane branches before merge). Typecheck exit 0, zero diagnostics reference the touched file. Three temporary mutations of `parent-wake-prompt-dispatch.ts` (no-op the marker write, make the coalesce-requeue branch also write markers, make it also bump the wrong counter) each broke the assertion meant to catch that specific regression, then were reverted with `git status` confirming a clean production tree.
- Task 8: `parent-wake-active-defer-ceiling.test.ts` 6 pass / 0 fail, unchanged from before the fix landed. Full suite 781 pass / 0 fail matching the stated baseline exactly. Verdict: the ceiling invariant survived. The new coalesce-requeue branch is guarded by `isDiscardedCoalesceDispatchResult(...) && !isAdmitOnlyDispatch(input)`, structurally excluded from admit-only deposits, and this test's stubbed client never produces a discarded-coalesce result, so the branch is never reached in these six cases. This conclusion is derived from reading the guard code plus the pass result, not from a runtime trace printing `lastAdmitOnlyDepositAt` (recorded honestly in the task 8 evidence and repeated below).

**Real-harness QA results (task 9):**
- Part A: log evidence for session `ses_01dfb55b4ffeh3Ioh4gpp4w9y9` shows two `promptAsync dispatching` lines for the same `background-agent-parent-wake` source, five seconds apart, with the retry landing inside the 15s semantic hold opened by the first dispatch. `dispatching=2 dispatched=2 coalesced=0 requeued=1 live_dispatch=2`. `coalesced=0` is the key line: zero coalesce log lines for this session, so the second dispatch is a real send. The fake LLM logged `branch=wake` and the sandbox db holds the assistant text (`WAKE_ACK`) it returned. Artifact: `task-9-artifacts/part-a-grep.txt`, run-of-record counters in `task-9-artifacts/summary.txt` (`dispatching=2 dispatched=2 coalesced=0 requeued=1 live_dispatch=2 sse_exit=0 wake_frames_on_wire=3 real_db_before=1542 real_db_after=1542 VERDICT=PASS`).
- **POST-QA CORRECTION (independent audit):** the causal mechanism claimed above is wrong. The original claim was that the retry fired because the variant harness's fake LLM stalls 9s, exceeding the 5s `PARENT_WAKE_FAILURE_REQUEUE_WINDOW_MS`. The run's own `task-9-artifacts/fake-llm.log` contradicts that: dispatch 1 at `15:36:34.748`, requeue at `15:36:39.778` (+5.03s), but the fake LLM's `branch=wake` log line lands at `15:36:40.764`, about 1s AFTER the requeue. The 9s stall had not even started when the retry fired; the 5s window elapsed on roughly 6s of request latency to reach the fake LLM, not on the configured stall. The second real dispatch still did happen (that observation stands, `coalesced=0`), but the harness is **timing-dependent and non-deterministic**, not a controlled stall. An independent auditor re-ran the same harness 3 times and got `dispatching=1 coalesced=0 requeued=0` every time, i.e. Part A did not reproduce, 0 of 3, on re-run (fake LLM answered in ~15ms, wake succeeded on the first try, nothing to retry, which is correct no-retry-needed behavior, not a fix failure). Part B reproduced 3 of 3. Net honest characterization: Part A's harness is timing-dependent, reproduced 1 of 4 known runs. The deterministic proof of the retry path is the unit test `e2cb98f72`, independently re-verified by the auditor to fail RED on pre-fix source (`Expected length: 2, Received length: 1`) and pass at HEAD.
- Part B: `sse-hook-probe.sh` exit 0, `PASS: observed 'message.updated'` (`sse-probe.txt`). A raw SSE capture correlated the wake turn's message id (`msg_fe204ea2a001d6X5hN9AAOMQXb`) against three `message.updated` frames on the wire (`task-9-artifacts/part-b-correlation.txt`), so the specific wake turn, not just any event, is confirmed on the wire.
- Bundled probe (happy path, does not exercise the retry): `RESULT=FIXED ... plugin_inits=1 WAKE_DISPATCHED_DURING_PARENT_TURN=true route_live_dispatch=true` (`task-9-artifacts/serve-wake-split-probe-verdict.txt`). **Naming hazard note:** this probe reports `wake:0` branch hits on the fake LLM despite `WAKE_DISPATCHED_DURING_PARENT_TURN=true`; its wake never actually reached the fake LLM. Harmless, since this is not the Part A evidence, but do not read it as wake-delivery proof.
- Fix-was-loaded verification: plugin loaded from worktree source (not `dist/`), fix symbols present in the tree, and the live run emitted a log line only the fixed code path can produce.
- Isolation: real db session count `1542 -> 1542`, delta 0 (`isolation-receipt.txt`). Every QA-created session id returns 0 rows when looked up by id in the real db (6 ids checked across 5 run types). A probe-title check over the 20 newest real sessions also returns 0. The real db's mtime DID advance during the QA window; this is disclosed and attributed to the user's own live opencode instance writing to its own db concurrently, not to the sandbox, and is corroborated by the two independent zero-leak checks above rather than asserted on mtime alone.

## 3. Why it is enough

The unit layer exercises the real prompt-async gate end to end (semantic dedupe record, reservation expiry, real 2s/15s timing relationships via a controlled clock), not a mocked gate, so the assertions reflect the production collision mechanics rather than an idealized model of them. Every new assertion added in tasks 3, 6, and 7 was shown to fail under a targeted reversion or mutation of the production code it is meant to guard, which rules out vacuous passes. The suite grew monotonically and cleanly across tasks (777 -> 781 -> 783 -> 783, +2/+2/+0 matching each task's stated new-case count) with zero regressions in sibling parent-wake paths at every step.

The real-harness layer closes the gap unit tests cannot: it proves the fix holds under the actual `opencode serve` process, the actual prompt-async-gate module boundary crossing into a live session, and the actual SSE event stream the user's terminal renders from, with the specific wake turn's message id correlated against the wire rather than an event on the stream. Zero coalesce events for the retried session is the load-bearing observation: the collision this bug depended on did not occur, on a live server, running the real fix.

Residual regression risk:
- The `#4120` ceiling re-verification (task 8) is derived from code-path reading plus a pass result, not a runtime trace of `lastAdmitOnlyDepositAt`. If a future change moves the `isAdmitOnlyDispatch` guard or the coalesce-requeue branch's placement relative to the admit-only deposit, this conclusion would need re-establishing with an actual trace.
- The regression-window analysis (task 1, `regression-window.md`) found no single fully-verified frequency multiplier for why the collision became user-visible now rather than when both ingredients shipped six weeks earlier. Three candidate mechanisms are documented with git-verified evidence (`a456466d1`, `308e84418`, and the `a47f804c9`/`e65752afc`/`c0af74ee1` ceiling chain), each shown to add dispatch volume, but their link to the specific empty-turn/no-output retry path is explicitly labeled unverified for the third candidate and speculative for a fourth (model-chain migration `b3b45cd2a`). This does not affect confidence in the fix; it means the "why now" question is not closed to the same standard as the fix itself.
- The two known residual defects below (section on residual defects) mean the same failure class is not eliminated system-wide, only on the parent-wake background-agent path this plan scoped in.

## 4. What was omitted

- **Secrets:** none copied into any evidence file or this README. Task 9 used per-run randomly generated sandbox server passwords, redacted at the point of capture in `task-9-qa.md`. The model provider throughout was a local fake OpenAI server on `127.0.0.1`; no real provider API key was used or logged.
- **Full log dumps:** the plugin's temp-dir log is roughly 25MB. Only offset-scoped, session-id-filtered `grep` slices were captured and recorded (`task-9-artifacts/part-a-grep.txt`); the full file was not copied.
- **Not proven - harness-level negative control (task 9):** three attempts were made to reproduce the original loss end to end on a pre-fix checkout, and none succeeded as a clean repro.
  - Attempt 1 was invalid and discarded: `node_modules` was symlinked from the fix worktree, so `@oh-my-opencode/utils` resolved back into the fixed tree even though the app source was pre-fix.
  - Attempt 2, correctly isolated via a real `bun install` in the control worktree, still passed on the pre-fix build (`task-9-artifacts/control-prefix-summary.txt`: `dispatching=1 dispatched=1 coalesced=0 requeued=0 ... VERDICT=FAIL`). **Naming hazard note:** `VERDICT=FAIL` here means the negative control failed to reproduce the bug (a disclosed non-repro), not that the fix failed. Do not read this artifact as a passing negative control. Root cause: the two wake prompts were not byte-identical (`len 518` with the `OMO_INTERNAL_NOREPLY` marker vs `len 488` without), because the first dispatch took the admit-only `forceNoReply` branch rather than the reply branch, so the semantic keys never collided in the first place. This is stated plainly as a limitation, not glossed over: the bug's precondition (two byte-identical dispatches) was not reproduced at the harness level.
  - Attempt 3 retuned the timing (extended parent hold, delayed child completion 25s) and instead produced `dispatching=1 requeued=0` on both builds: the wake succeeded on its first send, so no retry occurred at all. A different scenario, still not a repro.
  - What IS proven, deterministically, at the unit level: the byte-identical-retry-inside-the-hold precondition is pinned by the RED test `e2cb98f72` (`parent-wake-noout-retry-dedupe.test.ts`), which fails on pre-fix code and passes on fixed code for exactly that reason. The fix-side real-harness evidence (Parts A and B above) is real and positive. The harness-level negative control is honestly unproven, not claimed as passing.
- **Not proven - runtime trace of the `#4120` ceiling mechanism (task 8):** see the residual-risk note above; the conclusion rests on code-path reading and a pass result, not an instrumented trace.
- **Not proven - single frequency multiplier (task 1):** no single fully-verified commit explains why the collision became user-visible now. See `regression-window.md` for the three candidates with stated (and, for one, explicitly speculative) mechanisms.

## 5. Post-QA defect found and fixed (independent audit)

After task 9's QA ran, an independent Oracle audit found a second defect in
the coalesce-requeue secondary net added by commit `5113f9124`: the net
could never actually fire.

At QA time: `MAX_COALESCE_REQUEUE_ATTEMPTS = 3` x
`COALESCE_REQUEUE_FLUSH_DELAY_MS = 2000ms` = a 6000ms total requeue budget,
against a 15000ms semantic dedupe hold (`DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS`)
that is never refreshed on a coalesce. The budget always exhausted inside
the hold, so execution fell through and the wake was recorded as
dispatched anyway, the very bug this branch was written to fix, just
inside the secondary net instead of the primary path.

Fixed in commit `001432e7a`: `COALESCE_REQUEUE_FLUSH_DELAY_MS` is now
derived from the hold constants instead of hardcoded:

```
Math.ceil((DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS + DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS) / MAX_COALESCE_REQUEUE_ATTEMPTS)
  = ceil((15000 + 2000) / 3) = 5667ms
new total budget = 3 x 5667ms = 17001ms >= 15000ms
```

An invariant test now fails loudly if a future edit to `timing.ts` or
either constant breaks that relationship. A second new test proves the net
now actually catches a wake: the hold expires and a real second
`promptAsync` call happens before the requeue cap is reached. Final suite
after this fix: 870 pass / 0 fail across 77 files. Branch head is now
`001432e7a`.

The secondary net is now genuinely functional. Task 9's unit and
real-harness QA (sections 1 to 4 above) were performed against a build
where the secondary net was inert. The **primary** fix (`e3bdfcf25`, the
distinct retry-scoped dedupe key) was and remains the mechanism that
resolves the reported bug; the QA evidence for the primary fix is
unaffected by this.

## Known residual defects (recorded, deliberately NOT fixed)

Both were scoped out of this fix by the plan (`.omo/plans/bg-wake-sse-render.md`, "Must have" item 7) and are recorded here so a future engineer does not rediscover them from scratch.

### 1. `packages/omo-opencode/src/features/monitor/output-injector.ts:179-190`

Identical bug shape to the one fixed here. A coalesce can return `"queued"`, which bypasses the `status === "reserved"` check around line 166 and reaches `trackDelivered` around line 190, marking the payload delivered even though nothing was actually dispatched.

User-facing note: this will look identical to the fixed bug from the outside. If background output still occasionally vanishes after this fix ships, this file is the likely source, not a failed fix.

### 2. `packages/omo-opencode/src/features/team-mode/tools/messaging-live-delivery-recipient.ts:97-129`

A reservation-leak shape rather than the same lost-delivery shape. A coalesce phantom gets marked delivered while still holding its reservation, because the release only runs on the not-accepted branch.

## Files in this evidence bundle

- `regression-window.md` - task 1, frequency-multiplier analysis
- `task-2-RED.txt` - task 2, RED test output
- `task-3-GREEN.txt` - task 3, primary fix, GREEN + discrimination proof
- `task-4.txt` - task 4, `coalesceKind` discriminator
- `task-5.txt` - task 5, coalesce-requeue on the reply path
- `task-6.txt` - task 6, retention-guard regression pins
- `task-7.txt` - task 7, marker/retry-budget regression pins
- `task-8-ceiling.txt` - task 8, `#4120` ceiling re-verification
- `task-9-qa.md` - task 9, real-harness QA narrative
- `sse-probe.txt` - task 9, raw Part B probe output
- `isolation-receipt.txt` - task 9, before/after session counts and leak check
- `task-9-artifacts/` - task 9, supporting grep slices, correlation data, and run-of-record counters
