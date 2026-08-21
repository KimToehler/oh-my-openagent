# QA evidence: task status stops promising a notification it may not deliver

Finding: `docs/troubleshooting/harness-findings.md` - "2026-08-17 - Dead task reports
`running`; resume requires cancel first", reporting half. The resume half was fixed in
`8728fa5f1`; this is the reporting half that fix deliberately did not touch.

Branch: `fix/status-honesty` (off `dev`, independent of the resume fix - different file).

## What was tested

`formatTaskStatus()` in `packages/omo-opencode/src/tools/background-task/task-status-format.ts`,
the renderer behind `background_output`, driven directly on three task shapes:

| # | Scenario | Expected after fix |
|---|---|---|
| A | running, last activity 30s ago | unchanged reassurance |
| B | running, last activity 47m ago | disclose the silence |
| C | running, absent from the session registry for 3 polls | disclose the missed polls |

Driver: `07-qa-drive-script.ts`.

## What was observed

`05-qa-drive-dev.txt` (before) vs `06-qa-drive-patched.txt` (after). On `dev` all three
render the identical note:

```
> **Note**: No need to wait explicitly - the system will notify you when this task completes.
```

That is the actual defect. For B and C the child is already gone, so the harness tells the
reading agent to keep waiting for a notification that will not arrive until the poller's
45-minute `staleTimeoutMs` fires. Patched output:

| Case | patched note |
|---|---|
| A | unchanged - `No need to wait explicitly ...` |
| B | `No session activity for 47m. The task is still marked running, but nothing has been observed from the child; verify progress on disk ...` |
| C | `This session was not present in the session registry for the last 3 polls, so the child may already have exited. Verify progress on disk ...` |

Note the `Duration` field was never frozen: it renders `1h 2m 0s` on both sides, because
`formatDuration` falls back to `new Date()` when `completedAt` is unset
(`time-format.ts:2`). The reported "frozen duration counter" is therefore NOT reproduced
here and is not what this change fixes - see the findings-log update for that correction.

### Unit tests

`01-red-baseline.txt` -> `02-green-after-fix.txt`: **3 pass / 3 fail -> 6 pass / 0 fail**.
The suite pins both directions: the reassurance must survive for a healthy task (A), and
must be replaced for a silent one (B, C). Two further tests guard against over-firing - a
`completed` task with an old `lastUpdate` gets no warning, and a blocked task keeps its
blocked notice rather than the silence warning.

### Scoped suite and typecheck

`03-scoped-suite-patched.txt`: 71 pass / 0 fail across `tools/background-task/`.
`04-typecheck-patched.txt`: exit 0, 0 errors.

## Why this is enough

The change adds one branch to one renderer, and the QA exercises every arm of that branch
on the real function plus the two shapes that must NOT trigger it. The threshold reuses
`DEFAULT_STALE_TIMEOUT_MS` and `MIN_SESSION_GONE_POLLS` rather than inventing new numbers,
so the disclosure appears exactly when the poller itself would consider the task stale -
the status line and the lifecycle now agree instead of contradicting each other.

## What was omitted

- No live `opencode serve` run: reproducing a genuinely dead child on demand is not
  deterministic, and this change is confined to a pure formatting function whose inputs
  are fully determined by the task record.
- No secrets or environment dumps; the driver constructs task objects in-process.
