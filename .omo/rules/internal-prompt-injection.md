---
description: Internal message injection safety - fires when touching the prompt-async gate or any route that dispatches an internal prompt into a live session
globs:
  - "packages/omo-opencode/src/shared/prompt-async-gate.ts"
  - "packages/omo-opencode/src/hooks/shared/prompt-async-gate.ts"
  - "packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts"
  - "packages/omo-opencode/src/shared/session-route.ts"
  - "packages/omo-opencode/src/shared/model-suggestion-retry.ts"
  - "packages/omo-opencode/src/cli/run/runner.ts"
  - "packages/omo-opencode/src/plugin/event-model-fallback-state.ts"
  - "packages/omo-opencode/src/plugin/unstable-agent-babysitter.ts"
  - "packages/omo-opencode/src/plugin/build-team-idle-wake-hint-client.ts"
  - "packages/omo-opencode/src/features/background-agent/**"
  - "packages/omo-opencode/src/features/monitor/output-injector*.ts"
  - "packages/omo-opencode/src/features/team-mode/tools/messaging-live-delivery-recipient.ts"
  - "packages/omo-opencode/src/tools/call-omo-agent/**"
  - "packages/omo-opencode/src/hooks/goal/**"
  - "packages/omo-opencode/src/hooks/atlas/**"
  - "packages/omo-opencode/src/hooks/ralph-loop/**"
  - "packages/omo-opencode/src/hooks/runtime-fallback/**"
  - "packages/omo-opencode/src/hooks/team-session-events/**"
  - "packages/omo-opencode/src/hooks/todo-continuation-enforcer/**"
  - "packages/omo-opencode/src/hooks/unpolled-shell-job/**"
  - "packages/omo-opencode/src/hooks/unstable-agent-babysitter/**"
  - "packages/omo-opencode/src/hooks/compaction-context-injector/**"
  - "packages/omo-opencode/src/hooks/claude-code-hooks/**"
  - "packages/omo-opencode/src/hooks/anthropic-context-window-limit-recovery/**"
---

# Internal Message Injection Is Dangerous (BLOCKING)

OpenCode lets a plugin corrupt the main session through the main-session message APIs
`session.prompt` / `session.promptAsync`. Treat every such call as a write to shared session state.

**Root cause to remember:** `promptAsync` returns BEFORE the prompt is durably accepted, and a later
failure can arrive as a separate `session.error`. Multiple OMO hooks and tools observe the same
idle / error / completion edge, so the naive implementation injects the SAME internal message into a
live parent session two or more times.

## THE GATE IS THE ONLY LEGAL ROUTE

Production code may call `session.prompt` / `session.promptAsync` only inside
[`packages/omo-opencode/src/shared/prompt-async-gate.ts`](../../packages/omo-opencode/src/shared/prompt-async-gate.ts).
Every other route MUST go through `dispatchInternalPrompt({ mode: "async" | "sync", ... })` or a
proven equivalent gate, and MUST check the result with `isInternalPromptDispatchAccepted()`.

## REQUIRED GATE SEMANTICS

1. Reserve per session BEFORE dispatch.
2. Check active session state.
3. Keep a short post-dispatch hold.
4. Release only on intentional abort or recovery paths.
5. Restore optimistic task / loop state when dispatch is skipped, or when it fails later.

## FORBIDDEN

- Raw prompt calls outside the shared gate.
- `postDispatchHoldMs: 0`.
- A no-session fallback that reaches for the raw prompt API.
- A new internal message route without duplicate-injection regression tests.

## TESTS MUST PIN BOTH LAYERS

Update the static raw-prompt audit
([`prompt-async-route-audit.test.ts`](../../packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts),
which parses source via the TS compiler API and FAILS the suite on a raw call outside the gate), THEN
add route-specific tests proving concurrent / live / idle / error triggers collapse to exactly one
dispatch. Cover: background completion wakes, fallback retries, team mailbox live delivery, recovery
continuations, CLI run resumes, Claude Code hook injections, and sync or background subagent prompts.

Full design rationale: [`docs/reference/prompt-async-gate-rfc.md`](../../docs/reference/prompt-async-gate-rfc.md).
