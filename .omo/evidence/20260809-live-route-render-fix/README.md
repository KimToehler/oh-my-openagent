# Live parent-wake routing render stall — evidence

**Date:** 2026-08-09
**Fix commit:** `aafc97e87` (merged to `dev` as `16902f246`)
**Branch:** `fix/live-route-render`

## What was tested

Background-task completion wakes were persisted to the database but never
rendered in the attached TUI. The user had to fully quit and restart opencode
to see both the completion notification and the assistant turn that followed
it.

The surface driven was the real, live opencode session the user was working in
(not a sandbox): four background tasks fired in a single burst, each instructed
to emit one unique token and use no tools. The behavior under test was whether
the parent-wake notification and the resulting assistant turn repaint in the
attached TUI without a restart.

Each run used an identical probe shape so the runs are directly comparable.
The log was sliced from a byte offset captured immediately before firing, so
every count below covers only that run.

## What was observed

| Run | opencode | Live route | `dispatch via live listener` | `Requeued ... no assistant output` | `Dropped retained parent wake` | Rendered live? |
|-----|----------|-----------|------------------------------|------------------------------------|--------------------------------|----------------|
| 1 | 1.18.10 | on (default) | 2 | 1 | 1 | NO — restart required |
| 2 | 1.18.15 | on (default) | 2 | 1 | 1 | NO — restart required |
| 3 | 1.18.15 | off (user config) | 0 | 0 | 0 | YES |
| 4 | 1.18.15 | off (code default) | 0 | 1 | 0 | YES |

Run 2 reproduced run 1 line for line on a newer opencode, which ruled out an
opencode version regression. Run 3 disabled the route through
`experimental.disable_live_parent_wake_routing` in `~/.omo/omo.jsonc` and
rendering worked — a single-variable bisect that identified the live route.
Run 4 removed that config workaround entirely and relied only on the new code
default; rendering worked, confirming the fix carries the behavior on its own.

Render outcome was reported by the user in each run. It is not observable from
the log, and treating clean logs as proof of rendering produced two incorrect
"pass" verdicts earlier in this investigation.

Run 4 environment: runtime `rt:4067`, plugin loaded 11:47:22Z from a bundle
built at 13:45 local, `~/.omo/omo.jsonc` containing no
`live_parent_wake_routing` key, and `dist/index.js` containing the new
`enable_live_parent_wake_routing` marker.

Tokens round-tripped exactly in every run, including the two failing ones —
delivery to the model was never broken, only the render.

## Root cause

Since opencode 1.18.x every event carries location metadata, and the instance
SSE stream filters on it:

```
packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:34-41
  event.location?.directory === instance.directory &&
  (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID)
```

The attached TUI subscribes to that filtered `/event` stream
(`packages/tui/src/context/event.ts:9-29`). The live route builds a second SDK
client from `serverUrl` alone (`live-server-route.ts:239-249`), so a prompt
dispatched through it publishes into a different instance context: the message
persists, but the render event is filtered away.

`promptAsync` forks the work and returns `204 No Content` immediately
(`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:311-329`),
so the dispatch still reported success. The wake bookkeeping then observed
"no assistant output", retried after ~5s, and finally dropped the retained
wake. Those retry and drop lines were symptoms; they were mistaken for the root
cause twice before the bisect settled it.

The `GET /session/{id}` affinity probe only proves the listener owns the
SESSION, never that it owns the TUI's event stream, so the route cannot be made
render-safe by adding more probes.

## Why this is enough

The bisect is single-variable and reversed the symptom in both directions on
the same opencode build, same plugin bundle, and same probe. Run 4 additionally
removed the config workaround, so the observed behavior is attributable to the
code change alone.

The regression test was mutation-tested: reverting the one-line default made it
fail, restoring it made it pass, so it genuinely detects this bug rather than
passing vacuously.

Test results: 130 pass / 0 fail across the live-route suites, 1272 pass / 0 fail
across background-agent + utils, 12778 pass / 4 fail on the full suite. Those 4
failures are `skills-loader-core` `ulw-plan` deduplication cases that fail
identically on clean `dev`; this branch never touched that package. `typecheck`
reports 0 errors.

## Residual risk

The live route still exists behind `experimental.enable_live_parent_wake_routing`
and remains render-unsafe when enabled. It was built for serve-topology
runner-split protection (#5569 / #6022); anyone relying on that case will opt in
and inherit the render stall. A render-affinity handshake would be needed to
make the route safe, and no such primitive exists upstream today.

The `no assistant output` requeue fired once in run 4 without harming delivery.
`promptAsync` legitimately returns before durable acceptance, so that retry path
retains value independent of this bug, but its interaction with the admit-only
deposit is worth revisiting.

The SDK pin was deliberately kept out of this change so the fix stayed
single-variable, then bumped separately in `fd775e03d` (merged as
`9e8a819ce`): `@opencode-ai/sdk` and `@opencode-ai/plugin` 1.15.13 -> 1.18.15,
matching the running opencode release. Typecheck reported 0 errors and the
suite held at 12778 pass / 4 fail. A fifth probe run on the bumped SDK
(`WAKE5_*`, runtime `rt:19483`) rendered correctly, confirming the fix and the
bump work together.

Also unfixed and previously recorded: `background_output` returns
`Task not found` for completed tasks, requiring the `session_read` fallback.

## What was omitted

No secrets, tokens, auth headers, or environment dumps are reproduced here. Log
excerpts were limited to background-agent and live-server-route lines for the
probe sessions.
