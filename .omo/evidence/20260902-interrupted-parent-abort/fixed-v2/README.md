# Interrupted-parent abort, re-probed after the review fixes

## What was tested
The real `interrupted-parent-abort-probe.sh` against a rebuilt `dist/index.js`
carrying the review fixes, driving a real isolated opencode server: launch a
child lane, interrupt the parent, then read the plugin log and the SSE stream.

## What was observed

| Signal after interrupt | Before fix (`../fixed/`) | After fix (this run) |
|---|---|---|
| terminalize lines for this parent | 2 | 1 |
| parent-wake dispatches | 3 | **0** |
| `session.created` on SSE | 6 | **0** |

`15-verdict.txt`: `no_wake_after_interrupt=PASS (wakes=0 sessions_created=0)`.

## Why it is enough
The original defect was not that lanes failed to terminalize - they did, and the
old probe passed on exactly that signal. The defect was that terminalizing them
woke the parent and restarted the turn the user had just aborted. This run holds
both halves at once: the lane still terminalizes, and nothing resumes afterwards.

The probe itself was strengthened in the same change, so the assertion that
caught this is now permanent rather than a one-off manual check.

## What was omitted
The 45-minute stale-reaper path is still not waited out; the assertion remains
about immediate terminalization. Host session count is recorded before and after
as isolation proof.
