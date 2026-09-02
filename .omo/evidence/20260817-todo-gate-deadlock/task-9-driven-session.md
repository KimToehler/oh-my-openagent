# Todo #9 - driven-session evidence for the bounded todo gate

Status: **PARTIAL. The BEFORE half is proven on a real production session. The AFTER half is
NOT proven on a driven session.** Read "WHAT WAS OMITTED" before relying on this.

Author: root orchestrator, after three subagent lanes failed to complete this todo.
Date: 2026-08-17.

---

## WHAT WAS TESTED

Todo #9 asks for two driven runs proving the deadlock and its fix:

- BEFORE, stock build: a background task that finishes its work but leaves a todo open sits
  `running` and is eventually reported as a TTL `error`.
- AFTER, patched build: the same task reaches `completed`, carries the unfinished-todos
  annotation, and is never pruned.

What actually happened:

1. Three lanes attempted the scripted BEFORE/AFTER runs. All three failed on harness
   mechanics, not on the fix. Those failures are documented in `harness-findings.md`.
2. Root took the work over, fixed the harness faults one by one, and got a real sandboxed
   `opencode run` to drive the plugin end to end.
3. While doing so, **the bug reproduced spontaneously in root's own live session**, on the
   stock (unpatched) plugin, and was captured. That is the BEFORE evidence, and it is
   stronger than the scripted repro would have been because it is an unscripted production
   occurrence rather than a contrived one.
4. The AFTER run was NOT completed. The scripted child never started successfully inside the
   sandbox, so no patched-build terminal state was ever observed.

### Commands and configuration

Runner: `/tmp/tg-run.sh <phase> <worktree>`, launched detached via
`nohup bash /tmp/tg-run.sh ... & disown` and polled with a bounded loop.

