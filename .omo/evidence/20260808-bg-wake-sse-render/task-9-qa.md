# Task 9 - real-harness QA: background-agent parent-wake no-output retry

Branch `fix/bg-wake-sse-render` @ `00bf3c45c`, worktree
`/Users/tim/git/oh-my-openagent/.worktrees/bg-wake-sse-render`.
opencode 1.18.10, macOS, bun. Skill used: `.agents/skills/opencode-qa`
(Case B: hook / action / event on the live server).

## Verdict

**FIXED, with one honest limitation.** Against a live isolated opencode
instance running the fix source, a real background-task completion whose parent
wake produced no assistant output inside the 5s recovery window resulted in a
**second real dispatch** that **reached the model** and **emitted on the SSE
wire**. No semantic coalesce swallowed the retry.

Limitation, stated plainly: I could not build a black-box negative control that
reproduces the original loss end to end. The pre-fix build passed the same
harness because the harness did not reproduce the bug's precondition. The
fix-side evidence below is real and positive; the discriminating negative
control is **not** proven at the harness level. It is proven at the unit level
by the RED test `e2cb98f72`. Details in "Negative control" below.

## POST-QA CORRECTION (independent audit)

An independent auditor re-ran this QA and found that the causal mechanism
claimed in "Part A" below is wrong. The original claim: the retry fired
because the variant harness's fake LLM stalls 9s, exceeding the 5s
`PARENT_WAKE_FAILURE_REQUEUE_WINDOW_MS`.

The run's own `task-9-artifacts/fake-llm.log` contradicts that claim:

```
dispatch 1                       15:36:34.748
requeue                          15:36:39.778   (+5.03s)
fake LLM branch=wake logged at   15:36:40.764   (~1s AFTER the requeue)
```

The 9s stall had not even started when the retry fired. The 5s requeue
window elapsed before the fake LLM answered at all, because the wake HTTP
request took roughly 6s of latency just to reach the fake LLM. The actual
trigger was request latency, not the configured stall.

What this does and does not mean:
- The second real dispatch **did** happen. That observation stands:
  consistent timestamps, `coalesced=0`.
- The stated causal mechanism (9s stall exceeding the 5s window) was wrong.
  The harness is **timing-dependent and non-deterministic**, not a
  controlled stall.
- The auditor independently re-ran the same harness 3 times:
  `dispatching=1 coalesced=0 requeued=0` every time. Part A did **not**
  reproduce, 0 of 3, on re-run. The fake LLM answered within ~15ms in those
  runs, so the wake succeeded on the first try and there was legitimately
  nothing to retry. That exercises the no-retry-needed path, which is
  correct behavior, not a failure of the fix.
- Part B (SSE `message.updated`, exit 0, `wake_frames_on_wire=3`)
  reproduced 3 of 3.

Honest characterization: Part A's harness is timing-dependent, reproduced 1
of 4 known runs. The deterministic proof of the retry path is the unit
test `e2cb98f72`, which the auditor independently re-verified fails RED on
pre-fix source (`Expected length: 2, Received length: 1`) and passes at
HEAD.

## What was tested

The bug: when a parent wake dispatch produced no assistant output within
`PARENT_WAKE_FAILURE_REQUEUE_WINDOW_MS` (5000ms,
`packages/omo-opencode/src/features/background-agent/manager.ts:232`), the wake
was requeued and re-flushed. The re-flushed prompt was byte-identical, so its
SHA-256 semantic dedupe key collided with the 15s hold created by its own first
send. The gate returned `{status:"queued"}` for a discarded prompt, the caller
counted it as accepted, and the wake was lost.

Two claims had to be proven separately:

- **Part A** - the wake reaches the model: a second real dispatch happens, with
  no intervening semantic coalesce for that wake.
- **Part B** - the user could see it: the resulting turn emits on the SSE
  event stream.

## Fix was loaded - how that was verified

The instance driven was **not** a stale build. Three independent checks:

1. The sandbox `opencode.jsonc` loads the plugin **from worktree source**, not
   from `dist/`:
   `"plugin": ["file:///Users/tim/git/oh-my-openagent/.worktrees/bg-wake-sse-render/packages/omo-opencode/src/index.ts"]`
   The repo root is derived from the script location, so running the worktree's
   own copy of the skill script pins the plugin to the worktree tree.
