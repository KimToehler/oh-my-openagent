# Shutdown abort status - QA evidence (2026-08-21)

Change: a background task still in flight when the manager shuts down is no longer dropped
silently and no longer reported to the parent as `completed`.

Branch: `fix/shutdown-abort-status` (local worktree, no PR - single-reviewer fork).

## What was tested

Two defects sit behind one symptom. Both were driven, before and after.

1. **Shutdown drops the record.** `manager.ts` shutdown loop archived only already-terminal
   tasks and called `forgetBackgroundTask()` on anything still running, writing no terminal
   status. Driven by constructing a real `BackgroundManager`, adding a `running` task, calling
   the real `shutdown()`, then reading it back through a SECOND manager - the cross-process
   topology OpenDesign actually uses.
2. **Recovery fabricates success.** `create-background-output.ts` hardcoded `status: "completed"`
   on the task it reconstructs from the parent transcript, for ANY unreachable task. Driven
   through the real `createBackgroundOutput(...).execute()` with a transcript fixture, asserting
   on the rendered `Status:` line.

Surfaces driven: real `BackgroundManager`, real `background_output` tool, real build
(`bun run build`, exit 0), plus the unit suites and a same-scope baseline on clean `dev`.

## What was observed

- Recovery path, identical input: `dev` renders `Status: completed` (`CLAIMS_COMPLETED=true`);
  patched renders `Status: unknown (recovered from transcript; ...)` (`CLAIMS_COMPLETED=false`).
- Shutdown, cross-manager: `dev` returns `<undefined>` (record vanishes); patched returns
  `cancelled` with a FINAL-cancellation reason.
- `CALLER_OBJECT_MUTATED=false` - the archived record is a clone. An earlier revision of this
  fix mutated the caller's live task object and broke 2 poller tests that assert the poller
  left a task `running`; the clone-on-archive form fixes the defect without touching live state.
- Unit: `1443 pass / 4 fail` in the patched worktree vs `1440 pass / 4 fail` on clean `dev`,
  SAME scope. The 4 failures are byte-identical between the two runs (assertion-signature diff
  empty both directions) - pre-existing on `dev`, not caused here. +3 pass = the 3 new tests.
- Typecheck: exit 0, 0 `error TS`. (An earlier run showed 3 `TS2307 Cannot find module` in
  `packages/omo-senpi`; that was the fresh worktree missing `node_modules`, cleared by `bun install`.)
- Isolation: real DB session count 2299 before and after.

## Why it is enough

The reported symptom is a parent being told `completed` about work that was killed. That exact
string was reproduced on `dev` through the real tool, and is gone after the change, with the
control run isolating which half of the fix does what. The regression risk is the shared task
registry, so the whole background-agent + background-task + delegate-task surface was run and
diffed against a same-scope baseline rather than eyeballed.

One invariant was deliberately changed: the test formerly named "should forget active registry
tasks during earlier manager shutdown" asserted a killed task must become unreachable. That
assertion is what produced the bug. It was rewritten (not deleted) to assert the truthful
terminal status, keeping its cross-manager check. Rationale: commit `982fa8136` established that
terminal tasks stay visible across managers by design; making a killed task terminal brings it
under that existing rule.

## What was omitted

- No provider credentials, tokens, or auth headers appear in any artifact; the QA driver uses
  stub clients and a transcript fixture, so no real model call was made.
- Full test logs are tail-trimmed to the summary and failure regions; ANSI stripped.
- The OpenDesign host side is NOT fixed here and is not fixable in this repo: `opencode run`
  exits at turn end, so a background subagent cannot outlive it. This change removes the silent
  false success on every one-shot host; it does not make subagents survive.
