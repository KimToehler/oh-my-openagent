# Completion summary park replay - QA evidence (2026-08-21)

Change: the background-task completion summary no longer replays every historical park as a
separate current failure.

Branch: `fix/summary-park-dedupe`, stacked on `fix/shutdown-abort-status` (both local, no PR).

## What was tested

`notifyParentSession` pushes a summary row unconditionally
(`manager.ts:2899-2910`) and `completedTaskSummaries` is only cleared once every sibling
finishes. Eight call sites funnel into it, so a task that parks and resumes contributes one
row per cycle. The renderer then counts failures straight off that array
(`background-task-notification-template.ts`, `status !== "completed"`), so each park became a
reported failure.

Driven at the renderer, which is the single choke point all eight call sites feed, with the
reported shape: 2 real tasks x 6 park/resume cycles = 12 rows.

## What was observed

- `dev`: `[ALL BACKGROUND TASKS FINISHED - 10 FAILED]`, 12 task lines, mid-flight `[RUNNING]`
  rows printed under `Failed:`. 10 invented failures out of 0 real ones.
- patched: `[BACKGROUND TASK COMPLETED]`, 2 task lines, no `[RUNNING]`.
- Unit: red first - "4 FAILED" for 2 tasks and "2 FAILED" for 1, then 27 pass / 0 fail.
- Same-scope suites: 1445 pass / 4 fail vs 1440 / 4 on clean `dev`; failing-set
  assertion-signature diff empty in both directions, so the 4 are pre-existing. +5 pass =
  3 tests from the stacked fix plus 2 here.
- typecheck exit 0 / 0 `error TS`; build exit 0; `dedupeByTaskId` present in `dist/index.js`.

## Why it is enough

The defect is a fabricated failure count, and the exact fabricated header was reproduced on
`dev` and is gone after the change, through the real renderer rather than a mock of it. A
second test pins the direction that matters most: a task whose LAST state is a genuine
failure is still counted once as failed, so dedupe cannot silently swallow real failures.

Dedupe keeps the last entry per id because entries are appended chronologically, so the last
one is the task's final observed state.

## What was omitted

- No credentials or model calls; the renderer is a pure function driven with literals.
- Test logs tail-trimmed to summary and failure regions, ANSI stripped.
- The upstream accumulation in `manager.ts` is left as-is: rendering is where the count is
  derived, and fixing it there covers all eight notify routes at once. A future change could
  also stop the repeated push, but that is an optimization, not a correctness fix.
