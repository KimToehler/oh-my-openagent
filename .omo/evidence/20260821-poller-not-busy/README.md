# QA evidence: "session gone" was never gone - locking the probe that proves it

Finding: `docs/troubleshooting/harness-findings.md` - "2026-08-17 - Dead task reports
`running`". This is the poller half, and it **inverts** the fix I had queued.

Branch: `fix/poller-not-busy` (off `dev`).

## What I set out to do, and why it was wrong

I had concluded the poller had a defect: `checkSessionExistence` returning `exists` resets
`consecutiveMissedPolls`, so a dead-but-row-present task can never reach the 60s
`sessionGoneTimeoutMs` fast path and always waits out the slow inactivity ladder. The plan
was to delete or weaken that veto.

That rested on a premise I had asserted without checking: that idle sessions remain listed
in `session.status()`, so absence from the map means genuinely unregistered. **The premise
is false**, and deleting the veto would have been a real regression.

## What was tested

A real `opencode serve` (1.18.15) was driven in an XDG-isolated sandbox against a local
mock streaming provider, sampling `/session/status` across a known busy window.
Artifacts in `oracle-server-probe/` (`probe4.txt`, `probe6.txt` are the decisive two).

## What was observed

`probe4.txt` - status map across a 20s mock stream, 100ms transition sampling:

```
T+0s  TRANSITION -> {}
T+0s  TRANSITION -> {"ses_fd9881122ffe50qmnO8mQj61si":{"type":"busy"}}
T+20s TRANSITION -> {}
=== final: {}
```

The session row still resolved after the stream ended. `idle` never appears as a map value
at any point - it exists only as an SSE `session.status` event payload, even though the SDK
type permits it as a map value. **The map lists only `busy`/`retry`.**

So absence from the map means "not busy", not "dead". `MIN_SESSION_GONE_POLLS` (3) at
`POLLING_INTERVAL_MS` (3000) is 9 seconds of not-being-busy - the normal state of a healthy
task waiting on the todo gate, whose default grace is 10 minutes
(`DEFAULT_TODO_GATE_GRACE_MS = 600000`), a duration the config schema explicitly requires to
be shorter than the task TTL.

`probe6.txt` - `/session/status` is directory-scoped:

```
no-dir   : {"ses_fd98553b3ffemCqhQrB29344n7":{"type":"busy"}}
dir=proj : {"ses_fd98553b3ffemCqhQrB29344n7":{"type":"busy"}}
dir=other: {}
dir=/tmp : {}
```

## Why the veto is load-bearing (mutation-tested, not asserted)

`01-regression-test-passes.txt`: the new `not-busy-is-not-gone.test.ts` passes 3/0 on
current code. A characterization test that always passes proves nothing, so the veto was
deleted (design A) and the suite re-run:

`02-mutant-design-A-fails.txt`: **1 pass / 2 fail.** The mutant cancels an idle, live,
row-present task, including one held through a full 10-minute todo-gate grace. The test has
teeth, and the veto is doing real work.

## What changed

No behavior change. The code was correct; its naming and comments were what misled two
reviewers (an Oracle consultation and me) into proposing a regression:

- `sessionGone` -> `sessionNotBusy` (internal variable only). The public config key
  `sessionGoneTimeoutMs` is **deliberately left alone** - renaming it would break existing
  `.omo/omo.jsonc` files for a naming nit.
- The probe at `task-poller.ts` is marked LOAD-BEARING with the membership rule and the
  rate-limiting side effect of the counter reset spelled out.
- The "Session is idle or no longer in status response" comment in `manager.ts` is
  corrected - absence never proves the child finished.
- `task-poller.test.ts:717`'s `{"ses-1":{"type":"idle"}}` fixture is documented as a shape
  the server does not emit. Kept rather than deleted: presence-resets-the-counter is the
  branch it exercises, and that branch is real.

## Corrections to my earlier claims

- **"Stranded forever"** (original entry): wrong, already retracted.
- **"Dies at 45min via staleTimeoutMs"** (my retraction): also wrong. My probe called
  `checkAndInterruptStaleTasks` directly, bypassing `pruneStaleTasksAndNotifications`, which
  the real loop runs first (`manager.ts:3310` before `:3312`) and which kills on
  `TASK_TTL_MS` = **30min** with no existence check. The 45min ladder is only reachable for
  `teamRunId` tasks, which prune skips.
- **"The 60s fast path is unreachable, and that is a defect"**: unreachable for row-present
  tasks is *correct*. It is 404-only by design.

## Gates

`03-scoped-suite-patched.txt` 877 pass / 4 fail vs `04-scoped-suite-dev.txt` 874 / 4 -
failing set identical after normalizing the `[Nms]` suffix. Typecheck exit 0 / 0 errors,
build exit 0 with `sessionNotBusy` present in `dist/index.js`.

## Still open, deliberately not fixed here

`manager.ts:3300` calls `session.status()` with **no** `directory`, while
`checkSessionExistence` passes one (`session-existence.ts:45-48`) and children are created
with the *parent session's* directory (`spawner.ts:54-64`), which need not equal
`manager.directory`. Given probe6, that asymmetry could systematically hide sessions. It is
left untouched because changing it is behavior-affecting in the risky direction - adding a
`directory` filter could newly *hide* sessions and make `sessionNotBusy` fire more often -
and verifying it needs a real multi-directory server run. Logged as a separate finding.

## What was omitted

- The directory bug is reported, not fixed - see above.
- The sandbox used a mock provider; the membership rule is a server implementation detail
  that could change across versions, so the committed test asserts on *our handling*, never
  on the server's response shape.
- No credentials appear in the artifacts; the sandbox was XDG-isolated with its own
  `CODEX_HOME`/data dirs and never touched the real `~/.config/opencode`.
