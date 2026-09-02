# src/tools/background-task/ — Background Task Tool Wrappers

**Generated:** 2026-05-15

## OVERVIEW

28 files. Tool-layer wrappers for `background_output` and `background_cancel`. Does NOT implement the background execution engine — that lives in `src/features/background-agent/`. This directory provides the LLM-facing tool interface.

## THREE TOOLS

| Tool | Factory | Purpose |
|------|---------|---------|
| `background_output` | `createBackgroundOutput` | Get results from a running/completed background task |
| `background_cancel` | `createBackgroundCancel` | Cancel running task(s) |
| `createBackgroundTask` | internal | Shared factory used by both |

## KEY FILES

| File | Purpose |
|------|---------|
| `create-background-output.ts` | `background_output` tool: fetch task results by task_id |
| `create-background-cancel.ts` | `background_cancel` tool: cancel by taskId or all=true |
| `create-background-task.ts` | Shared tool factory with common params |
| `clients.ts` | Client interfaces for background output and cancel |
| `session-messages.ts` | Fetch session messages from OpenCode |
| `full-session-format.ts` | Format full session output (messages, thinking blocks) |
| `task-result-format.ts` | Format task result for LLM consumption |
| `task-status-format.ts` | Format task status (running/completed/error) |
| `message-dir.ts` | Temp directory for message exchange |
| `truncate-text.ts` | Truncate large output to fit context |
| `time-format.ts` | Human-readable duration formatting |
| `delay.ts` | Polling delay utility |
| `types.ts` | `BackgroundTaskOptions`, result/status types |
| `constants.ts` | Timeout defaults, polling intervals |

## BACKGROUND OUTPUT MODES

```
background_output(task_id, block=false)  → check current status/result
background_output(task_id, block=true)   → wait until complete (timeout default: 120s)
background_output(task_id, full_session=true) → return full session transcript
background_output(task_id, message_limit=N) → last N messages only
background_output(task_id, include_thinking=true) → include thinking blocks
```

## RELATIONSHIP TO BACKGROUND ENGINE

```
tools/background-task/  ← LLM tool interface
features/background-agent/  ← execution engine (BackgroundManager)
```

`createBackgroundOutput` queries `BackgroundManager.getTask(task_id)` for the primary path; it does not manage task state.

### Cross-runtime fallback (transcript scan)

Task state lives in per-process memory (`BackgroundManager.tasks`, its bounded archive, and the `globalThis` registry, see `features/background-agent/AGENTS.md`). When the calling runtime is not the one that owns the task (a different `opencode serve` instance, a separate terminal process, JetBrains-ACP opencode, and so on), `getTask` legitimately misses on all three tiers even though the task is alive and complete elsewhere.

On a `getTask` miss, `create-background-output.ts` does not return a bare `Task not found`. It scans the CALLING session's messages for the `bg_id -> ses_id` pairing that ties the task to its child session, looking for any of:

- `<task_metadata>` blocks
- `| session: \`ses_...\`` summary lines
- `Session ID:` launch text

If a pairing is found, it renders the recovered child session via `formatFullSession` and tells the caller the result was recovered from the transcript, not the live task registry.

**Why this works when the primary path cannot:** task state is per-runtime and in-memory, so it is invisible across a process boundary. Session transcripts are server-backed (OpenCode's session store) and readable by any runtime that can reach the server, including the one that made the original background call. The fallback trades "ask the process that ran it" for "ask the server for what it wrote down," which survives the exact process/realm split that defeats `getTask`.