2. The fix source is present in that tree:
   `grep -c noAssistantOutputRetryCount packages/omo-opencode/src/features/background-agent/parent-wake-prompt-dispatch.ts`
   returns non-zero, and `parent-wake-history-state.ts` exports
   `createNoAssistantOutputRetryDedupeKey` (commit `e3bdfcf25`).
3. The live run emitted a log line that only the fixed code path can produce:
   `[background-agent] Requeued dispatched parent wake after no assistant output` followed by a
   **second** `promptAsync dispatching` for the same session, with
   `coalesced=0`. On the pre-fix path that second dispatch does not occur.

Plugin init was confirmed once per run (`plugin-init-count.txt` = 1 in the
`serve-wake-split-probe` run).

## Part A - the wake reaches the model

### Commands

Instrument self-test first (bundled probe, run from the worktree):

```
cd /Users/tim/git/oh-my-openagent/.worktrees/bg-wake-sse-render
bash .agents/skills/opencode-qa/scripts/serve-wake-split-probe.sh --self-test
# -> SELF-TEST OK   (exit 0)
```

Bundled probe, happy path, live isolated server:

```
bash .agents/skills/opencode-qa/scripts/serve-wake-split-probe.sh \
  --expect fixed --evidence-dir /tmp/bgwake-qa/probe-fixed
# -> RESULT=FIXED parent_assistant_messages=3 parent_tool_call_turns=2
#    terminal_stops=1 child_task_sessions=1 plugin_inits=1
#    WAKE_DISPATCHED_DURING_PARENT_TURN=true route_live_dispatch=true
#    exit 0
```

That probe proves the wake dispatches and routes through the live listener, but
its fake wake answers in 3s, inside the 5s window, so it never exercises the
no-output retry. To drive the retry, a variant harness was used
(`.omo/qa-tmp/noout/`, gitignored, no production source modified): a **copy** of
the bundled fake-LLM whose FIRST wake response stalls 9s (past the 5s recovery
window) and whose retry wake answers fast:

**POST-QA CORRECTION:** this "stalls 9s, past the 5s window" framing is
wrong. See "POST-QA CORRECTION (independent audit)" above. The retry
actually fired from roughly 6s of request latency before the fake LLM ever
answered, not from the configured 9s stall completing.

```
bash .omo/qa-tmp/noout/run-noout-retry.sh /tmp/bgwake-qa/noout2
# -> dispatching=2 dispatched=2 coalesced=0 requeued=1 live_dispatch=2
#    sse_exit=0 wake_frames_on_wire=3 real_db_before=1542 real_db_after=1542
#    VERDICT=PASS   (exit 0)
```

### Grep evidence (line numbers from the session-scoped log slice)

Source log: `$TMPDIR/oh-my-opencode.log`
(`/var/folders/c6/rmmgm5s52vsc2_g434mnp_nm0000gn/T/oh-my-opencode.log`, ~25 MB).
Read scoped: byte offset captured before the run, then `tail -c +OFFSET | grep -F <session-id>`.
Session `ses_01dfb55b4ffeh3Ioh4gpp4w9y9`.

```
14: [prompt-async-gate] promptAsync dispatching   {"source":"background-agent-parent-wake"}   <- DISPATCH 1
15: [live-server-route] dispatch via live listener {"source":"background-agent-parent-wake"}
17: [prompt-async-gate] remembered semantic prompt dispatch {"holdMs":15000}                  <- the 15s hold
18: [prompt-async-gate] promptAsync dispatched    {"source":"background-agent-parent-wake"}
26: [background-agent] Requeued dispatched parent wake after no assistant output: {"retryCount":1}
27: [prompt-async-gate] expired reservation released {"source":"background-agent-parent-wake"}
28: [prompt-async-gate] promptAsync dispatching   {"source":"background-agent-parent-wake"}   <- DISPATCH 2
29: [live-server-route] dispatch via live listener {"source":"background-agent-parent-wake"}
31: [prompt-async-gate] remembered semantic prompt dispatch {"holdMs":15000}
32: [prompt-async-gate] promptAsync dispatched    {"source":"background-agent-parent-wake"}
```

Timestamps: dispatch 1 at `15:36:34.748`, requeue at `15:36:39.778` (5.03s later,
matching the 5s window), dispatch 2 at `15:36:40.739` - inside the 15s semantic
hold opened by dispatch 1 at `15:36:34.754`. Pre-fix, that is exactly where the
collision discarded the retry.

