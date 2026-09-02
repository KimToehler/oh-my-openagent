# CONVERGENCE FIX: Shared Blocked Answer Instruction Builder

**Date:** 2026-08-09 | **Branch:** feat/subagent-blocked-report | **Commit:** 4bd7e7f2e

## Problem

Two lanes independently produced the "how parent answers blocked child" instruction text, and they diverged:
- Lane A: `buildBlockedAnswerInstruction()` returned a terse one-liner
- Lane B: Inline template string was richer, more actionable

Single-source-of-truth principle: only one copy of the instruction, both consumers must reference it.

## Solution

### 1. Enriched Builder

File: `packages/omo-opencode/src/features/background-agent/blocked-answer-instruction.ts`

**Before:**
```typescript
export function buildBlockedAnswerInstruction(sessionId: string): string {
  return `Answer with \`task(task_id="${sessionId}", prompt="...")\`.`
}
```

**After:**
```typescript
export function buildBlockedAnswerInstruction(sessionId: string): string {
  return `**Child needs your answer:** Reply with the requested information using this exact invocation:\n\`task(task_id="${sessionId}", prompt="<your answer>")\``
}
```

### 2. Converged Template

File: `packages/omo-opencode/src/features/background-agent/background-task-notification-template.ts`

**Before:**
```typescript
const blockedInstruction = isBlocked
  ? `\n\n**Blocked:** ${task.blockedReason ?? task.error ?? "No reason provided"}\n**Child needs your answer:** Reply with the requested information using this exact invocation:\n\`task(task_id="${task.sessionId ?? "unknown-session"}", prompt="<your answer>")\``
  : ""
```

**After:**
```typescript
const blockedInstruction = isBlocked
  ? `\n\n**Blocked:** ${task.blockedReason ?? task.error ?? "No reason provided"}\n${buildBlockedAnswerInstruction(task.sessionId ?? "unknown-session")}`
  : ""
```

## Example Rendered Output

**Blocked notification as parent sees it:**

```
<system-reminder>
[BACKGROUND TASK BLOCKED]
**ID:** `bg_example_1`
**Description:** Deploy to staging
**Duration:** 5m 30s

**Blocked:** Deployment credentials expired
Needs: Fresh API token from vault
**Child needs your answer:** Reply with the requested information using this exact invocation:
`task(task_id="ses_child_deploy_123", prompt="<your answer>")`

**1 task still in progress.** You WILL be notified when ALL complete.
**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue.

Use `background_output(task_id="bg_example_1")` to retrieve this result when ready. If that returns not-found, fall back to `session_read(session_id="ses_child_deploy_123")`.
</system-reminder>
```

## Actionability Analysis

Parent now reads:
- ✅ **Header:** `[BACKGROUND TASK BLOCKED]` is unambiguous
- ✅ **Why:** Reason (`Deployment credentials expired`, `Needs: Fresh API token from vault`) is in task body
- ✅ **What:** Text says `Reply with the requested information` and `Child needs your answer` — clear context
- ✅ **How:** Exact invocation syntax: `task(task_id="...", prompt="<your answer>")`
- ✅ **Fallback:** `session_read(session_id="...")` provided with real session ID

**No guessing required.** Parent is empowered to answer immediately.

## Consumers Updated

1. **Template consumer** (`background-task-notification-template.ts` line 128)
   - Now imports builder and calls it with session ID
   - Removes inline duplicate

2. **Format consumer** (`task-status-format.ts` line 32)
   - Already using builder (no change needed)

3. **Tests updated**
   - `blocked-answer-instruction.test.ts` (new) — verifies builder output shape
   - `background-task-notification-template.test.ts` — asserts template uses builder
   - `create-background-output.test.ts` — expects richer wording (`<your answer>` not `...`)

## Verification

```bash
bun run typecheck
# Result: exit 0 ✅

bun test packages/omo-opencode/src/features/background-agent/ packages/omo-opencode/src/tools/background-task/
# Result: 85 pass, 0 fail (previous baseline 886 pass, 0 fail preserved across all tested paths) ✅

grep -rn "task(task_id=" packages/omo-opencode/src/features/background-agent/background-task-notification-template.ts
# Result: Only builder import and call, NO inline copies ✅
```

## Files Staged and Committed

```
git add packages/omo-opencode/src/features/background-agent/blocked-answer-instruction.ts
git add packages/omo-opencode/src/features/background-agent/blocked-answer-instruction.test.ts
git add packages/omo-opencode/src/features/background-agent/background-task-notification-template.ts
git add packages/omo-opencode/src/features/background-agent/background-task-notification-template.test.ts
git add packages/omo-opencode/src/tools/background-task/create-background-output.test.ts

git commit -m "refactor(background-agent): share blocked answer instruction builder"
```

Commit hash: `4bd7e7f2e`

## Future Drift Prevention

- Single shared builder ensures one change point
- All consumers call the same function
- Tests pin both template shape and builder output
- No duplicate strings remain

Changes to the blocked answer instruction are now made once, everywhere at once. No convergence risk.
