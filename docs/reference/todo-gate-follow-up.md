# Follow-Up: Bounded Todo Gate - Deferred Work and Harness Defects

**Origin:** Merge commit `bb322ddb6` into `dev` (bounded background-agent todo-completion gate; 10 commits, plan `.omo/plans/background-agent-todo-gate-deadlock.md`).
**Scope:** One deliberately deferred behavior change, one unfinished QA proof, four tooling defects, one closed doc gap.
**Status:** Open, except item 5 which is resolved in this commit.

---

## Context

`pollRunningTasks` waited unconditionally while `checkSessionTodos` reported incomplete todos. Nothing obliges a subagent to terminalize its own todos, so a background task that delivered its output correctly could sit in `running` until the TTL pruner failed it. The observed incident logged 330 gate-waits over 16.5 minutes and never reached a terminal state.

The merged fix bounds that wait with a continuous-idleness window (`background_task.todoGateGraceMs`, default 600000 ms) using two independent expiry conditions, completing through the existing `tryCompleteTask` writer. Condition A is stamp-based and predicate-gated so injected continuation prompts cannot reset it. Condition B shares the pruner's exact clock, which welds the bound to the same timeline as the false `error` it prevents.

Verification at merge: full suite 15531 pass / 7 fail against a `dev` baseline of 15500 pass / 7 fail with a byte-identical failure set (zero regressions, +31 tests), `bun run typecheck` exit 0. The authoritative `lastUpdate` re-read that prevents aborting a live session is pinned by a mutation-verified test: deleting the guard fails with `Expected: "running" Received: "completed"`.

Evidence for the whole effort lives under `.omo/evidence/20260817-todo-gate-deadlock/` (13 files). **That directory is gitignored (`.gitignore:2` = `.omo/*`), so it is not durable across worktree removal or machine change.** This document exists because a prior effort in this repo already lost its evidence that way.

## Tracked Items

### 1. Unify the incomplete-todo definition (plan todo #7)

**Target files:** `packages/omo-opencode/src/hooks/todo-continuation-enforcer/todo.ts`, `packages/omo-opencode/src/features/background-agent/manager.ts`, `packages/omo-opencode/src/hooks/session-todo-status.ts`, `packages/omo-opencode/src/hooks/todo-continuation-enforcer/continuation-injection.ts`, plus a new shared helper and its test.

**Gap:** Two different definitions of "incomplete todo" coexist. `todo-continuation-enforcer/todo.ts:3-10` excludes `completed`, `cancelled`, `blocked` and `deleted`. `manager.ts` (in `checkSessionTodos`), `hooks/session-todo-status.ts:17` and `continuation-injection.ts:168` exclude only `completed` and `cancelled`. So a `blocked` or `deleted` todo counts as incomplete to the background-agent gate but as done to the enforcer.

**Why it was deferred rather than bundled:** unifying them CHANGES when the enforcer stops injecting, which is an enforcer behavior change, not hygiene. It must ship on its own so the behavior delta is reviewable in isolation.

**Why fix-first was the correct order (verified during review):** before the bound existed, this divergence was fatal. A task left holding only `blocked` todos held the gate forever while the enforcer refused to inject, so nothing could move it and it died on TTL. The grace bound is what makes the divergence survivable. Unifying first would have masked the deadlock class instead of bounding it.

**Residual today:** `unfinishedTodoCount` uses the broader definition, so a completion notification can report unfinished todos the enforcer considers done. Cosmetic; resolves with this item.

**Acceptance criteria:**
- One shared helper for terminal todo statuses, used at all four sites.
- A table test enumerating every `Todo.status` value and asserting identical classification at every call site.
- `bun test` green including all `hooks/todo-continuation-enforcer/*.test.ts`.
- Ship as its own commit, labelled an enforcer behavior change.

### 2. Driven-session proof of the AFTER behavior (plan todo #9, partial)

**Gap:** The BEFORE half is proven and is stronger than the plan required: an unscripted production reproduction captured at `.omo/evidence/20260817-todo-gate-deadlock/task-9-live-deadlock-capture.log` (330 poll-path gate-waits plus 2 idle-path over 16.5 minutes, no terminal state). The AFTER half is NOT proven on a driven session; it rests on unit tests. Plan success criterion 1 is therefore partially satisfied. Accepted by explicit decision at merge time.

