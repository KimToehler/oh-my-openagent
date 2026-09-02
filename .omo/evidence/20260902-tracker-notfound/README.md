# QA evidence: unpolled-shell-job clears a reaped detached job

Change: `packages/omo-opencode/src/hooks/unpolled-shell-job/` on branch `fix/tracker-notfound`.

A `background_action="status"` poll that replies the job id is gone now deregisters the job,
so the `<unpolled-background-shell-jobs>` warning stops re-firing on work already finished.

## What was tested

Two live runs of `.agents/skills/opencode-qa/scripts/unpolled-shell-job-probe.sh` against a
REAL opencode 1.18.20 server (`opencode serve`) with the branch's built `dist/` loaded as the
plugin, a LOCAL mock model (no network egress, no API key), and a LOCAL stdio MCP exposing a
tool named `ctx_shell` that returns fixture output.

Each run drives one real session:

1. call the `ctx_shell`-named tool with `run_in_background: true` -> registers `shell_a1b2c3d4e5f6`
2. session goes idle -> the warning must fire naming that id
3. poll the SAME id with `background_action: "status"`, fixture reply
   `[background:shell_a1b2c3d4e5f6 not found or expired]`
4. wait past `NUDGE_COOLDOWN_MS` (65s), register a SECOND job `shell_b1c2d3e4f5a6`
5. session goes idle -> a second warning must fire naming ONLY the second id

Step 4 is what makes the result meaningful. A silent second idle would be ambiguous between
"job cleared" and "cooldown suppressed the warning". Forcing a second warning to fire proves
the hook is still live, so the first id's absence is deregistration and not silence.

| run | mode | artifacts |
|---|---|---|
| fixed | default | `live-probe/` |
| broken | `--negative-control` | `negative-control/` |

The negative control removes the `isNotFoundReply(...)` call site from the tracker, rebuilds
`dist/`, runs the identical probe, and restores source and bundle on exit.

## What was observed

Both runs, verdict lines:

```
live-probe:        UNPOLLED SHELL JOB PROBE PASS       (exit 0)
negative-control:  FAIL: second warning retained first reaped job
                   NEGATIVE CONTROL PASS: probe failed against broken tracker
```

Parsing the raw `events.sse` of each run independently of the script's own assertions:

```
== live-probe: 2 warning block(s)
   block1: first(reaped)=True   second=False
   block2: first(reaped)=False  second=True

== negative-control: 2 warning block(s)
   block1: first(reaped)=True   second=False
   block2: first(reaped)=True   second=True
```

The two runs are identical except for one cell: whether block 2 still names the reaped id.
That isolates the observed difference to the fix rather than to timing, cooldown, or setup.

Isolation: asserted by session IDENTITY, not by a row count, since the operator may be using
opencode concurrently. Each run checks its own session id is absent from the real DB
(`PASS: session identity absent from real DB`). Everything else runs under `oqa_mk_isolated_xdg`
with redirected `HOME`, `XDG_*`, and cwd.

## Why it is enough

The behavior is observed end to end on a real harness: a real server, the real hook, the real
tracker in the built bundle, and a real SSE stream. The negative control was observed RED on
the precise assertion under test and only that assertion, so a PASS cannot come from the probe
asserting nothing.

Supporting layers: `tracker.test.ts` covers both real reply wordings plus two fail-open guards
(a foreign not-found line and a `module not found` compile error, each alongside
`status: running`); mutation runs confirm the tests bite (remove the matcher, 3 red; drop the
id anchor, 1 red; drop the bracket anchor, 3 red). The full repo suite is unchanged against
`dev` at 14 unique pre-existing failures.

## What was omitted

- No live proof that the em-dash wording `not found — already finished or cancelled` clears
  through the probe. The MCP fixture returns the `or expired` wording only. The em-dash variant
  is covered by unit fixtures and was observed on a real harness, recorded in
  `incidental-live-reproduction.md`.
- `mock-requests.log` (~750 KB of full request bodies per run) and `serve.log` are NOT
  committed: the repo `.gitignore:33` excludes `*.log`. They were produced and reviewed, and
  they contain prompts and fixture text only, no credentials, since the mock takes
  `apiKey: "not-needed"` and no real provider is contacted. The committed `events.sse` for
  each run is the load-bearing artifact and carries every assertion above; the block-by-block
  parse in "What was observed" is reproducible from it alone.
- No secrets, tokens, or environment dumps are recorded. The sandbox server password is
  generated per run and dies with the sandbox.

## Two probe defects found and fixed while producing this evidence

Recorded because a green run from either version would have been worthless:

1. **Unbounded `curl` on session creation** hung the first attempt for 8 minutes with no output.
   Session creation blocks on MCP init, and the bare command substitution had no deadline to
   escape through. Now `-m 60`, with progress markers so a future stall is locatable.
2. **The negative control passed against broken code.** Its revert located a comment block by
   exact opening text that no longer matched, python raised, the heredoc died, and because the
   script runs under `set -uo pipefail` without `-e` the run continued against still-fixed code
   and reported green. The revert now targets the call site, verifies the edit applied, and
   asserts the rebuilt bundle differs byte-wise from the fixed one.

A third, smaller defect: `--evidence-dir` was used relative while the script `cd`s into the
sandbox, so artifacts were written inside the sandbox and deleted with it. It is now resolved
to an absolute path up front.
