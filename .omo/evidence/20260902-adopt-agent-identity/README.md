# QA evidence: adopted background sessions carry their real agent

Change: `resume()` no longer invents an agent named `continue` when adopting an orphaned
server session. It recovers the agent (and model) the session actually ran under from the
server transcript, and refuses the adoption when nothing is recoverable.

Defect background: `docs/troubleshooting/harness-findings.md`, entry dated 2026-08-27,
reproduced 5x in the field and revised to severity `blocker`.

## WHAT WAS TESTED

Real `opencode serve` (isolated XDG sandbox, local fake OpenAI provider, no real API
call), driven by `.agents/skills/opencode-qa/scripts/resume-adopt-midturn-probe.sh`.

The probe spawns a background child as `subagent_type: "explore"`, lets it enter a
running `bash` tool call, then `SIGKILL`s the server mid-turn so the transcript ends in
an unterminated assistant turn and the in-memory task map is lost. A second server is
started and the orphan is resumed with `run_in_background=true`, which routes through
`executeBackgroundContinuation -> manager.resume()` - the path under test.

The behavior it is meant to prove: the adopted task dispatches its continuation under the
agent the child actually ran under (`explore`), never the fabricated `continue`.

Three runs:

| Run | Build | Mode | Artifacts |
|-----|-------|------|-----------|
| Fixed | with fix | default | `live-fixed/` |
| Negative control | fix reverted | `--expect-fabricated-agent` | `negative-control/` |
| Red proof | fix reverted | default (`--self-test`) | `red-proof/` |

## WHAT WAS OBSERVED

Fixed build (`live-fixed/14-oracle.txt`, `15-verdict.txt`):

```
resume_path_reached=3
resume_dispatched=1
resume_skipped_tool_state=0
adopted_agent=explore
fabricated_continue_agent_lines=0
agent_continue_not_found_errors=0
midpre=2 midpost=4 unterminated=1
VERDICT=PASS
```

Negative control, fix reverted (`negative-control/14-oracle.txt`):

```
adopted_agent=continue
fabricated_continue_agent_lines=1
midpre=2 midpost=2 unterminated=1
VERDICT=PASS   (mode: expect fabricated agent - the defect reproduced)
```

The decisive difference is two cells. `adopted_agent` is `explore` with the fix and
`continue` without it. `midpost` is 4 with the fix and 2 without it - unchanged from
`midpre`, meaning the adopted session gained no new messages at all, which is the
field symptom: a live-looking task id whose lane never runs.

Red proof (`red-proof/15-verdict.txt`): the same reverted build run in the probe's
NORMAL mode exits non-zero with

```
AGENT IDENTITY FAILURE: adopted agent was "continue", expected "explore"
VERDICT=FAIL
```

This is the part that makes the PASS meaningful: the assertion that reports PASS on the
fixed build was observed FAIL on the unfixed build. A probe never seen red is not
evidence.

Isolation: `01-host-session-count-before.txt` equals `16-host-session-count-after.txt` in
all three runs, so the host `opencode.db` was untouched. Everything ran under a throwaway
`HOME`/XDG sandbox with a local mock model.

Build provenance for the negative control: after reverting the source the bundle was
rebuilt and `cmp` confirmed `dist/index.js` differed from the fixed build, so the probe
genuinely exercised reverted code rather than a stale bundle. Afterwards the source was
restored and `cmp` confirmed `dist/index.js` was byte-identical to the fixed build again.

## UNIT AND MUTATION EVIDENCE

- Scoped: `background-agent/` + `delegate-task/` = 1447 pass, 0 fail.
- `bun run typecheck` exit 0. `bun run build` exit 0 (declaration emit, which is what
  catches `rootDir` violations from the new cross-directory imports).
- Full suite failure set is byte-identical to the `dev` baseline: 14 unique failures in
  both. See `full-suite-dev-baseline.txt` and `full-suite-branch.txt`; `diff` is empty.
- Four mutations were applied, each caught by its intended test:
  1. restore `agent: "continue"` in `resume()` -> adopt-metadata test red
  2. disable the unresolvable-agent refusal -> refusal test red
  3. remove the compaction skip in `resolveResumeContext` -> compaction test red
  4. restore `?? "continue"` in the sync yield path -> fallback test red

Mutation 3 and 4 initially SURVIVED, which proved the `sync-continuation.ts` changes had
no coverage. Two tests were added and both mutations then went red.

## WHY IT IS ENOUGH

The live probe drives the exact production path on a real server across a real restart,
and asserts on a signal unique to that path (the `agent` field of the
`background-agent-resume` dispatch for that specific child session), not on a coarse
message-count delta that unrelated paths can also move. Both polarities were observed,
so the assertion is known to discriminate.

The refusal branch is covered at unit level rather than live: inducing a real session
whose transcript carries no agent at all would require corrupting the server's own
message store, which would test the corruption rather than the guard.

## WHAT WAS OMITTED

`mock-requests.log` and `serve.log` are excluded by `.gitignore` (`*.log`) and are not
copied here. They contain only fake-provider traffic against a local mock - no
credentials - but the oracle and verdict files above carry every asserted value.

Raw full-suite logs are summarized to their deduplicated failure lists rather than copied
whole.
