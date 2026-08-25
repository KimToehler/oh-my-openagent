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
