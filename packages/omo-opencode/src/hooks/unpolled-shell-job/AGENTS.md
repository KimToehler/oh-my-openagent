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

  **The output text is read through `shared/tool-output-text.ts`, never off `output.output`
  directly.** OpenCode fires this hook at a different point for MCP tools than for native
  ones (verified against the 1.18.15 bundle): native tools are passed a result that already
  carries `.output`, while MCP tools are passed the RAW MCP result, whose text lives in
  `content[]` blocks — `.output` is built on the next line, after every plugin hook has run.
  Guarding on `typeof output.output === "string"` therefore dropped 100% of `ctx_shell`
  calls: jobs never registered at start, and terminal status polls could not clear them, so
  every entry arrived through the status-adoption fallback labelled
  `(started before it was tracked)` and each cleanup poll re-created it. Do not "simplify"
  the helper away.
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
    to still-guarded rather than untracked — but **only when the parsed status positively
    reports the job as running**. Adopting whenever the status merely failed to parse turns
    an unreadable payload into a permanent phantom that every cleanup poll re-creates, which
    is exactly what the MCP payload bug above produced. Retired ids are remembered and
    refused, so a late "job not found" reply cannot resurrect a reaped job into an endless
    warning.
  - Entries are pruned by TTL (2h) and capped per session, because `session.deleted` is
    **not** guaranteed — `client.session.abort()` does not reliably emit it, and aborted
    subagents are the heaviest users of detached shells.
- `message.ts` builds the warning. It offers three resolutions (bounded wait / cancel /
  confirm-already-finished) rather than only "poll each one".

  The wait path pairs the loop with **one terminal `status` call**, because the loop alone
  does not deregister the job. The tracker only observes `ctx_shell` calls
  (`tool-execute-after.ts` → `recordToolCall`); consuming a job's result by reading a
  marker file, log, or verdict file with any other tool is invisible to it, so the job
  stays outstanding and the hook re-fires on work the agent already finished and acted on.
  That false positive was observed twice in one session. The message previously taught the
  bounded loop as a complete resolution while only mentioning the clearing call as a
  separate option, which is what produced it. Clearing on genuinely-observed completion is
  not implementable from the hook's inputs: `session.idle` carries no job status, and the
  tracker sees non-`ctx_shell` tool calls only as unrelated events. `tracker.test.ts`
  pins this ("keeps a job tracked when its result was consumed without a terminal poll")
  so the gap is characterized rather than rediscovered.

  The wait path prescribes a **bounded loop that breaks on completion**, because the
  earlier phrasing — a list of `background_action="status"` calls — reliably produced a
  spiral of a dozen-plus single status calls across as many turns, flooding context to
  learn what one loop would have reported. The message says explicitly that the
  "never sleep-poll" rule targets a *blind* `sleep 300` (which wastes the whole wait even
  when the job lands in 5s), not a loop that exits as soon as the work finishes;
  without that carve-out an agent reads the two rules as contradictory and falls back to
  spamming `status`.

  It also closes with the point that most jobs should never have been detached:
  `ctx_shell` runs in the foreground up to ~110s, and delegable work belongs in
  `task(run_in_background=true)`, which notifies. Telling an agent how to clean up a
  detached job without telling it not to detach next time treats the symptom.

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

  A `"queued"` result carrying `coalesceKind: "already-delivered"` also does **not** start
  the cooldown. `isInternalPromptDispatchAccepted` treats `"queued"` as accepted, but that
  coalesce shape means the prompt was discarded inside the 15s semantic dedupe hold. This
  warning is byte-identical on every fire while the same job set is outstanding, so it is
  precisely the prompt that shape suppresses.
- `session.deleted` drops all state — cleared centrally in
  `plugin/event-session-lifecycle.ts`, not inside the hook, because recording is
  unconditional. Clearing only in the (configurable) hook meant that disabling the hook
  removed the tracker's only reaper.

## Testing

`bun test packages/omo-opencode/src/hooks/unpolled-shell-job/` — 36 tests across
`tracker.test.ts` (registration, status parsing, adoption, retirement, TTL/cap,
per-session isolation) and `hook.test.ts` (dispatch shape, cooldown, settle gate,
event filtering, dedupe-discard retry).

Wiring is pinned by two tests outside this directory:
`plugin/tool-execute-after.test.ts` asserts a detached `ctx_shell` call reaches the
tracker with the right argument shape — in **both** the native (`.output`) and MCP
(`content[]`) payload shapes, the latter verified to fail before the fix — and
`plugin/event-hook-dispatcher.test.ts` enumerates every session hook and asserts each is
dispatched on `session.idle`. The extraction itself is unit-tested in
`shared/tool-output-text.test.ts`.

Fixtures use realistic `shell_*` ids and poll bodies, including the gradle/jest/bun log
tails that previously caused a running job to be retired.