**Where it stalled:** four separate attempts. The final blocker was child model resolution inside the isolated sandbox: a background task was created (`bg_a385da1e`) but returned `Task failed to start (status: error)` because the delegated category maps to a model the sandbox's mock provider does not define.

**Working harness pieces, already proven, do not rediscover them:**
- The omo harness block key is literally `[opencode]`, with square brackets. `assets/omo.schema.json` has `additionalProperties: false`, so a bare `opencode` key silently discards the ENTIRE config file. That failure mode would have produced an AFTER run exercising the default 600000 ms grace while appearing to test 60000 ms.
- `subagent_type` is rejected by the `task` tool for this purpose; use `category`.
- A sandboxed `opencode run` against the bundled mock model works end to end (`RUN_EXIT=0`, real streamed JSON) including with the plugin loaded from a `file://` dist bundle.
- Verify bundle distinctness before trusting any BEFORE/AFTER comparison: grep the built bundle for `todo-gate grace expired` (0 occurrences on stock, 1 on patched) and `todoGateGraceMs` (0 vs 8).

**Acceptance criteria:**
- A driven isolated session on a patched build where a background task with a non-terminal todo reaches `completed` and renders the unfinished-todos annotation, with no `Pruning stale task` line for it.
- Config load positively verified (0 occurrences of `Unrecognized key` / `Migration validation failed` in the run output).
- Isolation proven by an unchanged real-DB session count before and after.

**Cheap interim signal:** watch the plugin log for a first live `todo-gate grace expired` line during normal background-task use. Its absence over a week of activity is the signal to prioritize this.

### 3. `ctx_execute` kills processes it spawns (tooling, high impact)

**Gap:** The lean-ctx `ctx_execute` tool hard-times-out at roughly 2 seconds and reaps its own spawned children, including backgrounded ones. Backgrounding inside the call does not save them.

**Why it is expensive:** the visible symptom is a zero-byte output file from the child, which points the investigator at the child (opencode, the plugin, credentials) rather than at the tool. This misdiagnosis consumed one full subagent run and was inherited by a second, which then reported the QA environment as unusable. The environment was healthy.

**Working alternative:** launch from a shell tool with `nohup <cmd> > /tmp/x.log 2>&1 & disown`, verify liveness (`ps -p <PID>`, plus the log growing across two `wc -l` reads), then poll from separate later calls with a bounded loop.

**Acceptance criteria:** either detach spawned children from the call's process group, or fail loudly when a command tries to background, or document the reaping semantics in the tool description. Today the description says nothing about it.

### 3a. The QA path is healthy. Do not re-litigate this.

Two separate subagent runs concluded the QA environment was unusable. Both were wrong, and this section is the disproof, recorded so nobody spends a third run rediscovering it. Every row below was executed directly.

| Probe | Result |
| --- | --- |
| `opencode --version` | 1.18.15 |
| bare `opencode run` in an XDG sandbox | reaches a real provider and fails only on credentials, which is exactly what the mock model exists to avoid |
| `.agents/skills/opencode-qa/scripts/mock-model-selftest.mjs` | SELF-TEST PASS, 20 assertions |
| `opencode run` against the mock provider | `RUN_EXIT=0`, real streamed JSON, 4 requests served by the mock |
| the same, plus `plugin: ["file://<worktree>/dist/index.js"]` | `RUN_EXIT=0`, real streamed JSON, plugin log written |

The mock model works, the plugin loads from a `file://` bundle, and a sandboxed `opencode run` completes end to end. The blocker was item 3 above, not the harness.

A related non-issue, also raised and dismissed: the only modified file in the pinned QA worktrees was `packages/omo-senpi/plugin/extensions/omo-task.js`, a senpi extension that is not part of the opencode bundle under test and was byte-identical in both the stock and patched worktrees, so it could not bias a BEFORE/AFTER comparison.

### 3b. Verified-good QA recipe, proven end to end

