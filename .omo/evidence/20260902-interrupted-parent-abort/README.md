# Interrupted parent terminalizes its in-flight background lanes

Fixes the harness finding "2026-08-27 - An interrupted parent aborts its background
lanes, but they keep reporting `running` until the 45-minute stale reaper"
(`docs/troubleshooting/harness-findings.md`).

Change: `packages/omo-opencode/src/features/background-agent/manager.ts` gains
`terminalizeChildTasksOnParentAbort()`, called from the `session.error` branch of
`handleEvent`. On an abort-shaped error for a session that is not itself a tracked
task, its descendant tasks in `running` or `pending` are cancelled through the
existing `cancelTask` path with `source: "parent-session-abort"`.

## WHAT WAS TESTED

Two surfaces, because a unit test alone cannot prove the trigger exists in
production.

1. Unit: `packages/omo-opencode/src/features/background-agent/interrupted-parent-abort.test.ts`
   drives the real `BackgroundManager.handleEvent` with a `session.error` carrying
   `{ name: "AbortError", message: "Session aborted" }` for a parent that owns two
   in-flight children plus one unrelated task.
2. Live harness: `.agents/skills/opencode-qa/scripts/interrupted-parent-abort-probe.sh`
   runs a real `opencode serve` against a local fake LLM in an isolated XDG sandbox,
   spawns a real background child lane, waits until that child is genuinely mid tool
   call, then issues a real `POST /session/<parent>/abort` (what the TUI's ESC does)
   and reads the outcome from the SSE wire and the plugin log.

The probe deliberately runs an OBSERVATION phase first. The fix assumes a user
interrupt reaches the plugin as an abort-shaped `session.error`; that assumption was
never verified and the whole fix depends on it. The probe therefore records the raw
event wire and fails loudly as `PROBE-INVALID` if no `session.error` for the parent is
observed, rather than reporting a colour.

## WHAT WAS OBSERVED

Fixed build (`fixed/14-oracle.txt`, `fixed/15-verdict.txt`):

```
parent_session_error_events=1
parent_events_mentioning_aborted=2
terminalize_log_lines=2
terminalize_lines_for_this_parent=2
VERDICT=PASS
```

Negative control, identical probe against a build with only the call site removed
(`negative-control/14-oracle.txt`, `negative-control/15-verdict.txt`):

```
parent_session_error_events=1
parent_events_mentioning_aborted=2
terminalize_log_lines=0
terminalize_lines_for_this_parent=0
VERDICT=PASS   (mode: expect NO terminalization)
```

Two things this establishes. First, the assumed trigger is real: a genuine parent
abort does emit exactly one `session.error` for the parent session, in both builds.
Second, the probe distinguishes the builds. The only delta between the runs is the
single call to `terminalizeChildTasksOnParentAbort`, and the terminalization count
moves 2 -> 0 when it is removed, so a PASS on the fixed build is not a pass for an
unrelated reason.

Unit-level mutation check, same principle at the test layer: deleting the call site
turns `interrupted-parent-abort.test.ts` RED (`expect "cancelled", received
"running"`), restoring it turns it GREEN. The test is load-bearing rather than
incidentally satisfied.

Isolation: `01-host-session-count-before.txt` and `16-host-session-count-after.txt`
are equal in both runs, and the probe aborts on any mismatch, so the real
`~/.local/share/opencode/opencode.db` was never written. `90-cleanup-receipt.txt`
records every spawned pid as dead.

Regression: `bun test packages/omo-opencode/src/features/background-agent/` reports
942 pass, 0 fail across 84 files.

## WHY IT IS ENOUGH

The finding's claim is that an interrupted parent leaves lanes reporting `running`
until the reaper. The probe reproduces that exact scenario on real opencode: a real
child lane, genuinely in flight, and a real abort of its parent. The negative control
shows the stranding behaviour still present without the fix, and the fixed build
shows the lanes terminalized in the same conditions. The observation phase closes the
gap the unit test could not: production really does deliver the event shape the fix
keys on.

## WHAT WAS OMITTED

- The 45-minute reaper path itself was not waited out; the assertion is that the
  child is terminalized promptly on the interrupt, which is the behaviour under test.
  Whether the reaper would eventually have caught it is already established by the
  original finding.
- The probe asserts on the terminalization log line scoped to the parent session
  rather than on a final task status read back through the API, because the sandbox
  server is torn down immediately after the interrupt. The log line is emitted from
  inside the loop that calls `cancelTask`, one line per child.
- `04-opencode-serve.log` and `03-fake-openai.log` are raw local server logs from the
  sandbox. They contain no credentials beyond the throwaway `probe-pass` and
  `fake-key` used by the sandbox itself.
