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
  - A call with `background_action: "status"` clears the job **only if the parsed status
    field** reports a terminal value. The status is extracted from the field, never
    matched against the free-form body: a running gradle/npm job's log tail routinely
    contains `FAILED` / `completed`, and scanning the whole output for those words retired
    the job on its first poll — silently disarming the guard for exactly the long, noisy
    builds it exists for. An unparseable status is treated as **still running** (fail-safe).
  - A call with `background_action: "cancel"` always clears it.
  - A `status` poll naming an unknown job adopts it, so a reworded start message degrades
    to still-guarded rather than untracked. Retired ids are remembered and refused, so a
    late "job not found" reply cannot resurrect a reaped job into an endless warning.
  - Entries are pruned by TTL (2h) and capped per session, because `session.deleted` is
    **not** guaranteed — `client.session.abort()` does not reliably emit it, and aborted
    subagents are the heaviest users of detached shells.
- `hook.ts` runs on `session.idle` and dispatches an **internal continuation prompt**
  (`dispatchInternalPrompt`, `mode: "async"`), the same mechanism `goal` and
  `atlas/idle-completion-nudge` use.

  It deliberately does **not** use `contextCollector`: collector entries are drained by
  `experimental.chat.messages.transform` and injected into the next *real user* message
  (`features/context-injector/injector.ts`), which means they arrive only after a human
  types again — i.e. after the very stall this hook exists to prevent — and are skipped
  entirely for subagent sessions, whose prompts carry the internal-initiator marker.
  Subagents are the worst case (stale-cancelled at 15 min with work uncommitted), so a
  collector-based guard is silent exactly where it is needed most.

  A cooldown (`NUDGE_COOLDOWN_MS`) throttles repeat prompts, but the hook keeps firing
  while a job is outstanding — a guard against stalling must escalate, not go quiet after
  one attempt. A rejected dispatch does not start the cooldown, so the next idle retries.
- `session.deleted` drops all state — cleared centrally in
  `plugin/event-session-lifecycle.ts`, not inside the hook, because recording is
  unconditional. Clearing only in the (configurable) hook meant that disabling the hook
  removed the tracker's only reaper.

## Testing

`bun test packages/omo-opencode/src/hooks/unpolled-shell-job/` — 33 tests across
`tracker.test.ts` (registration, status parsing, adoption, retirement, TTL/cap,
per-session isolation) and `hook.test.ts` (dispatch shape, cooldown, settle gate,
event filtering).

Wiring is pinned by two tests outside this directory:
`plugin/tool-execute-after.test.ts` asserts a detached `ctx_shell` call reaches the
tracker with the right argument shape (verified to fail when the call is removed), and
`plugin/event-hook-dispatcher.test.ts` enumerates every session hook and asserts each is
dispatched on `session.idle`.

Fixtures use realistic `shell_*` ids and poll bodies, including the gradle/jest/bun log
tails that previously caused a running job to be retired.
