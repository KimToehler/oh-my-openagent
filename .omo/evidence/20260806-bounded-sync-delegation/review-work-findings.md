# review-work: 5-lane review findings and adjudication

Run after all 12 todos and all 4 plan gates completed. Four lanes returned FAIL.
Every finding below was independently re-verified against source by the orchestrator
before being accepted or rejected. This is NOT production ready as it stands.

## Verdicts

| Lane | Focus | Verdict | Net new defects |
|---|---|---|---|
| RW1 | Goal & constraint verification | FAIL | 0 new (1 rejected, see below) |
| RW2 | Hands-on QA execution | (see separate note) | - |
| RW3 | Code quality | FAIL | 1 BLOCKING (continuation unbounded) |
| RW4 | Security | FAIL, severity MEDIUM | 1 MEDIUM (concurrency bypass) |
| RW5 | Context mining | FAIL | 1 BLOCKING (per-attempt bound) + 6 gaps |

---

## ACCEPTED BLOCKER 1 (RW5 finding 1, the most serious): the wall-clock bound resets on every fallback retry

**Verified.** `sync-session-poller.ts:71` sets `const pollStart = Date.now()` INSIDE
`pollSyncSession`. `sync-task-runner.ts:107` wraps the call in `while (true)` and
re-invokes it on every model-fallback retry (`case "error"` creates a new session and
`continue`s).

Consequence: the bound is **per poll attempt, not per delegation**. With N fallback
retries the parent can still block N x 10 minutes. Model fallback is a routine path
in this repo, so this is reachable in normal operation, not a corner case.

**This defeats the stated goal of the whole change.** The user asked to stop the turn
being held; under fallback it is still held, just in 10-minute segments.

Root cause is a planning error: the plan instructed "reuse the `pollStart` timestamp
the poller already captures at line 63" without noticing that timestamp is created
inside the function the runner retries.

Fix: hoist the deadline above the retry loop. Compute an absolute deadline once in
`sync-task-runner.ts` before `while (true)` and thread it into `pollSyncSession`, so
every attempt shares one budget.

---

## ACCEPTED BLOCKER 2 (RW3 + RW5 finding 2): `sync-continuation.ts` is entirely unbounded

**Verified.** `sync-continuation.ts:102` destructures only `syncPollTimeoutMs`. The
`pollSyncSession` call at `:190-196` never passes `syncWallClockTimeoutMs`, so the
poller falls back to `getDefaultSyncWallClockTimeoutMs()`, which is `Infinity`
(`timing.ts:8`).

Consequence: `task(task_id="ses_...")` - resuming a subagent, a first-class
user-facing path - still blocks the parent indefinitely. The original bug survives
untouched on a sibling code path. The `wall_clock_yield` branch that exists there is
dead code in production.

Fix: thread the value through the continuation path too, and decide its yield
semantics (see Blocker 3, which is entangled with it).

---

## ACCEPTED BLOCKER 3 (RW5 finding 3, latent): continuation yield would leave a live child unmarked

**Verified by reading `sync-continuation.ts:262-272`.** The `finally` there only calls
`handedBackSyncSessions.add()` + `session.abort()` when `handedBackToParent === true`.
A `wall_clock_yield` return sets neither.

This is the exact reproduction of issue #5112 (two concurrent agents on the same
work). It is currently masked ONLY by Blocker 2 making the branch unreachable - the
two defects hide each other. Fixing Blocker 2 without fixing this would activate the
race.

