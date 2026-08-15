# unpolled-shell-job

Warns at `session.idle` when the turn is about to end with a detached `ctx_shell`
background job that was never polled to completion.

## Why this exists

Two async mechanisms share the spelling `run_in_background=true` and have **opposite**
completion contracts:

| Call | On completion |
|---|---|
| `task(run_in_background=true)` | Delivers a `<system-reminder>`; ending the turn is safe |
| `ctx_shell(run_in_background=true)` | **Never notifies.** The agent must poll |

An agent that ends its turn "waiting" for a detached `ctx_shell` job waits forever. In a
subagent that means idling until stale-cancellation with work uncommitted; in a main
session it means stalling until a human notices. Both have been observed repeatedly —
see `HANDOVER-background-task-notification-bug.md` and
`HANDOFF-PROMPT-mid-batch-wake-starvation.md` at the repo root.

Documentation alone did not fix it: the rule was already written in two AGENTS.md files
and was still violated three times in one session. Facts stated as reference get recalled
*after* the choice is made. This hook enforces the contract at the moment it is broken.

## How it works

- `tracker.ts` observes every `tool.execute.after` event whose tool name ends in
  `ctx_shell` (matching lean-ctx's MCP tool however the host prefixes it).
  - A call with `run_in_background: true` whose output contains a `shell_<hex>` id
    registers that job for the session.
  - A call with `background_action: "status"` clears the job **only if** the output
    reports a terminal state (`completed`, `failed`, `cancelled`, `timed out`, ...).
    A poll reporting `running` deliberately leaves it outstanding.
  - A call with `background_action: "cancel"` always clears it.
- `hook.ts` runs on `session.idle`. If any job is outstanding it registers a high-priority
  `contextCollector` entry naming each job id and its command. It warns **once per job**,
  so repeated idles do not spam, but a newly started job warns again.
- `session.deleted` drops all state for the session.

Recording happens unconditionally in `plugin/tool-execute-after.ts`, *before* the
configurable hook chain. The idle hook is gated by the `unpolled-shell-job` hook name, but
the tracking it depends on must not be — a disabled recorder would silently produce an
always-empty warning.

## Testing

`bun test packages/omo-opencode/src/hooks/unpolled-shell-job/` — 18 tests across
`tracker.test.ts` (registration, clearing, per-session isolation) and `hook.test.ts`
(warn/silent decisions, dedupe, event filtering).

The fixtures use real `shell_*` ids and real output shapes taken from a live transcript
(`~/.claude/transcripts/`), where a single session recorded 42 detached starts and 314
polls.