**POST-QA CORRECTION:** the fake LLM's `branch=wake` log line for dispatch 1
lands at `15:36:40.764`, about 1s AFTER the `15:36:39.778` requeue. The 9s
stall had not begun when the requeue fired; the window elapsed on request
latency, not on the stall. See "POST-QA CORRECTION (independent audit)"
above.

Counts over the same slice:

```
dispatching=2  dispatched=2  coalesced=0  requeued=1  live_dispatch=2
```

`coalesced=0` is the key assertion: zero
`[prompt-async-gate] prompt coalesced with recent semantic dispatch` lines for
this session, so the second dispatch is a real send, not a queued-but-discarded
one. Reproduced across two independent runs (`noout`, `noout2`).

Proof the second dispatch actually reached the model: the fake LLM logged
`branch=wake` and the sandbox db contains the assistant text it returned
(`WAKE_ACK`), written into the parent session.

## Part B - the event hits the wire

### Command and exit code

```
bash .agents/skills/opencode-qa/scripts/sse-hook-probe.sh \
  --attach http://127.0.0.1:57300 \
  --password '<redacted>' --user opencode \
  --directory /var/folders/.../oqa-xdg.XXXXXX.12nUSCtGwf/proj \
  --event message.updated --timeout 300
```

Output (`sse-probe.txt`):

```
watching http://127.0.0.1:57300/event?directory=<sandbox>/proj for 'message.updated' (<=300s)
first matching event: {"type":"message.updated"}
PASS: observed 'message.updated' on http://127.0.0.1:57300
```

**exit code 0.**

### Correlation - the WAKE turn specifically emitted

`sse-hook-probe.sh` exits on the first matching event, which alone does not
prove the *wake* turn emitted. A raw SSE capture ran alongside it. The assistant
message carrying the fake LLM's `WAKE_ACK` text was resolved from the sandbox db
and matched against the raw stream:

```
wake_message_id=msg_fe204ea2a001d6X5hN9AAOMQXb  wake_frames_on_wire=3
```

Three `message.updated` frames on the wire carry the wake turn's message id.
The wake the user was missing is observable on the event stream.

**Upstream is not implicated.** The symptom was the plugin losing the wake, not
opencode failing to render an emitted event. The server emitted; no opencode
core defect was found; no opencode core file was touched.

## Negative control - honest limitation

To confirm the harness can actually detect the bug, a scratch worktree was
created at the pre-fix parent commit `e2cb98f72` (verified: the fix symbols are
absent there) and the identical harness was run.

Attempt 1 was invalid: I symlinked `node_modules` from the fix worktree, so
`@oh-my-opencode/utils` resolved back into the FIXED tree. Caught and discarded.
After a real `bun install` in the control worktree, `@oh-my-opencode/utils`
correctly resolves to the control tree.

Attempt 2 (correctly isolated) still **passed** on the pre-fix build. Root cause
of the non-repro, found by diffing the two wake prompts out of the sandbox db:

```
wake prompt 0: len 518, contains OMO_INTERNAL_NOREPLY
wake prompt 1: len 488, no marker
identical_pair: False
```

The two wake prompts were **not byte-identical**, so their semantic keys never
collided and the bug's precondition was never met. The first dispatch took the
`forceNoReply: true` admit-only branch in
`parent-wake-flush-runner.ts` (parent still active / recently active), which
appends `<!-- OMO_INTERNAL_NOREPLY -->`; the retry took the reply branch.

Attempt 3 tuned the harness (parent hold extended, then child completion delayed
25s so the parent settles first). That made both builds report
`dispatching=1 requeued=0`: the wake succeeded on its first send, so no retry
was needed. Different scenario, still not a repro.

Conclusion: producing two byte-identical wake prompts requires both dispatches
to take the same idle branch while the wake still yields no assistant output
inside 5s. I did not find a black-box timing arrangement that pins that state
within this task's budget. That precondition **is** pinned deterministically by
the unit test `e2cb98f72`
(`parent-wake-noout-retry-dedupe.test.ts`), which fails pre-fix and passes
post-fix.

So: the fix-side evidence is real and positive; the harness-level negative
control is unproven and is **not** claimed as passing.

## Resources spawned and teardown receipts

Per run: 1 `opencode serve` process, 1 local fake-OpenAI node server, 1
`sse-hook-probe.sh` curl, 1 raw-capture curl, 1 mktemp XDG sandbox. All torn
down by the script's `trap teardown EXIT` plus `oqa_cleanup`.

