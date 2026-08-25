# Resume adopt-fallback: self-adoption guard + mid-turn dispatch

Covers two changes to `BackgroundManager.resume()`:

1. `3014085e3` - refuse to adopt the requesting session as its own subagent.
2. `67339856a` - pass `checkToolState: false` on the adopt path so an orphan killed
   mid-turn still receives its continuation prompt.

## What was tested

**Surface driven:** the real `opencode serve` HTTP API against an isolated XDG sandbox
and a local fake OpenAI server. No real model call, no writes to the host opencode DB.

**Scenario (`resume-adopt-midturn-probe.sh`):** a parent spawns a background child that
issues a long-running `bash` tool call. While that call is still `running`, the server is
`SIGKILL`ed, so the child's assistant turn is never finalized. A second server is started,
and a fresh session resumes the orphan by `task_id`.

**Behavior it is meant to prove:** with the fix, `manager.resume()` adopts the orphan and
the prompt gate dispatches the continuation. Without the fix, the gate's tool-state check
sees the unterminated turn and skips the dispatch.

## Why the earlier probe did not count

The pre-existing `resume-adopt-restart-probe.sh` drives the resume tool with
`run_in_background: false`. That routes to `executeSyncContinuation` ->
`adoptRunningSession` (`sync-continuation.ts:202`) and never calls `manager.resume()`.
Its oracle was also a message-count delta, which unrelated paths such as
`model-suggestion-retry` can move on their own. Both flaws together let it report PASS
against a build with the fix reverted.

This probe fixes both:

- The mock issues `run_in_background: true`, reaching
  `executeBackgroundContinuation` -> `manager.resume()` (`background-continuation.ts:30`).
- The oracle asserts on a signal unique to that path: a prompt-async-gate line whose
  `source` is `background-agent-resume` for the specific child session id, read from a
  plugin log redirected into the sandbox via `TMPDIR`. It also asserts
  `resume_path_reached > 0` in both polarities and hard-fails if the path never ran, so a
  routing regression surfaces as PROBE INVALID rather than a colour.

Note `midpre == midpost` in both runs: the old row-count oracle would have called the
passing run a failure. The counts are retained as context only, never as the verdict.

## What was observed

| Build | `resume_path_reached` | `resume_dispatched` | `resume_skipped_tool_state` | Verdict | `--self-test` exit |
|---|---|---|---|---|---|
| Fixed (`67339856a`) | 3 | 1 | 0 | PASS | 0 |
| Fix reverted | 1 | 0 | 1 | FAIL | 1 |

`unterminated_assistant_turns=1` in both runs confirms the precondition actually held: the
transcript really did end in an unterminated assistant turn. The probe hard-fails if that
precondition is absent, so a green run cannot come from a scenario that was never created.

Isolation: host session count identical before and after every run (the probe exits
nonzero on any change).

## Why this is enough

The probe was observed RED without the fix and GREEN with it, on the same commit, same
harness, differing only in the one-line change. The oracle keys on the code path under
test rather than on a side effect, so it cannot pass for an unrelated reason. The
`--expect-blocked` mode pins the old behavior explicitly, which turns a future silent
regression into a failing run.

Supporting unit coverage: `manager.resume-adopt.test.ts` 13/13. Full differential against
untouched `dev`: 1409 pass / 4 fail versus baseline 1408 pass / same 4 pre-existing
failures. `bun run typecheck` exit 0.

## What was omitted

Raw serve logs and the full plugin log are not copied here: they are large and contain
sandbox absolute paths and environment detail. The extracted per-session oracle lines are
included instead. No credentials appear in these artifacts; the fake provider uses the
literal string `fake-key`.

The `REFUSAL` and `ABSENT` control scenarios in the older restart probe still report
`NOT-REACHED`; they are unrelated to these two changes and remain unproven.
