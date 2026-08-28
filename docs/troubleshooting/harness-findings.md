# Harness findings log

**Purpose:** a running, append-only record of harness defects, footguns, and surprising
behaviours discovered *while doing real work in other repositories*. This is the place
those observations land so they are not lost in a session transcript.

**Audience:** OMO maintainers. This file is diagnostic, not user-facing — internal jargon
is fine here.

**This is not a bug tracker.** Entries are field observations with evidence. Some become
issues or fixes; some are resolved by documentation; some turn out to be user error and
are kept anyway, because "an agent reliably misreads X" is itself a harness finding.

## How to use this file

Append a new entry when you hit harness behaviour that cost you time, made you guess, or
would mislead the next agent. One entry per distinct finding. Do not rewrite or delete
existing entries — correct them by appending a `**Update:**` line, so the history of what
we believed and when stays intact.

Keep entries short. Evidence over prose: the exact log line, the exact status output, the
file:line. A finding nobody can reproduce is a rumour.

### Entry template

```markdown
## YYYY-MM-DD — Short title

**Severity:** blocker | costly | papercut | docs-gap
**Area:** background tasks | rules injection | subagents | tools | config | provider | other
**Observed in:** repo/context where it happened

**What happened:** one or two sentences.

**Evidence:**
```
exact output, log lines, or status text
```

**Root cause / hypothesis:** what actually caused it, or the best current theory —
label it clearly as one or the other.

**Workaround:** what unblocked it, if anything.

**Fix status:** unfixed | worked around | fixed in `<commit>` | needs-decision
```

## Severity guide

| Severity | Meaning |
|---|---|
| `blocker` | Work cannot proceed; no workaround found without intervention. |
| `costly` | Recoverable, but burned real time or tokens (repeated runs, lost sessions, re-work). |
| `papercut` | Small friction; correct behaviour eventually, annoying path there. |
| `docs-gap` | Harness behaved correctly, but the docs/instructions led the agent to the wrong conclusion. |

---

# Findings

## 2026-08-17 — Detached `ctx_shell` jobs never notify, and silently strand agent sessions

**Severity:** blocker
**Area:** background tasks
**Observed in:** `~/git/onara`, during a 27-todo parallel implementation plan

**What happened:** `ctx_shell(run_in_background=true)` returns a `shell_*` job id whose
completion is **pull-only** — nothing ever pushes a notification. Agents that fired a long
gradle build, ended their turn, and waited to be woken were never woken. Five subagent
sessions died this way in one work session; each time the detached job ran to completion
and wrote results to disk with no agent left to read them. Work sat uncommitted in a dirty
worktree for ~2.5h before a human noticed.

The trap is the spelling collision: `task(run_in_background=true)` **does** notify;
`ctx_shell(run_in_background=true)` **never** does.

**Evidence:** source read at `~/git/lean-ctx` (v3.9.18):

- job registry is in-process memory only —
  `rust/src/server/background_shell.rs:35` (`static JOBS: LazyLock<Mutex<HashMap<String, Job>>>`)
- completion detected by the worker thread at `background_shell.rs:141-166`; emits nothing
- the server *can* send MCP notifications, but only two exist —
  `rust/src/server/notifications.rs:7-23` (`resources/updated`, `tools/list_changed`)
- no disk-backed registry, socket, or DB — nothing external can watch job state
- docs are consistent about it: `rust/LEAN-CTX.md:46` says "then poll job_id"

**Root cause:** by design in lean-ctx; there is no configurable notify-on-completion path.
Confirmed absent, not merely undocumented.

**Workaround:** run the command in the **foreground** (~110s cap covers most builds), or
use ONE bounded loop that breaks on completion and stay inside that call:

```bash
(./gradlew … > /tmp/j.log 2>&1; echo $? > /tmp/j.rc) &
for i in $(seq 1 90); do [ -f /tmp/j.rc ] && break; sleep 2; done; cat /tmp/j.rc
```

**Fix status:** worked around. Options if we want a real fix: (1) caller-side command
composition (`build.sh; on-done.sh` — lean-ctx runs raw shell text, so this needs no
patch); (2) patch lean-ctx to emit a new MCP notification from the completion path and
wire client subscription; (3) make OMO's own `<unpolled-background-shell-jobs>` hook
reliable — see the next entry.