Post-QA sweep:

```
pgrep -fl "opencode serve"            -> (empty)
pgrep -fl "fake-openai-server.mjs"    -> (empty)
pgrep -fl "run-noout-retry"           -> (empty)
pgrep -fl "curl.*event?directory"     -> (empty)
tmux ls -> main, read-file  (both created Aug 7, pre-existing, NOT created by this QA)
```

No leftover process, no bound port, no tmux session created by this QA.
Scratch worktree `/Users/tim/git/oh-my-openagent/.worktrees/bg-wake-prefix-control`
is removed in cleanup; the variant harness lives under the gitignored
`.omo/qa-tmp/`.

## Post-QA defect found and fixed (independent audit)

After this QA ran, an independent Oracle audit found a second defect in the
coalesce-requeue safety net added by this branch (`5113f9124`): the net
could never actually fire.

At QA time:
- `MAX_COALESCE_REQUEUE_ATTEMPTS = 3`, `COALESCE_REQUEUE_FLUSH_DELAY_MS = 2000ms`
- total requeue budget = `3 x 2000ms = 6000ms`
- versus a `15000ms` semantic dedupe hold (`DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS`)
  that is never refreshed on a coalesce

The budget always exhausted inside the hold, so execution fell through and
the wake was recorded as dispatched anyway. That is the very bug this
branch was written to fix, just inside the secondary net instead of the
primary path.

Fixed in commit `001432e7a`: `COALESCE_REQUEUE_FLUSH_DELAY_MS` is now
derived from the hold constants instead of hardcoded:

```
COALESCE_REQUEUE_FLUSH_DELAY_MS =
  Math.ceil((DEFAULT_PROMPT_SEMANTIC_DEDUPE_HOLD_MS + DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS) / MAX_COALESCE_REQUEUE_ATTEMPTS)
  = ceil((15000 + 2000) / 3)
  = 5667ms

new total budget = 3 x 5667ms = 17001ms >= 15000ms
```

An invariant test now fails loudly if a future edit to `timing.ts` or
either constant breaks that relationship. A second new test proves the net
now actually catches a wake: the hold expires and a real second
`promptAsync` call happens before the requeue cap is reached.

Final suite after this fix: 870 pass / 0 fail across 77 files. Branch head
is now `001432e7a`.

Consequence: the secondary net is now genuinely functional. The unit and
real-harness QA recorded above in this file were performed against a build
where the secondary net was inert (it could never fire). The **primary**
fix (`e3bdfcf25`, the distinct retry-scoped dedupe key) was and remains the
mechanism that resolves the reported bug; the QA evidence for the primary
fix, above, is unaffected by this.

## Isolation

Real db session count `1542 -> 1542`, and every QA session id returns 0 rows in
the real db. Full receipt with the mtime disclosure: `isolation-receipt.txt`.

## Files

- `task-9-qa.md` - this narrative
- `sse-probe.txt` - raw Part B probe output
- `isolation-receipt.txt` - before/after counts and leak check
- `task-9-artifacts/part-a-grep.txt` - line-numbered Part A grep hits
- `task-9-artifacts/part-b-correlation.txt` - wake message id to wire correlation
- `task-9-artifacts/summary.txt` - run-of-record counters
- `task-9-artifacts/fake-llm.log` - fake provider branch log
- `task-9-artifacts/serve-wake-split-probe-verdict.txt` - bundled probe verdict. POST-QA CORRECTION (independent audit): this probe reports `wake:0` branch hits despite `WAKE_DISPATCHED_DURING_PARENT_TURN=true`; its wake never actually reached the fake LLM. Harmless, since it is not the Part A evidence, but do not read it as wake-delivery proof.
- `task-9-artifacts/control-prefix-summary.txt` - pre-fix control counters. Note: `VERDICT=FAIL, dispatching=1` here reflects the disclosed negative-control non-repro described above (the harness did not reproduce the bug's precondition), not a failure of the fix. Do not read `VERDICT=FAIL` as the fix failing.

Secrets: server passwords were per-run random values and are redacted above. No
provider credential was used - the model was a local fake server.

## What was omitted

- No full log dump. The omo log is ~25 MB; only offset-scoped, session-filtered
  greps were read and recorded.
- No production source was modified. The variant fake-LLM is a copy under the
  gitignored `.omo/qa-tmp/`.
- No opencode core patch. Upstream was not implicated.
