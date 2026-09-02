# Interrupted-parent abort, re-probed AFTER the 2062-commit upstream merge

## What was tested
The real probe against a dist bundle rebuilt from the merged tree, to confirm
the merge did not disturb the interrupt path.

## What was observed
```
terminalized=1
no_wake_after_interrupt=PASS (wakes=0 sessions_created=0)
VERDICT=PASS
```
Host session count 3636 before and after, so the sandbox stayed isolated.

## A flake worth recording, because it nearly became a false regression
The FIRST post-merge run came back PROBE INVALID with
`parent_session_error_events=0`, and the abort appeared only inside a
`message.updated` payload rather than as a `session.error` event. Read once,
that looks exactly like an upstream change of carrier that would leave our
`session.error` hook dead in production.

Two further runs both produced `parent_session_error_events=1` and PASS. The
first run was a race between the abort and the SSE subscription, not a change in
event shape. The cross-check that argued against the regression reading before
the re-runs: `todo-continuation-enforcer` (`handler.ts:76-95`) also keys on
`session.error` alone, so a real carrier change would have broken upstream's own
hook too, which is a much louder failure than one probe.

Rule this reinforces: a single probe run is not evidence, and a probe that fails
LOUDLY (PROBE INVALID) rather than reporting a colour is what made the flake
visible instead of silently green.

## What was omitted
The 45-minute stale-reaper path is still not waited out; the assertion remains
about immediate terminalization.
