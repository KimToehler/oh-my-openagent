# Silent provider-stream stalls — investigation handover

**Status:** partially fixed. One path bounded (`72f5ef50b` on `dev`); the primary-session path is still fully exposed.
**Date:** 2026-07-29
**Repos:** `~/git/oh-my-openagent` (this fix), observed while working in `~/git/onara`.

## The symptom

A turn opens a provider stream and then produces **nothing at all** — no token, no
error, no abort, no timeout. The log ends mid-turn:

```
19:41:05.171 message=stream providerID=onara modelID=visual-engineering ... step=73
19:41:05.173 "llm runtime selected" llm.runtime=ai-sdk
<nothing, ever>
```

The harness keeps reporting the task/session as alive. In the worst observed case a
background task read **"running" for 2h 9m** while no process held the worktree as
cwd and no file had been written for 96 minutes.

Observed **three times in ~6 hours of wall-clock**, all against `router.onara.eu`:

| # | Session kind | Model alias | Died at | Idle before noticed |
|---|---|---|---|---|
| 1 | background subagent | `visual-engineering` | step 0 (no tool call yet) | — |
| 2 | background subagent | `visual-engineering` | step 73 | 1h 36m |
| 3 | **primary session** | `sisyphus` | mid-turn | **8h 45m** |

## What it is NOT (each ruled out by probe, not assumption)

- **Not the combo-alias fallthrough** documented in `.omo/rules/od-subagent-dispatch.md`.
  A one-tool `curl` to the router returned `http=200` in 4.0s serving `claude-opus-5`
  with a native `tool_calls` delta and `finish_reason:"tool_calls"`. Healthy before,
  during and after.
- **Not quota/starvation.** A 429 or quota error would appear in the log. Nothing —
  the only entries in the 8h45m gap were housekeeping (`cleanup prune`, `watcher backend`).
- **Not a lane crash.** No error, no exit, no abort. Just silence after `stream`.
- **Not prompt size or OD file reads.** #3 was the primary session doing ordinary work.
- **Not `background_task.staleTimeoutMs` being unset.** It was set and the poller ran —
  see below.

## Root cause of the part that IS fixed

`staleTimeoutMs` never fired because the watchdog **ran and was told to skip**.

In `packages/omo-opencode/src/features/background-agent/task-poller.ts`, once a task is
already past its stale timeout, the poller calls `refreshTaskActivityFromSession`. Both
call sites treated `unavailable` as a bare `continue`:

```ts
const activityRefresh = await refreshTaskActivityFromSession(task, getSessionActivity)
if (activityRefresh.type === "unavailable") continue   // ← deferred forever
```

A hung session answers **every** lookup that way while `session.status` stays `busy`, so
the deferral repeated on every 3s poll indefinitely and the timeout was never consulted.

Deferring on a failed lookup is correct — a transient API error must not kill a healthy
lane — but it must be **bounded**. `72f5ef50b` caps consecutive deferrals at
`MAX_ACTIVITY_UNAVAILABLE_POLLS = 5` and resets the counter on any successful lookup,
mirroring `consecutiveMissedPolls` which already bounds the session-gone path.

### Trap for whoever continues this

The existing tests **encode the old behaviour as intended**:
`manager-session-activity.test.ts:106` is literally named
*"keeps a busy task running when session.get returns an error response"*. It still
passes because it polls **once** and so never reaches the cap. Any further change here
must check whether it is weakening a real guarantee or removing a bug pin.

Also: when writing tests for this, **do not freeze `Date.now`**. A frozen clock makes a
non-advancing activity timestamp look stale and produces a *false* red. One of the three
new tests failed for exactly that reason; with real time advancing it passes against
unmodified code, proving that path was already correct. Use
`spyOn(Date, "now").mockImplementation(() => nowValue)` and advance `nowValue` per poll.

## What is STILL BROKEN — start here

### 1. Primary sessions have no watchdog at all (highest value)

`task-poller.ts` only iterates **background tasks**. `first-prompt-watchdog.ts` — the one
existing zero-token watchdog — gates on `subagentSessions.has(sessionID)` at both arm
(`:199`) and fire (`:140`), so primary sessions are structurally excluded.

Consequence: occurrence #3 hung for 8h45m with nothing watching. This is the single
biggest remaining gap, and the one the user actually noticed.