**Update:** (2026-08-21, verified against `dev` source) Still accurate, and the workaround
is now durable rather than per-prompt. The notification gap itself is external and
unfixable here: `ctx_shell` is the lean-ctx MCP, and nothing in this repo can make it emit
a completion event. What changed is the rescue path around it. The `unpolled-shell-job`
hook is live and its tracking gap is closed (see the next entry), so a turn that ends with
a detached job still outstanding now gets warned at idle instead of silently stranding.
The duration-based routing table — foreground under ~110s, `task(run_in_background=true)`
for anything longer and delegable, detached `ctx_shell` only when you must own it and then
you poll in your own turn — is written into `AGENTS.md:100-126`, so it applies without a
parent re-teaching it. Severity holds at blocker: when it does bite, the session is
stranded, and the ~110s foreground cap is not raisable by env var
(`LEAN_CTX_SHELL_TIMEOUT_MS` governs a detached job's lifetime, not a foreground block).

**Fix status (2026-08-21):** worked around, durably. The notification gap is external and
stays open; the rescue hook and the duration-routing table in `AGENTS.md:100-126` are what
make it survivable.

**Update:** (2026-08-24, verified against dev source) External half unchanged and confirmed live: the parent of this review reproduced it in-session. The polling contract wording is intact and accurate at `/Users/tim/.config/opencode/AGENTS.md:110-118` (`task` notifies, detached `ctx_shell` "never notifies", poll `background_action="status"`) and `:121-122`. Our side of the problem is closed and durable: detached jobs are tracked unconditionally at `packages/omo-opencode/src/plugin/tool-execute-after.ts:123-134`, the idle rescue hook is wired as a Session-tier hook (`packages/omo-opencode/src/hooks/unpolled-shell-job/`), and its message now recommends a bounded completion loop rather than repeated status calls (`packages/omo-opencode/src/hooks/unpolled-shell-job/message.ts:28-45`). Note the entry's reference to `core/instructions.md` no longer resolves - that file does not exist in the current checkout, so the tracked copy of this guidance now lives only in the root `AGENTS.md` and the user-global `AGENTS.md`.

**Fix status (2026-08-24):** worked around, unchanged. External notification gap remains outside our control; repository-side tracking and rescue remain fixed. Severity revised `blocker` -> `costly`: the idle rescue prevents silent stranding in normal sessions, and the failure mode now requires a session that never goes idle.

## 2026-08-17 — `<unpolled-background-shell-jobs>` hook fires once, then stops

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`

**What happened:** OMO already has a rescue for the trap above — a hook that warns when a
turn ends with a detached job outstanding. It fired once, the agent recovered and worked
for ~35s, then relapsed into the same detach-and-yield pattern. The hook did **not** fire
the second time, and the session was stranded again.

**Evidence:** hook message in the child transcript reported the job as
`shell_442363fc607eed99 — (started before it was tracked)`. Agent woke at 13:32:25, made
three tool calls, went silent at 13:32:59. Files kept landing at 14:49–14:51 with no agent
alive.

**Root cause / hypothesis:** unconfirmed. Either the hook is one-shot per job, or the turn
ended without a *tracked* outstanding job while gradle was still running — the tracking gap
the hook's own message admits to (`started before it was tracked`).

**Workaround:** none automatic; the parent had to notice and resume the lane manually.

**Fix status:** unfixed — needs investigation of the hook's trigger condition and the
tracking gap.

**Update (2026-08-17, verified against `dev` source):** the hypothesis was wrong on the
"one-shot" half and right on the tracking half — and the tracking half is now fixed.

- **Not one-shot.** The hook re-fires on every `session.idle` while a job is still
  outstanding, gated only by an in-flight check and a cooldown
  (`hooks/unpolled-shell-job/hook.ts:84-91`); `lastNudgedAt` is armed only after an
  *accepted* dispatch (`hook.ts:112-124`), so a rejected dispatch retries on the next
  idle. Both behaviours are pinned by tests (`hook.test.ts:179-190`, `:192-201`).
- **The tracking gap was real, and was the actual cause.** MCP tool results arrive with
  the payload in `content[]` and `.output` populated only later, so `ctx_shell` jobs run
  through an MCP server were never recorded at start — the tracker only learned of them
  later via the adoption fallback, which is what stamps `(started before it was tracked)`
  (`hooks/unpolled-shell-job/tracker.ts:173-184`). Fixed in `b9b0a8b5c`: the after-hook
  resolves MCP text through `content[]` and records unconditionally
  (`plugin/tool-execute-after.ts:123-134`), with a regression test at
  `plugin/tool-execute-after.test.ts:38-68`.
- **A second silent-skip on the same path** — MCP outputs bypassing the truncator, so
  downstream hooks saw nothing — was fixed in `8810f3174`; the truncator now runs earlier
  in the same after-chain (`tool-execute-after.ts:143-165`, test `:130-159`).

Two limits remain, both by design rather than defect: a job started before tracking is
still only *adopted* late (and only from a `background_action="status"` call that parses a
running state, `tracker.ts:173-184`), and the warning is bound to `session.idle` — if no
idle event arrives, no warning fires (`hook.ts:82-85`).

**Fix status (revised):** fixed in `b9b0a8b5c` + `8810f3174` for the tracking gap; the
"fires once" diagnosis is retracted. Late adoption and idle-only firing remain open by
design.

**Update:** (2026-08-21, verified against `dev` source) The revised status holds; nothing
regressed. Re-confirmed the re-fire path directly: the hook re-arms on every
`session.idle` while a job is outstanding, guarded only by an in-flight latch and
`NUDGE_COOLDOWN_MS` (`hooks/unpolled-shell-job/hook.ts:87-89`), and a dispatch that is
rejected or coalesced away does not arm the cooldown (`hook.ts:112`), so the next idle
retries. `hook.test.ts` pins all three shapes: re-fire after cooldown (`:179-190`),
retry after a rejected dispatch (`:192-201`), retry after a dedupe discard (`:109-126`).
The tracking half is closed in current source — `plugin/tool-execute-after.ts:126-134`
records the shell call unconditionally, reading through `resolveToolOutputText()`
(`shared/tool-output-text.ts:33-46`) so an MCP result carrying its text in `content[]` is
seen, with a regression test at `tool-execute-after.test.ts:38-68`.
The two remaining limits are unchanged and remain by design, not defect: late adoption of
a job that started before tracking (`tracker.ts:173-184`) and idle-bound firing
(`hook.ts:82`). No status change.

**Fix status (2026-08-21):** unchanged from the revised status — tracking gap closed,
one-shot diagnosis retracted, two design limits open by intent.

**Update:** (2026-08-24, verified against dev source) Revised diagnosis holds; the "fires once" framing stays retracted. The hook fires on every `session.idle` with outstanding jobs, gated only by an in-flight flag and a cooldown, at `packages/omo-opencode/src/hooks/unpolled-shell-job/hook.ts:82-89`. `lastNudgedAt` is armed only after an accepted, non-discarded dispatch (`:112-120`), so a rejected or semantically-deduped dispatch retries on the next idle (`:46-48`). There is no per-job warned `Set` or permanent dedupe map; state is session-level only (`:50-56`). Repeat-after-cooldown and retry-after-discard are both pinned by tests at `hook.test.ts:109-126` and `:179-200`. `8810f3174` confirmed on `dev` as `fix(hooks): truncate MCP tool outputs, which were silently skipped`.

**Fix status (2026-08-24):** tracking gap remains fixed. Residual limits - idle-only firing (`hook.ts:82-85`) and positive-status-only late adoption (`tracker.ts:173-184`) - are deliberate design, not defects. Severity revised `costly` -> `papercut`.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Both declared-deliberate residuals confirmed unchanged. Idle-only firing still returns on any non-`session.idle` event before outstanding jobs are inspected (`packages/omo-opencode/src/hooks/unpolled-shell-job/hook.ts:82-85`); positive-status-only late adoption still requires `isRunningStatus(output)` (`tracker.ts:180-184`), pinned negatively by `tracker.test.ts:158`. Cross-checked for a compensating busy-parent route: the only force-dispatch ceiling in the codebase lives in `parent-wake-flush-runner.ts:295-308` and serves background-agent wakes, not unpolled shell jobs, so no sibling surfaces these to a busy parent. Re-fire after cooldown remains pinned (`hook.test.ts:179`, `:192`).

**Fix status (2026-08-27):** unchanged, tracking gap still fixed, residuals still deliberate. Severity stays `papercut`.

## 2026-08-17 — Stale-cancellation timer misread as a wall-clock budget

**Severity:** docs-gap
**Area:** subagents
**Observed in:** `~/git/onara`

**What happened:** a subagent reported blocked at 8m35s with "lane time expired", having
completed ~80% of its task. No such limit exists. It had read the instruction that idle
subagents are stale-cancelled at 15 min and converted a *liveness* deadline into a *time
budget*, then parked to protect uncommitted work from a cancellation that was never coming.

**Evidence:** global `AGENTS.md:116` warned "idle until stale-cancellation at 15 min,
work uncommitted", backed by a real setting — `staleTimeoutMs: 900000` in
`~/.config/opencode/oh-my-openagent.json:28`.

**Root cause:** the timer is real, but it measures **inactivity** and every tool call
resets it. The instruction stated the hazard without stating the escape, so an agent asking
"am I about to be cancelled?" had no reassuring answer available.

**Workaround / fix:** added an explicit clause to global `AGENTS.md`: stale-cancellation is
an inactivity timer, not a time budget; a polling agent is never at risk; there is no
wall-clock limit on a task, lane, or session; "out of time" is never a valid block reason.

**Fix status:** fixed in the user's global `AGENTS.md` (untracked config). Consider
carrying the same wording into the shipped instructions template so every install gets it.

**Update:** (2026-08-21, verified against `dev` source) Fixed, and no longer only in
untracked config — the follow-up this entry asked for has landed. The corrective paragraph
is present verbatim in BOTH `/Users/tim/.config/opencode/AGENTS.md:124` and the tracked
`AGENTS.md:124`, so it now ships to every machine and harness rather than living on one
box. It states plainly that stale-cancellation measures time since last activity, that
every tool call resets it, that a polling agent is therefore never at risk, and that
"out of time" is never a valid reason to cut scope.
The implementation matches the wording: `features/background-agent/task-poller.ts:317-319`
recomputes `timeSinceLastUpdate` from `task.progress.lastUpdate` on every poll cycle, which
is refreshed by activity — an inactivity timer, exactly as documented. Source default is
45 min (`features/background-agent/constants.ts:7`, `DEFAULT_STALE_TIMEOUT_MS = 2_700_000`);
the schema floor is 1 min (`config/schema/background-task.ts:18`); the 15 min quoted in the
entry is a user-level override, not the default. Severity stays `docs-gap` — the code was
always right, only the reading of it was wrong.

**Fix status (2026-08-21):** fixed in tracked source — the wording now lives in
`AGENTS.md:124` as well as the user's global config, so it no longer depends on one
machine. Closed.

## 2026-08-17 — Dead task reports `running`; resume requires cancel first

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`

**What happened:** after a subagent session died, `background_output` continued reporting
`Status: running` with a frozen duration counter (e.g. stuck at 18m35s while 40+ min of
wall-clock passed). Attempting `task(task_id=…)` to resume failed with
`Task … is currently running and cannot accept a continuation prompt`. The task had to be
explicitly cancelled first, then resumed.

**Evidence:**
```
Error: Task bg_2ce3fa6b is currently running and cannot accept a continuation prompt.
    at resume (…/oh-my-openagent/dist/index.js:141058:22)
```
Independently: last child tool call 12:54, files on disk written 14:49–14:51, no process
alive.

**Root cause / hypothesis:** the in-memory task record is not reconciled against actual
child liveness, so a dead child stays `running` forever.

**Workaround:** verify liveness from **disk** (file mtimes, `git status`, test-result
timestamps) rather than trusting the status line; then
`background_cancel(taskId=…)` followed by `task(task_id=…)` to resume with context intact.

**Fix status:** unfixed.

**Update (2026-08-17, verified against `dev` source):** still unfixed, and the hypothesis
is confirmed. There is no code anywhere in `features/background-agent/` that reconciles a
task's `running` status against actual child-session liveness. `resume()` reads the task
record and throws purely on `existingTask.status === "running"`
(`features/background-agent/manager.ts:1384-1399`), with no session probe in between. The
cancel-then-resume dance remains the only recovery, and disk timestamps remain the only
trustworthy liveness signal.

**Update:** (2026-08-21, verified against `dev` source) Still open, mechanism unchanged and
re-confirmed by hand. `manager.ts:1394-1399` rejects the continuation purely on the
in-memory string `existingTask.status === "running"`, with no liveness probe anywhere ahead
of it. The probe exists but is not wired into this path: `verifySessionExists()` is defined
at `manager.ts:3233` and used by the poller, never by `resume()`.
Cross-checked for a compensating mechanism rather than stopping at the defect. The poller
does reconcile against session existence during completion detection
(`task-poller.ts:283,336`), but that path only advances a task the poller is still
watching; it does not repair a record the parent then tries to resume. The
`first-prompt-watchdog` covers initial-silence timeout, not post-hoc status reconciliation.
No test covers "session died while status stayed `running`, then resume" — `blocked-resume.test.ts`
covers resume-after-cancelled (`:68-84`) and blocked-state preservation (`:86-114`) only.
Severity holds at `costly`: the cancel-then-resume workaround is reliable once known, but
the status line actively lies, and a lying status is what makes an agent trust it.
The contained fix is small: probe `verifySessionExists()` before the `:1394` guard and
downgrade a vanished session to a terminal status instead of blocking the resume.

**Fix status (2026-08-21):** still unfixed, confirmed at `manager.ts:1394-1399`. No liveness
reconciliation exists on the resume path; `verifySessionExists()` (`manager.ts:3233`) is
defined but never called there.

**Update (2026-08-21, fixed in `8728fa5f1`):** fixed on the resume path, and the fix this
entry suggested above turned out to be wrong. `verifySessionExists()` (`manager.ts:3233` ->
`session-existence.ts:60`) reports whether a session ROW exists, not whether the child is
alive: it returns `missing` only on 404 / "not found", and maps `unknown` to `true`. A dead
child's row persists, so probing it before the guard would have returned `true` and changed
nothing. The codebase already treats it that way - the poller calls it and, on `exists`,
resets `consecutiveMissedPolls` and keeps waiting (`task-poller.ts:284-287`).

The actual liveness signal is `client.session.status()`, classified by
`session-status-classifier.ts` (active = busy|retry|running, terminal = idle|interrupted).
`resume()` now probes it and distinguishes active / terminal / absent: an active session
still rejects with the byte-identical message, a terminal or absent one is reconciled and
the resume proceeds. Absent readings honour `MIN_SESSION_GONE_POLLS` by reusing the counter
the poller keeps on the same record, so one status blip cannot double-prompt a live session;
an unavailable or throwing status endpoint fails safe and still rejects. The task is claimed
in `completingTaskIds` across reconciliation so the poller cannot complete it midway, and
reconciliation releases the dead run's concurrency slot and clears its completion and idle
timers, which a bare status flip would have leaked.

Verified against the real `BackgroundManager` rather than only unit tests: driving
`resume()` on a task whose session is absent from the status registry, `dev` rejects all
three scenarios (dead-and-gone, single-poll blip, genuinely busy) while the patched build
accepts only the first. Evidence: `.omo/evidence/20260821-resume-liveness/`.

**Correction to the severity/mechanism recorded above:** the claim that a dead task stays
`running` forever is too strong. Probing the poller directly shows a dead-but-row-present
task at 20min idle stays `running` with `consecutiveMissedPolls` cycling 1 -> 2 -> 0, but at
50min idle it is cancelled on the first poll by the `staleTimeoutMs` (45min) path. The real
defect is narrower: because `checkSessionExistence` returning `exists` resets the gone
counter, a dead task whose row survives can never take the 60s `sessionGoneTimeoutMs` fast
path and always waits out the 45min slow one. Still open, and separate from the resume fix:
`task-poller.ts:284-287,337-340` should let row existence reset the gone counter without
vetoing the inactivity timeout.

**Also still open:** `background_output` continues to render a stale `running` with a
frozen-looking duration until that poller timeout fires. The resume fix does not touch the
reporting path.

**Update (2026-08-21, retraction - verified against a real `opencode serve` 1.18.15):** two
claims I wrote above are wrong, including the poller "defect" I proposed fixing.

First, the reporting half is fixed in `cc13ab687`: a `running` task whose child has been
silent past the stale threshold, or absent from the session registry, now reports the
silence and points at disk instead of promising "the system will notify you". The
"frozen duration counter" in the original report is NOT reproduced: `formatDuration` falls
back to `new Date()` when `completedAt` is unset (`time-format.ts:2`), so a running task's
duration always advances. That symptom remains unexplained and may be a third, separate bug.

Second, and more importantly, my claim that the poller's existence probe wrongly blocks the
60s `sessionGoneTimeoutMs` path was based on a premise I never checked. Driving a real
server against a mock streaming provider shows `session.status()` lists ONLY `busy`/`retry`
sessions: an idle-but-alive session is absent from the map, and `idle` never appears as a
membership value even though the SDK type permits it - it exists only as an SSE event
payload. Evidence: `.omo/evidence/20260821-poller-not-busy/oracle-server-probe/probe4.txt`
(`{}` -> `busy` -> `{}` with the row still resolving afterwards).

So absence from the map means "not busy", never "gone", and `MIN_SESSION_GONE_POLLS` (3) at
`POLLING_INTERVAL_MS` (3000) is merely 9 seconds of not being busy - the normal state of a
task waiting on the todo gate, whose grace defaults to 10 minutes. Deleting the probe would
have cancelled healthy todo-gated tasks at 60s. Confirmed by mutation: with the veto removed
the new regression test drops to 1 pass / 2 fail. The 60s path being reachable only on a
genuine 404 is correct behavior, not a defect. Locked in `d133f0f8d`.

Third, my earlier "dies at 45min via `staleTimeoutMs`" correction was also wrong. That probe
called `checkAndInterruptStaleTasks` directly and bypassed `pruneStaleTasksAndNotifications`,
which the real loop runs first (`manager.ts:3310` before `:3312`) with no existence check and
a 30-minute `TASK_TTL_MS`. A dead-but-row-present task actually dies at ~30min as `error`.
The 45min ladder is reachable only for `teamRunId` tasks, which prune skips
(`task-poller.ts:76-78`).

**Update:** (2026-08-24, verified against dev source) **Diagnosis retracted.** Resume no longer requires a cancel first. `BackgroundManager.resume()` now probes session liveness before rejecting: `packages/omo-opencode/src/features/background-agent/manager.ts:1396` enters the running branch, `:1402-1407` defines the rejection, `:1413-1417` withholds judgement until `MIN_SESSION_GONE_POLLS` is exceeded, and `:1424-1430` reconciles a confirmed-dead session and admits the continuation prompt with an explicit "previous run did not report a result" note. Verified fix commits: `8728fa5f1 fix(background-agent): reconcile stale running status on resume` and `cc13ab687 fix(background-task): disclose session silence instead of promising a notification` (both confirmed present in `git log`). Regression coverage at `stale-running-resume.test.ts:89-180` drives dead-session resume without cancellation and still rejects a genuinely busy session. The "frozen duration" symptom was not reproduced.

**Fix status (2026-08-24):** fixed in `8728fa5f1` (resume path) + `cc13ab687` (reporting path); the earlier poller diagnosis was retracted in `d133f0f8`. Residual: a status endpoint failure still fails safe and blocks resume (`manager.ts:1411-1412`), which is intended. Severity revised `costly` -> `papercut`.





**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed fixed in code, both halves, and all three cited SHAs resolve and are ancestors of `dev`: `8728fa5f1` (`fix(background-agent): reconcile stale running status on resume`), `cc13ab687` (`fix(background-task): disclose session silence instead of promising a result`), `d133f0f8` (`test(background-agent): lock the session-existence probe`). Resume reconciliation probes real liveness at `manager.ts:1462`, still rejects `active`/`unknown` at `:1463`, and rejects `absent` below `MIN_SESSION_GONE_POLLS` at `:1464-1467`. Reporting no longer promises a result: running status is labelled manager belief at `task-status-format.ts:86-91`, with absent-registry and long-silence disclosures at `:93-109`. Five resume tests and two reporting tests pin it (`stale-running-resume.test.ts:90,106,126,148,169`; `task-status-format.test.ts:35,49`). The status-endpoint fail-safe residual is confirmed intended (`manager.ts:3357-3366`).

**Fix status (2026-08-27):** fixed, verified in source and history. Severity stays `papercut`.

## 2026-08-17 — Provider outage drops the in-memory task record; sessions unrecoverable by `task_id`

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`

**What happened:** after a provider outage and runtime restart, resuming a lane by session
id failed permanently — the runtime that owned the record was gone. The child session's
*work* was intact on disk, but its conversation context could not be resumed.

**Evidence:**
```
Error: Task not found for session: ses_ff0451424ffeWr7FTI4zAUYAYH
```
Earlier, `background_output` had already warned the task was "owned by a different runtime
than the one serving this tool call".

**Root cause:** task records live in the runtime's memory and do not survive a restart.

**Workaround:** dispatch a fresh agent pointed at the existing worktree, with an explicit
"here is what is already on disk" briefing. Cheap, because the work itself is on disk —
only the reasoning is lost. This is a strong argument for instructing lanes to **commit
early** rather than batching everything behind one final commit.

**Fix status:** unfixed — persisting task records across restarts would close it.

**Update (2026-08-17, verified against `dev` source):** still unfixed, root cause
confirmed at source. The `bg_*` registry is memory-only, parked on `globalThis` with no
disk, DB, or any restart-safe write path
(`features/background-agent/task-registry.ts:11-29`, maps at `:22-29`). Nothing survives a
runtime restart by design.

Partially mitigated on the *guidance* side: the not-found messages now name the recovery
explicitly instead of only blaming cross-instance state — `formatTaskNotFoundMessage`
points at `session_read(session_id="ses_…")` and states that session transcripts are
server-backed and readable from every runtime
(`tools/background-task/create-background-output.ts:159-178`), and the completion
notification carries the `| session: ses_…` suffix plus the same fallback instruction
(`features/background-agent/background-task-notification-template.ts:114`, `:157`). The
data loss is unchanged; the agent is merely told where to look now.

**Update:** (2026-08-21, verified against `dev` source) Still open, unchanged. The registry
is memory-only by construction: `features/background-agent/task-registry.ts:11-29` holds
`activeTasks` and `completedTasks` as plain `Map`s parked on `globalThis` under
`REGISTRY_KEY` (`:22-30`). No disk, no SQLite, no `.omo/` state, no load-on-init path — a
restart erases the registry by design, not by accident.
Cross-checked the two things that could have quietly closed it. Neither does. Making the
process-cleanup listeners log-only rather than force-exit (`process-cleanup.ts:10-13`,
pinned by `process-cleanup.test.ts:162,345,363`) keeps the host alive through a transient
error, which reduces how often the registry is lost, but creates no durable record. And the
cross-process transcript fallback added for `background_output`
(`tools/background-task/create-background-output.ts`) recovers a child *session id* from the
parent transcript — that is a different axis: it survives a realm boundary, not a restart,
and it returns the task's output, never the task record (status, attempts, retry history).
Severity holds at `costly`. The documented workaround — dispatch a fresh agent carrying the
session id as context — recovers the work but not the tracking.

**Fix status (2026-08-21):** still unfixed, confirmed at `task-registry.ts:11-30`. Neither
log-only process cleanup nor the cross-process transcript fallback persists a task record;
both address different axes.

**Update:** (2026-08-24, verified against dev source) Still open, and independently cross-checked for a compensating mechanism. `activeTasks` and `completedTasks` are plain `Map`s hung off `globalThis` at `packages/omo-opencode/src/features/background-agent/task-registry.ts:6-29`; registration, archival, and lookup touch only those maps (`:99-124`). `TaskHistory` is likewise process-local (`task-history.ts:19-21`). No `~/.omo/` write, SQLite table, JSON state file, or hydrate path exists anywhere in the module. Plugin-restart orphaning is documented as expected behavior at `packages/omo-opencode/src/features/background-agent/AGENTS.md:52-53`.

The cross-check did find a partial mitigation the original entry did not credit: `background_output` now falls back to reconstructing a child session from the parent transcript when the registry misses, pairing `bg_...` to `ses_...` (`packages/omo-opencode/src/tools/background-task/create-background-output.ts:88-179`, pairing logic in `parent-transcript-pairing.ts:114-142`, tests at `create-background-output.cross-instance.test.ts:135-191`). That recovers *output* but not task state - status, retry history, cancellation state, and resumability are all still lost, and the code says so at `:148-149`.

**Fix status (2026-08-24):** partially fixed - result retrieval has a transcript fallback; task-record persistence does not exist. Severity stays `costly`: restart still breaks `task_id`-based control, and a missing transcript pairing is unrecoverable.

**Update:** (2026-08-24, second pass, verified against `dev` source) Unchanged, and now located precisely. The registry is not under `tools/background-task/` as earlier updates implied - it is `packages/omo-opencode/src/features/background-agent/task-registry.ts:22-29`, where `globalThis[REGISTRY_KEY]` holds `activeTasks` and `completedTasks` as plain `Map`s. A repo-wide search for `persist` / `hydrate` / `restore` / `writeFile` in that directory found no production persistence path, and `git log` on the registry file shows no persistence commit. The continuation half is confirmed harder than the retrieval half: `resume()` calls `findBySession()` first and throws `Task not found for session` at `manager.ts:1385-1389`, so the transcript fallback recovers output only and never rehydrates `BackgroundManager`. Smallest fix stays as scoped: durable store plus startup rehydration in `task-registry.ts`, loaded before `getTask()` (`manager.ts:1140-1142`) and `resume()`.

**Fix status (2026-08-24, fixed):** a guarded adopt-on-miss fallback shipped in `BackgroundManager.resume()` at `packages/omo-opencode/src/features/background-agent/manager.ts:1385-1500`. On a `findBySession` miss it no longer throws `Task not found for session` immediately - it verifies the session row exists, probes liveness, and adopts the live child session into this manager via the pre-existing production method `adoptRunningSession` (`manager.ts:689-733`). This closes exactly the gap the update above identified: `resume()` now rehydrates `BackgroundManager`, not only the transcript.

Liveness policy, checked before adoption is allowed:
- `active` - refuse. A task another runtime is actively driving must not be double-adopted.
- `unknown` - refuse. Ambiguous state is treated as unsafe rather than guessed at.
- `terminal` - adopt.
- `absent` - adopt only if `validateSessionHasOutput` (`manager.ts:2406`) confirms the transcript already has real assistant/tool output, otherwise refuse. `absent` must be adoptable because a real `opencode serve` omits idle sessions from `session.status()` - a genuinely idle orphan reports `absent`, not `terminal`. Refusing `absent` outright would have left the dominant real-world case (a lane that went quiet, then the runtime that owned it restarted) permanently unresumable.

Two findings reshaped the fix and are worth keeping on record:

1. A registry/archive fallback inside `findBySession` was considered and rejected as unsafe. The `globalThis` registry returns a detached clone (`task-registry.ts:116-125`, cloning at `:124`), while `resume()` mutates its record in place (`manager.ts:1447-1483`) and the poller iterates only `this.tasks` (`manager.ts:3412`). A registry fallback would let `resume()` acquire a concurrency slot and dispatch a prompt against an object nothing polls: the task would never complete and the slot would never release. This trap is now pinned by a regression test in `blocked-retention.test.ts`.
2. Durable disk persistence was considered and rejected too. It would restore the record but not the poller, concurrency slot, timers, or client handle, and a shared file would remove the per-runtime partition that currently keeps two runtimes from double-driving one child session. Making that safe needs an owner-id and heartbeat lease, judged disproportionate to the gap it would close.

Escalation trigger for revisiting persistence: only if a task that dies while still `pending` - never spawned, so it has no `sessionId` and no server-side anchor to adopt - proves to be the common case. Adoption cannot help that case; the smaller and safer artifact there would be a pending-only queue snapshot, not a general-purpose registry restore.

Proof, and its limits:
- Unit tests: `manager.resume-adopt.test.ts`, 8 tests, including one that drives the real unstubbed liveness probe against an empty status map (the realistic idle-orphan shape).
- Live-harness QA: proven across a real `opencode serve` restart. Server 1 (PID 10388) was killed; the continuation was served by a different process (PID 10456), so that process's task map could not have contained the record and `findBySession` necessarily missed. The child session gained a genuine new turn (message count 2 -> 4) and the continuation tool call reported `Task continued and completed in 1s.` Evidence: `.omo/evidence/20260824-resume-adopt-fallback/`.
- Not proven on the live harness: the `active`-session refusal and `absent`-session error paths. Both are covered by unit tests but were not reached in the live QA run.
- Adoption is proven structurally here (a cross-process continuation could only have succeeded through the adopt branch), not by a persisted adoption marker - the adopted task's description lives in memory and is never written to a session part.

Severity: no longer `costly` for the case this entry centers on. `task_id`-based continuation now survives a restart for a spawned session with transcript output. The `pending`-never-spawned case remains unrecoverable by design, per the escalation trigger above.

**Update (2026-08-24, doc correction):** the update above at line 442 cites the AGENTS.md claim at `packages/omo-opencode/src/features/background-agent/AGENTS.md:52-53`, but that file has since grown and the bullet now lives at line 65. The bullet itself was also stale, still calling restart-orphaning "unaddressed" after the `resume()` adopt-on-miss fallback shipped. It has now been corrected to describe the shipped adopt-on-miss behavior (liveness policy, `manager.ts:1386-1423` citation) while keeping the parts that are still true: the in-memory task record is still lost, an adopted task loses model/fallback-chain/category/skill-content fidelity, and a `pending`-never-spawned task still has no session to adopt.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Split verdict confirmed. The resume-adopt half is genuinely fixed: `resume()` now verifies the session exists (`manager.ts:1405-1411`), probes liveness (`:1414-1426`), and adopts through `adoptRunningSession` (`:1428-1439`, implementation `:699-742`), pinned by ten cases in `manager.resume-adopt.test.ts:136-365` including concurrency-race rollback. The persistence half is untouched: `task-registry.ts:22-29` still holds `activeTasks`/`completedTasks` as plain `Map`s on `globalThis`, and `:99-124` operates only on those maps. Cross-checked for any durable route (`storage/`, `writeFile`, `persist`) in the background-agent tree and found none; `manager.ts:1497` uses "persisted concurrency group" for an in-memory field, not durable storage.

**Fix status (2026-08-27):** partially fixed, unchanged from the 2026-08-24 split. Restart still destroys `task_id` control. Severity stays `costly`.

## 2026-08-17 — Completion summary replays every historical park as a current failure

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`, wave of 3 parallel lanes

**What happened:** the final "all background tasks finished" summary reported
**`14 FAILED`** for a wave of **three** lanes. The list was not fourteen distinct
failures — it was the same two task ids repeated, one line per *historical* park or error
across each task's whole lifetime, most of them tagged `[RUNNING]`. Two of the entries were
verbatim replays of block reasons that had already been resolved and superseded an hour
earlier.

Read literally, the summary says most of the wave failed. On disk, one lane was fully
committed and clean, and the other two had complete work awaiting a commit. Nothing had
failed.

**Evidence:**
```
[ALL BACKGROUND TASKS FINISHED - 14 FAILED]
Completed:
- bg_3db0b708 … | bg_524a0301 … | bg_85e1ba37 …
Failed:
- bg_3db0b708 … [RUNNING]
- bg_3db0b708 … [RUNNING]
- bg_85e1ba37 … [RUNNING]
   (× 14, only two distinct ids, several tagged [RUNNING], two replaying stale
    block reasons already resolved)
```
Disk at the same moment: lane 23 `c701b35e0`, 0 dirty; lane 20 and 21 complete but
uncommitted.

**Root cause / hypothesis:** the summary appears to aggregate every park/error event ever
recorded for a task rather than its terminal state, and does not dedupe by task id. The
`[RUNNING]` tag on lines under a `Failed:` heading suggests state is being read from event
history, not from the task's final status.

**Workaround:** ignore the counts entirely; verify each lane from disk —
`git log --oneline -1`, `git status --porcelain`, and test-result timestamps. This is the
same rule that applies to the dead-task-reports-`running` finding above: **disk is the only
trustworthy status.**

**Fix status:** unfixed. Dedupe by task id and report only terminal state; a task that
parked and later succeeded is a success.

**Update:** (2026-08-21, verified against `dev` source) Still open, and I confirmed the
mechanism myself rather than accepting the search result. Every completion pushes a fresh
entry into `completedTaskSummaries` keyed only by parent session
(`manager.ts:2899-2910`) — the push is unconditional, with no id lookup and no replacement
of a prior entry for the same task. When the batch closes, `manager.ts:2931` hands the
entire accumulated array to the notification builder. There is no dedupe stage in between:
a repo-wide search of `features/background-agent/` for a dedupe helper, `Map`-by-id, or
`Set` of seen ids returns nothing on this path, and `completedTaskSummaries` is only ever
`has`/`get`/`push` — never pruned, replaced, or cleared per task.
The count the parent reads comes straight off that array:
`background-task-notification-template.ts:87` computes
`failedTasks = completedTasks.filter((t) => t.status !== "completed")`, and `:98` renders
`${failedTasks.length} FAILED`. So a task that parks, resumes, and parks again contributes
one "failure" per park, which is exactly the reported 14-for-2 inflation.
Severity holds at `costly`: it is not lost work, but a fabricated failure count is the kind
of evidence an agent acts on, and acting on it means re-running work that already succeeded.
Fix is contained — dedupe by task id keeping last terminal state, either at the `:2931`
handoff or inside the template before `:87`. Needs a regression test asserting a
park-resume-park task appears exactly once.

**Fix status (2026-08-21):** still unfixed, confirmed at `manager.ts:2899-2910` (unconditional
push, no id dedupe) and `background-task-notification-template.ts:87,98` (count taken
straight off the accumulated array).

**Update:** (2026-08-21, fixed in `7d41a6f23`) Closed. The renderer now collapses the summary
list to the last entry per task id before counting, so a task that parked N times is reported
once, in its final state. Fixed at the renderer rather than at the push site: eight call sites
funnel into `notifyParentSession`, and the count is derived during rendering, so one choke
point covers every route. The repeated push upstream is left in place - that is a size
question, not a correctness one.
Reproduced and verified through the real renderer with the reported shape (2 tasks x 6
park/resume cycles = 12 rows): `dev` renders `[ALL BACKGROUND TASKS FINISHED - 10 FAILED]`
with 12 task lines and mid-flight `[RUNNING]` rows under a `Failed:` heading; patched renders
`[BACKGROUND TASK COMPLETED]` with 2 lines and no `[RUNNING]`. Same-scope suites 1445 pass /
4 fail vs 1440 / 4 on clean `dev` with a byte-identical failing set, typecheck exit 0, build
exit 0, `dedupeByTaskId` confirmed in `dist/index.js`.
Second test pins the direction that matters more than the headline one: a task whose LAST
state is a genuine failure is still counted once as failed, so the dedupe cannot silently
swallow real failures. Evidence: `.omo/evidence/20260821-summary-park-dedupe/`.

**Update:** (2026-08-24, verified against dev source) **Fixed, at the render boundary rather than the one the entry predicted.** The manager still appends every completion row unconditionally at `packages/omo-opencode/src/features/background-agent/manager.ts:2938-2946` - so the original source citation is still accurate - but the notification template now collapses rows by task id before counting failures: `dedupeByTaskId` at `background-task-notification-template.ts:76-82`, applied at `:93` ahead of the failure filter at `:102` and the `${failedTasks.length} FAILED` render at `:113`. Regression tests at `background-task-notification-template.test.ts:729-773` prove repeated park/resume events collapse to one line with no `FAILED`, while a genuine final error still counts exactly once. Fix commit verified: `7d41a6f23 fix(background-agent): stop replaying every park as a current failure`.

This is why reading the manager alone would have produced a false "still open" - the compensating mechanism is one module downstream.

**Fix status (2026-08-24):** fixed in `7d41a6f23`. Residual is cosmetic: duplicate rows are still retained in memory at `manager.ts:2938-2946`. Severity revised `costly` -> `papercut`.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed fixed. `7d41a6f23` (`fix(background-agent): stop replaying every park as a current failure`) resolves and is an ancestor of `dev`. The renderer dedupes by task id keeping last state (`background-task-notification-template.ts:76-82`) and applies it before terminal-state counting (`:92-102`), so a task that parked repeatedly is rendered once at its final state. Cross-checked for a second summary builder: `buildBackgroundTaskNotificationText` has exactly two references (`background-task-notification-template.ts:84`, `manager.ts:3061`), and `parent-wake-dedupe.ts:121-133` only classifies existing headers. Pinned by `background-task-notification-template.test.ts:729` (repeated parks render one line each) and `:755` (a genuine final failure is still counted once). The cosmetic residual is confirmed unchanged: manager still pushes one row per notification without task-id replacement (`manager.ts:3013-3024`), cleared at batch end (`:3044-3050`).

**Fix status (2026-08-27):** fixed. Severity stays `papercut`.

## 2026-08-17 — `report_blocked` used for waiting, not for blocking

**Severity:** costly
**Area:** subagents
**Observed in:** `~/git/onara`, across ~8 lanes

**What happened:** subagents repeatedly parked via `report_blocked` on situations that
required no parent decision at all — most often a long-running gradle job **they had
started themselves** that was either still alive or had already finished successfully. One
lane parked twice this way; each park cost a full round-trip. In one case the agent had a
completely green board (`detekt` `BUILD SUCCESSFUL`, `.rc` = 0, no gradle process alive)
and parked anyway rather than reading it.

The same mechanism was also used correctly and valuably: a different lane parked four
times and every one was a genuine defect needing my decision (a repository signature that
could not express its own acceptance criteria, a missing Flyway migration, a missing pgen
enum entry, a dead enum constant). So the tool works; the calibration of *when* to use it
does not.

**Evidence:** representative false park —
```
Blocked: Final detekt process remains active after tool timeout;
         source/evidence edits uncommitted.
Needs from parent: Resume lane after detekt completes.
```
State at that moment: `/tmp/j23-detekt-final.log` → `BUILD SUCCESSFUL in 1m 25s`,
`/tmp/j23-final.rc` → `0`, `pgrep -f gradlew` → nothing running.

**Root cause / hypothesis:** the `report_blocked` tool description says to use it "if
blocked and parent input is required", but gives no test for distinguishing *blocked* from
*waiting*. A slow job that outlives a tool timeout reads to the agent as an external
condition it cannot resolve. Compounded by the detached-job finding above: an agent that
cannot be woken by its own job has no other move it trusts.

**Workaround:** state the distinction explicitly in the lane prompt — *waiting is not
blocking* — plus the three concrete checks to run before parking: `pgrep -f gradlew`,
`cat /tmp/<job>.rc`, `tail` the log. Park only for something the parent alone can decide:
an ambiguous spec, a missing API, a cross-lane conflict.

**Fix status:** worked around per-prompt. A durable fix would put the waiting-vs-blocking
test into the `report_blocked` tool description itself, so it applies without every parent
re-teaching it.

**Update:** (2026-08-21, verified against `dev` source) Still open. The durable fix this
entry asked for was never made, and the workaround is still per-prompt.
The tool description is unchanged and still ambiguous —
`tools/report-blocked/tools.ts:14-16` says only "cannot continue without parent input" and
"parks the current background task until the parent resumes it". It offers no test to
separate a genuine block (parent must decide) from a wait (a job that will finish on its
own). An agent poll-waiting on its own long job reads "cannot continue" as a fair
description of its situation, which is precisely how the misuse happens.
Cross-checked every place that could have carried the distinction instead. The subagent
system prompt repeats the tool description verbatim rather than adding to it
(`tools/delegate-task/prompt-builder.ts:16-18`). No rule under `.omo/rules/` addresses it.
The test suites (`tools/report-blocked/tools.test.ts`, `features/background-agent/blocked-notify.test.ts`)
pin the tool's mechanics but never the wait-vs-block decision. And
`docs/reference/blocked-escalation-follow-up.md:19-25` records that the user-facing
reference entry for `report_blocked` was an acceptance criterion of the original feature
and was never written — so the gap is documented as owed, not disputed.
Severity: revise to `docs-gap`. Every branch of the real fix is wording — the tool
description, the delegation prompt, and the missing reference entry. The mechanism works;
only its trigger condition is under-specified.

**Fix status (2026-08-21):** still unfixed, severity revised `costly` -> `docs-gap`. Three
wording changes close it: the tool description at `tools/report-blocked/tools.ts:14-16`, the
delegation prompt at `tools/delegate-task/prompt-builder.ts:16-18`, and the owed reference
entry noted in `docs/reference/blocked-escalation-follow-up.md:19-25`.

**Update:** (2026-08-24, verified against dev source) Still open, and the fix is still wording. The tool description at `packages/omo-opencode/src/tools/report-blocked/tools.ts:12-20` still says only "cannot continue without parent input" and asks what prevents progress - it never says that a job which will finish on its own is *waiting*, not *blocked*. The delegation prompt repeats the same incomplete framing at `packages/omo-opencode/src/tools/delegate-task/prompt-builder.ts:16-18`. A repo-wide search of `packages/prompts-core/` and `.omo/rules/` found no wait-versus-block instruction anywhere. The owed user-facing documentation is still listed as missing at `docs/reference/blocked-escalation-follow-up.md:15-24`. The runtime mechanism itself is correct - it parks the task as designed (`tools.ts:38-50`).

**Fix status (2026-08-24):** still unfixed, severity confirmed `docs-gap`. Contained fix: add the distinction to the tool description, mirror it in `prompt-builder.ts`, and add the owed row to `docs/reference/features.md`.

**Fix status (2026-08-24, fixed):** fixed locally. Both remaining wording sites now separate blocked from waiting: the tool description at `packages/omo-opencode/src/tools/report-blocked/tools.ts:14-16` and the subagent prompt at `packages/omo-opencode/src/tools/delegate-task/prompt-builder.ts:17-19`. Both now say the tool is for a decision, credential, missing API, or clarification only the parent can supply, and explicitly NOT for a long-running or detached job that is still executing - a job that is still running is not a blocker, poll it. The existing parking semantics text was left intact, and the `docs/reference/features.md:681` row was already correct.

**Update:** (2026-08-24, second pass, verified against `dev` source) One third of the scoped fix has quietly landed and the rest has not. The owed reference row now exists at `docs/reference/features.md:681`, and it already describes the parking semantics correctly. The two wording sites do not: the tool description at `packages/omo-opencode/src/tools/report-blocked/tools.ts:14-16` and the subagent prompt at `packages/omo-opencode/src/tools/delegate-task/prompt-builder.ts:16-18` both say only that the tool parks the task until the parent resumes it, with nothing distinguishing *blocked on parent input* from *waiting on a detached job*. Remaining fix is now two wording edits, not three.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed fixed at both wording sites, and both are committed, not working-tree-only. The tool description at `packages/omo-opencode/src/tools/report-blocked/tools.ts:16` now says a still-running detached job is not a blocker and must be polled; the subagent prompt at `packages/omo-opencode/src/tools/delegate-task/prompt-builder.ts:21` repeats it. The `docs/reference/features.md:681` row is correct. Residual worth naming: no test asserts the wording, so a future edit could silently drop it (`report-blocked/tools.test.ts:26-60` and `prompt-builder.test.ts:122-132` assert mechanics and presence only).

**Fix status (2026-08-27):** fixed, wording only, unpinned by tests. Severity stays `docs-gap`.

## 2026-08-17 — Mid-batch background completions starve a busy parent; delivery bounded, retention not

**Severity:** blocker
**Area:** background tasks
**Observed in:** `~/git/onara` (orchestrator), diagnosed in `~/git/oh-my-openagent`

**What happened:** an orchestrator fires 3–8 `task(run_in_background=true)` agents and
keeps working. Over a two-day span, mid-batch completions almost never woke it — turn after
turn ended with "I'll report when they land", and the trigger never arrived. When
notifications did arrive they were usually the final `[ALL BACKGROUND TASKS COMPLETE]`,
sometimes twice for one batch. `background_output(task_id="bg_…")` frequently returned
`Task not found` even as the *first* action after a notification; recovery only ever worked
through `session_read` / `task(task_id="ses_…")`. The subagent *sessions* survive; the
`bg_*` registry entries do not.

User's words: *"since 2 days you always say that you will report as soon as the background
jobs return, but you never get any kind of trigger or continue on your own. The work just
dies."*

**Evidence:** two mechanisms, only one of which is now closed.

- Only `shouldReply` wakes (`allComplete || isTaskFailure || isBlocked`,
  `features/background-agent/manager.ts:2965-2968`) qualify for the 60s force-dispatch
  ceiling — `shouldForceDispatchAfterActiveDefer` gates on `wake.shouldReply`
  (`parent-wake-flush-runner.ts:295-297`, ceiling `:23`). A mid-batch success is
  `shouldReply === false` and never qualifies.
- The retention guard in `scheduleTaskRemoval` pins a task only while a **shouldReply**
  wake is owed — three states, all `shouldReply === true` or an in-flight dispatch
  (`manager.ts:2496-2516`). A `noReply` wake does not pin its task, so
  `TASK_CLEANUP_DELAY_MS` can reap it while its notification is still queued.

**Root cause:** a deliberate design tension, not a plain bug. Interrupting a working
orchestrator for every sibling completion was intentionally avoided; the cost is that a
parent which never idles defers `noReply` wakes indefinitely, and the result expires
underneath the notification.

**Update / partial fix (verified in source):** the *delivery* half is closed. A second,
longer ceiling now re-admits a starved retained wake as a `noReply` deposit —
`PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS` = 300s,
`shouldAdmitRetainedWakeAfterCeiling` (`parent-wake-flush-runner.ts:28`, `:299-309`),
deliberately kept above the 60s reply ceiling so the reply path gets its chance first.
Landed across `a47f804c9` → `c0af74ee1` → `e01b03315`, pinned by a 9-test suite
(`parent-wake-midbatch-starvation.test.ts`), including the two cases that matter here:
*"a mid-batch noReply wake with no final wake ever arriving … is delivered within a bounded
deadline"* (`:446`) and the busy-parent merge case (`:141`).

The *retention* half is still open: `wakeStillOwed` (`manager.ts:2496-2516`) remains
`shouldReply`-only, so a deferred mid-batch wake still cannot pin its own task against
cleanup. That is the `Task not found` path, and it is the minimum correct remaining fix.

**Workaround:** on `Task not found`, fall back to `session_read(session_id="ses_…")` — the
session id is carried on every notification line. Do NOT raise `TASK_CLEANUP_DELAY_MS`; it
converts a loud failure into a rare one and leaves the ordering bug intact.

**Fix status:** partially fixed — delivery bounded in `a47f804c9`/`c0af74ee1`/`e01b03315`;
retention of `noReply` wakes unfixed. Full context and the required failing-test approach:
`HANDOFF-PROMPT-mid-batch-wake-starvation.md` (repo root, untracked).

**Update (2026-08-17, second pass — this entry's own diagnosis was partly wrong):** the
entry above was written from the *untracked root copy* of the handoff prompt. A **tracked,
54-lines-longer copy exists at `.omo/plans/HANDOFF-PROMPT-mid-batch-wake-starvation.md`**
(committed in `c9fc012ae`), and it corrects two things this entry got wrong. That tracked
copy is authoritative; the root copy is stale and should not be cited.

- **The `Task not found` symptom is NOT the retention race described above.** That framing
  is falsified by a production log ledger (n=6): `bg_a4f323d2` completed 14:47:01 and was
  missing 14:47:09 — **8.8 seconds later**, against a 10-minute `TASK_CLEANUP_DELAY_MS`,
  with no removal line ever logged. Across all six observed ids, `Removed completed task
  from memory` lands 6–8 minutes *after* the failed lookup, never before it. No retention
  timer produces an 8.8s miss. The real mechanism is a **process/realm boundary**:
  `background_output` runs in a different OS process than the one whose in-memory
  `BackgroundManager` owns the task. `create-background-output.cross-instance.test.ts`
  (green) proves two managers in ONE realm still share the `globalThis` registry, so a
  same-realm split cannot produce the symptom.
- **That failure is now closed**, not by anything retention-shaped, but by a transcript-scan
  fallback: `findSessionIdInParentTranscript` recovers the child session id from the
  calling session's own transcript, which is server/DB-backed and therefore readable from
  every runtime (`tools/background-task/create-background-output.ts:12`, `:88`, `:105-116`,
  note text `:144`). Verified green this session: 19 tests pass across
  `create-background-output.cross-instance.test.ts` + `parent-transcript-pairing.test.ts`.

What remains true: `wakeStillOwed` (`manager.ts:2496-2516`) is still `shouldReply`-only, so
a mid-batch wake still does not pin its own task. That is a real ordering weakness worth
closing — but it is **not** the cause of the `Task not found` incidents that motivated this
entry, and fixing it would not have prevented them.

**Fix status (revised):** delivery bounded (`a47f804c9`/`c0af74ee1`/`e01b03315`);
cross-process lookup closed by the transcript-scan fallback; `noReply` retention remains
open as a lower-severity ordering issue, no longer blocker-grade. Authoritative context:
`.omo/plans/HANDOFF-PROMPT-mid-batch-wake-starvation.md` (tracked), not the untracked root
copy.

**Update:** (2026-08-21, verified against `dev` source) Both halves confirmed closed, plus a
residual worth naming. This is the entry a previous pass got wrong by checking one ceiling
and stopping, so both were checked this time.
DELIVERY is bounded. Two ceilings exist, not one:
`PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS = 60_000` (`parent-wake-flush-runner.ts:23`) and
`PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS = 300_000` (`:28`). The first,
`shouldForceDispatchAfterActiveDefer` (`:295-297`), is gated on `shouldReply` — which is
what made the earlier pass call the whole thing open. The second,
`shouldAdmitRetainedWakeAfterCeiling` (`:303-309`), is NOT gated on `shouldReply`: it
re-admits on elapsed time alone, so a `noReply` mid-batch wake is delivered within a bounded
deadline even if no final wake ever arrives. Nine tests pin it in
`parent-wake-midbatch-starvation.test.ts`, including the no-final-wake case (`:446`), the
busy-parent merge (`:141`), and a parked failure wake aging past the ceiling (`:348`).
RETENTION is closed too, but the original diagnosis of it was wrong and the entry already
records the retraction: `Task not found` was a cross-process realm boundary, not a
cleanup-timer race, and it is closed by the parent-transcript fallback
(`create-background-output.ts` → `parent-transcript-pairing.ts`) with its own test suites.
Residual, and it is real: `wakeStillOwed` remains `shouldReply`-only, so a mid-batch
`noReply` wake still does not pin its own task. That is an ordering weakness, not a
starvation path — the 300s retained-admit ceiling is what guarantees delivery regardless.
Severity: revise to `costly`. The blocker-grade symptom (a completion that never arrives)
is bounded and pinned by tests; what remains is ordering.

**Fix status (2026-08-21):** delivery bounded and pinned (`parent-wake-flush-runner.ts:28`,
`:303-309`, nine tests); cross-process retention closed via the parent-transcript fallback.
Residual `shouldReply`-only `wakeStillOwed` ordering weakness remains open at `costly`.

**Update:** (2026-08-24, verified against dev source) Verified separately per half, with the earlier false-verdict trap explicitly avoided.

*Delivery: fixed.* Two ceilings now exist, not one. `PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS = 60_000` at `parent-wake-flush-runner.ts:23`, and the second ceiling `PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS = 300_000` at `:28`. `shouldForceDispatchAfterActiveDefer` is indeed still `shouldReply`-gated at `:295-297` - which is what misled the first verifier - but `shouldAdmitRetainedWakeAfterCeiling` at `:303-309` closes the noReply path, and the active-session flush drives it with `forceNoReply: true, retainPendingWake: true` at `:61-81`. Pinned by `parent-wake-midbatch-starvation.test.ts:184-239` and `:446-496`.

*Retention: still open.* Task cleanup still counts only `pendingParentWake?.shouldReply`, `dispatchedParentWake?.shouldReply`, or an in-flight dispatch toward `wakeStillOwed` at `manager.ts:2545-2553`. A pending noReply wake does not pin its completed task; cleanup is bounded only by `TASK_TTL_MS`. Retention coverage at `task-completion-retention-guard.test.ts:304-539` tests the shouldReply cases, not this one.

**Fix status (2026-08-24):** delivery fixed and pinned; retention still open at `manager.ts:2545-2553`. Severity revised `blocker` -> `costly`: unbounded parent starvation is gone, and the remainder is an in-memory lookup window, not a delivery failure.

**Update:** (2026-08-24, second pass, verified against `dev` source) Retention confirmed still open, read directly rather than taken from a verifier. `wakeStillOwed` at `manager.ts:2547-2552` is the disjunction of `pendingParentWake?.shouldReply === true`, `dispatchedParentWake?.shouldReply === true`, and `hasInFlightParentWakeDispatch(...)` - a pending `noReply` wake contributes nothing, so the guarded reschedule at `manager.ts:2553-2556` does not fire for it and the task is removed on the ordinary `TASK_TTL_MS` path. Cross-checked for a compensating sibling mechanism: no `RETAIN` / `MAX_RETAINED` / `evict` exists in `features/background-agent/`; `prune` appears only in stale-task pruning (`manager.ts:3184`, `task-poller.ts:33`), and the `create-background-output.ts` transcript fallback is cross-runtime recovery, not retention. The failing test that would express it: complete a task holding only a pending `noReply` wake, fire the cleanup timer before `TASK_TTL_MS`, assert `getTask(taskId)` is still defined - beside the existing `shouldReply`-only cases at `task-completion-retention-guard.test.ts:304-539`.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Split confirmed, and the retention half is now located precisely. Delivery is bounded and pinned: `PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS = 60_000` and `PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS = 300_000` at `parent-wake-flush-runner.ts:23-28`, with the retained-admission predicate at `:303-308` deliberately ungated by `shouldReply`, delivering as `forceNoReply` at `:70-80`; three tests pin it (`parent-wake-midbatch-starvation.test.ts:141`, `:184`, `:446`). Retention is open at an exact predicate: `wakeStillOwed` recognizes only pending-`shouldReply`, dispatched-`shouldReply`, or in-flight dispatch (`manager.ts:2623-2630`), so a completed task whose only outstanding wake is `noReply` contributes nothing and is cleaned up on `TASK_TTL_MS` (`:2608-2615`, `:2631-2635`). Existing retention tests cover the `shouldReply` and in-flight states only (`task-completion-retention-guard.test.ts:304-420`); no test pins pending-`noReply` retention.

**Fix status (2026-08-27):** partially fixed, unchanged. Severity stays `costly`. The contained fix is a failing test for completed-task-with-pending-`noReply`-wake, then widening `wakeStillOwed` at `manager.ts:2623-2630`.

## 2026-08-17 — Findings log had no review path; three entries were stale within hours

**Severity:** costly
**Area:** other
**Observed in:** `~/git/oh-my-openagent`

**What happened:** the first pass over this log after its creation found that of five
entries, one diagnosis was outright wrong (`<unpolled-background-shell-jobs>` "fires once"
— it does not; the real defect was MCP tracking), one had been fixed in commits already on
`dev` at the time the finding was written, and one had been half-fixed. The capture rule
(`~/.omo/rules/harness-findings.md`) mandates *appending*; nothing mandated ever *reading*
the log back. Entries therefore rot at the speed the harness is fixed, which is fast.

**Evidence:** `b9b0a8b5c` and `8810f3174` were both on `dev` when the "fires once" entry
was written; `a47f804c9`/`c0af74ee1`/`e01b03315` had already bounded mid-batch delivery.
None were referenced by any entry.

**Root cause:** an append-only log with no scheduled verification pass is a write-only
store. Worse, a stale `unfixed` entry is actively harmful: it is exactly the artifact the
next agent trusts, and it will send that agent to re-diagnose a solved problem.

**Workaround:** a verification pass — one background `explore` per entry, each required to
answer with `file:line` and commit SHAs, then `**Update:**` lines appended. Note that even
this pass produced a wrong answer (an agent reported the mid-batch defect fully open
because it checked only the first of two ceilings); a second, targeted read caught it.
**Corollary: verification agents need their conclusions cross-checked, not just their
citations.**

**Fix status:** needs-decision — a `harness-findings-review` skill (triage → verify →
re-score severity → route the top findings into work) would make the read side routine
instead of accidental.

**Update:** (2026-08-21, verified against `dev` source) Fixed — and this update is itself
the proof, since it was produced by the mechanism the entry asked for.
Both halves exist. The capture rule is present at `~/.omo/rules/harness-findings.md`
(user-scope, 3.6 KB, dated 2026-08-17) — a verifier on this very pass reported it missing
after globbing only the repo's `.omo/rules/`, which is the wrong directory for a user-scope
rule; `ls ~/.omo/rules/` shows it alongside `worktrees.md` and
`worktree-parallel-safety.md`. The read-back skill is present at
`.agents/skills/harness-findings-review/SKILL.md` and prescribes the workflow this pass
followed: inventory by headings, one background `explore` per entry, mandatory independent
cross-check of every "still open", append-never-rewrite, re-score severity, propose without
starting, commit the log alone.
Manual-invocation-only is intact: no hook, command registration, or session-start path in
`packages/`, `.opencode/`, or `.agents/` references `harness-findings-review`. It ran here
because a human asked.
One gap remains, small and worth closing: the capture rule does not mention the review skill
(`grep -c harness-findings-review ~/.omo/rules/harness-findings.md` → 0), so an agent that
appends a finding is never told a read-back path exists. Revise status to `fixed`, with that
cross-reference as follow-up.
First-pass validation of the skill: 11 entries, 11 verifiers, and the cross-check step
caught two verifier errors that would otherwise have been written into this log as fact —
the missing-capture-rule claim above, and an entry reported as missing its `Fix status:`
line when it has one at `:245`. The cross-check requirement is load-bearing.

**Fix status (2026-08-21):** fixed — capture rule at `~/.omo/rules/harness-findings.md`,
read-back skill at `.agents/skills/harness-findings-review/SKILL.md`, manual-only wiring
confirmed. Follow-up: the capture rule does not yet mention the review skill.

## 2026-08-18 — Subagents summarize mutation-test output instead of pasting it, making evidence unfalsifiable at review time

**Severity:** costly
**Area:** subagents
**Observed in:** `~/git/onara`, 23-todo wave, 7 lanes affected (tasks 15–21)

**What happened:** lanes were instructed to capture RED-before-GREEN and mutation proofs
into an evidence file. Seven of them wrote the *conclusion* rather than the *output*:

```text
A. Executed. Mutated `GENERATED_DRILL_ENRICHMENT_SCOPE` to set `backfillCatalogTags = true`.
Named test `execute enqueues generated drills with translation and image scope excluding
catalog tags` failed: `generated-drill scope must exclude authored catalog tags ==>
expected: <false> but was: <true>`.
```

That reads as a real result but contains no command line, no `rc=`, no `FAILED` line, no
XML counts. A later audit lane (F1) could not distinguish it from invention and issued a
REJECT for "reconstructed prose" across seven todos.

**Evidence:** re-executing two of the claimed mutations reproduced them *exactly* — same
named test, same assertion string (`DisciplineGenerationTaskTest` 13 tests/1 failure;
`TrainingControllerTest` 91 tests/1 failure). The lanes had been honest; the format simply
made honesty unverifiable without re-running the work.

**Root cause (theory):** the instruction said "capture evidence", which a summarizing agent
satisfies with a faithful paraphrase — its default output mode. Nothing in the prompt made
*verbatim* the requirement, and a paraphrase of a real run is indistinguishable from a
paraphrase of an imagined one.

**Cost:** one full audit lane's REJECT plus two re-run mutation cycles (~2 min gradle each)
to establish that nothing was actually wrong.

**Workaround:** demand the artifact, not the claim — "paste the command line, the `rc=`
sentinel, the `FAILED` line, and the `tests=/failures=` XML counts; a sentence describing a
failure is not evidence". Cheap and mechanical to check: an evidence file with zero
occurrences of `BUILD ` or `rc=` is prose.

**Fix status:** unfixed — worth hoisting into whatever shared guidance tells subagents to
record verification, since the failure is systemic across lanes rather than per-lane.

**Update:** (2026-08-21, verified against `dev` source) Still open. Evidence discipline
exists but does not reach the subagent that produces the summary.
What exists: the `.omo/evidence/` mandate in `AGENTS.md:21-29` requires "the exact captured
output" and an artifact path, and the `verification-before-completion` skill teaches
run-then-read-then-claim. Both are real, and a subagent that happens to load that skill
would paste raw output.
What is missing is the wiring. The Atlas delegation prompts instruct subagents to "append
findings" (`packages/prompts-core/prompts/atlas/opus-4-7.md:388`,
`packages/prompts-core/prompts/atlas/kimi-k3.md:263`) without ever defining "findings" as
raw command output — no mention of exit codes, test counts, or verbatim pasting. No rule
under `.omo/rules/` covers it, and the skill that would cover it is loaded selectively, not
on every `task()` delegation. So the default path — a subagent reading the delegation prompt
and nothing else — still has no instruction to paste rather than summarize.
Severity: holds at `costly`, and revise the framing to `docs-gap` in terms of fix shape —
the whole fix is prompt wording. What keeps it costly rather than cosmetic is the failure
mode: an honest summary and a fabricated one are indistinguishable at review, so the review
gate silently stops working. Fix is one path-scoped rule plus one line in the Atlas
delegation MUST-DO block.

**Fix status (2026-08-21):** still unfixed. Evidence discipline exists
(`AGENTS.md:21-29`, `verification-before-completion`) but is not wired into the default
delegation path, so the subagent that writes the summary never sees it.

**Update:** (2026-08-24, verified against dev source) Still open, and searched exhaustively rather than assumed. No instruction requiring verbatim tool output - no "paste the raw output, do not summarize" or equivalent - exists in `packages/prompts-core/prompts/`, `.omo/rules/`, `~/.omo/rules/`, the root `AGENTS.md`, or any `.agents/skills/*/SKILL.md`. The closest wording all falls short: Atlas tells subagents to "append findings" without defining findings as raw output (`packages/prompts-core/prompts/atlas/opus-4-7.md:387-389`, `kimi-k3.md:260-272`); the root `AGENTS.md:21-29` demands "the exact captured output" as an artifact but then permits summarizing for secret-bearing material and does not bind default delegation; `codex-qa` calls captured JSON "the evidence" (`SKILL.md:32-36`) without forbidding a prose summary in its place. The one place that does demand exact lines is the findings capture rule itself (`.omo/rules/harness-findings.md:45-50`), which applies to findings, not to every subagent result.

**Fix status (2026-08-24, fixed):** fixed locally at the choke point. The paste-do-not-summarize requirement now lives in `buildTaskPrompt` (`packages/omo-opencode/src/tools/delegate-task/prompt-builder.ts`), as an `<evidence-reporting>` block prepended to every delegated prompt: paste the command, the real pass/fail lines, the counts, and the full failure text; a summarized result is not evidence and is treated as unverified, because an honest summary and a fabricated one are indistinguishable at review.

Site choice matters here, so it is recorded. `buildSystemContent` was rejected because it returns `undefined` for a plain category delegation, so it is not a choke point. The nine `sisyphus-junior` model variants were rejected as a shotgun that would still miss non-category `subagent_type` delegations. `packages/prompts-core/prompts/` reaches the PARENT, not the spawned subagent. `buildTaskPrompt` is the single funnel: all four non-continuation delegation call sites route through it - background (`background-task.ts:117`), sync (`sync-session-lifecycle.ts:33`, `sync-prompt-sender.ts:88`), forced-background (`unstable-agent-task.ts:32`), and resume (`sync-continuation.ts:160`).

**Fix status (2026-08-24):** still unfixed. Severity revised `costly` -> `docs-gap` per the review rule that a finding whose real fix is wording is a docs-gap regardless of cost - the operational impact remains high, since a summarized result and a fabricated one are indistinguishable at review.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
The two contradictory statuses above are settled: line 896 (`fixed`) is correct and line 900 (`still unfixed`) is stale. `EVIDENCE_REPORTING` exists verbatim at `packages/omo-opencode/src/tools/delegate-task/prompt-builder.ts:16-19` and is prepended unconditionally to all three prompt shapes (non-plan `:102-105`, plan `:107-108`, background `:111-112`). Every delegation route reaches one of them: `background-task.ts:117`, `sync-session-lifecycle.ts:33`, `sync-prompt-sender.ts:88`, `sync-continuation.ts:160`, `unstable-agent-task.ts:32`. Pinned by three tests (`prompt-builder.test.ts:138`, `:153`, `:167`). Cross-checked `packages/prompts-core/`, `.omo/rules/`, and `.agents/skills/` for a duplicate requirement and found none, so the choke point is the only site, which is the right place for it.

**Fix status (2026-08-27):** fixed at the choke point; the 2026-08-24 `still unfixed` line above is retracted as stale. Severity `docs-gap` retained for the record.

## 2026-08-21 — OpenDesign kills in-flight background subagents at parent turn end, then reports them `completed`

**Severity:** blocker
**Area:** background tasks
**Observed in:** Open Design desktop app (Onara design-canvas project); same plugin build works correctly in the CLI TUI

**What happened:** Three `task(..., run_in_background=true)` builder subagents were launched to
write four HTML mockups. All three were terminated within 550 ms of the parent's `step-finish`,
having written **zero** files, and every one was reported to the parent as `completed`. An earlier
pair of `explore` agents in the same session died the same way but had already finished their
work, so the kill was invisible and they looked successful. This is distinct from the
notification/lookup defects logged on 2026-08-17: the tasks here are not lost after completing —
they are **killed before completing**.

**Evidence:**

Parent `step-finish` at `19:43:33.851`; all three children dead within 550 ms
(`opencode.db`, `part` table, `session_id` = each child):

```
agent     start     death          parts  outcome
buildA    19:42:19  19:43:34.396   32     tool:write = error
buildB    19:42:47  19:43:34.304   17     never reached write
buildC    19:43:17  19:43:34.205   15     never reached write
```

buildA's terminal part — note the empty `input`, i.e. the call was aborted before its
arguments were delivered, so this is not a permission or path error:

```json
{"tool":"write","state":{"status":"error","error":"Tool execution aborted","input":{}}}
```

Every child's part stream ends `... reasoning → patch` with **no** `step-finish` and no error
part — an external termination, not a model stop. Meanwhile the parent reported:

```
[BACKGROUND TASK COMPLETED]
[ALL BACKGROUND TASKS COMPLETE]
- `bg_919157ea`: Build discipline safety + cautioned pages
```

and `ls redesign/*.html` was unchanged at 101 files.

Control: the earlier `explore` pair died at the *previous* parent `step-finish`
(`19:30:39`–`19:30:40`), confirming the trigger is turn end rather than a per-task fault.

**Root cause / hypothesis:** *Hypothesis, from process topology — not yet confirmed in OMO source.*
Two independent `opencode` servers exist on this machine:

```
TUI         pid 4454   ppid 3993 (login shell)          uptime 6h50m
OpenDesign  pid 68874  ppid 46475 (Open Design Helper)  uptime ~1h
```

This agent's ancestry is `Python → lean-ctx → opencode(68874) → Open Design Helper(46475) →
Open Design(46465)`. In the TUI, `opencode` is a long-lived daemon owned by the user's shell, so
a detached child outlives any single turn and its notification lands later. Under OpenDesign the
server is a child of the app helper and its lifecycle appears bound to the request/response
cycle, so in-flight children are torn down when the assistant turn completes. That would also
explain the `owned by a different runtime than the one serving this tool call` warnings and the
mid-word truncation of transcript-recovered results seen in the same session — per-turn runtimes,
with recovery falling back to a capped transcript replay.

**Workaround:** in OpenDesign, do not use `run_in_background=true`. Use synchronous `task()`
(which holds the turn open) or do the work inline. The four mockups were produced inline after
the delegated builds died.

**Fix status:** unfixed — needs-decision. Three options, in descending value: (1) give detached
children their own lifecycle under OpenDesign, as the TUI daemon has; (2) if teardown is
intentional, report the task as `aborted`, never `completed`; (3) reject `run_in_background=true`
in this harness rather than accepting and silently killing. The false `completed` is the
expensive part — a task that dies loudly costs one retry, one that dies claiming success cost a
full session here.

**Update (2026-08-21, same session):** hypothesis confirmed, and the fix splits across two
owners. The mechanism is **not** an app-side teardown of a long-lived server — it is the
choice of entrypoint.

OpenDesign spawns a **one-shot batch process per turn**:

```
opencode run --format json -s ses_fdaa167f5ffeARGckJ5AbwtXeg -m onara/sisyphus
```

The CLI TUI instead runs one persistent process (`opencode`, bare, no args) for the whole
session. Proof the OpenDesign process is per-turn, not per-session: across two consecutive
turns of the *same* session the PID changed while `ppid` stayed constant, each time ~30 s old.

```
turn N    pid 68874  ppid 46475  uptime 37s
turn N+1  pid 79221  ppid 46475  uptime 31s   # same session id on the command line
CLI TUI   pid  4454  ppid  3993  uptime 7h01m # bare `opencode`, one process, all turns
```

`opencode run` exits when its answer completes. A background subagent's contract is
"outlives the current turn", so on a one-shot host it cannot survive by construction. **No
in-process retention or notifier change in OMO can fix that** — which also retro-explains the
Wave-5 puzzle in `HANDOVER-background-task-notification-bug.md`, where `bg_a4f323d2` went
missing 8.8 s after completing with *no* `Removed completed task from memory` line ever
logged. A process exit leaves no removal log; nothing logs its own death.

**However, the false `completed` is a genuine OMO defect and is separately fixable.** On
shutdown, terminal tasks are archived but still-running tasks are dropped with no terminal
status written:

```ts
// manager.ts:3486-3491
for (const task of this.tasks.values()) {
  if (TERMINAL_BACKGROUND_TASK_STATUSES.has(task.status)) {
    archiveBackgroundTask(task)
  } else {
    forgetBackgroundTask(task.id)   // still-running -> erased, no status recorded
  }
```

`forgetBackgroundTask` (`task-registry.ts:127-131`) only deletes from `activeTasks` and
`completedTasks`; it records nothing. Shutdown is reached on every exit via
`registerSignal("SIGINT"|"SIGTERM", true)` and `registerSignal("beforeExit"|"exit", false)`
(`process-cleanup.ts:272-278`). The subagent's *session* still persists in `opencode.db`, so
downstream the parent sees a session that exists and has stopped, and reports `completed`.
Persistent state, ephemeral execution, reported as success.

**Ownership split:**

| Fix | Owner | Effort | Value |
|---|---|---|---|
| Use a persistent `opencode serve` + socket instead of `opencode run` per turn | OpenDesign | large | Actually restores background tasks |
| Mark non-terminal tasks `aborted` (reason `host-shutdown`) and archive, instead of `forgetBackgroundTask` at `manager.ts:3490` | OMO | small | Removes the deception on every one-shot host |
| Detect a one-shot host and reject `run_in_background=true` up front | OMO | small-medium | Stops the trap being entered at all |

The third needs new code: there is currently no one-shot/headless detection in the
background machinery (`process.argv` appears only in `mcp/lsp.ts` and `cli/codex-ulw-loop.ts`).

Revised severity split: `blocker` for OpenDesign (feature is unusable there), `costly` for
OMO (the silent drop is what converts an honest limitation into lost work).

**Update:** (2026-08-21, verified against `dev` source) Confirmed open, with the ownership
split sharpened. Two distinct defects sit behind one symptom, and only one of them is ours.
The kill is not ours and is not fixable here. OpenDesign spawns `opencode run --format json`
per turn; that process exits when its answer completes, so a background subagent — whose
whole contract is to outlive the current turn — cannot survive on a one-shot host by
construction. No `step-finish` handler in this repo does the killing. Searched for a
compensating path and found none: no keep-alive, no detach-from-parent, no re-dispatch on
abort. `OMO_DISABLE_PROCESS_CLEANUP=1` disables only the error-event listeners; the signal
handlers stay registered (`process-cleanup.ts:181-185,272-278`).
The false `completed` IS ours, and the quoted snippet still matches current source exactly
(`manager.ts:3486-3491`). On shutdown, a task already in a terminal status is archived with
its status written; anything still `running` falls to the else branch and is handed to
`forgetBackgroundTask()`, which deletes it from `activeTasks`/`completedTasks` and writes
nothing (`task-registry.ts:127-131`). With no terminal record, the parent later reads the
child session, sees it stopped without an explicit failure, and reports `completed`. That
is what converts an honest platform limitation into silently lost work.
Test coverage confirms the gap: `manager-shutdown-global-cleanup.test.ts:66-110` asserts
shutdown clears session registrations, but nothing asserts what status a still-running task
receives. `git log` since 2026-08-19 touches releases and senpi bumps only — nothing in
`manager.ts` or the shutdown status path.
Severity: hold at `blocker` for the OpenDesign host, but note that our half — option 2, mark
still-running tasks `aborted` and archive them at `manager.ts:3490` — is small, contained,
and removes the silent drop on every one-shot host, not just this one. That is the piece
worth doing regardless of what OpenDesign decides.

**Fix status (2026-08-21):** still unfixed, ownership split confirmed. The kill is an
OpenDesign one-shot-host property and is not fixable in this repo. The false `completed`
is ours and is contained: `manager.ts:3490` drops still-running tasks through
`forgetBackgroundTask()` (`task-registry.ts:127-131`) without writing a terminal status.

**Update:** (2026-08-21, fixed in `9096d20da`) Our half is closed. Verification turned up a
SECOND source the original entry did not name, and it was the one actually producing the
reported symptom: `create-background-output.ts:119` hardcoded `status: "completed"` on the
task it reconstructs from the parent transcript — for ANY unreachable task, not just killed
ones. Because the registry is per-process (`globalThis`, `task-registry.ts:11-30`), the
parent's `background_output` on a one-shot host misses the lookup regardless of what
shutdown wrote and falls straight to that path. Fixing only the shutdown side would have
left the false `completed` fully intact.
Both are fixed. `manager.ts` now archives a terminal CLONE of any non-terminal task, stamped
`cancelled` with a FINAL-cancellation reason, instead of calling `forgetBackgroundTask()`.
Cloning is load-bearing: the first revision mutated the live task object and broke two
poller tests that assert the poller left a task `running` — shutdown must not rewrite state
a caller still holds. The recovery path no longer asserts an outcome it cannot observe; it
renders `Status: unknown (recovered from transcript; this runtime cannot observe the task's
outcome)` and says in prose that the transcript does not prove completion.
Evidence (`.omo/evidence/20260821-shutdown-abort-status/`): driven through the real manager
cross-manager and the real `background_output` tool, before and after. On `dev` the recovery
path renders `Status: completed`; patched it renders `Status: unknown`. Same-scope suites
1443 pass / 4 fail patched vs 1440 pass / 4 fail on clean `dev`, failing set byte-identical,
typecheck exit 0, build exit 0, both strings confirmed in `dist/index.js`.
One invariant was deliberately inverted: the test formerly named "should forget active
registry tasks during earlier manager shutdown" asserted a killed task must become
unreachable, which is the bug itself. Rewritten, not deleted, keeping its cross-manager
check — commit `982fa8136` already established that terminal tasks stay visible across
managers by design.
The OpenDesign half remains open and is not fixable here: `opencode run` exits at turn end,
so a background subagent cannot outlive it by construction. Severity for the host-side issue
stays `blocker`; the silent-false-success half is closed on every one-shot host.

**Update:** (2026-08-24, verified against dev source) Verified separately per half; the ownership split the entry predicted is confirmed, and our half is now closed.

*Mislabeling (ours): fixed.* `BackgroundManager.shutdown()` now archives every still-running task as a cloned `cancelled` record carrying a FINAL-cancellation reason at `manager.ts:3586-3602`, instead of dropping it. Cross-runtime `background_output` recovery no longer asserts success: it carries task status `running` and renders `Status: unknown` with an explicit warning that a transcript does not prove completion (`create-background-output.ts:111-148`). Fix commit verified: `9096d20da fix(background-agent): stop reporting killed in-flight tasks as completed`. Tests at `manager-shutdown-global-cleanup.test.ts:159-203` pin both the cancel-on-shutdown path and terminal-status preservation.

*The kill itself (OpenDesign's): still open.* The one-shot `opencode run` lifecycle still terminates in-flight background tasks at parent turn end. Nothing in our source can keep them alive.

Note for anyone extending this: there is still no `aborted`/`killed` status (`types.ts:5-11`) and no parser for the literal `"Tool execution aborted"` string anywhere in source - that string appears only in this log and in evidence files.

**Fix status (2026-08-24):** OMO false-success reporting fixed in `9096d20da`; the external kill remains unfixed and stays a `blocker` for OpenDesign specifically, where background work is unusable by construction.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
OMO-side half confirmed fixed; `9096d20da` (`fix(background-agent): stop reporting killed in-flight tasks as completed`) resolves and is an ancestor of `dev`. Shutdown archives every non-terminal task as `cancelled` with a FINAL-cancellation error (`manager.ts:3664-3678`), and cross-runtime transcript recovery renders `Status: unknown` with an explicit warning rather than claiming success (`create-background-output.ts:119-148`). Pinned by `manager-shutdown-global-cleanup.test.ts:159` (running becomes `cancelled`), `:186` (already-terminal `completed` is preserved), and `create-background-output.cross-instance.test.ts:273` (recovered killed task is not `completed`). The external kill is unchanged and remains outside this repository.

**Fix status (2026-08-27):** OMO half fixed and verified; external kill still unfixed, still a `blocker` for OpenDesign specifically.

## 2026-08-21 — `session.status()` polled without a directory, but the endpoint is directory-scoped

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/oh-my-openagent`
**What happened:** found while auditing the stale-task poller, not from a user-visible
failure — so treat the impact as indicated rather than confirmed.

`BackgroundManager.pollRunningTasks` queries `this.client.session.status()` with no
`directory` argument (`manager.ts:3300`), while every neighbouring call passes one:
`checkSessionExistence` sends `query: { directory }` (`session-existence.ts:45-48`), and
children are created with the PARENT session's directory
(`spawner.ts:54-64`, `parentDirectory = parentSession?.data?.directory ?? directory`), which
need not equal `manager.directory`.

**Evidence:** the endpoint is directory-filtered. With one session busy in `proj`:

```
no-dir   : {"ses_fd98553b3ffemCqhQrB29344n7":{"type":"busy"}}
dir=proj : {"ses_fd98553b3ffemCqhQrB29344n7":{"type":"busy"}}
dir=other: {}
dir=/tmp : {}
```

Full artifact: `.omo/evidence/20260821-poller-not-busy/oracle-server-probe/probe6.txt`
(real `opencode serve` 1.18.15, XDG-isolated sandbox).

**Root cause / hypothesis:** hypothesis, not yet proven end to end. A background session
spawned into a directory other than the manager's would be absent from whatever map the
no-argument call returns, making `sessionNotBusy` true forever for that task and pushing it
onto the inactivity ladder regardless of how busy it actually is. I could not close the loop
because the cross-directory prompt in the sandbox failed with an unrelated provider error.

**Workaround:** none needed today; the 30-minute prune TTL still bounds such a task.

**Fix status:** unfixed, deliberately. Adding `directory` is behavior-changing in the risky
direction — if the no-argument call currently returns a BROADER map, filtering it would newly
hide sessions and make `sessionNotBusy` fire more often, which is the failure mode we just
proved is dangerous. Needs a real multi-directory server run before either direction ships.

**Update:** (2026-08-24, verified against dev source) Still open, and the surface is wider than the entry recorded. Both cited call sites remain unscoped: `manager.ts:3285` (liveness probe) and `:3398` (`pollRunningTasks`) call `session.status()` with no `query`. Cross-checked for a wrapper supplying the directory one level up - there is none, and `spawner.ts:49-64` can give a child session a parent-derived directory, so the call is not harmless by construction.

Two corrections to the original entry. First, the contrast case is imprecise: `session-existence.ts:39-65` does conditionally scope with `query: { directory }` at `:45-48`, but it calls `session.get`, not `session.status`. Second, this is not two call sites but roughly fifteen. Scoped: `cli/run/completion.ts:87-89`, `cli/run/poll-for-completion.ts:230-232`, `cli/run/prompt-start.ts:38-40`. Unscoped: the two manager sites plus `features/tmux-subagent/polling-manager.ts:70-71`, `features/tmux-subagent/polling.ts:76-77` and `:113-114`, `features/tmux-subagent/session-ready-waiter.ts:20-22`, `features/tmux-subagent/manager.ts:714-718`, `features/tui-sidebar/snapshot-builder.ts:55-62`, `tools/look-at/session-poller.ts:41-47`, `tools/call-omo-agent/completion-poller.ts:33-37`, `tools/delegate-task/sync-session-poller.ts:163-167`, `tools/delegate-task/unstable-agent-task.ts:123-129`, `plugin/unstable-agent-babysitter.ts:27-28`, and `packages/utils/src/session-idle-settle.ts:52-63`.

Mitigating: `not-busy-is-not-gone.test.ts:6-20,41-48` pins the invariant that an absent status does not mean a dead session, and the poller confirms row existence with a directory before acting (`task-poller.ts:263-353`), so an unscoped miss currently fails safe.

**Fix status (2026-08-24):** still unfixed, still deliberately. Severity stays `costly`, confidence moderate - end-to-end harm remains unproven, and any fix should now be scoped as a sweep of all fifteen sites rather than a two-line change.

**Update:** (2026-08-24, second pass, verified against `dev` source) Still unfixed, and the fifteen-site count is now exact rather than approximate: 14 unscoped calls inside `packages/omo-opencode/src/`, plus `packages/utils/src/session-idle-settle.ts:60` outside it. One correction worth recording - six of those calls pass `path: undefined` and could be mistaken for scoped ones; they are not (`tmux-subagent/polling-manager.ts:70,142`, `session-ready-waiter.ts:20`, `polling.ts:76,113`, `tmux-subagent/manager.ts:716`). The three genuinely scoped calls all live in the CLI and pass `query: { directory }` (`cli/run/completion.ts:87-89`, `poll-for-completion.ts:230-232`, `prompt-start.ts:38-40`), which is the pattern a sweep would apply. No central directory-binding wrapper exists to shortcut it: `features/background-agent/opencode-client.ts:1-3` is a bare type alias. Harm remains theoretical - the only in-repo demonstration is `not-busy-is-not-gone.test.ts:41-48`, which models an empty status map against a live session row and asserts the task survives.



**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Still open, and now enumerated exactly rather than approximately. There are 17 `session.status()` call sites under `packages/omo-opencode/src/`: 3 scoped, passing `query: { directory }` (`cli/run/completion.ts:87-89`, `cli/run/poll-for-completion.ts:230-232`, `cli/run/prompt-start.ts:38-40`) and 14 unscoped (`features/background-agent/manager.ts:3363,3476`; `features/tmux-subagent/polling-manager.ts:70,142`, `session-ready-waiter.ts:20`, `polling.ts:76,113`, `manager.ts:716`; `features/tui-sidebar/snapshot-builder.ts:60`; `tools/look-at/session-poller.ts:42`; `tools/call-omo-agent/completion-poller.ts:35`; `tools/delegate-task/sync-session-poller.ts:165`, `unstable-agent-task.ts:127`; `plugin/unstable-agent-babysitter.ts:27`). Note the five `tmux-subagent` sites pass `{ path: undefined }`, which looks scoped but is not. Cross-checked for a central injector that would make the omission harmless: `features/background-agent/opencode-client.ts:1-3` is a bare type alias and `plugin/build-team-idle-wake-hint-client.ts:16-29` binds methods without injecting query options, so no compensation exists. No test asserts a production status call carries `directory`.

**Fix status (2026-08-27):** still unfixed, still deliberately. Severity stays `costly`; end-to-end harm remains unproven, so the sweep is worth scoping but not urgent.

## 2026-08-23 — lean-ctx triage silently eats dense output; every per-call bypass is a dead end

**Severity:** costly
**Area:** tools
**Observed in:** `~/git/onara`

**What happened:** reading a Wave-2 task-spec slice out of a plan file took ~10 tool calls
instead of 1. lean-ctx's content classifier ("triage") drops lines it judges low-signal and
returns a stub. Dense enumerations — task specs with `Files:` lists, env-var names, directory
listings, config arrays — are exactly its blind spot, and exactly the content that must be
copied verbatim. The agent then escalated through six workarounds, none of which work.

**Evidence:**

```
[lean-ctx: 109 lines filtered by triage (level 2)]
```

Reproduced ~12 times while investigating. Not size-based — `seq 1 40` (40 lines) passes,
`lean-ctx --help` (12 lines) is filtered:

| Probe | Result |
|---|---|
| `seq 1 40` | passes |
| `lean-ctx --help` (12 lines) | filtered |
| `raw=true` / `inline=true` / both | no effect |
| `LEAN_CTX_COMPRESSION_LEVEL=0` via `env` | ignored |
| `LEAN_CTX_TOOL_PROFILE=raw` via `env` | ignored |
| `ctx_execute` python printing same text | filtered identically |
| base64-encoding to defeat the classifier | filtered |
| write `/tmp` -> `ctx_read` / `look_at` | filtered |
| copy into repo -> `ctx_read` | filtered |

`ctx_perf` during the same session reported `triage_profile: null`, `request_count: 0`,
`tokens_saved_total: 0` — so on that session's own ledger the filtering saved nothing while
costing ten calls.

**Root cause / hypothesis:** part confirmed, part theory.

Confirmed: `~/.lean-ctx/config.toml` `compress_protect` (line 139) shipped covering
`.toml .lock .env .snap .html .css .kt .kts .ts .tsx .java .sql .yaml .yml .json` — and
**not `.md`**. Plans, specs, and evidence files are the one class carrying exact paths and
line numbers agents must transcribe, and the one class with no protection.

Confirmed: no per-call bypass and no env knob exists. `strings` on
`/Users/tim/.local/bin/lean-ctx` exposes only `LEAN_CTX_TRIAGE_MODEL_URL` — no level,
profile, or disable variable. Filtering is content-based and applies to every read path
in-process (`ctx_read`, `ctx_shell`, `ctx_execute` stdout alike), which is why the
tmp-file, repo-copy, and base64 dodges all fail.

Theory: `compress_protect` governs the compression layer only, and triage runs after it, so
protecting `.md` fixes `ctx_read` of Markdown but is not expected to cover shell stdout.

**Workaround:** delegate. `task(subagent_type="explore", ...)` returns the raw text first
try — a subagent's context is unfiltered. Used it in the original session and again while
writing this entry; both worked on the first call. The rule is one narrowing retry, then
delegate — never iterate the bypass list.

**Fix status:** worked around. `"**/*.md"` added to `compress_protect`
(`~/.lean-ctx/config.toml:158`); requires an MCP server restart to take effect — a re-test
in the same session was still filtered. Project rule written at
`onara/.omo/rules/lean-ctx-triage.md` documenting the delegate-don't-iterate rule and the
full dead-end table. Shell stdout stays unfixed and has no known knob.

**Update 2026-08-24:** fixed upstream, not worked around. Root cause is an ONNX
task-profile classifier in the MCP server (`context_gate.rs:525 triage_filter_level`,
floor 500 chars); its escape hatches landed in `0f86871aa` (2026-08-20), *after* the
installed `v3.9.19` tag (2026-08-18) — so the shipped release predated its own fix.
Settled with `git merge-base --is-ancestor 0f86871aa v3.9.19` → false. Rebuilt from
source to `lean-ctx 3.9.20`; `ctx_shell raw=true` and `ctx_read mode=full` now return
verbatim, including the dense `git log`/`git status`/test-log output that motivated the
entry. `ctx_shell` stdout **without** `raw=true` is still filtered. The delegate rule
above is no longer the first move — `raw=true` is.

---

**Update:** (2026-08-24, live reproduction during the harness-findings review) **The `compress_protect` workaround does not hold, and the upstream-fix claim above is not true for this runtime.** Reading this very file during its own review failed through every path attempted: `ctx_read` in `full`, `lines:N-M`, and `map` modes including `aggressiveness=0`; `ctx_search` with `action=regex`; `ctx_shell` running `grep` with both `raw=true` and `inline=true`; and `ctx_execute` in both `shell` and `python` printing the slice to stdout. All returned `[lean-ctx: N lines filtered by triage (level 2)]` with zero content.

The active config is `/Users/tim/.lean-ctx/config.toml`, not `~/.config/lean-ctx/config.toml` as the error message advertises. `"**/*.md"` **is** present in `compress_protect` at `:158` - so the glob is neither missing nor mis-scoped. The key sits under `[proxy]` (`:137-139`), and no `triage_protect` or any triage-level exclusion key exists in the config at all. That is the actual mechanism: `compress_protect` governs *compression*; triage is a separate, earlier layer with no protect list, and protecting a file from one does not protect it from the other.

Delegation remained the only working route: `task(subagent_type="explore", ...)` returned the file's contents in full. Every step of this review that needed this file's text - the initial inventory, and each of the 17 verifier lanes - went through a subagent for that reason.

**Fix status (2026-08-24, revised):** NOT worked around. `compress_protect` is the wrong lever; there is no triage-side equivalent to set. Severity revised `costly` -> `blocker`: recurrence outranks the original guess, this now reproduces on a file being actively worked on, it is silent, and no per-call bypass exists. Only delegation works.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
The `blocker` re-score does not survive scrutiny in its stated form, and the entry title overstates the claim. Configuration confirmed: lean-ctx runs from `~/.config/opencode/opencode.json:91-97`; `compress_protect` including `"**/*.md"` is at `~/.lean-ctx/config.toml:155-159`, inside `[proxy]` at `:137-139`. No `triage_protect`, triage level, firewall, or disable switch exists anywhere in that config (`:137-166`) or in the skill (`~/.config/opencode/skills/lean-ctx/SKILL.md:1-71`), which confirms the central claim that `compress_protect` is the wrong lever and no triage-side equivalent is documented. However, `ctx_expand` IS a documented lossless retrieval path for archived output (`SKILL.md:52-54`), so "every per-call bypass is a dead end" is too broad as written: it holds for arbitrary dense text and shell stdout, not for archived slices. This was reproduced again during this very review: `ctx_shell` triage filtered 9 of 16 lines of a `sed` output (`[lean-ctx: 9 lines filtered by triage (level 2)]`), and `raw=true` recovered it, which further narrows the "no per-call bypass" claim.

**Fix status (2026-08-27, revised):** still unfixed. Severity revised `blocker` -> `costly`: the silent-loss mechanism is real and has no config-side lever, but `raw=true` and `ctx_expand` are working per-call bypasses, so this is not a total dead end. The claim to carry forward is narrower: triage silently drops dense output by default, and the default is the defect.

## 2026-08-24 — `formatTaskResult` discards a lane's whole transcript when the session errors

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`

**What happened:** two long background lanes (same task id, `category="deep"`) ended with
`Session error: Aborted` as their *entire* result — no partial report, no progress
indication. Both had done substantial correct work and left it uncommitted. The work
survived only because the orchestrator went looking for it by hand with `git status`.

**Evidence:**

```
Task Result

Task ID: bg_e5031b85
Description: Fix review findings in modality day bodies
Duration: 22m 30s
Session ID: ses_fccb631beffdF9zbXUFFkofj04

---

Session error: Aborted
```

| Abort | Ran | Committed | Uncommitted work found afterwards |
|---|---|---|---|
| 1st | 22m 30s | 0 | 4 files — a complete, correct backend contract extension (`oas.yaml`, `RequestDtos.kt`, `TrainingController.kt` create **and** update paths, `TrainingControllerTest.kt`) |
| 2nd | 38m 40s | 0 | 1 file — a valid TDD red test, verified failing correctly |

The first lane's output was salvaged, independently verified (`compileKotlin` clean, 94
tests / 0 failures, mutation-proved by reverting the threading → `failures=1` naming the
test), and committed as `onara@47ff71394`.

The completion notification for both read `- completed with 8 unfinished todos` (then 7),
which reads as *finished*, not *crashed*.

**Root cause:** confirmed, not theory.
`packages/omo-opencode/src/tools/background-task/task-result-format.ts:67-81` — the
`sessionError` branch returns early and drops `sortedMessages` entirely, so
`consumeNewMessages` on the next line never runs:

```ts
const sessionError = sortedMessages
  .filter((message) => message.info?.role === "assistant" && message.info?.error)
  .map((message) => extractErrorMessage(message.info?.error))
  .find((message): message is string => typeof message === "string" && message.length > 0)
if (sessionError) {
  return `Task Result … Session error: ${sessionError}`
}
```

A lane that worked 38 minutes and errored on its last turn reports exactly as much as one
that died on its first. Note the asymmetry with the neighbouring branch at `:84`, which at
least says `(No assistant or tool response found)` — accurate, because there genuinely is
nothing.

Existing coverage does not catch it: `task-result-format.test.ts:30-47` builds an errored
assistant message with `parts: []` — an error with *no* partial work — and asserts only
that the output contains `"Session error"`. That passes under both current and fixed
behaviour. The real case, error-after-N-good-turns, is untested.

Separately unknown: whether a duration/token ceiling on `deep` produces the `Aborted` at
all. Both aborts were long-running; no other lane in the session exceeded ~9 min and none
aborted. The report gives the orchestrator nothing to distinguish a ceiling from a
provider-side cancellation.

**Workaround:** none for the data loss itself — recovery is manual `git status` in the
lane's worktree. Downstream mitigation: split the work into two smaller parallel lanes on
separate worktrees, and promote *"commit after every finding, never batch"* from a
footnote to a primary instruction. Whether smaller lanes abort less is unverified.

**Fix status:** unfixed. Suggested fix is to emit the partial transcript **and** the
error rather than choosing between them, with a regression test asserting that a session
with N good turns followed by an error still surfaces those N turns. Making the
completion notification distinguish aborted from completed would close the secondary half.

---

**Update:** (2026-08-24, verified against dev source) Still open, confirmed at the exact shape the entry described. `formatTaskResult` returns on `if (sessionError)` at `task-result-format.ts:71-82`, emitting only the header and `Session error:`, before `consumeNewMessages` is ever reached at `:84-97`. The default `background_output` path routes completed tasks straight into it at `create-background-output.ts:292-295`.

Cross-checked for a compensating path: `formatFullSession` does preserve the transcript, but only on two routes that do not cover the default - `full_session=true` (`create-background-output.ts:275-285`) and cross-runtime registry-miss recovery (`:120-145`). Neither helps a caller who just asks for a result. The existing test supplies a single errored message with `parts: []` and asserts only the error text (`task-result-format.test.ts:24-47`), so it cannot catch this: there is no good-turns-then-error case.

**Fix status (2026-08-24):** still unfixed. Severity stays `costly`. This is the most contained fix in the log: emit the consumed partial transcript alongside the session error in `task-result-format.ts:71-82`, with an N-good-turns-then-error regression test beside `task-result-format.test.ts:23-47`. Touches an OpenCode-connected path, so it needs `opencode-qa` evidence.

**Fix status (2026-08-24, fixed):** fixed locally in `36e1cf15f`. `formatTaskResult` no longer returns early on `sessionError`; the consumed transcript is emitted and the error is appended as a clearly-labelled `Terminal error:` line at `packages/omo-opencode/src/tools/background-task/task-result-format.ts:124`, so a partially-completed lane can no longer be mistaken for a clean one. Regression coverage added in `task-result-format.test.ts` (good turns with real text parts, then an errored message).

Red/green verified independently by the reviewing agent rather than taken on report: reverting only the fix line drove the suite to `EXITCODE=1, 0 pass, 2 fail`; restoring it gave `EXITCODE=0, 2 pass, 0 fail`. Full area `bun test packages/omo-opencode/src/tools/background-task/` = `73 pass, 0 fail` across 15 files; `bun run typecheck` = exit 0. Evidence at `.omo/evidence/20260824-formattaskresult-transcript/`.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed fixed. `36e1cf15f` (`fix(background-task): keep partial transcript when a lane session errors`) resolves and is an ancestor of `dev`. `formatTaskResult` computes `sessionError` and then still calls `consumeNewMessages` (`task-result-format.ts:67-71`), returning the transcript with `Terminal error:` appended (`:112-124`). The regression case (two good turns, then an errored message, asserting both transcript entries and the terminal error) is at `task-result-format.test.ts:50-83`. QA evidence exists on disk at `.omo/evidence/20260824-formattaskresult-transcript/qa.md:1-48`, recording `2 pass / 0 fail`.

**Fix status (2026-08-27):** fixed, verified in source, history, tests, and evidence.

## 2026-08-24 — A timed-out `ctx_shell` is indistinguishable from a failed one

**Severity:** papercut
**Area:** tools
**Observed in:** `~/git/onara`

**What happened:** a `git commit` whose pre-commit hook runs `detekt` (60–90s) exceeded
the ~110s foreground cap and returned a timeout error. The agent read that as failure and
retried the commit detached — but the first commit had already **succeeded**. Only the
wait timed out.

**Evidence:**

```
MCP error -32001: Request timed out
```

then, from the detached retry:

```
EXIT=1
pre-commit: running detekt (backend_kt)…
On branch review-fixes
nothing to commit, working tree clean
```

`git log --oneline -1` confirmed the original commit (`47ff71394`) had landed. The
detached job then sat registered until an `<unpolled-background-shell-jobs>` reminder
fired.

**Root cause / hypothesis:** hypothesis. The error text carries no signal that the
command is still running, so "timed out" and "failed" are the same string to the agent.
Retrying a **non-idempotent** command on that reading is the natural next move and the
wrong one — harmless here because `git commit` is effectively idempotent, but the same
reflex on a migration or a `push` would not be.

Compounding: the detach was unnecessary. 60–90s is inside the foreground budget; the
correct recovery was `git log`, which is what happened anyway two calls later.

**Workaround:** on a `ctx_shell` timeout, check the command's *effect* (`git log`, output
file, test-results XML) before assuming failure — never blind-retry. The
`<unpolled-background-shell-jobs>` reminder worked correctly and explained how to clear
the job; the gap is upstream of it.

**Fix status:** needs-decision. If the command genuinely keeps running past the cap (as
documented), returning the `shell_<id>` it detached to — instead of a bare error — would
make recovery obvious rather than guesswork.

---

**Update:** (2026-08-24, verified against dev source) Largely closed by guidance that already exists, though not in this repo. `/Users/tim/.config/opencode/AGENTS.md:128` states "Verify by effect, not by status line" and names the artifacts to check; `:126` documents the fixed ~110s foreground cap and separates it from a detached job's lifetime; `:130` says to prefer reading existing build artifacts over re-running. Together those cover the recovery this entry asked for. The repo-local `AGENTS.md` and `.omo/rules/*.md` carry no equivalent wording, so an agent running without the user-global file is still uncovered. Note the entry's `core/instructions.md` reference no longer resolves - that file is absent from the current checkout.

**Fix status (2026-08-24):** effectively fixed for agents that load the user-global `AGENTS.md`; uncovered otherwise. Severity stays `papercut`.

## 2026-08-24 — `multimodal-looker` reports high confidence on image regions outside the frame

**Severity:** costly
**Area:** subagents
**Observed in:** `~/git/onara`

**What happened:** asked to compare two UI elements across 10 screenshots, the agent
returned "visibly different hues, **high confidence**" for every file, and clean verdicts
on all five requested categories. The comparison was impossible: the captures are
viewport-sized and the second element is below the fold in every one.

**Evidence:**

```
sips -g pixelWidth -g pixelHeight t9-round-dark-mobile.png
  pixelWidth: 414
  pixelHeight: 896
```

The pages are ~1445px tall (`scrollHeight`), so the cool-down section it claimed to
compare is simply not in the image. Re-asking about an element that *is* in frame
produced a correct answer immediately, and volunteered `NOT VISIBLE` for one file — which
is the signal that a real look happened.

Running score for the image channel across this wave: **5 findings, 5 false, 0 true.**
Each disproved by returning to the DOM (`scrollWidth - clientWidth === 0` on every row,
disproving a reported "clipping") or by checking frame size. Three of the five came from
an earlier image pass in the same wave and were disproved the same way.

**Root cause / hypothesis:** hypothesis — the agent infers a plausible answer from
context rather than reporting inability to see, and the prompt did not force it to
establish what was in frame first. A uniformly-clean, uniformly-high-confidence report is
itself the smell.

**Workaround:** scope image questions to elements known to be in frame; check
`sips -g pixelWidth -g pixelHeight` before trusting any spatial claim; treat every image
finding as a hypothesis to confirm against the DOM, never as a checklist-closer. Project
rule written at `onara/.omo/rules/visual-qa-evidence.md` splitting visual QA into a
measured channel (`getComputedStyle` / `getBoundingClientRect`) and a looked-at channel,
with the two-instrument division and the frame-bounds check.

**Fix status:** worked around. A prompt-level fix in the agent — require it to state image
dimensions and confirm the target is in frame before answering, and to prefer
`NOT VISIBLE` over inference — would close it at the source.

---

**Update:** (2026-08-24, verified against dev source) Still open. Neither of the two places a guard could live has one. The agent system prompt at `packages/omo-opencode/src/agents/multimodal-looker.ts:24-59` instructs attachment analysis and reporting missing information, but never requires stating actual pixel dimensions, confirming the target is within frame, or preferring `NOT VISIBLE`. The runtime prompt passes goal and attachment straight through (`packages/omo-opencode/src/tools/look-at/look-at-prompt.ts:23-31`). The tool description warns against using `look_at` for precision (`packages/omo-opencode/src/tools/look-at/constants.ts:1-3`) but adds no frame check, and the schema validates paths and goal only (`tools.ts:13-22`). A search for `dimensions`, `out of frame`, `bounds`, and `NOT VISIBLE` across the module returned nothing relevant.

**Fix status (2026-08-24):** still worked around at the caller. Severity stays `costly` - the recorded hit rate was five false findings out of five, and false confidence closes visual-QA work incorrectly. Contained prompt-only fix, best applied at `multimodal-looker.ts:53-57` and mirrored in `look-at-prompt.ts:29-31`.

**Fix status (2026-08-24, fixed):** fixed locally in `fa6feef70`. A frame-bounds requirement now sits in both routes: the agent system prompt (`packages/omo-opencode/src/agents/multimodal-looker.ts`) and the direct-call runtime prompt (`packages/omo-opencode/src/tools/look-at/look-at-prompt.ts`). Both require stating actual pixel dimensions before any spatial claim, confirming the target is within bounds, answering `NOT VISIBLE` when it is not, and never inferring content for an unseen region. Prompt-only; the `look_at` schema and runtime behavior are unchanged.

Guard-deletion tests added in `multimodal-looker.test.ts` covering both prompts: `bun test packages/omo-opencode/src/agents/multimodal-looker.test.ts` = `5 pass, 0 fail, 16 expect() calls`; `bun run typecheck` = exit 0. Evidence at `.omo/evidence/20260824-multimodal-looker-frame-guard/`.

Caveat on scope: this raises the cost of fabricating, it does not make it impossible. The original failure was five confident false findings out of five, and a prompt instruction is not a hard bound. Treat a `NOT VISIBLE` as trustworthy and a confident spatial claim as still worth a second look.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed fixed. `fa6feef70` (`fix(multimodal-looker): require frame-bounds check before spatial claims`) resolves and is an ancestor of `dev`. Both routes carry the identical requirement to state actual pixel dimensions, confirm the target is in bounds, answer `NOT VISIBLE` otherwise, and never infer unseen content: the agent system prompt at `packages/omo-opencode/src/agents/multimodal-looker.ts:61` and the direct-call runtime prompt at `packages/omo-opencode/src/tools/look-at/look-at-prompt.ts:27`. Pinned by `multimodal-looker.test.ts:78-99`, which asserts the wording in both prompts. Cross-checked for a third image route that bypasses the guard: the only production path is `look_at` (`look-at-session-runner.ts:24-26,65-77`), so there is none.

**Fix status (2026-08-27):** fixed. The original caveat stands: this is a prompt-level guard, not an enforced one.

## 2026-08-24 — `review-work` and `full-code-review` default to a diff range that is empty for merged work

**Severity:** docs-gap
**Area:** subagents
**Observed in:** `~/git/onara`

**What happened:** both skills instruct the reviewer to collect scope via
`git diff main...HEAD` (or `HEAD~1`). The work under review had **already been merged to
main**, so that range is empty. Run as written, both would have reviewed nothing and
reported PASS.

**Evidence:** `review-work` Phase 0 auto-collection sequence:

```bash
git diff --name-only HEAD~1  # or: git diff --name-only main...HEAD
git diff HEAD~1              # or: git diff main...HEAD
```

`full-code-review` Inputs: *"Default scope is the working-tree + branch diff
(`git diff main...HEAD` …)"*. On the merged branch both yield zero files. The real scope
required an explicit wave merge-base: `git diff 136d5884c..HEAD` — 29 code files, ~1268
diff lines.

**Root cause / hypothesis:** confirmed for the scope default; the failure mode is that an
empty diff produces a *passing* review rather than an error, so nothing signals the
mistake. `review-work` Phase 0 already says "confirm the real scope before reviewing" —
it just does not name the merged case, which is the one where the default silently
degrades.

**Workaround:** scope every lane explicitly to the wave's merge-base rather than the
branch default, and state the range in each lane's prompt.

**Fix status:** unfixed. Both skills would benefit from a line: *if the work is already
merged (or you are standing on `main`), the branch-diff default yields nothing — scope to
the wave's merge-base.* Optionally, a reviewer that finds an empty diff should refuse
rather than pass.

**Related, same session:** the two skills overlap almost entirely on code quality.
Running both wholesale would have put ~9 agents on the same 1268-line diff; merging into
three non-duplicative lanes (2 × `oracle` on different questions + 1 context miner) is
what fit. The security lane was deliberately skipped and *reported as skipped* — the diff
was UI rendering, SCSS and i18n, with no auth, input or network surface. A note in
`review-work` that lanes may be dropped when the diff cannot exercise them, provided the
drop is stated rather than silently counted as PASS, would make that legitimate instead of
improvised.

---

**Update:** (2026-08-24, verified against dev source) Still open in both skills, and neither has the fallback that would rescue it. `review-work` defaults to `git diff --name-only HEAD~1` and `git diff HEAD~1`, offering `main...HEAD` only as an alternate (`packages/shared-skills/skills/review-work/SKILL.md:95-102`); its input section mentions "the appropriate base (branch point, specific commit)" at `:85-86` but gives no trigger or procedure for merged work, and nothing in `:76-110` refuses an empty range. `full-code-review` defaults to `git diff main...HEAD` plus uncommitted changes (`/Users/tim/.agents/skills/full-code-review/SKILL.md:20-23`, repeated at `:38-40`) with no merged-work branch; its merge-base handling at `:46-54` applies only to validating regression claims, not to picking the review scope.

Ownership differs and matters: `review-work` is tracked in this repo at `packages/shared-skills/skills/review-work/SKILL.md`, so it is fixable here. `full-code-review` is user-global at `/Users/tim/.agents/skills/` and outside this repository.

**Fix status (2026-08-24):** still unfixed in both. Severity stays `docs-gap`. One line in each - if the range is empty because the work is already merged, ask for an explicit commit range - closes it.

**Fix status (2026-08-24, fixed):** both halves are now fixed. The user-global half was applied at `/Users/tim/.agents/skills/full-code-review/SKILL.md:22` (the Scope input) and `:40` (the gather-the-diff step): an empty range is explicitly not a pass, it means the work is already merged or the branch is wrong, and the reviewer must stop and ask for an explicit commit range such as the merge commit's `<sha>^1..<sha>`. That file is outside this repository and is not tracked here, so this entry is the only record of the change; a backup of the pre-edit file was taken at `/tmp/fcr-skill.bak`. Wording matches that file's existing voice, which uses em dashes - the repo-side no-em-dash convention does not apply to it.

**Fix status (2026-08-24, partially fixed):** the repo half is fixed locally. `packages/shared-skills/skills/review-work/SKILL.md` now carries an explicit instruction after the auto-collection block: if the collected range is empty, the work is likely already merged or you are on the wrong branch, so stop and ask for an explicit commit range rather than reviewing nothing. The `full-code-review` half remains unfixed and is NOT actionable from this repository - it lives at `/Users/tim/.agents/skills/full-code-review/SKILL.md`, user-global. The proposed one-line edit for it, to be applied by the user at `:24` and again at `:41`, mirrors the wording above. Severity stays `docs-gap`.

**Update:** (2026-08-24, second pass, verified against `dev` source) Still unfixed in both, with the exact lines to change now identified. `review-work` sets its range at `packages/shared-skills/skills/review-work/SKILL.md:85-86` (`git diff --name-only HEAD~1 or against the appropriate base`), with the concrete commands at `:99-103`; that file is tracked here and fixable in this repo. `full-code-review` sets its default at `/Users/tim/.agents/skills/full-code-review/SKILL.md:20-23` (`git diff main...HEAD` plus `git diff HEAD`), repeated at `:38-40`, and is user-global - outside this repository, so only the `review-work` half is actionable here. Neither mentions an empty range or already-merged work anywhere.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Both halves confirmed fixed, and a third copy surfaced. The repo half is committed, not working-tree-only: `packages/shared-skills/skills/review-work/SKILL.md:110` carries the stop-and-ask instruction and the file has no working-tree diff against `dev` at `7a5c3506c`. The user-global half is present after all, at `/Users/tim/.agents/skills/full-code-review/SKILL.md:22` and `:40`, so the `partially fixed` status above is stale. Third copy: `packages/omo-codex/plugin/skills/review-work/SKILL.md:142` also carries it, generated by `packages/omo-codex/plugin/scripts/sync-skills.mjs:238-269`, so it needs no separate edit.

**Fix status (2026-08-27):** fixed, both halves, plus the generated Codex copy. Severity `docs-gap` retained for the record.

## 2026-08-24 — `ctx_shell` redirect guard also blocks heredoc appends

**Severity:** papercut
**Area:** tools
**Observed in:** `~/git/onara`

**What happened:** appending a section to a Markdown file with a heredoc was rejected.

**Evidence:**

```
ERROR: ctx_shell detected a file-write command (shell redirect > or >>).
Use the native Write tool to create/modify files. ctx_shell is ONLY for reading
command output (git status, cargo test, npm run, etc.). File writes via shell cause
MCP protocol corruption on large payloads. Output capture to temp paths
(/tmp, /var/tmp, $TMPDIR) is allowed.
```

Triggered by `cat >> file <<'MD' … MD`, the natural way to append a section.

**Root cause / hypothesis:** confirmed from the message itself — the guard matches
redirect **syntax**, not intent, so a heredoc append is indistinguishable from a
large-payload file write. Correct in spirit; the temp-path carve-out shows the intent is
narrower than the match.

**Workaround:** read the file's tail, then `Edit` against a unique anchor. Arguably safer
than the heredoc anyway, since it fails loudly when the anchor has moved.

**Fix status:** worked around. Worth documenting that the rule is syntactic, so agents
reach for `Edit` first rather than discovering the guard.

**Update:** (2026-08-24, reproduced live during the harness-findings review) Confirmed, verbatim. A heredoc append to a throwaway path under `.local-ignore/` was rejected:

```
ERROR: ctx_shell detected a file-write command (shell redirect > or >>). Use the native Write tool to create/modify files. ctx_shell is ONLY for reading command output (git status, cargo test, npm run, etc.). File writes via shell cause MCP protocol corruption on large payloads. Output capture to temp paths (/tmp, /var/tmp, $TMPDIR) is allowed.
```

The message text confirms the mechanism is syntactic: it matches on `>` / `>>` and reasons about payload size, with no notion of the heredoc body being small and literal. Worth noting the message names an escape hatch the entry did not - output capture to `/tmp`, `/var/tmp`, or `$TMPDIR` is explicitly permitted, so redirecting to a temp path and reading it back is a supported route where the native `Write` tool is not wanted.

A documentation search found no note anywhere - repo `AGENTS.md`, user-global `AGENTS.md`, `.omo/rules/*.md` - that the guard is syntactic, and no documented `ctx_execute(language="shell")` escalation for it. The closest is `/Users/tim/.config/opencode/AGENTS.md:78`, "File editing -> native Edit/StrReplace".

**Fix status (2026-08-24):** still worked around, still undocumented. Severity stays `papercut`.
## 2026-08-24 - Rules injection re-suppressed after compaction by full-transcript hydration

**Severity:** costly
**Area:** rules injection
**Observed in:** `onara`, long orchestration session under opencode + oh-my-openagent

**What happened:** A rule injected before a session compaction could never be re-injected,
because transcript hydration kept finding its `[Rule: ...]` banner in messages the model
could no longer see.

**Evidence:**
```
live opencode DB session ses_fd16c1c72fferXUROX6pmb41R1
rule banner in message msg_032e51103001Lb1cRxxJR6LYM6 at 2026-08-24 08:31:08
compaction part {"type":"compaction","auto":false,"tail_start_id":"msg_032e6577f0018RuplNhW0akUDj"}
tail-start message at 2026-08-24 08:32:31
banner predates tail-start -> dropped from context
zero [Rule: ...harness-findings...] parts appear after 08:33:28
persisted state file still listed the rule as injected
```

**Root cause / hypothesis:** confirmed. `transcript-hydration.ts` scanned the full
transcript via `client.session.messages({path:{id}})`, unbounded by compaction.
`injection-processor.ts:135-141` then marked the rule injected and `continue`d without
emitting. `hook.ts:101-106` cleared the persisted cache on `session.compacted`, but
hydration immediately re-suppressed it. A second, worse path also existed: the persisted
cache was loaded and checked before hydration ran, so a plugin restart across a compaction
made the stale on-disk cache win regardless.

**Workaround:** none found before the code fix landed.

**Fix status:** fixed in `08a8d55b1` - hydration now stops at the last compaction part, and
the persisted cache carries a `compactionEpoch` stamp that invalidates it on mismatch.

## 2026-08-24 - MCP-prefixed tool names bypass rules injection entirely

**Severity:** blocker
**Area:** rules injection
**Observed in:** `onara` and `oh-my-openagent`

**What happened:** Hooks gated on exact tool-name equality, so MCP-served file tools never
matched and the injectors were silently dead for an entire session.

**Evidence:**
```
hook.ts:36: const TRACKED_TOOLS = ["read", "write", "edit", "multiedit"]
matched by TRACKED_TOOLS.includes(input.tool.toLowerCase())
probe: "lean-ctx_ctx_read" matched false

live DB session ses_fcc7a7320ffeqqbiGtzKPWFg5U used only
lean-ctx_ctx_shell (38 calls) and lean-ctx_ctx_execute (6 calls),
produced NO rules-injector state file at all

second session tool mix: ctx_shell 391 / ctx_execute 101 / ctx_read 34
against edit 41 / write 6, cutting injection opportunities ~90 percent
```

**Root cause / hypothesis:** confirmed. Exact-equality matching against a lowercase list,
with no awareness of MCP name prefixes (`mcp__<server>__<tool>`, `lean-ctx_ctx_<tool>`).

The naive fix is wrong: `"todowrite".endsWith("write")` is `true`, so a plain suffix match
would have injected rules on every todo write. The fix needed a separator boundary, not a
substring or suffix check.

**Workaround:** none found before the code fix landed.

**Fix status:** fixed in `8f3d2daa3` (shared `matchesTrackedTool` helper), `cea18ab27`
(rules-injector), `00bb1d903` (directory injectors).

## 2026-08-24 - The findings log was unfindable from root AGENTS.md

**Severity:** docs-gap
**Area:** other
**Observed in:** `onara` session, filing harness findings

**What happened:** An agent recorded harness defects in `docs/superpowers/specs/` in the
wrong repo, then in an invented `docs/handovers/` file in the right repo. The user
corrected it twice before the agent found `docs/troubleshooting/harness-findings.md`.

**Evidence:**
```
root AGENTS.md STRUCTURE tree mentioned only docs/ ... troubleshooting/,
never named harness-findings.md by name

capture rule naming it lived only at machine-local ~/.omo/rules/harness-findings.md,
uncommitted, and had been dropped from the session's context by a compaction
(see the compaction entry above)

docs/AGENTS.md:40-41 did register the log, but that file is read on demand
while root AGENTS.md is always in context
```

**Root cause / hypothesis:** confirmed. The always-in-context file did not name the log,
and the file that did name it was both machine-local and evicted by compaction. The agent
pattern-matched a plausible existing tracked directory instead of finding the real one.

**Workaround:** the user pointed the agent at the correct file by hand, twice.

**Fix status:** fixed in `afc234a0c` (root AGENTS.md pointer) and `48f0c1345` (capture rule
committed as `docs/templates/harness-findings-rule.md.example`).

## 2026-08-24 - Exact-match tool-name gating survives in other hooks

**Severity:** costly
**Area:** tools
**Observed in:** `oh-my-openagent`, found while verifying the fix for the MCP-prefix entry
above

**What happened:** After fixing three hooks for the same bug class, a repo-wide grep showed
exact-equality tool-name matching still present elsewhere, including in a security-relevant
guard.

**Evidence:**
```
packages/omo-opencode/src/hooks/write-existing-file-guard/tool-execute-before-handler.ts:113
  if (toolName !== "write" && toolName !== "read")
packages/omo-opencode/src/hooks/write-existing-file-guard/tool-execute-before-handler.ts:131
  if (toolName === "read")
packages/omo-opencode/src/hooks/comment-checker/hook.ts:72
  if (toolLower !== "write" && toolLower !== "edit" && toolLower !== "multiedit")

local exact-match helpers also present at:
packages/omo-opencode/src/hooks/read-image-resizer/hook.ts:15
packages/omo-opencode/src/hooks/hashline-read-enhancer/hook.ts:19
packages/omo-opencode/src/hooks/hashline-read-enhancer/hook.ts:23
packages/omo-opencode/src/hooks/hashline-edit-diff-enhancer/hook.ts:31
packages/omo-opencode/src/hooks/atlas/write-edit-tool-policy.ts:3
```

**Root cause / hypothesis:** confirmed as a systemic bug class, not an isolated bug. A
shared `matchesTrackedTool` helper now exists at
`packages/omo-opencode/src/shared/tool-name-match.ts`, and these call sites have not been
migrated to it.

The `write-existing-file-guard` case is the concerning one of the set: a guard that
silently stops seeing MCP-prefixed writes fails open rather than closed.

**Workaround:** none. Deliberately left out of scope for the change that found it.

**Fix status:** unfixed - each migration needs its own failing test first, and (per the
prior entry) a naive suffix match would break `todowrite`.

**Update:** (2026-08-24, verified against dev source) Still open, and now enumerated. `matchesTrackedTool` (`packages/omo-opencode/src/shared/tool-name-match.ts:3-21`) has exactly three production callers, all injectors: `rules-injector/hook.ts:73`, `directory-agents-injector/hook.ts:50`, `directory-readme-injector/hook.ts:44`. Fix commit verified as `8f3d2daa3 feat(shared): add MCP-aware tool-name matching helper`; no later migration commit exists.

Genuinely affected active hooks - each gates a *built-in* tool name that can arrive MCP-qualified:

1. `write-existing-file-guard/tool-execute-before-handler.ts:113` - `toolName !== "write" && toolName !== "read"`, and `:131`. Security-relevant: the guard fails open for a qualified write.
2. `comment-checker/hook.ts:72` - `toolLower !== "write" && toolLower !== "edit" && toolLower !== "multiedit"`, and `:115-116`.
3. `read-image-resizer/hook.ts:15-16,121` - qualified reads skip resizing.
4. `hashline-read-enhancer/hook.ts:19-25,201-202` - qualified reads skip hashline tagging, which also breaks the `hashline_edit` pairing invariant.
5. `atlas/write-edit-tool-policy.ts:1-4`, consumed at `atlas/tool-execute-before.ts:13,82` and `atlas/tool-execute-after-direct-work.ts:14,24`.

Latent, not active: `hashline-edit-diff-enhancer/hook.ts:31-33,60,75` uses exact `write` matching but the directory is unwired.

Cross-checked and classified as **false positives** - these gate OMO-internal tool names that cannot arrive MCP-qualified, where exact matching is correct and a prefix match would wrongly catch unrelated MCP tools: `team-tool-gating/hook.ts:98-133`, `prometheus-md-only/hook.ts:27,40`, `question-label-truncator/hook.ts:58`, `interactive-bash-session/hook.ts:54`, `empty-task-response-detector.ts:18`, `sisyphus-junior-notepad/hook.ts:16`, `non-interactive-env/non-interactive-env-hook.ts:74`, `bash-file-read-guard.ts:23`, `delegate-task-retry/hook.ts:12`, `session-notification.ts:74,153`, `todo-continuation-enforcer/pending-question-detection.ts:21,29`. `edit-error-recovery/hook.ts:45` could not be classified from source alone.

**Fix status (2026-08-24):** still unfixed, now scoped: five hooks to migrate, each needing its own failing MCP-qualified-name test first. Severity stays `costly`, led by the `write-existing-file-guard` fail-open.

**Fix status (2026-08-24, fixed):** fixed locally. Four of the five scoped hooks now delegate to `matchesTrackedTool`: `write-existing-file-guard/tool-execute-before-handler.ts:116-117,135` (the security fail-open), `comment-checker/hook.ts:75,134`, `read-image-resizer/hook.ts:121` (local `isReadTool` deleted), and `atlas/write-edit-tool-policy.ts:1-7` (literal array replaced, redundant casing duplicates collapsed since the helper lowercases). Each migration was TDD: a failing MCP-qualified-name test first, then the swap. Combined suites for the touched dirs are 811 pass / 0 fail, typecheck exit 0.

The fifth hook, `hashline-read-enhancer`, was assessed and DELIBERATELY NOT MIGRATED. Its read-tagging is paired with `hashline_edit`, which validates every anchor against `computeLineHash` on current disk content (`packages/hashline-core/src/validation.ts:67-79,162-179`) and accepts no other hash scheme. `ctx_read` emits `N:hash|content`, a different grammar that `parseReadLine` does not accept (`hook.ts:31-53`) carrying a different hash. Suffix-matching it would either leave output untouched, which is useless, or hand agents anchors that hard-fail at edit time. Safe migration would need an explicit allowlist rather than suffix matching, plus an integration test driving a paired read into `hashline_edit`. Recorded as a known non-migration, not an oversight.

QA note worth keeping: the first `opencode-qa` boundary probe reported the guard STILL fail-open. That verdict was wrong - the probe passed a raw `/var/folders/...` session root, which macOS canonicalizes to `/private/var/...`, so `isPathInsideDirectory` early-returned before the tool-name gate mattered. It had no native-write positive control, so an environmental early-return was indistinguishable from the defect under test. Corrected probe and the retraction are in `.omo/evidence/20260824-mcp-tool-name-gating/`.

**Update:** (2026-08-24, second pass, verified against `dev` source) Still unfixed, and the fail-open is now traced line by line rather than asserted. `matchesTrackedTool` (`packages/omo-opencode/src/shared/tool-name-match.ts:3-21`) lowercases both sides, accepts exact equality, and accepts a tracked-name suffix only when the preceding character is one of `_ - . : /` - so `mcp__foo__write` matches `write` while `todowrite` does not. Its production callers are still only the three injectors: `rules-injector/hook.ts:73`, `directory-readme-injector/hook.ts:44`, `directory-agents-injector/hook.ts:50`. On the guard side, `mcp__foo__write` fails both exact comparisons at `write-existing-file-guard/tool-execute-before-handler.ts:113` and returns at `:114`, before the path and permission checks at `:117-141` - the fail-open is confirmed, not inferred. Test coverage is the sharpest signal: `mcp__` appears in exactly two hook test files, `directory-readme-injector/hook.test.ts` and `directory-agents-injector/hook.test.ts`, both already-migrated injectors. None of the five hooks awaiting migration has an MCP-qualified-name test, which is why each needs its own failing test first.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Four migrations confirmed real and committed in `b22ffb4a6` (`fix(hooks): match MCP-qualified tool names in four tool-name gates`), an ancestor of `dev`: `write-existing-file-guard/tool-execute-before-handler.ts:116-117,135`, `comment-checker/hook.ts:75,134`, `read-image-resizer/hook.ts:121`, `atlas/write-edit-tool-policy.ts:6`. Each has MCP-qualified coverage (`write-existing-file-guard/index.test.ts:92`, `:103`; `comment-checker/hook.before-after.test.ts:90`; `read-image-resizer/hook.test.ts:238`; `atlas/index.test.ts:32`).

The fifth hook is `hashline-read-enhancer`: `isReadTool` and `isWriteTool` still compare `toolName.toLowerCase() === "read"` / `=== "write"` at `packages/omo-opencode/src/hooks/hashline-read-enhancer/hook.ts:19-24`, and its tests use bare `"read"` only (`index.test.ts:25,58,90,117`). Cross-check that changes the severity: this hook is composed behind the `hashline_edit` config flag (`plugin/hooks/create-tool-guard-hooks.ts:125`), which defaults to **false** (`config/schema/oh-my-opencode-config.ts:60-61`), so the remaining gap is dormant on default config rather than an active fail-open. Two further literal arrays were not fully cleared and should be checked for MCP-qualified reachability before this entry closes: `plan-format-validator/hook.ts:9` and `prometheus-md-only/constants.ts:12`. A latent copy also sits in the unwired `hashline-edit-diff-enhancer/hook.ts:32`.

**Fix status (2026-08-27):** partially fixed. Four of five migrated and pinned; the fifth is dormant-by-default. Severity revised `costly` -> `papercut`, since the security fail-open that led the original severity is closed and the remainder is off by default.

## 2026-08-24 - A negative-assertion QA probe with no positive control reported a false defect

**Severity:** costly
**Area:** tools
**Observed in:** oh-my-openagent, `opencode-qa` evidence run for the MCP tool-name gating fix

**What happened:** A QA subagent wrote a boundary probe to prove that `write-existing-file-guard` blocks an MCP-qualified write. The probe reported the guard still fail-open, and the agent returned a FAILED security verdict with that line as its headline evidence. The verdict was wrong. The guard was correct; the probe was broken.

**Evidence:**
```
FAIL: mcp__foo__write returned without blocking
```
Corrected probe, same handler, session root canonicalized:
```
write:           BLOCKED (File already exists. Use edit tool instead.)
mcp__foo__write: BLOCKED (File already exists. Use edit tool instead.)
todowrite:       NOT BLOCKED
```

**Root cause:** The probe passed a raw `mkdtempSync` path (`/var/folders/...`) as the session root. macOS canonicalizes that to `/private/var/...`, so the guard's `isPathInsideDirectory(canonicalPath, canonicalSessionRoot)` check returned early, before the tool-name comparison was ever reached. The probe tested nothing about tool names.

**Why it was not caught:** the probe asserted only the negative case. It ran `mcp__foo__write` and nothing else. A plain `write` would have produced the identical FAIL, which is the tell - but with no positive control in the output, an environmental early-return is indistinguishable from the defect under test. The agent then reported the failure confidently rather than questioning a result that contradicted its own passing unit tests.

**Generalization worth enforcing:** any QA probe whose pass condition is "X is blocked / rejected / refused" MUST include a control that is already known to be blocked, and a control known NOT to be blocked. Without both, the probe cannot distinguish "the guard works" from "nothing reached the guard".

**Workaround:** re-ran the probe with `realpathSync` on the session root and added `write` and `todowrite` controls. Retraction and corrected artifacts recorded in `.omo/evidence/20260824-mcp-tool-name-gating/` (`08-write-guard-boundary-corrected.txt`, plus a CORRECTION section prepended to the evidence README).

**Fix status:** worked around per-probe. A durable fix would put the positive-and-negative-control requirement into the `opencode-qa` skill, which currently gives no guidance on constructing a negative-assertion probe.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed still open, in both skills. `.agents/skills/opencode-qa/SKILL.md` has no positive-control or negative-assertion guidance in its golden rules (`:17-30`) or its hook/event case (`:88-115`), and no reference under `references/` matches `positive control`, `negative assertion`, or `false negative`. The sibling `.agents/skills/codex-qa/` has none either, so there is no guidance to copy across. Cross-checked root `AGENTS.md`, `.omo/rules/`, and `packages/shared-skills/skills/` for the requirement and found no match. The only incidental hits are unrelated: `opencode-qa/SKILL.md:190` (reminder matcher) and `scripts/serve-wake-split-probe.sh:22` (a flag-disabled control inside one script, not general guidance).

**Fix status (2026-08-27):** still unfixed. Severity stays `costly`: the recorded outcome was a false defect reported as real, which is the same failure class as a summarized-evidence claim. The contained fix is a probe-construction section in `opencode-qa`, mirrored into `codex-qa`.

## 2026-08-24 - Gitignored .omo/plans is invisible inside task worktrees

**Severity:** costly
**Area:** worktrees / plugin config
**Observed in:** oh-my-openagent, `start-work` and `work-with-pr` sessions dispatching workers into task-owned git worktrees

**What happened:** `start-work` and `work-with-pr` dispatch workers into task-owned git worktrees and instruct them to read the work plan from `.omo/plans/<plan>.md` inside that worktree. That file is never there.

**Root cause, verified:**
```
$ git check-ignore -v .omo/plans/resume-adopt-fallback.md
.gitignore:59:plans/	.omo/plans/resume-adopt-fallback.md

$ sed -n '55,62p' .gitignore
.debugging
.debug-journal*.md
session-ses_*.md
pr-*.md
plans/
.ulw/
.claude/*
!.claude/skills
```
`.gitignore:59` is a bare `plans/` pattern. A bare directory pattern in gitignore matches at any depth, so it matches `.omo/plans/` as well as a top-level `plans/`. The directory is therefore untracked, and `git worktree add` only materializes tracked content.

**Why it is not obvious:** `.omo/evidence/` IS visible inside worktrees because `.gitignore` carries explicit un-ignore rules `!.omo/evidence/` and `!.omo/evidence/**`. `.omo/plans/` has no such rule. An agent sees its evidence directory work fine and reasonably assumes plans behaves the same way.

**Observed impact, both variants:** four workers were dispatched into worktrees in one session with instructions to read the plan.
- One correctly reported BLOCKED with the exact error (`sed: no such file or directory`) instead of guessing. That is the correct behavior.
- Three others proceeded silently without reading the instructed input. Their output happened to be correct only because each dispatch prompt restated the specification exhaustively. This silent variant is the dangerous one: a worker that guesses instead of blocking produces work that looks compliant but was never grounded in the plan.

**Workaround used this session:** the orchestrator copied the plan into each lane worktree at `.omo/plans/`. Because the path is gitignored, the copy cannot be staged or committed, so it cannot pollute a lane commit and the worktree stays clean.

**Candidate durable fixes (not yet chosen):**
1. Narrow `.gitignore:59` from bare `plans/` to `/plans/` so it anchors at the repo root and stops matching `.omo/plans/` at depth, then track `.omo/plans/` the way `.omo/evidence/` already is via its un-ignore rules.
2. Or make the `start-work` / `work-with-pr` dispatch step copy the selected plan into each task worktree explicitly.

**Generalization worth keeping:** a bare directory name in `.gitignore` matches at every depth, so `plans/`, `build/`, `dist/`, and similar bare patterns silently capture same-named directories nested anywhere in the tree.

**Fix status:** unfixed. Two candidate fixes proposed above, neither applied.

---


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
The mechanism is still open but the diagnosis above is wrong in two details, and the practical impact is smaller than recorded. First, the ignore line cited in the entry (`.gitignore:59:plans/`) is a **generic** `plans/` pattern, not an `.omo`-specific rule; the `.omo/*` block at `.gitignore:2-6` unignores only `rules/` and `evidence/`. `git check-ignore -v .omo/plans` exits 1 (the bare directory is not matched), while `git check-ignore -v .omo/plans/<file>.md` matches `.gitignore:59`. Second, and more importantly, **10 plans are already tracked** (`git ls-files .omo/plans/` returns 10 files, including `plan-gate-hardening.md` and `omo-agent-toolkit-rename.md`), so force-added plans ARE visible inside worktrees today. The gap is limited to plans that were never force-added. Confirmed no compensating mechanism: worktree creation is plain `git worktree add` (`.agents/skills/work-with-pr/SKILL.md:65-73`), `start-work` only records `worktree_path` (`start-work-hook.ts:153`), the plan resolver takes the supplied path with no walk-up (`session-plan-affinity.ts:34-36`), and no `OMO_PLANS_DIR` exists. `work-with-pr` touches plans only during post-work cleanup (`SKILL.md:308-314`).

**Fix status (2026-08-27, revised):** still unfixed, scope corrected. Severity revised `costly` -> `papercut`: force-adding a plan already works and is in active use, so the residual is a discoverability gap, not a blocker.

## 2026-08-25 — A stdio MCP server is reaped after exactly 30 min idle and never respawns; its tools then report as *nonexistent*

**Severity:** costly
**Area:** tools
**Observed in:** `~/git/onara` — `port-design` skill, Open Design (`open-design`) MCP

**What happened:** mid-task, every `open-design_*` call began failing with `Model tried to call unavailable tool`, and the server's tools were absent from the advertised tool list. The MCP was correctly registered and enabled; opencode had silently dropped the connection 30 minutes after the last call and did not reconnect on demand. Because the failure surfaces as *tool does not exist* rather than *server disconnected*, it reads as a naming problem — I guessed at four different tool-name spellings before checking the log. Only a user-initiated opencode restart restored it, and the same reap then recurred.

**Evidence:** the interval is exactly 30:00 after the last call, to the second, across six occurrences:

```
close=2026-08-22T21:42  last_call=2026-08-22T21:12:17.475Z
close=2026-08-23T12:54  last_call=2026-08-23T12:24:06.269Z
close=2026-08-24T09:05  last_call=2026-08-24T08:35:46.528Z
close=2026-08-25T06:51  last_call=2026-08-25T06:21:18.594Z
```
```
timestamp=2026-08-25T06:21:18.594Z level=INFO  message=evaluated permission=open-design_get_project ... action=allow
timestamp=2026-08-25T06:51:18.916Z level=WARN  message="MCP connection closed" server=open-design
```

The server is not at fault — a fresh handshake against the same wrapper answers immediately:

```
$ /Users/tim/.config/opencode/bin/open-design-mcp   # {"method":"initialize",...} on stdin
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{},"resources":{}},
 "serverInfo":{"name":"open-design","version":"0.2.0"}, ...
```

Nor is the backing app: the Open Design daemon (PID 2660) and its IPC sockets
(`/tmp/open-design/ipc/release-stable/{daemon,desktop,web}.sock`) have been up since Aug 23. Only the stdio bridge process is gone (`ps aux | grep -c '[o]pen-design-mcp'` → `0`).

**Not a blanket idle-reap.** Two other MCP servers in the same session survived far longer idle periods — `playwright-mcp` (PID 22613, up since 08:20) and `lean-ctx serve` (PID 29790, up since Aug 24). Whatever triggers this is specific to `open-design`, so the reap is likely a *reaction* to something that server's process does rather than a scheduled sweep. Closure counts in this log: `chrome-devtools` 8, `open-design` 7, `playwright` 1.

**Root cause / hypothesis:** *hypothesis, not diagnosis — not yet traced to source.* Two candidates I could not separate without reading opencode's MCP client: (a) the wrapper `exec`s an Electron helper with `ELECTRON_RUN_AS_NODE=1` (`~/.config/opencode/bin/open-design-mcp`), which may close or EOF its stdio pipe when idle in a way a plain node server does not; (b) opencode treats a transport-level EOF/stderr event as a permanent disconnect and drops the server's tool registration without attempting a respawn. The exact-to-the-second 30:00 interval argues for a timer somewhere, but a timer alone does not explain why two sibling stdio servers were unaffected.

**Two distinct defects, worth separating:**
1. *Reaped while idle* — arguably intentional resource management, though 30 min is short for a design-tool bridge whose backing app stays resident for days.
2. *No respawn on next use, and a misleading error* — this is the expensive half. A stdio server is cheap to restart (the handshake above is sub-second). Reporting the tools as nonexistent, rather than surfacing "server disconnected", sends the agent down a tool-naming rabbit hole. Four wasted calls here; the same trap previously cost a whole phase in this repo, when I read the *global* `enabled: false` and concluded the server was disabled while a project-scope `.opencode/opencode.json` had it enabled all along.

**Workaround:** restart opencode (user-initiated — an agent cannot respawn a stdio MCP it does not own). Where the MCP is only needed for *reads*, prefer the on-disk path: `$OD` is a real git checkout, so `cat`/`sed`/`awk` substitute for `get_file` entirely, and the `port-design` skill already mandates that for unrelated reasons. Only genuinely two-way operations (`start_run`, `get_run`, `write_file`) actually require the bridge.

**Fix status:** unfixed. Suggest, in priority order: (1) on a tool call to a registered-but-disconnected MCP, respawn and retry once before failing; (2) failing that, error with `server disconnected` naming the server, never as an unknown tool; (3) reconsider the idle TTL for stdio servers whose restart cost is a sub-second handshake.

**Update (same day):** a full opencode restart is **not** required. Toggling the server's `enabled` flag in the project's `.opencode/opencode.json` (true → false → true) respawns the stdio bridge in place, and the tools return immediately — verified by an `open-design_get_project` call succeeding right after the toggle, with `list_agents` and `start_run` working thereafter. That is a much cheaper recovery than restarting the session and losing conversational context, and it is something the user can do without killing in-flight work.

**Update (same day, 2):** the reap is not specific to `open-design` after all — `playwright` was reaped identically later in the same session (its tools vanished from the advertised list mid-task, while `lean-ctx` stayed up). So the earlier "only this one server is affected" observation was a sampling artifact of which servers happened to be idle 30 minutes. The `chrome-devtools` 8 / `open-design` 7 / `playwright` 1 closure counts in this log are better read as *how often each server sat idle*, not as evidence that one server is uniquely fragile.

**Update (same day, 3):** the misleading-error half has a concrete cost measurement now. When `playwright` was reaped, the recovery that worked was **re-loading the owning skill** (`skill(name="playwright")`) and then invoking through `skill_mcp(mcp_name="playwright", ...)`, which routes via the skill's own MCP registration rather than the reaped top-level one. Worth knowing as a second workaround where a skill owns the server. Without it, the failure presents as `Model tried to call unavailable tool 'playwright_browser_navigate'` — indistinguishable from a tool that never existed, which is what sends an agent guessing at name spellings instead of checking the connection.

**Update:** (2026-08-25, verified against installed opencode `1.18.20` and `~/git/opencode` `dev`@`38e10eb140`; reproduced experimentally)

*Diagnosis was half right. Hypothesis (b) is retracted: opencode does not reap the server. The **server self-exits**, and opencode is the victim.*

**Proven by experiment, not by reading.** A standalone probe spawned `/Users/tim/.config/opencode/bin/open-design-mcp` directly with **no opencode process anywhere in the picture**, completed the `initialize` handshake, held stdin open, and then sent nothing:

```
initialized_at=2026-08-25T07:19:17.3Z
child_exited_at=2026-08-25T07:49:18.3Z
exit_code=0            # stderr: 0 bytes
initialized -> self-exit = 1801.0s
```

The server exits **cleanly, on its own, at 30m01s idle**. `exit_code=0` and an empty stderr are the signature of a deliberate idle shutdown, not a crash, not an EOF, and not a kill.

A second probe reproduced it to the same tenth of a second while holding **byte-identical stdio to opencode's own child** - spawned via Bun with `stdin/stdout/stderr: "pipe"`, so fds 0/1/2 are unix socketpairs exactly as `lsof` shows for the real opencode child, rather than the first probe's FIFO plus regular files:

```
+1801.0s child exited code=0
```

Two different stdio flavours, same `1801.0s`, same `exit_code=0`. The timer is in the server and depends on neither the transport plumbing nor opencode.

**The same reap was then predicted and observed live, to the second.** In this session the opencode-owned child (pid 28242, spawned 09:16:13 local) last served a call at `07:18:44.208Z`. Predicted close `07:48:44Z`; the log recorded `timestamp=2026-08-25T07:48:44.450Z level=WARN message="MCP connection closed" server=open-design`, an idle interval of **1800.242s**, and the child was gone.

**The interval is idle-clocked, not age-clocked, and one unified rule explains all seven closures.** Recomputed across the whole log: five closes land 1800.3-1802.9s after the last `open-design_*` call. The two the original entry could not explain (`5406f5c9`, `1d5cfc5b`) occurred in runs with *zero* open-design calls, and are 1802.4s and 1801.7s after **run start** - the clock simply runs from connect when no call ever happens. Age is ruled out independently: pid 28242 was still alive at 30m20s of process age and only died at its idle mark.

**Two evidence corrections to the original entry.**

1. *The process-absence evidence is invalid.* `ps aux | grep -c '[o]pen-design-mcp'` can never match: the wrapper ends in `exec "$APP/.../Open Design Helper" .../daemon-cli.mjs mcp "$@"` (`~/.config/opencode/bin/open-design-mcp:69-70`), and `exec` replaces argv. The live process is `...Open Design Helper .../daemon-cli.mjs mcp`, which was present and healthy throughout. The conclusion "only the stdio bridge process is gone" happened to be true, but not for the stated reason. Grep the post-exec argv.
2. *The "not a blanket idle-reap" control does not hold as stated.* Sibling servers being long-lived proves nothing here, because they were never idle *and connected* in the same sense: `chrome-devtools` sat idle over 1800s inside a live run 17 times and `playwright` 3 times, with no close. The three `chrome-devtools` closures are 3-52s after their last call, i.e. browser teardown, an unrelated cause. Server-specificity is confirmed - just by the self-exit above, not by the sibling comparison.

**Downstream half confirmed exactly as written, and it is opencode's own defect.** `client.onclose` deletes `clients`, `defs`, and `instructions`, sets `{status:"failed",error:"Connection closed"}`, logs the WARN, publishes `ToolsChanged`, and never attempts a respawn (`packages/opencode/src/mcp/index.ts:443-455`; byte-identical logic in the installed 1.18.20 binary). `MCP.tools()` then skips any client whose status is not `connected` (`index.ts:675-684`), so the tools vanish from the advertised set, and the model-facing wording comes from the Vercel AI SDK's `NoSuchToolError` - `Model tried to call unavailable tool '<name>'` - confirmed present in the shipped binary. That is the whole rabbit hole: a server-side idle exit is rendered to the agent as a tool-naming mistake.

**Not our defect.** No omo code participates. Our only 30-minute constants are unrelated (`packages/lsp-daemon/src/daemon-server.ts:22`, `packages/git-bash-mcp/src/mcp.ts:8`); tier-2 `.mcp.json` servers are handed to opencode at `packages/omo-opencode/src/plugin-handlers/mcp-config-handler.ts:38-68` and their lifecycle is opencode's; and our tier-3 manager uses a 5-minute idle timeout and *does* force-reconnect on use (`packages/mcp-client-core/src/skill-mcp-manager/manager.ts:53,145-188`) - which is the behavior opencode is missing.

**Better workaround: restarting opencode is unnecessary.** opencode ships `MCP.connect` and a UI for it. In the TUI, run the `mcp.list` command (slash `/mcps`) and press **space** on the dead server to toggle it back - `dialog.mcp.toggle` calls `client.mcp.connect` and refreshes status. Over HTTP it is `POST /mcp/{name}/connect` (`packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`, `McpPaths.connect`). This re-runs `createAndStore` (`index.ts:648-651`), spawning a fresh child and re-registering the tools in-session, with the sub-second handshake the entry already measured. The read-path substitution advice stands and is still cheaper when only reads are needed.

**Diagnostic rule worth keeping:** when tools go missing mid-session, do not guess spellings. One grep settles it - `grep 'MCP connection closed' ~/.local/share/opencode/log/opencode.log`.

**Fix status (2026-08-25, revised):** root cause identified, unfixed, and split across two owners. (a) *Upstream, Open Design:* the server self-exits at 1801s idle; the exact timer was not located in the shipped bundle, so the ask is to make the idle TTL configurable or disable it for stdio. (b) *Upstream, opencode:* `onclose` drops tool registrations permanently with no respawn-on-use and no distinct error - upstream has an open PR for **remote** reconnect ([anomalyco/opencode#43558](https://github.com/anomalyco/opencode/pull/43558)) and an open idle-disconnect issue ([#43444](https://github.com/anomalyco/opencode/issues/43444)), but nothing for local stdio. Nothing is actionable inside this repository. Severity revised `costly` -> `papercut`: recovery is an in-session `/mcps` toggle rather than a restart, and the log grep identifies it in one command - but the misleading error stays expensive for whoever has not read this entry.

## 2026-08-25 - An inverted test silently deleted the only coverage of a still-reachable rollback path

**Severity:** costly
**Area:** tools
**Observed in:** oh-my-openagent, `review-work` gate on the resume adopt-fallback follow-up

**What happened:** A follow-up fix let `BackgroundManager.resume()` dispatch a continuation prompt for an orphan killed mid-turn, by passing `checkToolState: false` on the adopt path only. Two shipped tests pinned the opposite behavior, so they were rewritten to assert the new one. That much was correct. But those two tests were also the only coverage of the skipped-dispatch rollback at `manager.ts:1706-1714` (`restoreTaskAfterSkippedResume` + `rollbackAdoptedSession` + `completingTaskIds.delete` + throw). Rewriting them left that branch reachable in production and asserted by nothing. It is exactly the P1 false-success defect a review found one day earlier and commit `29d878800` fixed: `resume()` reporting success with zero prompts dispatched, leaving a phantom running task that wedges every retry.

`checkToolState: false` removes only one of four skip reasons. `reserved` (`session-idle-dispatch.ts:44-53`), `active` from the still-enabled `checkStatus` probe (`:86`), and `unavailable` all still reach the same rollback.

**Evidence:** deleting the `throw` at `manager.ts:1713` is killed on baseline `dev` but survives on the branch:
```
# baseline dev (d69fda7f2), mutation applied
 10 pass
 2 fail
# branch, same mutation applied
 13 pass
 0 fail
```
Repo-wide, the only remaining reference to the error string was the production line itself:
```
$ grep -rn "continuation prompt was not dispatched" --include=*.ts packages/
packages/omo-opencode/src/features/background-agent/manager.ts:1713
```

**Why the gates missed it:** the unit suite went green (13/13), typecheck passed, and a live probe proved the intended new behavior against a negative control. Every gate measured what the change *added*; none measured what it *removed*. Three independent review lanes converged on it, which is what caught it.

**Fix status (2026-08-25, fixed):** coverage restored with a trigger that does not depend on `checkToolState`. The replacement holds a prompt reservation on the child session via `setPromptReservation`, so the gate returns `reserved` and the rollback runs for a reason orthogonal to the tool-state check. Two tests: rollback hygiene (throw, `tasks.size === 0`, root-descendant count restored, `subagentSessions` cleared, session agent cleared) and the no-wedge retry (a second `resume()` must not throw `is currently running`). Both are killed by the same mutation, so the branch is pinned again.

**Rule worth keeping:** when a change inverts an existing test, check what else that test asserted. A test named for behavior X often carries incidental coverage of path Y, and repurposing it deletes Y silently. Before rewriting an assertion, mutate the production branch it covered and confirm something else still goes red.

---


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
OMO-side ownership retracted. The entry's own revised root cause already places the reap upstream (`docs/troubleshooting/harness-findings.md:1866-1868`), and source confirms OMO's tier-3 skill MCP manager already does the thing this entry asks for: `getOrCreateClientWithRetry()` force-reconnects on use with three attempts (`packages/omo-opencode/src/features/skill-mcp-manager/AGENTS.md:53-67`), pinned by `manager.test.ts:617` (one `Not connected` failure then success) and `:657` (persistent failure throws `Failed after 3 reconnection attempts`). Nothing in `packages/omo-opencode/src/mcp/` participates in the tier-1/tier-2 registration drop, which is upstream `onclose` behavior.

**Fix status (2026-08-27, revised):** not ours to fix at the tier-1/tier-2 layer; the OMO tier-3 path already reconnects. Remaining OMO-side option, if wanted, is a clearer error naming the disconnected server instead of reporting the tool as nonexistent.

## 2026-08-26 — A lane that yields mid-task reports as `completed`; nothing checks for a dirty tree

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`, orchestrating `.omo/plans/composed-days-modality-unification.md`

**What happened:** background lane `bg_d601cd11` (`category="deep"`, fixing two merge-blocking
defects) stopped mid-task and reported through the **completion** path. Its own final message
said:

> "Work incomplete. Stop point after F1 green and partial F2 implementation; no commits created."

Five modified files sat in the worktree with **zero commits**. The first fix was complete and
proven (RED `expected: <false> but was: <true>`, then `BUILD SUCCESSFUL`, XML at 11:35:16) —
all of it uncommitted, and all of it lost if that worktree were disturbed.

The parent did not catch it. The **user** did:

> "check the output of the agents. i think they may have stalled"

**Why the existing entries do not cover this** — four are adjacent, each different:

| Entry | Covers | Why today differs |
|---|---|---|
| 2026-08-17 stale-cancellation misread | agent converts inactivity timer into a budget, then **parks** via `report_blocked` | today it never parked; it returned a normal completion |
| 2026-08-17 dead task reports `running` | child **dead**, status frozen | child was **alive and correct**, it chose to stop |
| 2026-08-24 `formatTaskResult` discards transcript | session **errors**, transcript dropped | session did **not** error; it reported cleanly |
| 2026-08-25 invisible park | a **correctly-used** park whose wake is never delivered | no park was attempted at all |

Note the 2026-08-17 corrective wording (`AGENTS.md:124`) was present and **still did not
prevent this**. That fix inoculates the *block* path — "out of time is never a valid block
reason". This agent took the *completion* path instead, where no equivalent statement exists.

**Evidence:** the notification rendered as success-shaped:
```
- `bg_d601cd11`: Fix F1+F2 blockers | session: `ses_...` - completed with 2 unfinished todos
```
Meanwhile, on disk:
```
$ git log --oneline 0c96e66bc..HEAD     # → empty
$ git status --porcelain
 M backend_kt/.../program/ProgramPlanPersistence.kt
 M backend_kt/.../services/TrainingService.kt
 M backend_kt/.../integration/StackedCompositionLegsIT.kt
 M backend_kt/.../services/TrainingServiceTest.kt
 M docs/superpowers/evidence/composed-days-modality-unification/task-7.md
```
`background_output` compounded it: `Status: running`, plus a note that the child "was not
present in the session registry for the last 20 polls" — so the status line alone was
ambiguous. Reaching the truth took `git status`, `find -newermt`, log greps, and finally
`full_session` to surface the agent's own admission.

**Root cause:** two independent gaps, both read from `dev` source, not hypothesis.

1. **The completion summary cannot distinguish "finished" from "gave up".**
   `features/background-agent/background-task-notification-template.ts:57-66` builds the
   summary purely from `status` and `unfinishedTodoCount`:
   ```ts
   const statusSuffix = task.status === "completed"
     ? task.unfinishedTodoCount && task.unfinishedTodoCount > 0
       ? ` - completed with ${task.unfinishedTodoCount} unfinished todo${...}`
       : ""
     : ` [${task.status.toUpperCase()}]${task.error ? ` - ${task.error}` : ""}`
   ```
   A lane that finished cleanly and one that abandoned five modified files both render as
   `completed`. "N unfinished todos" reads as a tidy-up note, not as *work was abandoned
   uncommitted*.

2. **No dirty-tree check exists anywhere in the feature.**
   ```
   $ rg -n "git status|porcelain|isDirty|uncommitted" \
       packages/omo-opencode/src/features/background-agent/ | grep -v test
   (no matches)
   ```
   Nothing correlates a lane's terminal state with the worktree it was working in, so
   uncommitted work is invisible to the parent by construction.

Additionally, `rg` finds no "out of time" / commit-before-yield wording in
`features/background-agent/spawner.ts` or `tools/report-blocked/`, so the corrective clause
that exists for parking is never restated on the path this agent actually took.

**Workaround:** never trust a `completed` summary on a lane that was doing implementation
work. Check `git log <base>..HEAD` and `git status --porcelain` in the lane's worktree
before believing it. On finding this shape, `background_cancel(taskId=…)` then
`task(task_id="ses_…")` to resume **the same session** — full context is preserved and the
partial work is still on disk. Restarting fresh discards it.

**Proposed fixes** (in order of cost):

1. Have the completion path run `git status --porcelain` in the lane's working directory and
   prefix the summary with a loud marker when the tree is dirty **and** the lane produced zero
   commits — e.g. `⚠️ UNCOMMITTED: 5 modified files, 0 commits`. Converts a silent stall into a
   visible one. This is the cheap 80% and needs no behavioural change.
2. Extend the 2026-08-17 corrective wording to name the completion path explicitly: a lane must
   not *yield* with uncommitted work, not merely must not *park* over it. Current text at
   `AGENTS.md:124` only addresses blocking.
3. Instruct lanes to commit incrementally rather than saving commits for the end. A proven fix
   held hostage to an unproven one is the actual failure here — F1 was complete and verified,
   and was still at risk because F2 was not.

**No existing test** covers "a lane reports completed while its worktree is dirty". The
probe worth pinning first is the cheapest: assert that the summary line for a `completed`
task with uncommitted changes is distinguishable from one with a clean tree.

**Fix status:** unfixed.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed still open, with no compensating mechanism anywhere. Terminal status is assigned at `manager.ts:2925-2932`, reached from four accepting conditions in the poller: terminal session status (`:3521-3523`), idle or session-gone after valid output (`:3545-3561`), incomplete-todo grace expiry (`:3567-3599`), and normal completion (`:3602`). The notification renders every one of those as `completed`, with unfinished todos as the only qualifier (`background-task-notification-template.ts:57-68`); there is no commit count, dirty-tree state, yield reason, or abandonment marker. Exhaustive search for a dirty-tree check on the completion path (`git status`, `--porcelain`, `isDirty`, `dirtyTree`, `uncommitted`) returns nothing in `features/background-agent/` or `tools/background-task/`; the only `--porcelain` uses in the tree are `shared/git-worktree/collect-git-diff-stats.test.ts:73` and `hooks/start-work/worktree-detector.ts:79`, neither on this path. Partial compensations exist but do not cover a yielded lane: the todo grace window (`manager.ts:3567-3599`) and explicit `blockedAt`/`blockedReason` parking (`types.ts:104-107`, `blocked-state.ts:4`). No `turnCount`, `completionReason`, or `yielded` marker exists. No test covers completed-with-dirty-worktree.

**Fix status (2026-08-27):** still unfixed. Severity revised `costly` -> `blocker`: this is the failure mode that makes every other lane-completion signal untrustworthy, an agent cannot distinguish finished work from abandoned work, and unlike the mid-batch case there is no bounded fallback at all.

## 2026-08-25 — A `report_blocked` park is invisible to a *busy* parent, which then reports the dead lane as "in flight"

**Severity:** blocker
**Area:** background tasks
**Observed in:** `~/git/onara`, orchestrating `.omo/plans/composed-days-modality-unification.md`

**What happened:** background lane `bg_b200ac39` called `report_blocked` three times. The
first two delivered a `[BACKGROUND TASK BLOCKED]` reminder and the parent resumed the child
normally. The **third** park delivered nothing. The task went terminal (`cancelled`) and the
parent, having received no reminder, twice told the user the lane was "in flight". The user
caught it, not the agent:

> "are we waiting for something or do you need me for a decision?"
> "did you check the actual output? i dont think anything is really still running"

The child's work happened to survive (it had committed `3279ca35b` before parking), so the
damage was a stalled orchestrator. A park *before* a commit would have stranded uncommitted
work in a lane the parent believed was alive.

This is distinct from the 2026-08-17 `report_blocked` entry above. That one is about
**misuse** (agents parking on waits). This one is about a **correctly-used** park whose
notification is never delivered.

**Evidence:** `background_output` on the supposedly-running lane:
```
| Task ID | `bg_b200ac39` |
| Status  | **cancelled**  |
| Duration| 29m 35s        |
```
No result payload — a status table plus the original prompt.

**Root cause** (read from `dev` source, not hypothesis for the mechanism; the delivery
timing is inferred from the two working parks):

`report_blocked` parks by cancelling with notification suppressed —
`packages/omo-opencode/src/tools/report-blocked/tools.ts:41-47`:
```ts
await manager.notifyBlockedTask(task.id)
const parked = await manager.cancelTask(task.id, {
  source: "report_blocked", reason: blockedReason,
  abortSession: true, skipNotification: true,
})
```
`skipNotification: true` takes the early return at `manager.ts:2822-2827`, which calls
neither `markForNotification` nor `enqueueNotificationForParent`. The suppression is
deliberate and correct — `tools.test.ts:481` pins it as deadlock prevention — so the *entire*
burden of informing the parent falls on the preceding `notifyBlockedTask` wake.

That wake is queued **before** `cancelTask` sets `task.status = "cancelled"`
(`manager.ts:2683`/`:2786`). At queue time the task is still `running`, so
`isTaskFailure` (`manager.ts:3079`) is false and `allComplete` is false → the wake is born
with **`shouldReply === false`** (`manager.ts:2705`). A `shouldReply === false` wake has **no
defer ceiling**: `shouldForceDispatchAfterActiveDefer`
(`parent-wake-flush-runner.ts:256-258`) forces only `shouldReply` wakes. A continuously busy
parent — i.e. an orchestrator mid-plan — reschedules it forever.

This is **D2 from `HANDOVER-background-task-notification-bug.md`**, whose annotation narrows
D2 to "self-heals whenever the batch reaches `allComplete`". **That narrowing does not hold
for a park:** the task goes terminal via the one path that queues no second wake, so there is
never an `allComplete` wake to merge with and drag the pending one over the force-dispatch
line. The 300s bounded re-admission added for D2 deposits `noReply` only, so it cannot
surface this either.

Why the first two parks worked: timing. Both landed while the parent was briefly idle, so
the plain-dispatch path (`parent-wake-flush-runner.ts:143`) was reachable. **Delivery of a
terminal state depends on whether the parent happens to be busy.**

**Secondary finding:** `background_output` on a `cancelled` task returns a Markdown status
table, not an error. It is not shaped like the `[ERROR]` / `Task not found` responses a
caller is primed to notice, so an orchestrator scanning for a DoneClaim reads past it.
Compare `formatTaskNotFoundMessage` (`create-background-output.ts:81-98`), which is explicit
about both the failure and the recovery action.

**Workaround:** none that is reliable from inside the parent. After any `report_blocked`
round-trip, call `background_output` explicitly rather than trusting that a missing reminder
means "still running". The child *session* survives the park, so
`task(task_id="ses_...")` still recovers the lane.

**Fix status:** unfixed. Three candidate fixes, cheapest last:
1. Make the park's wake forcing — set the terminal status *before* `notifyBlockedTask`
   queues, or pass `shouldReply: true` for blocked wakes. Reuses the existing force-dispatch
   path. The "don't interrupt a busy parent" constraint pinned by
   `parent-wake-active-defer-ceiling.test.ts:145` is not violated: a terminal park is not
   gratuitous, the parent is by construction waiting on a child that stopped existing.
2. Have `cancelTask`'s suppressed branch verify a wake was actually *dispatched* before
   returning `true`, imitating the owed-wake check `scheduleTaskRemoval` gained for D1
   (`manager.ts:2405-2440`).
3. Prefix terminal-without-result states (`cancelled`, `interrupt`, `error`) in
   `background_output` with an explicit marker naming the state and the recovery action.
   Does not fix delivery, but converts a silent stall into a loud one.

**Do not** simply drop `skipNotification: true` — it prevents a self-deadlock
(`tools.test.ts:481`); removing it trades a silent stall for a hang.

**No existing test** covers "a park notification reaches a *busy* parent".
`parent-wake-midbatch-starvation.test.ts` is the closest shape and its fake-timer rig is the
one to reuse. The probe worth pinning first is the cheapest: assert the `shouldReply` value
of the wake queued by `notifyBlockedTask` — it is `false` today, and that is the mechanical
root cause.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Confirmed, with the boundary located exactly. `report_blocked` records the park (`tools.ts:36-38`), calls `notifyBlockedTask` (`:40`), which queues a parent wake and arms escalation (`manager.ts:2657-2660`), then cancels with `skipNotification: true` (`tools.ts:41-46`) so no second notification fires. On the flush side, a busy parent defers (`parent-wake-flush-runner.ts:39-49`, `:61-87`). Cross-checked every ceiling constant, which is the step that corrected a prior review of a sibling entry: `PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS` (`:23`, used `:295-297`) force-dispatches **only** when `wake.shouldReply === true`, so a blocked wake never qualifies; `PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS` (`:28`, used `:303-308`) does admit it after 300s, but only as a `noReply` deposit. `PENDING_PARENT_WAKE_RETRY_MS` and `PENDING_PARENT_WAKE_DEBOUNCE_MS` (`manager.ts:156-157`) are timing only. So the park is not invisible forever, but it is never actionable: the parent gets a no-reply deposit it cannot answer, which is what makes the lane read as "in flight". No test pairs `report_blocked` with a busy parent (`blocked-resume.test.ts:86`, `blocked-retention.test.ts:83-183`, `blocked-races.test.ts:51-187` cover resume, retention, and races only).

**Fix status (2026-08-27):** partially fixed. Unbounded invisibility is closed by the 300s retained ceiling; the actionable-wake half is open at `parent-wake-flush-runner.ts:295-297`. Severity revised `blocker` -> `costly`.

## 2026-08-26 — `ctx_read` v1 request shape loops on an incompatible empty `paths` field

**Severity:** costly
**Area:** tools
**Observed in:** `~/git/onara`, parent session `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4`; child `opencode://ses_fc1b79bf4ffeJKLMFp60fIHmg1`.

**What happened:** a worker retried the same `ctx_read(engine_interface="v1")` request after
lean-ctx rejected it. The payload had a valid single `path` but also carried `paths: []`, so
it was not a single-path read under the v1 contract. The same failed read was retried several
times before the worker finally removed `engine_interface`.

**Evidence:**
```
engine_interface="v1" supports only single-path ctx_read
```

First failing part: `opencode://ses_fc1b79bf4ffeJKLMFp60fIHmg1#prt_03e48dd03001UWAxMzGNTkoDtF`.
Parent receipt: `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4#prt_03e65e04c001yvNZrpvsH7KYDJ`.

**Root cause / hypothesis:** v1 validates the full request shape, including empty optional
fields. The model/tool adapter had no recovery rule saying "after this exact rejection, omit
`engine_interface` and `paths`, or use plain `ctx_read`/shell".

**Workaround:** omit `engine_interface="v1"` unless issuing a strict single-path request;
otherwise use ordinary `ctx_read` or a targeted shell read.

**Fix status:** unfixed — needs request normalization or an explicit error-recovery hint.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Still open and confirmed external. The lean-ctx skill documents `ctx_read` modes and cache behavior (`~/.config/opencode/skills/lean-ctx/SKILL.md:36-54`) but nothing about `paths` versus `path` or `engine_interface: "v1"`; no `references/` directory exists beside it. No tracked recovery hint exists in this repo: the only `ctx_read` mention is tool-name matching at `packages/omo-opencode/src/hooks/rules-injector/AGENTS.md:21`. Ownership is external: lean-ctx appears in neither `package.json:8-38` nor `.opencode/package.json:1-5`, so there is nothing here to normalize.

**Fix status (2026-08-27):** still unfixed, upstream ownership. Repo-side option is a one-line agent-facing hint; the real fix is upstream request normalization.

## 2026-08-26 — Foreground timeout hid a failing detekt pre-commit gate

**Severity:** costly
**Area:** tools
**Observed in:** `~/git/onara`, parent session `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4`; child `opencode://ses_fc1b6b923ffe85o1mBslxEfb4U`.

**What happened:** a commit pre-hook ran detekt. The foreground call reported a timeout, so
three reports framed the state as "commit timed out, state unknown". Direct detached log
capture later showed a real quality-gate failure, not a timeout.

**Evidence:**
```
MCP error -32001: Request timed out
Analysis failed with 34 issues.
BUILD FAILED in 1m 23s
EXIT:1
```

Timeout: `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4#prt_03e8dcbcd001f76TMdTUcFgtAr`.
Diagnosis: `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4#prt_03e91dc92001qJYq0ZQjs5Chd7`.

**Root cause / hypothesis:** the foreground cap terminated observation before the pre-hook
printed its terminal result. The harness exposed timeout without enough context to distinguish
"still running" from "finished unsuccessfully".

**Workaround:** after a timeout, inspect `git log`, `git status`, and any redirected hook log;
for long hooks use supported background-shell polling and verify the resulting XML/report on
disk.

**Fix status:** worked around. A terminal-status probe or direct capture of trailing tool
output would make the failure legible.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Coverage is better than recorded, but not at the strongest site. The core lesson is tracked in-repo, not user-global-only as the sibling entry at line 1383 claims: verify-by-effect guidance sits at `docs/troubleshooting/harness-findings.md:269-271` and `:1372-1375`, and `packages/omo-opencode/src/hooks/unpolled-shell-job/AGENTS.md:41-49` documents `background_action="status"` terminal-state parsing with bounded polling at `:63-75`. The user-global copy is at `~/.config/opencode/AGENTS.md:128-130`. What is missing is a single tracked instruction tying the two together: after a foreground timeout, probe the job's terminal status if a job id exists, then verify the effect on disk. No `.omo/rules/*.md` and no `.agents/skills/**` file carries it.

**Fix status (2026-08-27):** partially fixed. Severity stays `costly` until the timeout-to-probe step is written down where an agent reads it at request time.

## 2026-08-26 — Detached shell completion and task completion have incompatible wake contracts

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`, parent session `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4`.

**What happened:** a detached `ctx_shell` commit job was treated like a background `task`.
The task path pushes a completion reminder; the shell path is pull-only. The shell completed,
but a lane later sat idle with reformatting on disk and no process alive until the parent
inspected `git log`, `git status`, and `pgrep` by hand.

**Evidence:**
```
ctx_shell(run_in_background=true) does not notify on completion
no <system-reminder> will ever arrive for it
```

Start: `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4#prt_03e8edafa001onlHOEQHMOFhKu`.
Harness warning: `#prt_03e91fac20018ds0HEAYr9rUFY`.
Silent-lane discovery: `#prt_03e9ab573001E0KPE1pyYlUsnG`.

**Root cause:** documented lean-ctx behaviour; the failure is a predictable contract mix-up
between identically named `run_in_background=true` options.

**Workaround:** foreground commands expected under the cap; use `task` for delegable long
work; when detached `ctx_shell` is necessary, poll `background_action="status"` until
terminal and verify disk effects.

**Fix status:** docs-gap. Existing warnings are correct but need stronger request-level
routing or shape-specific affordances.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Partially fixed, and the coverage claim in the entry needs correcting: the distinction IS tracked in-repo, at `packages/omo-opencode/src/hooks/unpolled-shell-job/AGENTS.md:8-14`, which states that `task(run_in_background=true)` delivers a `<system-reminder>` while `ctx_shell(run_in_background=true)` never notifies and must be polled, with the why at `:16-24`. The user-global copy is at `~/.config/opencode/AGENTS.md:110-121`. The gap is at the strongest possible site: no tool description says it. `delegate-task/tools.ts:71` and `call-omo-agent/constants.ts:6,13` describe only that async returns an id for `background_output`; the generated results at `background-executor.ts:93`, `background-agent-executor.ts:85`, and `create-background-task.ts:120` tell the agent to wait for a notification, which is correct for `task` and actively misleading if generalized to a detached shell. No tool description mentions `background_action="status"`.

**Fix status (2026-08-27):** partially fixed. Severity stays `costly`: hook-directory `AGENTS.md` is read on file touch, not at the moment the agent chooses the mechanism.

## 2026-08-26 — Prompted sentinel-loop workaround conflicts with active shell guidance

**Severity:** costly
**Area:** rules injection
**Observed in:** `~/git/onara`, parent session `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4`; child `opencode://ses_fc12f80a7ffenWqJHX5Bp2wzKh`.

**What happened:** execution prompts prescribed a hand-rolled detached shell wrapper:
`(cmd > /tmp/x.log; echo EXIT:$? >> /tmp/x.log) &` plus a `for`/`sleep` sentinel loop. The
worker had an active developer rule forbidding hand-rolled sentinel wrappers, so it blocked
before capturing its required RED test.

**Evidence:**
```
Gradle RED verification exceeded foreground cap and user-mandated detached bounded-poll workflow conflicts with active developer rule forbidding hand-rolled sentinel wrappers
```

Blocked receipt: `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4#prt_03ed74db0002j3EaTnLEQIGjWP`.
Resolution: `#prt_03ed7f3aa001731jrJ0dHIURYQ`.

**Root cause:** the parent specified an implementation mechanism rather than the invariant:
run long work to a terminal state, then verify its on-disk effect. The rule hierarchy offered
two incompatible mechanisms.

**Workaround:** specify the contract, not a shell incantation. Prefer foreground for short
Gradle selectors; for truly long work use supported `ctx_shell` background polling and XML /
report verification.

**Fix status:** worked around. Prompt templates should avoid prescribing unsupported sentinel
wrappers.


**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
The prescribed pattern is gone from active prompts and skills. Exhaustive search of `packages/prompts-core/`, `packages/omo-opencode/src/agents/`, `packages/omo-opencode/src/tools/*/prompt*.ts`, `.agents/skills/`, `.opencode/skills/`, and `packages/shared-skills/` found no detached-wrapper or `for`/`sleep` sentinel guidance. The only `sentinel` hit is unrelated (`packages/prompts-core/prompts/ultrawork/codex.md:268`, a hook-grepped token). The `until [...] ; do` loops at `.agents/skills/work-with-pr/SKILL.md:299` poll GitHub PR state, and the `sleep` calls at `.opencode/skills/opencode-qa/references/tui-tmux.md:44,47` are TUI smoke timing, neither is the pattern. The opposite direction is now written down in three places: `~/.config/opencode/AGENTS.md:122` forbids foreground sleep-polling, `packages/omo-opencode/src/hooks/unpolled-shell-job/AGENTS.md:67` and `message.ts:31` distinguish blind `sleep 300` from supported polling, and `.agents/skills/publish/SKILL.md:44,155` requires polling without sleep commands. The entry does not name the template that originally prescribed it, so the source could not be confirmed.

**Fix status (2026-08-27):** effectively fixed by removal; the conflicting guidance no longer exists in any active prompt path. Severity revised `costly` -> `papercut`.

## 2026-08-26 — File-disjoint lanes can still starve each other through Gradle capacity

**Severity:** costly
**Area:** subagents
**Observed in:** `~/git/onara`, parent session `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4`.

**What happened:** seven source-disjoint worktree lanes were dispatched together. Each ran
Gradle with a large daemon heap against shared caches. Three lanes stalled at
`:compileTestKotlin`; one deleted its uncommitted test to restore a clean tree, losing work.

**Evidence:**
```
7 concurrent Gradle builds contending on the same daemon/lock
7 concurrent Gradle daemons at -Xmx4g each exhausted memory
```

Diagnosis: `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4#prt_03ee5b012001x0q5Oo1vf939xO`.
Confirmation: `#prt_03ee5fc1600102O5SfMiIw5R2F`.
Impact: `#prt_03ee6f3b4001wfi8efJNqoTEic`.

**Root cause:** parallel dispatch gate only considered declared file overlap. It had no
resource-capacity dimension for shared Gradle daemons, memory, or caches.

**Workaround:** serialize or cap build-heavy lanes; a lane blocked on infrastructure must
keep its dirty worktree or commit its scoped WIP rather than delete work for cleanliness.

**Fix status:** unfixed — scheduler/concurrency policy needs a resource-class limit in
addition to file-overlap safety.

**Update (2026-08-26, live source trace):** The capture rule was not disabled or denied in
the new Onara session. `~/.omo/rules/harness-findings.md:1-5` has a valid `**/*` global
match; user-global discovery explicitly scans `~/.omo/rules`
(`packages/rules-engine/src/constants.ts:14,29`, `finder.ts:25-51,124-148`); no filename or
content denylist applies; and the rule was recorded in child-session cache
`~/.local/share/opencode/storage/rules-injector/ses_fc0f6f566ffedn3RyfkfvsOzHO.json` under
`/Users/tim/.omo/rules/harness-findings.md`.

The surprise is delivery, not discovery. Rules injection does **not** add a durable
session/system prompt: it runs only after a tracked native read/write/edit/multiedit yields
path metadata (`packages/omo-opencode/src/hooks/rules-injector/hook.ts:37,69-79`), then
appends the banner into that particular tool result (`injection-processor.ts:115-188`,
`injection-output.ts:7-24`). Real-path/content-hash dedupe and transcript hydration suppress
later replay (`injection-processor.ts:125-168`, `transcript-hydration.ts:46-56,76-106,135-170`).
Consequently a rule can have injected successfully earlier yet be absent from the agent's
visible working context when a later harness incident occurs. The current parent transcript
is `opencode://ses_fc1bb1a48ffeH59hmVy9454tq4`; the cache evidence above is from its child.

**Fix status (2026-08-26):** discovery works; durable recall remains a docs/design gap. A
finding-capture rule needs an explicit re-surfacing trigger at a natural incident boundary,
or must be carried in durable session instructions rather than one-shot tool output.

**Update:** (2026-08-27, verified against `dev` source at `7a5c3506c`)
Two claims in this entry, verified separately.

**Claim A, Gradle/resource capacity.** Still open. Concurrency is keyed by model, provider, or a default only (`packages/omo-opencode/src/features/background-agent/concurrency.ts:28-55`), and config exposes exactly `providerConcurrency` and `modelConcurrency` (`config/schema/background-task.ts:14-15`). No `resourceClass`, build-capacity, or shared-resource semaphore exists; the only `semaphore` in the tree limits ripgrep processes (`tools/shared/semaphore.ts:2,31`). A file-overlap scheduler could not be located in this source tree at all, so the entry's premise that file-overlap safety exists is itself unconfirmed.

**Claim B, rules-injection durable recall.** Still open, and the mechanism is confirmed exactly as described. Discovery works: `~/.omo/rules` is in both `OPENCODE_USER_RULE_DIRS` and `SOURCE_PRIORITY` (`packages/rules-engine/src/constants.ts:14,29`) and is resolved by `addUserRuleCandidates()` from `findRuleFiles()` (`finder.ts:25-50,124-148`). Delivery is one-shot: only tracked `read`/`write`/`edit`/`multiedit` results with path metadata reach processing (`hooks/rules-injector/hook.ts:37,69-79`), and the banner is appended into that single tool output (`injection-output.ts:7-24`). Replay is then suppressed by real-path and content-hash dedupe (`injection-processor.ts:125-167`) and transcript hydration (`transcript-hydration.ts:46-56,76-106,135-170`). Cross-checked for a durable route: the context injector only consumes already-pending collector content (`features/context-injector/injector.ts:53-67,90-166`) and the Transform tier registers no rules re-injection (`plugin/hooks/create-transform-hooks.ts:70-71,108-116`); the rules injector remains a Tool Guard hook (`create-tool-guard-hooks.ts:102-109`).

**Fix status (2026-08-27):** both claims still unfixed. Claim B is the more consequential: every capture rule, lesson, and path-scoped architecture rule inherits this delivery model, so a rule can be discovered, injected once, and absent from context exactly when it matters. Severity for Claim B revised `costly` -> `blocker`; Claim A stays `costly`.

## 2026-08-27 — Background-agent todo-gate tests used an unpinned historical clock

**Severity:** costly
**Area:** background-agent tests

**What happened:** Three todo-gate cases used a `2026-08-17` fixture from `manager.polling.test.ts:396` but called unmocked `Date.now()`. As wall-clock time moved beyond the 60-second grace period, they failed on the next unrelated edit to `manager.ts` despite unchanged production behavior.

**Root cause:** only one of four tests in the block pinned `Date.now`; the other three compared historical fixture timestamps against real time.

**Fix:** added one `withFixedNow(fixedNow, fn)` helper with `finally` restoration and ran all four cases through it. Expectations retain their todo-gate behavior; only clock source is deterministic.

## 2026-08-27 — A fresh `git worktree` has no `node_modules`, so build, typecheck, and live QA all fail inside it

**Severity:** costly
**Area:** subagents
**Observed in:** oh-my-openagent, `/start-work` executing `.omo/plans/2026-08-27-harness-findings-top3.md` across per-lane worktrees

**What happened:** Three separate lanes working in per-task worktrees under `.worktrees/` each hit the same wall and each lost a turn to it. One reported `bun run typecheck` exit 2 and listed it as a risk in its DoneClaim; an independent reviewer then escalated it as a possible defect of the change under review. Two others reported BLOCKED when `bun run build` died, which in turn blocked the live QA that requires a fresh `dist/`. None of it was caused by the code being reviewed.

**Evidence:**
```
packages/omo-senpi/src/components/memory/tools.ts(15,49): error TS2307: Cannot find module 'typebox' or its corresponding type declarations.
packages/omo-senpi/src/components/memory/worker/entry-renderers.ts(24,33): error TS2307: Cannot find module '@earendil-works/pi-tui' or its corresponding type declarations.
TYPECHECK_EXIT=2

build:cli-node
$ bun run script/build-cli-node.ts
error: File not found ".worktrees/hf-top3-pr2/node_modules/jsonc-parser/lib/esm/main.js"
build: FAILED: build:cli-node failed with exit code 1
```
```
$ ls -d .worktrees/hf-top3-pr1/node_modules
ls: .worktrees/hf-top3-pr1/node_modules: No such file or directory
$ bun run typecheck        # in the MAIN checkout, same commit
TYPECHECK_EXIT=0
```

**Root cause:** `node_modules/` is gitignored (`.gitignore:11`), and `git worktree add` only materializes tracked content, so a new worktree starts with no dependencies at all. This repo is a 30-package Bun workspace whose deps resolve from the main checkout's root `node_modules` plus per-package `node_modules` (for example `typebox` and `@earendil-works/pi-tui` live in `packages/omo-senpi/node_modules`). Every lane worktree therefore needs its own install before it can build, typecheck, or drive live QA. Same class as the already-logged `.omo/plans` worktree gap: worktree isolation is only as complete as the tracked tree.

**Workaround:** `cd <worktree> && bun install` (616 packages, about 11s) immediately after `git worktree add`, before dispatching any lane into it. The first response was weaker and should not be repeated: the typecheck failure alone was diagnosed as a worktree artifact and routed around with a scoped `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`. That unblocked typecheck but left the underlying gap in place, and the build failure then resurfaced in two further lanes. Treat module-not-found inside a worktree as a missing-install signal, never as a defect of the change under review.

**Follow-on trap:** once the install succeeds, `bun run build` regenerates nine committed bundle artifacts (`packages/omo-codex/plugin/components/codegraph/dist/{cli,serve}.js`, `packages/omo-codex/scripts/install-dist/install-local.mjs`, and six `packages/omo-senpi/plugin/extensions/*`). They show as modified in the lane's worktree despite the lane never touching them. A lane told to finish with an empty `git status --porcelain` will be tempted either to `git checkout` them, which fights the build, or to `git add -A`, which stages nine unrelated files into its commit. The contract must instead be an explicit allowlist of those known regenerated paths.

**Update (2026-08-28):** the same gap also disables the LSP inside a lane worktree, which is a separate loss from build and typecheck because it is silent. Three lanes in the post-merge review wave (`b212e8ff2`, `100a71127`, `3ca83323f`) each ran `bun install` correctly and still could not obtain diagnostics:

```
Request initialize failed with message: Could not find a valid TypeScript installation.
Please ensure that the "typescript" dependency is installed in the workspace or that a
valid `tsserver.path` is specified. Exiting.
```

The language server resolves `typescript` from the workspace root rather than from the per-worktree install, so `lsp_diagnostics` returns nothing useful even after dependencies are present. Unlike the build failure, this does not announce itself as a blocker: a lane simply gets no diagnostics and may report the file as clean. `bun run typecheck` (which uses `tsgo` and does not depend on the language server) is the correct substitute gate inside a worktree, and a lane brief should say so explicitly rather than asking for LSP-clean as evidence.

**Fix status:** worked around

## 2026-08-27 — `record_lesson` rejects a well-formed `globs` array and cannot write a lesson

**Severity:** costly
**Area:** tools
**Observed in:** oh-my-openagent, attempting to persist a worktree lesson during `/start-work`

**What happened:** Three consecutive `record_lesson` calls failed on valid input, so a durable lesson could not be written through the intended surface at all. The first failure named a different field than the later two, which suggests arguments are lost or mis-parsed before validation rather than a single bad field.

**Evidence:**
```
attempt 1 (title, what_went_wrong, rule_for_next_time, globs: 3-entry array, citations: 3 entries)
  -> undefined is not an object (evaluating 'value.replaceAll')

attempt 2 (same, globs: ["packages/**/*.ts", "script/**/*.ts"], citations: 2 entries)
  -> undefined is not an object (evaluating 'args.globs.map')

attempt 3 (compact single-line array, em dashes and backticks removed from all prose)
  -> undefined is not an object (evaluating 'args.globs.map')
```

**Root cause / hypothesis:** hypothesis, not confirmed. `args.globs` is `undefined` inside the tool despite a non-empty array being supplied, and attempt 1 failing on `value.replaceAll` points at a separate undefined string field. Both are consistent with the argument object arriving empty or partially deserialized, so the schema-declared required fields are never populated. Not reproduced against tool source; the three call shapes above are the only evidence.

**Workaround:** the lesson content was written into `.omo/start-work/ledger.jsonl` and into this log instead. The operational rule it encoded was enforced directly by installing dependencies in every worktree.

**Fix status:** unfixed

## 2026-08-27 — An interrupted parent aborts its background lanes, but they keep reporting `running` until the 45-minute stale reaper

**Severity:** costly
**Area:** background tasks
**Observed in:** oh-my-openagent, `/start-work` running two implementation lanes as background tasks

**What happened:** The user interrupted the primary session turn. That abort propagated to both background lanes and killed them at 19:31:59 and 19:32:05. Neither ever resumed. But `background_output` kept reporting `Status: running` with a plausible `Last tool`, so when the user said "continue", the orchestrator checked task status, saw `running` on both, and reported both lanes healthy and still working. They had been dead for two hours. At 21:37 the 45-minute stale reaper finally fired and reported them as FINAL cancellations with "no activity for 45min", which is true but reads like a fresh hang rather than a two-hour-old abort.

**Evidence:**
```
19:31:59.385 [unstable-agent-babysitter] Marked session cancelled {"sessionID":"ses_fbbb42581ffeE2FwjmiLssXnhN"}
19:31:59.386 [background-agent] session.error received but session still alive, treating as transient: {"taskId":"bg_f7ae25cc","sessionId":"ses_fbbb42581ffeE2FwjmiLssXnhN","errorMessage":"Aborted"}

19:32:05.389 [unstable-agent-babysitter] Marked session cancelled {"sessionID":"ses_fbbe30a9bffexHIqsUnb8N77qT"}
19:32:05.390 [background-agent] session.error received but session still alive, treating as transient: {"taskId":"bg_34350d8c","sessionId":"ses_fbbe30a9bffexHIqsUnb8N77qT","errorMessage":"Aborted"}
19:32:05.391 [atlas] session.error {"sessionID":"ses_fbbe30a9bffexHIqsUnb8N77qT","isAbort":true}
```
Status reported to the orchestrator roughly 1h40m AFTER those aborts, while the user was waiting:
```
| Task ID | `bg_f7ae25cc` |  | Status | **running** |  | Duration | 1h11m55s |  | Last tool | lean-ctx_ctx_shell |
| Task ID | `bg_34350d8c` |  | Status | **running** |  | Duration | 1h13m23s |  | Last tool | lean-ctx_ctx_shell |
```
Last real disk activity, consistent with in-flight work draining and then silence, never with a live agent:
```
.worktrees/hf-top3-pr1/.omo/evidence/20260827-bg-completion-reason/  last write 19:50
.worktrees/hf-top3-pr2  last commit e8a86869a                        19:51:23
```

**Root cause / hypothesis:** two components disagree about the same abort, one millisecond apart, and nothing reconciles them. `unstable-agent-babysitter` marks the session cancelled; the background-agent then inspects the same `session.error`, judges the session still alive, and classifies the abort as transient, so the task record stays `running`. The parent's abort is not treated as terminal for its children. The task then survives as a zombie until the unrelated `staleTimeoutMs` reaper (`background-task.ts:18`, default 2700000 ms) collects it. The "still alive" branch is presumably there to protect against transient provider errors, and a parent-initiated abort is being funnelled through it. That mechanism reading is a hypothesis; the log lines above and the timings are directly observed.

**Why it is costly:** the reported status is not merely late, it is actively misleading, and it defeats the normal way an orchestrator checks liveness. The repo's own guidance is that a running child is alive and that you should poll rather than assume death, which is exactly the wrong move here. Roughly two hours of wall-clock across two lanes was lost, and a user question ("did those lanes go stale?") was needed before anyone looked at the log. Compounding it, seven duplicate `BACKGROUND TASK ANSWER ACCEPTED` reminders arrived for one already-dead task, which read like ongoing activity.

**Workaround:** after ANY interruption of the primary session turn, treat every background lane as suspect regardless of its reported status. Verify liveness by effect, not by status line: check file mtimes in the lane's worktree, its commit times, and `grep` the plugin log (`$TMPDIR/oh-my-opencode.log`) for `isAbort` or "Marked session cancelled" against the lane's session id. Disk state survives the abort intact, so surviving work can be salvaged and the lane relaunched with narrowed scope rather than restarted.

**Fix status:** unfixed

## 2026-08-27 — A green test suite hid a feature that never fires on its common path, because the plan's example test only covered the rare branch

**Severity:** costly
**Area:** other
**Observed in:** oh-my-openagent, PR 1 of `.omo/plans/2026-08-27-harness-findings-top3.md`, adding a completion-reason discriminator to background-task notifications

**What happened:** A lane implemented the feature, added seven tests, and reached `916 pass, 0 fail`, up from a 909 baseline. The feature did not work. The reason qualifier was nested INSIDE the unfinished-todos branch of the notification template, so it rendered only when `unfinishedTodoCount > 0`. A cleanly completing background task, which is the common case and the case that motivates four of the five reason values, rendered no reason at all. The lane separately reported its live QA as blocked on agent-model resolution, but the QA could never have passed: it spawned one trivial lane that completed cleanly, so the marker it was asserting was structurally unreachable.

**Evidence:** executing the real template against two fixtures, rather than reading it or trusting the suite:
```
CLEAN COMPLETION, completionReason "session-gone":
  "- `task-a`: task A | session: `ses_x`"
  reason rendered? -> false

UNFINISHED TODOS, completionReason "todo-gate-expired":
  "- `task-a`: task A | session: `ses_x` - completed with 3 unfinished todos, reason: todo-gate-expired"
  reason rendered? -> true
```
The QA artifact agrees, and was the first clue:
```
.omo/evidence/20260827-bg-completion-reason/09-notification-lines.txt   0 bytes
```

**Root cause:** the work plan's own Test 6 example embedded the reason inside the unfinished-todos sentence:
`expect(text).toContain("completed with 3 unfinished todos, reason: todo-gate-expired")`. Its Test 7 asserted the opposite case, that no qualifier renders when no reason is recorded. Between them the two tests never covered a clean completion WITH a reason, so an implementation that satisfied both literally could still fail the feature's main path. The lane implemented exactly what the plan specified.

**Why it is costly, and the transferable lesson:** the plan was reviewed twice (Momus, Oracle) and revised three times, and this still got through, because review checked whether the tests were rigorous rather than whether they covered the common case. A test-first plan that supplies literal example assertions transfers its blind spots directly into the implementation, and a suite derived from those examples will be green over the gap. When a plan hands you exact assertion strings, check which cases they do NOT constrain before implementing. When verifying, run the feature on its ordinary input rather than only running the suite: a green suite plus an empty QA artifact is a contradiction, and the empty artifact is the one telling the truth.

**Workaround:** add the missing case, a clean completion that renders its reason, and fix the template so the qualifier is not nested inside the unfinished-todos branch.

**Fix status:** unfixed

## 2026-08-27 — Completion reasons were hidden for clean background-task completions

**Severity:** costly
**Area:** background-agent notifications

**What happened:** Four completion call sites produce five union values: poller completion uses `terminal-session-status`, `todo-gate-expired`, `idle-status`, and `session-gone`; `session-idle-event-handler.ts:92` independently produces `session-idle-event` outside poller flow. Notification rendering nested reason text inside `unfinishedTodoCount > 0`, so clean completions omitted their discriminator.

**Root cause:** `background-task-notification-template.ts` made todo count and completion reason one nested suffix. A 916-pass feature suite hid this common-path defect because existing reason coverage used unfinished todos.

**Fix:** render todo count and completion reason as independent completed-task suffixes. Added regression coverage for clean completion, unfinished todos plus reason, and missing reason. Live isolated HTTP-server QA recorded `reason: session-gone` in `[ALL BACKGROUND TASKS COMPLETE]`.

## 2026-08-27 — A QA project under macOS `/tmp` silently disables the rules injector, because the resolved path loses its leading slash

**Severity:** costly
**Area:** rules injection
**Observed in:** oh-my-openagent, sandboxed `opencode-qa` runs verifying a rules-injector change

**What happened:** Four separate lanes, roughly two and a half hours in total, tried to observe the baseline `[Rule: ` marker in a sandboxed opencode session and never saw it once. Two of them concluded the feature was broken; a dedicated probe reported "baseline injection works on dev: no", which would have meant the QA harness could not verify this hook at all. The feature was fine the whole time. The QA fixture's own location was the defect.

**Evidence:** parsed from the probe's captured tool part, not from a summary:
```
TITLE: 'private/tmp/rules-baseline-probe/dev-project/packages/omo-opencode/src/shared/prompt-async-gate.ts'
META : {'preview': 'import { configureSharedSubunitLogger } ...'}
```
```
$ ls -ld /tmp
lrwxr-xr-x  1 root  wheel  11 ... /tmp -> private/tmp

$ [ -e "private/tmp/rules-baseline-probe/dev-project/packages/omo-opencode/src/shared/prompt-async-gate.ts" ] && echo RESOLVES || echo "DOES NOT RESOLVE"
DOES NOT RESOLVE (relative, no leading slash)
```

**Root cause:** two facts compound. First, the `read` tool's `metadata` carries only `preview`, with no `filePath`, so `getRuleInjectionFilePath()` (`hooks/rules-injector/output-path.ts`) falls through to `output.title`. Second, macOS `/tmp` is a **relative** symlink to `private/tmp`, so resolving a path under it yields `private/tmp/...` and drops the leading slash. The injector therefore receives a path that resolves from no working directory at all, `findProjectRoot` and `findRuleFiles` find nothing, and it correctly declines to inject. `/var/folders/...` sandbox paths are reached the same way, which is why an XDG sandbox exhibits it too.

**Why it fooled every investigation:** the failure is completely silent and imitates a broken feature. The tool call succeeds, real file content comes back, the tool name `read` matches `TRACKED_TOOLS` exactly, the rule files exist, and their globs match the target. Every check a lane thinks to run is green except the marker itself. One lane reasonably hypothesized the hook was never invoked; another concluded the injector returns early at the hook boundary. Both were describing a symptom of the fixture path.

**What broke the deadlock:** a contradiction that could not be argued away. The rules injector was visibly firing in the orchestrator's own session on every file read, and that repo lives under `/Users` with no symlink. "Works in production, fails in every sandbox" pointed at the fixture rather than the code, and parsing the probe's raw artifact rather than trusting its conclusion produced the title string above.

**Workaround:** keep the QA PROJECT directory outside symlinked temp space, for example under `$HOME` or a real checkout under `/Users`. XDG isolation (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `$HOME` redirection) can stay in temp, since only the project path feeds rule discovery. Assert it before running: `python3 -c "import os;print(os.path.realpath(PROJECT))"` must not print a path starting with `private/`. More generally, any QA that exercises a path-dependent hook needs this check, and a fixture that silently produces a non-resolving path should be suspected before the feature is.

**Fix status:** worked around

## 2026-08-27 — Resuming a dead background session adopts a nonexistent agent named `continue`, returning a live-looking task id that can never run

**Severity:** costly
**Area:** subagents
**Observed in:** oh-my-openagent, `/start-work` resuming lanes whose sessions had been aborted or stale-cancelled

**What happened:** Twice, calling `task(task_id="ses_...")` against a session whose agent was no longer alive did NOT fail fast. Both times it reported a successful-looking adoption, complete with "Agent continues with full previous context preserved", and returned a NEW background task id. Both times the task then died with `Agent "continue" not found`. An orchestrator that trusted the returned id would wait for a lane that had never started, and the harness reports the same wording for a healthy continuation, so the difference is invisible at the call site.

**Evidence:**
```
task(task_id="ses_fbb40821fffeN8y2nslkBmeeTL", ...)
  -> Background Task ID: bg_0e3f0221
     Agent: continue
     Status: interrupt
     "This continuation adopted an orphaned server session using agent: continue.
      It has no original model, no fallback chain, no category, and no loaded skill content."
  -> [INTERRUPT] Agent "continue" not found. Make sure the agent is registered in your
     opencode.json or provided by a plugin.
```
```
task(task_id="ses_fbaea1948ffexIR9CBWzgKF2UN", ...)
  -> Background Task ID: bg_128d9711
     Agent: continue
     Status: interrupt
  -> [INTERRUPT] Agent "continue" not found.
```
Verified by effect in both cases that the adopted session never ran: no new commits and no file writes in the lane's worktree in the minutes following adoption.

**Root cause / hypothesis:** hypothesis, not confirmed against source. The adoption path appears to substitute a literal agent named `continue` as a placeholder when the original session's agent cannot be recovered, and that name is not registered in this installation. The adoption message itself states the recovered session carries "no original model, no fallback chain, no category, and no loaded skill content", which is consistent with a placeholder that was never expected to be dispatched as a real agent. The mechanism was not traced in the plugin source; only the two observations above are direct.

**Why it is costly:** it produces a plausible task id and an encouraging status line for work that cannot happen. Combined with the separate finding that aborted lanes keep reporting `running` until the 45-minute stale reaper, an orchestrator can be waiting on two different kinds of dead task while both look alive. The safe habit is the same in both cases: after any resume or any interruption, verify by effect, meaning worktree file mtimes and commit times, not by the returned status.

**Workaround:** do not resume a session that has been aborted or stale-cancelled. Spawn a FRESH lane with a self-contained brief instead, and carry forward the surviving on-disk state (commits and evidence files) explicitly in the new prompt. Disk state survives both aborts and cancellations, so a fresh lane loses nothing but the conversation.

**Fix status:** unfixed

## 2026-08-27 — Blocked reply contract was unpinned and terminal parks expired without a parent-visible wake

**Severity:** costly
**Area:** background-agent notifications

**Correction:** Earlier finding claimed a blocked wake never qualified for reply delivery. That reading became stale at `8f7f768ab`. `manager.ts` now computes `shouldReply` with `allComplete || isTaskFailure || isBlocked`; blocked wakes qualify. The former `blocked-notify.test.ts` guard was false because its sole task made `allComplete` true. Removing `|| isBlocked` kept that old test green.

**Fix:** Repaired pin gives parent a second running sibling, proves `allComplete` false, and mutation proof fails when `|| isBlocked` is removed. Terminal blocked expiry now enqueues its cancelled notification before pending-parent cleanup, exposing `Blocked task expired unanswered` to the parent. No active-defer ceiling changed because forced replies into unsafe Electron-hosted environments retain crash risk from issue #4120.

**Residuals:** Reply delivery still follows existing safety gating. This correction does not introduce a blocked-specific forced-dispatch route.

**Fix status:** fixed

## 2026-08-28 — `bun:test` spy call history survives another file's `mock.restore()`, silently corrupting index-based assertions

**Severity:** costly
**Area:** test runner
**Observed in:** oh-my-openagent, post-merge review of `.omo/plans/2026-08-27-harness-findings-top3.md`

**What happened:** a test that passed in isolation failed when its directory ran alongside another, at a clean commit with no local edits. `packages/omo-opencode/src/hooks/rules-injector/resurfacing.test.ts` creates `spyOn(shared, "log")` inside the test body, filters the captured calls to its own log message, and indexes `decisions[0]` and `decisions[1]` to assert a first evaluation logs `gap: null` and a second logs `gap: 0`. Run together with a background-agent file, `decisions[0].gap` was `40` — a real `RESURFACE_TOOL_CALL_GAP` payload emitted by an earlier test in the same file.

**Evidence:**
```
$ bun test packages/omo-opencode/src/hooks/rules-injector/
 111 pass  0 fail

$ bun test packages/omo-opencode/src/features/background-agent/abort-with-timeout.test.ts \
           packages/omo-opencode/src/hooks/rules-injector/resurfacing.test.ts
error: expect(received).toBeNull()
Received: 40
(fail) rule resurfacing > #given no watermark and a genuine zero gap #when each suppressed rule
       is evaluated #then their log payloads are distinguishable
 9 pass  1 fail
```
Reproduced twice at `d59ca317a` with a clean tree, and independently by a second agent in its own worktree.

**Root cause / hypothesis:** partly confirmed. The polluting files (`abort-with-timeout.test.ts`, `session-status-classifier.test.ts`) call `mock.module("../../shared/logger", ...)` and later `mock.restore()`. A `spyOn` created *after* that restore observes a call history that is not empty at creation time. Whether the history belongs to the restored module mock or to a shared spy registry was not traced in the runner's source; the observable fact is that a freshly created spy is not guaranteed to start with zero recorded calls when an earlier file in the same process mocked and restored the same module.

**Why it is costly:** the failure is invisible to the file's own author. The suite is green per-directory and green in CI if directories are sharded, so the defect surfaces only in a combined run and looks like a flake or like a regression from whatever change happened to be under review. It cost one review lane a full investigation cycle to isolate, and it was initially misattributed to the change being reviewed.

**Workaround:** never index a spy's call history positionally when the spied module could have been mocked elsewhere in the process. Filter to a value the test owns — a unique `sessionID` or other per-test discriminator carried in the payload — before indexing. Applied at `98d451ebe`, which keeps the original ordered assertions but selects only this test's own decisions, making the test immune to foreign history regardless of file order.

**Fix status:** worked around in our test; runner behavior unfixed

## 2026-08-28 — In a worktree, `sync-skills.mjs` silently regenerates Codex skills from the MAIN checkout instead of failing

**Severity:** costly
**Area:** build tooling
**Observed in:** oh-my-openagent, editing `packages/shared-skills/skills/review-work/SKILL.md` in `.worktrees/rw-size-gate`

**What happened:** after editing the shared source and running the documented regeneration commands, the Senpi copy picked up the edit and the Codex copy did not — while reporting success and writing a file with a fresh mtime. The Codex copy contained the pre-edit body, including the old `| 4 | Security Auditor | Oracle | Is it secure? | SUB |` row that the edit had changed to `MAIN`.

**Evidence:**
```
$ cd .worktrees/rw-size-gate && npm run --prefix packages/omo-codex/plugin sync:skills
> node scripts/sync-skills.mjs
$ echo EXIT=$?
EXIT=0

$ for f in packages/shared-skills/.../SKILL.md packages/omo-senpi/plugin/skills/.../SKILL.md \
           packages/omo-codex/plugin/skills/.../SKILL.md; do grep -c '^## When to use' $f; done
1
1
0                      # <- regenerated, fresh mtime, zero new sections

$ cd packages/omo-codex/plugin && node --input-type=module \
    -e "import {sharedSkillsRootPath} from '@oh-my-opencode/shared-skills'; console.log(sharedSkillsRootPath())"
RESOLVED: /Users/tim/git/oh-my-openagent/packages/shared-skills/skills/     # <- MAIN checkout, not the worktree
```

**Root cause:** the two sync scripts resolve their source differently. Senpi computes it path-relatively — `packages/omo-senpi/plugin/scripts/sync-skills.mjs:8-11` derives `repoRoot` from `import.meta.url` and joins `shared-skills/skills`, so it cannot leave its own tree. Codex calls `sharedSkillsRootPath()` (`packages/omo-codex/plugin/scripts/sync-skills.mjs:10`), whose probe walks `./skills/`, `../skills/`, `../../skills/` relative to the *resolved package* (`packages/shared-skills/index.mjs:16-23`). A fresh worktree has no `node_modules` (see the 2026-08-27 entry), so Node resolves `@oh-my-opencode/shared-skills` out of the worktree and into the main checkout, and the probe then finds the main checkout's `skills/`. The script reads there and writes into the worktree.

**Why it is costly:** this is the failure mode that does not announce itself. The already-logged missing-`node_modules` finding covers builds that *crash* with module-not-found; here nothing crashes. Exit code 0, a plausible file on disk, a fresh mtime. The only way to catch it is to diff the generated copy for content you know you added — and an agent that trusts the exit code will ship a stale artifact. The Codex copy is gitignored, so `git status` shows nothing either.

**Workaround:** before regenerating Codex skills from a worktree, give the worktree the dependency and verify the resolved path:
```bash
mkdir -p node_modules/@oh-my-opencode
ln -sfn ../../packages/shared-skills node_modules/@oh-my-opencode/shared-skills
cd packages/omo-codex/plugin && node --input-type=module \
  -e "import {sharedSkillsRootPath} from '@oh-my-opencode/shared-skills'; console.log(sharedSkillsRootPath())"
# assert the path is inside the worktree, THEN sync
```
A full `bun install` in the worktree fixes it too, at higher cost. Either way, verify the regenerated copy actually contains the edit rather than trusting the exit code.

**Suggested real fix:** make the Codex script resolve path-relatively like the Senpi one, or have `sharedSkillsRootPath()` refuse a candidate outside the calling package's own repository root instead of silently walking to a sibling checkout.

**Fix status:** unfixed; worked around per-invocation
