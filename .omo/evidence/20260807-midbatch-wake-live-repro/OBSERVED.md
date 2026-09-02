# Live reproduction — background_output "Task not found" (2026-08-07)

Captured opportunistically: an orchestrator session in this repo fired 5 parallel
`explore` background tasks and hit the reported failure in-session.

## WHAT WAS TESTED

Real OpenCode session (not a test harness), `/Users/tim/git/oh-my-openagent`.
5 background tasks launched via `task(subagent_type="explore", run_in_background=true)`:
`bg_f3c12652`, `bg_dd0b56e9`, `bg_b331dea5`, `bg_780b8fc4`, `bg_da0c6c62`.

After the completion notifications arrived, `background_output(task_id=...)` was
called as the first action of the turn, exactly as the notification text instructs.

Log source: `/var/folders/c6/rmmgm5s52vsc2_g434mnp_nm0000gn/T/oh-my-opencode.log`

## WHAT WAS OBSERVED

### 1. Notifications DID arrive (starvation half NOT reproduced)

4 mid-batch `[BACKGROUND TASK RESULT READY]` reminders plus
`[ALL BACKGROUND TASKS COMPLETE]` were delivered to the parent. Each carried the
`OMO_INTERNAL_NOREPLY` marker, i.e. deposited into history rather than waking a
reply turn. They surfaced because the parent reached a turn boundary.

A continuously-busy parent (the reported onara case) never reaches that boundary.
So this run exercises the deposit path, NOT the never-delivered path.

### 2. `[ALL BACKGROUND TASKS COMPLETE]` fired TWICE for one batch

Identical payload, two separate system reminders. Matches the reported double-fire.

### 3. `background_output` returned "Task not found" — 3 of 3 attempts

Plugin log, verbatim:

```
[2026-08-07T14:24:17.185Z] [background_output] background task missing on first lookup; retrying {"taskId":"bg_f3c12652","retryDelayMs":100}
[2026-08-07T14:24:17.290Z] [background_output] background task still missing after retry {"taskId":"bg_f3c12652"}
[2026-08-07T14:24:17.237Z] [background_output] background task missing on first lookup; retrying {"taskId":"bg_dd0b56e9","retryDelayMs":100}
[2026-08-07T14:24:17.341Z] [background_output] background task still missing after retry {"taskId":"bg_dd0b56e9"}
[2026-08-07T14:24:24.202Z] [background_output] background task missing on first lookup; retrying {"taskId":"bg_b331dea5","retryDelayMs":100}
[2026-08-07T14:24:24.308Z] [background_output] background task still missing after retry {"taskId":"bg_b331dea5"}
```

Self-contradicting contract: the notification body says
"Your next action should be to call `background_output(task_id="<id>")`", and the
store answers `Task not found` for those same ids.

### 4. Timing FALSIFIES the reaper explanation

`bg_f3c12652` lifecycle:

```
[2026-08-07T14:20:35.871Z] Task queued
[2026-08-07T14:22:28.485Z] Queued notification for short-debounce flush to idle parent:
                           {"allComplete":false,"isTaskFailure":false,"shouldReply":false}
[2026-08-07T14:22:28.485Z] Task completed via session.idle event
[2026-08-07T14:24:17.185Z] background task missing on first lookup
```

**109 seconds** from completion to missing. `TASK_CLEANUP_DELAY_MS` is
**10 minutes** (`constants.ts:22`). The cleanup timer cannot have fired.

### 5. The archives make "not found" impossible via ANY removal path

`removeTask` (`manager.ts:436-441`) archives BEFORE deleting:
`archiveCompletedTask(task)` -> `completedTaskArchive`, `archiveBackgroundTask(task)`
-> global registry, THEN `this.tasks.delete(task.id)`.

`getTask` (`manager.ts:1116`) reads all three tiers:
`this.tasks.get(id) ?? this.completedTaskArchive.get(id) ?? getRegisteredBackgroundTask(id)`

Both archives cap at 100 entries. This batch had 5 tasks. Eviction impossible.

**Conclusion: a reaped task is still returned by `getTask`. Therefore no removal
path — reaper, TTL, or eviction — can produce this failure.** The task was never
present in the maps of the manager instance that `background_output` is bound to.

Leading hypothesis: manager/registry instance mismatch between the launching path
and the tool's `BackgroundOutputManager` (`clients.ts:34`, `Pick<BackgroundManager,
"getTask">`). Note the log is shared across concurrent OpenCode processes
(`oh-my-openagent`, `onara`, `tokprobe-mcp/scratch` all write to it), and the global
registry lives on `globalThis` — per process, not per machine.

### 6. `ses_*` sessions SURVIVE and returned full results

3 of 3 recovered via `session_read(session_id="ses_...")` after 3 of 3 registry
lookups failed. Confirms the handoff's claim that subagent sessions outlive `bg_*`
registry entries, and that a session-transcript fallback is viable.

## WHY IT IS ENOUGH

Points 3, 4, 5 together falsify the D2 retention-guard diagnosis as the cause of
THIS failure: the timing rules out the reaper, and the archive chain rules out
every removal path. Building the planned retention-guard fix would not have
prevented what was observed.

Point 1 is a genuine limitation: this run does NOT reproduce the "wake never
arrives" starvation half. That half still needs the deterministic busy-parent test
the handoff describes.

## WHAT WAS OMITTED

No secrets, tokens, or auth headers present in captured lines. Session ids and
task ids retained deliberately as correlation keys. Full log not copied; it is
shared across concurrent OpenCode processes and contains unrelated project paths.

## CAVEATS

- n=1, uncontrolled, opportunistic capture during unrelated work.
- `removeTask` emits no log line, so absence of a removal entry is NOT itself
  evidence the reaper did not run. The archive-chain argument (point 5) is what
  carries the conclusion; it does not depend on log absence.
- Instance-mismatch remains a hypothesis, not yet proven. It requires a
  deterministic test that pins which manager instance the tool resolves.