1. Start the mock model from a shell tool, detached, and wait for `MOCK_LISTENING <port>`.
2. Write `$XDG_CONFIG_HOME/opencode/opencode.json` with both the `plugin` array pointing at the built `dist/index.js` and a `mock` provider on `http://127.0.0.1:<port>/v1`.
3. Put omo settings in `$HOME/.omo/omo.jsonc` under the literal `[opencode]` key, with square brackets. A bare `opencode` key is rejected by `additionalProperties: false` and silently discards the whole file.
4. Drive with `opencode run '<prompt>' --model mock/mock-model --format json`.
5. Delegate with `category`, not `subagent_type`.
6. Anything long-lived goes through `nohup ... & disown` from a shell tool, polled by a bounded loop in later calls. Never from `ctx_execute` (item 3).
7. Before trusting any BEFORE/AFTER comparison, prove the two bundles differ: grep each built bundle for a string unique to the change.

### 4. Plugin log escapes XDG sandbox isolation (tooling, correctness risk for all QA)

**Gap:** The logger writes to `os.tmpdir()/oh-my-opencode.log`, which `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` do not redirect. A sandboxed QA run and a live parent session therefore share one file.

**Two consequences:** the documented QA recipe of clearing the log, driving a session, then reading it back DELETES the log a live session is writing to; and lines read back may belong to a different concurrent session, so log-derived evidence is racy whenever another opencode process runs. Session-count isolation can pass while log evidence is still contaminated. The log also rotated mid-effort, invalidating byte-offset reads.

**Acceptance criteria:** honour an env override for the log directory (for example `OMO_LOG_DIR`, or derive from `XDG_STATE_HOME`), then update the `opencode-qa` skill to set it and to stop deleting a shared path.

### 5. `todoGateGraceMs` missing from the config reference (RESOLVED in this commit)

**Target file:** `docs/reference/configuration.md`

**Gap:** The `background_task` option table documented every sibling key but omitted `todoGateGraceMs`, leaving the only user-facing control over the new bound undiscoverable. The Zod `.describe` and both schema assets were correct.

**Resolution:** row added, including the constraint that it must stay below `taskTtlMs` and that lowering `taskTtlMs` below this default is rejected at validation time.

## Smaller Notes, No Action Required

- **`ctx_shell` write-guard false positive (tooling papercut):** a relative redirect after `cd` into a `mktemp -d` under `$TMPDIR` is blocked even though that prefix is explicitly allowed, because the guard cannot resolve a relative target against the command's effective working directory. It forces every redirect in a QA script to be spelled as an absolute `/tmp/...` path. Fix would be to resolve the redirect target against the effective cwd before deciding, or to allow relative targets when the command contains a `cd` into an allowed prefix. Workaround until then: absolute paths in redirects.
- **A subagent can announce blockage without calling `report_blocked`, and then hang indefinitely (harness behavior):** one lane wrote the word BLOCKED in its final message text and never invoked the tool, so it parked as `running` for 43 minutes with no notification, no evidence file, and no live process. Status alone does not reveal this: wall-clock duration keeps climbing while the last-tool field never advances, so liveness has to be inferred by comparing the last activity timestamp against the clock and checking `ps` for the processes the lane claims to be running. A cheap heuristic would close it: detect a final assistant message that announces blockage with no matching `report_blocked` call, and either convert it or warn the parent. Contrast with the following lane, which did call the tool correctly and was unblocked in under two minutes.
- **`todoGateLogLastEmittedAt` residue on the stale-interrupt path:** `checkAndInterruptStaleTasks` does not pass `onTaskInterrupted`, so an interrupted task's entry survives cancellation until the terminal reap calls `removeTask`. Proven bounded by live-task count and always reclaimed, so not the unbounded leak the guard targets. A one-line `onTaskInterrupted` wiring would close it symmetrically.
- **`unfinishedTodoCount` written one statement before `tryCompleteTask`:** if a concurrent completer holds `completingTaskIds`, the bail leaves a stale count on a still-running task. Benign today: the field has one reader, inside completion, and renders only for `status === "completed"`, and every resume route clears it. Moving the assignment after a successful completion would make it structurally impossible rather than merely unobservable.
- **Team member tasks now terminalize through the bound.** The plan's success criterion 4 asked that they behave exactly as before; strictly they do not, because `pollRunningTasks` has no `teamRunId` skip. This is the correct outcome and the plan's own reasoning requires it: the pruner and the idle handler both skip team tasks, so the poll gate is their only terminalizer. Before the change a team member with open todos stranded in `running` forever and non-force `team_delete` was permanently blocked. Do not "fix" this back by adding a guard.
