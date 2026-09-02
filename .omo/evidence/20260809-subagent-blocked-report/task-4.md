# Task 4: Failure-Framing Fix for BLOCKED Status

## Context

Defect: Background-task notification was misdirecting parents when a child was BLOCKED. Because `statusText === "BLOCKED"` was not included in `isFailure` logic, BLOCKED status inherited the generic failure call-to-action: "**ACTION REQUIRED:** This task failed. Check error decide whether retry, cancel remaining tasks, or continue."

This actively misdirects the parent away from the one action that resolves a blocked child: **answering the child**. The whole purpose of the background-agent wake feature is to provide actionable, high-signal notifications, so a misleading call-to-action defeats the feature intent.

## Solution

1. Renamed `isFailure` → `isGenuineFailure` and excluded BLOCKED from it:
   - OLD: `const isFailure = statusText !== "COMPLETED"`
   - NEW: `const isGenuineFailure = statusText !== "COMPLETED" && statusText !== "BLOCKED"`

2. Added a dedicated call-to-action branch for BLOCKED:
   ```
   ${isBlocked ? "**CHILD AWAITING RESPONSE:** Answer the child to unblock it." : isGenuineFailure ? "**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue." : "Do NOT poll - continue productive work."}
   ```

3. Tests added:
   - Existing test verified BLOCKED renders the answer-oriented instruction
   - NEW: Test explicitly verifies BLOCKED uses answer-oriented call-to-action, NOT failure call-to-action
   - NEW: Test explicitly verifies ERROR still gets the failure call-to-action, NOT the answer-oriented text

## Files Modified

- `packages/omo-opencode/src/features/background-agent/background-task-notification-template.ts` — Introduced `isGenuineFailure` logic and added BLOCKED-specific call-to-action branch
- `packages/omo-opencode/src/features/background-agent/background-task-notification-template.test.ts` — Added regression tests catching future misdirection

## Test Results

✓ `bun test packages/omo-opencode/src/features/background-agent/background-task-notification-template.test.ts` — 18 pass, 0 fail
✓ `bun test packages/omo-opencode/src/features/background-agent/` — 813 pass, 0 fail
✓ `bun run typecheck` — 0 type errors

## FAILURE-FRAMING FIX

### Rendered BLOCKED Notification (NEW CALL-TO-ACTION)

```
<system-reminder>

[BACKGROUND TASK BLOCKED]

**ID:** `bg_blocked_123` | session: `ses_blocked_child_456`
**Description:** Inspect remote logs
**Duration:** 2m 5s
**Error:** Reason: repeated gateway timeout
Needs: refreshed API credentials

**Blocked:** Reason: repeated gateway timeout
Needs: refreshed API credentials

**Child needs your answer:** Reply with the requested information using this exact invocation:
`task(task_id="ses_blocked_child_456", prompt="<your answer>")`

**1 task still in progress.** You WILL be notified when ALL complete.

**CHILD AWAITING RESPONSE:** Answer the child to unblock it.

Use `background_output(task_id="bg_blocked_123")` to retrieve this result when ready. If that returns not-found, fall back to `session_read(session_id="ses_blocked_child_456")`.

</system-reminder>
```

### Key Improvement

- **OLD (WRONG):** "**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue."
- **NEW (CORRECT):** "**CHILD AWAITING RESPONSE:** Answer the child to unblock it."

The new call-to-action is imperative, concise, and actionable. It tells the parent exactly what unblocks a child: answering it. No misdirection toward retry/cancel/continue — those don't apply to blocked children.