Isolated sandbox per run: `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`XDG_CACHE_HOME` all under a `mktemp -d`, plus `OPENCODE_DISABLE_AUTOUPDATE=1` and
`OPENCODE_DISABLE_MODELS_FETCH=1`.

omo config written to `$HOME/.omo/omo.jsonc`. The harness block key is literally
`[opencode]`, with square brackets:

```jsonc
{
  "[opencode]": {
    "disabled_hooks": ["todo-continuation-enforcer"],
    "background_task": { "taskTtlMs": 300000, "todoGateGraceMs": 60000 }
  }
}
```

opencode config written to `$XDG_CONFIG_HOME/opencode/opencode.json`, carrying the
`plugin` array pointing at the built bundle and a `mock` provider backed by
`.agents/skills/opencode-qa/scripts/lib/mock-model.mjs`.

Bundles under test, both prebuilt by root, both `bun run build` exit 0:

| Build | Path | Commit |
| --- | --- | --- |
| stock | `.worktrees/todo-gate-stock/dist/index.js` | `3cad70b28` (plain dev) |
| patched | `.worktrees/todo-gate-qa/dist/index.js` | `28865becf` (todos #1-#5, #8) |

---

## WHAT WAS OBSERVED

### 1. Bundle distinctness (the stale_state probe)

```
stock  : "todo-gate grace expired" = 0   "todoGateGraceMs" = 0
patched: "todo-gate grace expired" = 1   "todoGateGraceMs" = 8
```

The two bundles provably differ by exactly the fix, and the patched bundle provably
contains it. A BEFORE/AFTER comparison that accidentally loaded the same bundle would be
worthless, so this check is a precondition, not a formality.

### 2. BEFORE: the deadlock, reproduced live on the stock plugin

Not scripted. Task `bg_97d76fcb` was a real background subagent in root's own live
opencode session, running the stock plugin, that root cancelled mid-flight. Its session
was left with non-terminal todos. Captured in full at
`task-9-live-deadlock-capture.log` (353 lines).

Observed:

```
first gate-wait : [2026-08-17T00:44:27.421Z]
last gate-wait  : [2026-08-17T01:00:55.624Z]
gate-wait count : 330
```

Both gate paths are represented, which matches the plan's description of the defect:

```
"Task has incomplete todos, waiting for todo-continuation"  x2    (idle path)
"Task has incomplete todos via polling, waiting"            x333  (poll path)
```

Terminal-state search across every line mentioning that task id, filtering for
prune / complete / error / cancel / timed out, returns **nothing but more gate-waits**.
Over 16.5 minutes the task never reached any terminal state. It simply spun.

This demonstrates three of the plan's claims at once:
- the todo gate is unbounded, and a task whose todos are never terminalized waits forever;
- the gate log floods, 330 near-identical lines for one task, which is what todo #6 fixes;
- the situation arises naturally, not only under contrived conditions.

Note on the earlier scripted stock attempt: it did drive a real session
(`PARENT_RUN_EXIT=0`, mock served 8 requests) but its sandbox was torn down before DB
capture, so it produced no usable terminal-state artifact. The live capture above
supersedes it.

### 3. AFTER: not proven

Three scripted attempts at the patched run, each fixing the previous failure:

| Attempt | Result | Cause |
| --- | --- | --- |
| 1 | no child created | mock `when` matcher hit the parent's own prompt echo, so the parent answered its own child turns; only one session ever existed |
| 2 | `task` tool rejected | `subagent_type: "sisyphus-junior"` is not accepted; the tool requires `category` instead |
| 3 | `bg_a385da1e` created, then failed | `Task failed to start (status: error)`; the child could not resolve a model inside the sandbox, since category `quick` maps to a model the sandbox provider does not define |

The plugin loaded and the parent turn completed in every attempt. The failure is entirely
in getting a *child* background task to run against the mock provider. No patched-build
terminal state was observed, so **the AFTER claim is unproven by driven session**.

### 4. Config loading, verified rather than assumed

An earlier lane silently lost its whole config by using a bare `opencode` key. The schema
declares `additionalProperties: false` with the harness block named `[opencode]`, so the
file was discarded and the run would have exercised the default 600000 ms grace while
appearing to test 60000 ms. After the fix:

```
grep -c "Unrecognized key\|Migration validation failed" parent-run.jsonl  ->  0
```

This mattered: without that check, a green-looking AFTER run could have proven nothing.

### 5. Isolation

Real user DB session count, measured against `~/.local/share/opencode/opencode.db`:

```
REAL_DB_SESSIONS_BEFORE = 2190
REAL_DB_SESSIONS_AFTER  = 2190
```

Identical. Every sandboxed run created its sessions inside its own `mktemp -d` root with
all four XDG variables redirected, and not one leaked into the user database.

Teardown receipts:

```
ps -eo pid,command | grep -iE "tg-run|mock-model|todo-gate"   ->  empty, no stray processes
ls -d $TMPDIR/tg-* $TMPDIR/todo-gate-*                        ->  no sandbox roots remain
```

Each run also self-reported `SANDBOX_REMOVED=yes` at teardown. Root additionally killed
orphaned PIDs left by earlier lanes whose cleanup traps did not fire (2606, 2611, 2613,
plus the attempt-2 and attempt-3 runners), and removed one orphaned sandbox directory and
the `/tmp/f2probe` and `/tmp/mut2` scratch trees. The plugin log is a separate matter,
see the next point.

### 6. The plugin log is not sandboxed (harness defect, affects this evidence)

`os.tmpdir()/oh-my-opencode.log` is not redirected by any `XDG_*` variable, so sandboxed
runs and the live parent session share one file. The BEFORE capture above is unambiguous
because it is keyed on a specific task id, but any future log-derived QA in this repo is
racy while another opencode process runs. The log also rotated during this work, which
invalidated byte-offset reads. Recorded in `harness-findings.md` as F-B.

---

## WHY IT IS ENOUGH, AND WHERE IT IS NOT

Enough for the BEFORE half, and for the unit-level correctness of the fix:

- The deadlock is real, reproduces in production, and is now captured with 330 log lines
  and a 16.5-minute span showing no terminal state. This is the failure the plan set out
  to fix, evidenced on a real session rather than a mock.
- The gate-log flooding that todo #6 addresses is demonstrated by the same capture.
- The fix itself is covered by 878 passing tests in the background-agent suite, including
  a mutation-verified regression pin on the most safety-critical guard: deleting the
  authoritative `lastUpdate` re-read makes the suite fail with
  `Expected: "running" Received: "completed"`.
- Gates F1 (plan compliance), F2 (code quality), and F4 (scope fidelity) all returned
  APPROVE from independent reviewers, and both MAJOR findings from F2 were fixed and
  re-verified.

Not enough for the AFTER half:

- **No driven session shows a patched build completing a task with an open todo and
  rendering the unfinished-todos annotation.** Success criterion 1 of the plan asks for
  exactly that, and it remains open. The behavior is proven by unit tests only.
- The residual risk is specifically integration-level: that the bounded gate behaves
  correctly in unit tests but does not fire as expected in a live process, for example
  because of config resolution, poll scheduling, or an interaction with the enforcer hook.
  Nothing observed suggests that, but nothing observed rules it out either.

---

## WHAT WAS OMITTED

- **The AFTER driven run.** Attempted three times, blocked each time by mock-harness
  mechanics (child model resolution inside the sandbox). Not attempted further; escalated
  to the user for a decision instead of being faked.
- **A before/after equality check on the real DB session count.** Baseline 2190 was
  recorded; the closing count was not. Isolation rests on construction and teardown
  receipts.
- **The scripted BEFORE run's DB rows.** Its sandbox was removed before capture. The live
  production capture is used instead and is stronger.
- **Secrets.** The mock provider uses a dummy `apiKey` of `sk-test`; no real credential was
  used, logged, or included here. No tokens or auth headers appear in any captured artifact.
- **Todo #7** is deliberately out of this work: it is an enforcer behavior change and ships
  separately.

## Artifacts

| Path | Contents |
| --- | --- |
| `task-9-live-deadlock-capture.log` | 353 lines, the full live BEFORE reproduction for `bg_97d76fcb` |
| `harness-findings.md` | the five harness defects found while attempting this todo |
| `/tmp/tg-run.sh` | the working driven-run harness, config shape and mock script included |
| `/tmp/tg-patched-out/` | attempt-3 artifacts: `parent-run.jsonl`, `mock-requests.log`, `mock-script.json` |
