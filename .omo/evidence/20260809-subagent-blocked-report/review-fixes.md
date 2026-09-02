# Review fixes

## B1
Before: blocked wake was classified as progress by header and by remaining-work body, so final merge deleted it in both orderings.
Fix: BLOCKED remains failure-class/actionable, is removed from progress headers, and is explicitly excluded before body progress matching.
After:

 5 pass
 0 fail
 15 expect() calls
Ran 5 tests across 1 file. [992.00ms]
Mutation:

 3 pass
 2 fail
 13 expect() calls
Ran 5 tests across 1 file. [998.00ms]

Both ordering tests failed because `[BACKGROUND TASK BLOCKED]` was absent after merge.

## B2
Before: allComplete returned failure summary before blocked rendering.
Fix: BLOCKED rendering wins. When allComplete is true, completed siblings are included under `**Completed siblings:**` while blocked child remains primary actionable wake. This avoids misclassifying parked child as failure while retaining useful sibling results.
After:

 21 pass
 0 fail
 51 expect() calls
Ran 21 tests across 1 file. [79.00ms]
Mutation:

 18 pass
 3 fail
 45 expect() calls
Ran 21 tests across 1 file. [80.00ms]

Single-child, last-of-batch, and second-sequential-block tests failed under mutation because blocked header/instruction disappeared.

## B3
Before: running blocked task queued `shouldReply=false`.
Fix: `isTaskBlocked(task)` participates in `shouldReply`. Cleanup is not stranded: cleanup caps wake retention at `TASK_TTL_MS` and watches pending, dispatched, and in-flight reply-required states; those states clear after wake consumption.

## B4
Before: `blockedNotificationTaskIds` survived resume/removal and failed park.
Fix: clear after dispatched resume, `removeTask` purge, and `cancelTask` rejection. One blocked episode still dedupes duplicate `notifyBlockedTask` calls.

## Other fixes
- `report_blocked` reason/needs require minimum length 1.
- Failed park reports current task status.
- Requested production em dashes removed.

## Verification

```text
908 pass
0 fail
2381 expect() calls
Ran 908 tests across 90 files. [32.08s]

501 pass
0 fail
1177 expect() calls
Ran 501 tests across 43 files. [2.40s]

bun run typecheck: exit 0
```

OpenCode isolated QA:

```text
PASS: dependencies present (opencode sqlite3 curl jq tmux)
PASS: isolated XDG sandbox auto-removed on exit
PASS: isolated HOME points inside sandbox
PASS: common.sh self-check
first matching event: {"type":"server.connected"}
PASS: SSE /event opened and delivered server.connected
```

LSP note: LSP server could not initialize because workspace TypeScript installation was not discoverable; full repo typecheck passed exit 0.

## Final rendered wakes

### Single child

```text
<system-reminder>
[BACKGROUND TASK BLOCKED]
**ID:** `bg_blocked_last` | session: `ses_child_real`
**Description:** Audit payments
**Duration:** 1m
**Error:** Reason: payment scope unclear
Needs from parent: choose audit boundary

**Blocked:** Reason: payment scope unclear
Needs from parent: choose audit boundary
**Child needs your answer:** Reply with the requested information using this exact invocation:
`task(task_id="ses_child_real", prompt="<your answer>")`

**All other background tasks are complete.**
**CHILD AWAITING RESPONSE:** Answer the child to unblock it.

Use `background_output(task_id="bg_blocked_last")` to retrieve this result when ready. If that returns not-found, fall back to `session_read(session_id="ses_child_real")`.
</system-reminder>
```

### Mid-batch

```text
<system-reminder>
[BACKGROUND TASK BLOCKED]
**ID:** `bg_blocked_last` | session: `ses_child_real`
**Description:** Audit payments
**Duration:** 1m
**Error:** Reason: payment scope unclear
Needs from parent: choose audit boundary

**Blocked:** Reason: payment scope unclear
Needs from parent: choose audit boundary
**Child needs your answer:** Reply with the requested information using this exact invocation:
`task(task_id="ses_child_real", prompt="<your answer>")`

**2 tasks still in progress.** You WILL be notified when ALL complete.
**CHILD AWAITING RESPONSE:** Answer the child to unblock it.

Use `background_output(task_id="bg_blocked_last")` to retrieve this result when ready. If that returns not-found, fall back to `session_read(session_id="ses_child_real")`.
</system-reminder>
```
