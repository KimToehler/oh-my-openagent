# QA evidence: dismissing a parked background task

Covers the review blocker found against `c9dca1003`: that commit's cleanup could not
reach the scenario its findings entry reports. Fixed in `8479eaa22`.

## What was tested

`blocked-escalation-probe.sh --dismiss`, a new mode added to the existing probe. It
drives a real `opencode serve` against an isolated XDG sandbox and a local mock model,
and replays the reported incident end to end:

1. the parent delegates a background child,
2. the child calls `report_blocked`, which parks it,
3. the parent answers the blocked wake by calling `background_cancel` on it,
4. the run then continues past both the reminder deadline (60s) and the expiry
   deadline (120s) to prove neither fires.

Step 3 is what the default mode never does. The default mode ignores the child on
purpose, so it can only ever prove the timers DO fire. That is why the original run
passed against a live defect.

The task id in step 3 is minted at runtime, so the mock lifts it out of the blocked
notification with `capture` on `\*\*ID:\*\* \`(bg_[A-Za-z0-9]+)\`` rather than a
hardcoded fixture.

## What was observed

`dismiss-probe-PASS.txt`, against the fix:

```
MODE=dismiss
BLOCKED_AT_S=10
DISMISSED_AT_S=10
REMINDER_AT_S=none
EXPIRY_AT_S=none
REMINDER_COUNT=0
ESCALATION PROBE PASS
```

The child parked, the parent dismissed it 0s later, and nothing woke the parent again
across the following ~165s.

Isolation held: `PARENT_IN_REAL_DB=0`, `CHILD_IN_REAL_DB=0`. The `REAL_DB_BEFORE=3526`
/ `REAL_DB_AFTER=3527` delta is the operator's own concurrent opencode use, which is
why identity, not count, is the authoritative check. opencode 1.18.20.

## Negative control

A probe never seen red is not evidence. Both halves of the fix were reverted, the
plugin rebuilt, and the same probe re-run. `negative-control-FAIL.txt`:

```
observed: blocked wake at +9s
observed: reminder at +62s
observed: expiry at +123s
FAIL: parent never dismissed the child
FAIL: a dismissed task still reminded the parent (1 times)
FAIL: reminder wake at +62s after the task was dismissed
FAIL: dismissed task still ran to expiry at +123s
ESCALATION PROBE FAIL (4)
```

`DISMISSED_AT_S=none` is the defect itself: `background_cancel` refused the parked task
outright, so the parent had no way to retire it, and the escalation ran to completion.
That is the incident the findings entry describes, reproduced on a real harness.

## Why this is enough

The probe distinguishes fixed from unfixed on the exact reported path, and the two
runs differ only in the two reverted hunks. Both timers are covered: the reminder
(`REMINDER_COUNT=0` versus `1`) and the hard expiry (`none` versus `+123s`).

## Residual risk

- The park-then-dismiss path is proven; the recurring-park re-entry path
  (`report_blocked` calling `cancelTask` on an already-parked task) is covered only by
  the unit test `#given a task parked by report_blocked #when the park itself re-enters
  cancelTask #then escalation stays armed`. The probe cannot induce a recurring park
  against a healthy server.
- The probe overrides both timer knobs to 60s/120s, so it proves the wiring, not the
  shipped defaults. Defaults stay pinned in `blocked-escalation.test.ts`.

## Probe defect found and fixed during this run

The first `--dismiss` run reported `expiry at +0s` and failed. The cause was in the
probe, not the product: the expiry marker was matched against the shared plugin log by
bare text, and `bun test` writes the identical line for its own fixture tasks
(`taskId":"task-skipped"`). The line-count offset does not protect against this because
the log rotates at 50MB mid-run. The matcher is now scoped to the run's own parent
session id.

## What was omitted

Raw SSE streams and sandbox config are not copied here: they carry the generated
server password and full environment. The captured stdout above contains the assertions
and the session identities, which is what the claims rest on.