Open questions:
- Where should a primary-session watchdog live? `first-prompt-watchdog.ts` already has
  the arm/cancel/fire shape and the `onAssistantProgress` / `onSessionTerminal` reset
  hooks — extending it may beat a new module.
- What is the right action on fire for a primary session? Aborting a subagent is safe;
  killing a user's foreground turn needs care. Probably: abort the stalled request and
  surface a visible error so the turn can be retried, never silently.
- `runtime-fallback` already dispatches a fallback model on subagent silence. Should a
  stalled primary turn get the same treatment, or just a loud failure?

### 2. The watchdog is mid-stream-blind everywhere

`first-prompt-watchdog` only covers the **first** prompt of a session. Occurrence #2 died
at **step 73** — long past first-prompt. There is no equivalent "assistant went silent
mid-session" timer for either session kind; the background path only recovers because
polling notices staleness after the fact.

Consider a stream-level liveness timer at the point where
`"llm runtime selected" llm.runtime=ai-sdk` is emitted, armed per request and cancelled
on first token. That is the layer common to primary and subagent, and it is where the
evidence says the failure actually occurs.

### 3. Reported status lies

`background_output` showed **"running"** for a task whose process was gone. Status tracks
the open request, not liveness. Whatever is built should make a stalled task *report* as
stalled — that alone would have cut hours off all three incidents.

### 4. Upstream cause unexamined

Three stalls in ~6h against `router.onara.eu` is a high rate; this is likely a router or
upstream-provider behaviour (connection held open, no bytes, no RST) rather than pure bad
luck. The cap converts a silent hang into a loud cancellation — strictly better, but it
treats the symptom. Worth capturing a stalled connection (`ss`/`lsof`/proxy logs) to see
whether the socket is alive, half-open, or black-holed.

## Reproduction

No deterministic local repro yet — that is itself a task. Candidate approach: a stub
provider that accepts the request, returns 200, opens the SSE stream and then writes
nothing, and confirm both a background lane and a primary turn hang against it. That
harness would let every fix above be proven red-first instead of reasoned about.

## Verification commands

```bash
cd ~/git/oh-my-openagent
bun test packages/omo-opencode/src/features/background-agent/     # 749 pass
npx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
# NOTE: two pre-existing errors in shared/typescript-native-source-parser.ts
# (typescript/unstable/{async,ast}) are present on clean dev — verify by stashing.
```

Probe whether a model alias is healthy (rules out the *other* known failure mode):

```bash
KEY=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.local/share/opencode/auth.json')));print(d['onara']['key'])")
curl -s --max-time 60 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"visual-engineering","max_tokens":50,"messages":[{"role":"user","content":"call the tool"}],"tools":[{"type":"function","function":{"name":"t","parameters":{"type":"object","properties":{}}}}]}' \
  https://router.onara.eu/v1/chat/completions | tr ',' '\n' | grep -E '"model"|finish_reason|tool_calls'
```

Healthy = expected model + `tool_calls` delta + `finish_reason:"tool_calls"`.

## Diagnosing a live stall

```bash
LOG=~/.local/share/opencode/log/opencode.log
grep '<session-id>' "$LOG" | grep -E 'message=(stream|process|loop)' | tail -5   # ends at `stream`?
grep -c '' <(awk '$0 ~ /<time-range>/' "$LOG" | grep -v 'permission=')           # only housekeeping in the gap?
for p in $(pgrep -f node); do lsof -p $p -a -d cwd 2>/dev/null | tail -1; done   # any process still in the worktree?
```

A task whose log ends at `message=stream`, with no process and no recent file write, is
this bug.

## Key files

| File | Role |
|---|---|
| `features/background-agent/task-poller.ts` | stale detection; the two `unavailable` sites now capped |
| `features/background-agent/task-activity-refresh.ts` | returns `activity`/`missing`/`unavailable` |
| `features/background-agent/session-status-classifier.ts` | `busy`/`retry`/`running` = "active" |
| `features/background-agent/constants.ts` | `MAX_ACTIVITY_UNAVAILABLE_POLLS`, `POLLING_INTERVAL_MS=3000` |
| `features/background-agent/manager.ts` | task state machine; owns transitions out of `running` |
| `hooks/runtime-fallback/first-prompt-watchdog.ts` | the only zero-token watchdog; **subagent-only** |
| `features/background-agent/stale-deferral-cap.test.ts` | the three new pins |