RW5 also surfaced the decisive historical detail from commit 850415a79 (PR #5113):
`session.abort()` alone provably did NOT fix #5112, because aborting an already-idle
session re-publishes `session.idle` with no error event. `handedBackSyncSessions` is
the load-bearing guard, not the abort. Any sync exit that is not a successful
adoption MUST mark it.

---

## ACCEPTED, MEDIUM (RW4): adopted tasks bypass background concurrency accounting

**Verified as a real consequence of a deliberate decision.** Adoption intentionally
leaves `concurrencyKey` undefined (`manager.ts:664-696`), because the sync path never
acquired a background slot and releasing one it never took would drift the per-key
limit upward. That reasoning is sound and was validated during planning.

The unintended consequence RW4 identified: adopted tasks therefore are not counted
against the default per-key limit of 5. Enough foreground sync delegations that each
reach the bound can accumulate unbounded `status: "running"` background work. The
depth guard (`DEFAULT_MAX_SUBAGENT_DEPTH = 3`) limits nesting depth, not sibling
count, so it does not cap this.

Not a security vulnerability in the classic sense (no external attacker), but a real
resource-exhaustion path for a runaway agent. Accepted as MEDIUM. Fix options: either
acquire a genuine slot at adoption, or add a separate adopted-task cap enforced
before yielding, released in the completion/cancel/stale paths.

---

## REJECTED (RW1's sole blocking issue): "adoption failure can still abort the child"

RW1 marked FAIL because if `adoptRunningSession()` throws, `yieldedToBackground`
stays false and the `finally` aborts the child.

**This is deliberate, specified, and correct.** Plan todo 10(c) mandates exactly this:
the skip flag is set ONLY after adoption returns successfully, so that a failed
adoption falls through to the normal cleanup path. The rationale, recorded during
planning: an unowned live child is worse than a killed one. Without the abort, a
failed adoption would leave an orphan running with no owner, no tracking, and - per
the #5112 finding above - no `handedBackSyncSessions` marking, which is the two-agent
race.

RW1 read the "do not abort on the yield path" constraint as absolute. It is scoped to
the SUCCESSFUL yield path. Behavior is correct as written. **Not a defect.**

---

## ACCEPTED, non-blocking (RW5 findings 4-9)

- **Open PR #6236** modifies `sync-session-poller.ts` and `timing.ts` for the same
  symptom class (busy status resetting the inactivity clock; author observed real
  42-min and 65-min hangs). Our discriminated-union change will conflict. Must
  coordinate or explicitly supersede.
- **`call_omo_agent`** is a second sync delegation executor with a hardcoded 5-minute
  cap that ignores config, and hard-fails instead of adopting, discarding the child's
  work. Its factory sits nine lines above where we threaded the new value. Open PR
  #2404 has requested config plumbing here since March. Decide: extend or document why
  not.
- **Adopted-task retry safety unverified.** Adopted tasks carry
  `prompt: "[already prompted]"`; BackgroundManager has retry machinery that
  re-prompts on retryable failure. If an adopted task is retried it would replay that
  literal placeholder. Needs verification.
- **Docs and CHANGELOG debt.** `docs/reference/configuration.md:474` documents
  `staleTimeoutMs` but neither `syncPollTimeoutMs` nor the new
  `syncWallClockTimeoutMs`. CHANGELOG has an active `[Unreleased]` section with no
  entry for this change. `packages/omo-opencode/src/tools/delegate-task/AGENTS.md:11-14`
  still describes sync as "poll until idle -> return result", now inaccurate.
- **Evidence hygiene (RW4 LOW).** Committed evidence contains concrete local session
  ids. Local-only, no tokens or keys found, but worth redacting.

## Confirmed genuinely out of scope (RW5 finding 10)

Codex Light (`packages/omo-codex/`) has no session-delegation runtime, `delegate-core`
has no poll loop, `team-core`'s only loop is bounded lock acquisition, and
`senpi-task` uses heartbeat/idle waiters rather than a parent-blocking poll. No
cross-harness fix required. This rules out the largest suspected scope gap.

## Also validated by RW5 (design reasons respected)

Issue #5112 -> commits 850415a79, 46ee38c6f confirm the abort block at
`sync-task.ts:160-167` traces to a real reported incident, and that this change
correctly preserves the `handedBackSyncSessions` guard on the normal exit path.

---

## Orchestrator conclusion

**NOT production ready.** Two blocking defects (per-attempt bound, unbounded
continuation path) plus one latent race that activates on fixing the second. Both
blockers trace to planning errors, not worker errors: the plan pointed at a timestamp
inside a retried function, and scoped the work to `sync-task.ts` without tracing the
sibling continuation path that shares the same poller.
