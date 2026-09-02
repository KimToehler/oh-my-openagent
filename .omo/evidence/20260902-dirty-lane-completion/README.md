# PASS: live dirty-lane completion annotation

## Scope

Evidence-only QA in `/Users/tim/git/oh-my-openagent/.worktrees/bg-lane-fixes`. No product source changed. No commit.

## Repro

```bash
./.omo/evidence/20260902-dirty-lane-completion/run-live-probe.sh
```

Script sources `script/agent/qa-sandbox.sh`, runs from `$OMO_QA_PROJ`, starts fresh fake OpenAI and real `opencode serve` processes for each scenario, validates fake `/health` and authenticated OpenCode `/global/health`, captures raw SSE, and records every process terminal output.

## FIXED scenario

- `FIXED-04-status-before.txt`: baseline dirty path existed before child launch.
- `FIXED-10-child-session.txt`: server-minted child session ID.
- `FIXED-11-status-completion.txt`: baseline and post-launch marker both dirty when child released.
- `FIXED-14-exact-count.txt`: exact parent completion notification contains `completed with 1 uncommitted file`.
- Script rejects `completed with 2 uncommitted files`.

## NEGATIVE scenario

- `NEGATIVE-04-status-before.txt`: baseline dirty path existed before child launch.
- `NEGATIVE-10-child-session.txt`: server-minted child session ID.
- `NEGATIVE-11-status-completion.txt`: same baseline path remains dirty; no post-launch file created.
- `NEGATIVE-13-completion.txt`: real parent completion notification. Script asserts no `uncommitted file` text.

## Isolation and cleanup

- `01-host-session-count-before.txt` equals `19-host-session-count-after.txt`.
- `FIXED-91-process-cleanup.txt` and `NEGATIVE-91-process-cleanup.txt` record fake model, OpenCode server, and SSE collector cleanup.
- Raw event capture: `FIXED-06-sse.txt`, `NEGATIVE-06-sse.txt`.

## Terminal result

```text
PASS: FIXED exact 1-file annotation; NEGATIVE omitted annotation; host DB unchanged; processes cleaned.
```
