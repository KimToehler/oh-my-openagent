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

**Update:** (2026-08-28, measured) The `~110s` foreground figure used throughout this entry is **superseded** and was never the real bound. Measured: the MCP client aborts a `ctx_shell` tool call at **~59 s** (`sleep 58` returns normally; `sleep 60` returns `MCP error -32001: Request timed out`), and lean-ctx's own foreground cap default is now **45 s** (`LEAN_CTX_SHELL_FG_CAP_MS`), lowered from 110 s so the cap trips before the client abort. Read every `~110s` above as `~45 s foreground cap / ~59 s client abort`. The workaround also improves: `background_action="wait"` now blocks server-side until the job is terminal or `wait_timeout_ms` elapses (default 45 s, max 50 s, silently clamped), so a detached job can be supervised with ~6 cheap calls for a 5-minute job instead of ~30 status polls — but `wait` does **not** make the job notify, so it must be re-called on timeout and a turn must still never end with a detached job outstanding. `LEAN_CTX_SHELL_TIMEOUT_MS` still governs only a detached job's lifetime, as this entry states.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) The shape has changed again, in our favour. `88d2cb9b2 fix(hooks): offer background_action="wait" as the unpolled-job warning's primary resolution` makes `wait` the FIRST resolution the warning offers, not a footnote: `packages/omo-opencode/src/hooks/unpolled-shell-job/message.ts:18-26` now leads with it and states that it blocks server-side until the job is terminal or `wait_timeout_ms` elapses. The warning still tells the truth about the external half - `ctx_shell(run_in_background=true)` "does not notify" (`message.ts:12-14`) - and the idle rescue is intact (`hook.ts:82-85` outstanding-job check, `:91-110` dispatch, `:112-124` cooldown). Tracker behaviour for all three wait outcomes is pinned at `tracker.test.ts:344-381`, with warning ordering at `:413-423`. Two same-day siblings tightened the same path: `7788a7d9a` (terminal status with an exit clause) and `b93318cd1` (id-gone deregistration).

**Fix status (2026-09-02):** worked around, materially better. The external no-notification gap is unchanged and still outside our control, so this does not close. Severity stays `costly`: `wait` turns a 5-minute job from ~30 status polls into ~6 blocking calls, but a turn that ends with a detached job outstanding still strands it.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02) Re-checked as part of the full-log pass. Three same-day commits touched this hook without changing the finding's standing: `7788a7d9a` (terminal status with an exit clause), `b93318cd1` (deregister on an id-gone status poll) and `88d2cb9b2` (wait as the primary resolution). Tracking gap remains fixed; the idle-only firing and positive-status-only late adoption remain deliberate.

**Fix status (2026-09-02):** unchanged. Severity stays `papercut`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Last verified:** not re-checked 2026-09-02 - skipped as settled (fixed in tracked source); re-verify only on a full-log pass

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Settled.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged. The registry is still purely in-process: `task-registry.ts:6-13` declares `Map` stores and `:22-29` hangs `activeTasks`/`completedTasks` off `globalThis`, with all mutations staying in memory (`:99-124`). The adopt-on-miss path survives and improved - `resume()` at `manager.ts:1400-1457` verifies the session, probes liveness, and adopts - and `a307c362a` (2026-09-02) additionally made it carry the child's real agent identity rather than a fabricated one, which strengthens the recovery half without touching persistence. `manager.ts:1413-1415` still states outright that task state lives in process memory and may be lost on restart. Cross-checked for persistence introduced elsewhere - `.omo/` writes, `writeFile`/`Bun.write`, SQLite, a startup rehydrate - and found none in the feature's production source; the transcript fallback (`background-task-notification-template.ts:131`, `:174`) recovers a transcript, not a task record.

**Fix status (2026-09-02):** partially fixed, unchanged. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Settled.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Still wording-only and still unpinned by tests, so it can regress silently.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Retention half still open, confirmed at the current location. `wakeStillOwed` now sits at `manager.ts:2647-2654` and still reads `pendingParentWake?.shouldReply === true || dispatchedParentWake?.shouldReply === true || hasInFlightParentWakeDispatch(...)`, so a completed task whose only outstanding wake is pending-with-`noReply` contributes nothing and the record is removed at `:2661-2669` rather than rescheduled at `:2655-2657`. Cross-checked for a sibling retention mechanism: the 300s ceiling at `parent-wake-flush-runner.ts:28`/`:303-308` bounds DELIVERY and deposits with `retainPendingWake: true` (`:70-80`), but it pins the wake, not the task record; the pending queue is a single in-memory map (`parent-wake-pending-queue.ts:19-23`) whose `noReply` admission metadata (`:94-96`) the manager cleanup never reads. Retention tests cover pending/dispatched/in-flight `shouldReply` only (`task-completion-retention-guard.test.ts:304-549`); no `wakeStillOwed` test exists.

**Fix status (2026-09-02):** partially fixed, unchanged. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Last verified:** not re-checked 2026-09-02 - skipped as settled (fixed, capture rule + this skill); re-verify only on a full-log pass

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Settled at the `buildTaskPrompt` choke point.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Split unchanged; OMO half re-confirmed in current source. Shutdown aborts running sessions (`manager.ts:3691-3703`) and archives still-running tasks as cloned `cancelled` records carrying an explicit FINAL-cancellation error (`:3726-3742`), leaving already-terminal tasks untouched via `TERMINAL_BACKGROUND_TASK_STATUSES` (`:3732-3735`); pinned at `manager-shutdown-global-cleanup.test.ts:159-211`. Cross-runtime recovery no longer claims success either - the task stays `running` and the output renders `Status: unknown` with a warning that a transcript does not prove completion (`tools/background-task/create-background-output.ts:111-148`), pinned by a test that explicitly rejects `Status: completed` for a recovered killed task (`create-background-output.cross-instance.test.ts:273-329`). `9096d20da` (2026-08-21) is confirmed present in history. The external one-shot kill is not observable from this repository and is neither fixed nor disproven here.

**Fix status (2026-09-02):** OMO half fixed and re-verified; external kill still unfixed, still a `blocker` for OpenDesign specifically.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, and the count is stable at 17 production call sites: 3 pass `query: { directory }` (`cli/run/completion.ts:87`, `cli/run/poll-for-completion.ts:230`, `cli/run/prompt-start.ts:38`), 14 do not. The background manager is still unscoped at `manager.ts:3425` and `:3538`. Six tmux-subagent sites pass `{ path: undefined }`, which is NOT the same thing as a directory and should be counted as unscoped (`tmux-subagent/polling-manager.ts:70,142`, `session-ready-waiter.ts:20`, `polling.ts:76,113`, `manager.ts:716`). Cross-checked for a central injector that would make the raw count misleading: none exists - `background-agent/opencode-client.ts:1-3` is a bare type alias, `plugin/build-team-idle-wake-hint-client.ts:16-29` only binds methods, and the directory-aware wrappers in `shared/session-route.ts:18-106` cover prompt/messages but have no status equivalent.

Note on evidence quality: the verifier for this entry reported "no fix commit" after reading `.git/logs/refs/heads/dev` through `read`, which is a reflog and not history. The orchestrator-run `git log` confirms the conclusion anyway, but the reasoning was unsound - see the 2026-09-02 entry on the skill ordering its verifier to run git.

**Fix status (2026-09-02):** still unfixed, still deliberately. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, probed against dev @ 64d608f6d) Still unfixed, and this pass produced a fresh live reproduction rather than a source read. Running `grep -n "^## 20\|^\*\*Severity:\|^\*\*Fix status" docs/troubleshooting/harness-findings.md` through `ctx_shell` returned `[Firewalled ctx_shell output - 37311 chars, 9640 tok, 271 lines stored out-of-band]` with a head/tail excerpt and `--- ... 243 lines omitted ... ---` in the middle. `ctx_expand(id=...)` recovered it, confirming the archive is lossless and that the narrowed claim is the correct one: the content is not destroyed, it is silently withheld by default. Configuration is unchanged - `~/.lean-ctx/config.toml:137-159` still exposes only `compress_protect` (which already includes `"**/*.md"` and did not prevent this), and `~/.config/opencode/opencode.json:91-97` registers the server with `command`/`enabled`/`type` and no tuning surface. `ctx_expand` remains documented as the recovery path (`~/.config/opencode/skills/lean-ctx/SKILL.md:51-54`); `raw=true`/`inline=true` remain undocumented in any agent-read file.

**Fix status (2026-09-02):** still unfixed, reproduced live. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Settled.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-08-28, measured) The **`~110 s` figure this entry rests on is superseded**, including the `/Users/tim/.config/opencode/AGENTS.md:126` citation in the update above — that line documented a "fixed ~110s foreground cap" and has itself been corrected, so it can no longer be read as authority for 110 s. Measured bounds: the MCP client aborts a `ctx_shell` tool call at **~59 s** (`sleep 58` returns normally; `sleep 60` returns `MCP error -32001: Request timed out`), and lean-ctx's foreground cap default is now **45 s** (`LEAN_CTX_SHELL_FG_CAP_MS`, lowered from 110 s so the cap trips before the client abort). This *sharpens* the original finding rather than retiring it: the `detekt` commit at 60–90 s in "What happened" was **never** inside the foreground budget — the note at `:1435` that "60–90s is inside the foreground budget" is wrong on the measured numbers, and that command was always going to time out. The recovery advice is unchanged and still correct: on a timeout, verify by **effect** (`git log`, output file, test-results XML) before assuming failure, and never blind-retry a non-idempotent command. New in the toolbox: `background_action="wait"` provides a cheap blocking poll — it blocks server-side until the job is terminal or `wait_timeout_ms` elapses (default 45 s, max 50 s, silently clamped), roughly 6 calls for a 5-minute job instead of ~30 — while still not making the job notify.

**Last verified:** not re-checked 2026-09-02 - skipped as settled (effectively fixed); re-verify only on a full-log pass

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. The prompt-level caveat still stands.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Settled.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, probed against dev @ 64d608f6d) The GUARD half is retracted; the DOCUMENTATION half stands. A live probe run this pass - `cat >> /tmp/omo-heredoc-probe.txt <<'MD' / probe line / MD` - returned `exit=0` and was not blocked. Either the guard was narrowed since 2026-08-24, or, more likely given the message text quoted above, the `/tmp` escape hatch this entry itself noted covers the probed form; the original observation used a non-temp path. A probe against a repo-relative path was not run, so the guard's behaviour there is unconfirmed and the original report is not contradicted for that case. Documentation is unchanged: `grep` across root `AGENTS.md`, user-global `AGENTS.md` and `.omo/rules/` still finds no note that the guard is syntactic and no documented `ctx_execute(language="shell")` escalation.

**Fix status (2026-09-02, revised):** guard behaviour partially retracted - a heredoc append to a temp path works today, verified by probe. The undocumented-syntactic-guard half remains open. Severity stays `papercut`.

**Last verified:** 2026-09-02 (64d608f6d)
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

**Last verified:** not re-checked 2026-09-02 - skipped as settled (fixed in `08a8d55b1`); re-verify only on a full-log pass

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

**Last verified:** not re-checked 2026-09-02 - skipped as settled (fixed in `8f3d2daa3` + `cea18ab27`); re-verify only on a full-log pass

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

**Last verified:** not re-checked 2026-09-02 - skipped as settled (fixed in `afc234a0c` + `48f0c1345`); re-verify only on a full-log pass

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, and the MCP-prefix cross-check sharpens what the residual actually is. The shared helper `matchesTrackedTool` (`shared/tool-name-match.ts:3-21`) does exact-plus-separator-bounded-suffix matching and is used by seven call sites: `write-existing-file-guard/tool-execute-before-handler.ts:116-117`, `comment-checker/hook.ts:75,134`, `read-image-resizer/hook.ts:121`, `atlas/write-edit-tool-policy.ts:1-7`, plus the three injectors (`rules-injector/hook.ts:92`, `directory-agents-injector/hook.ts:50`, `directory-readme-injector/hook.ts:44`). `hashline-read-enhancer/hook.ts:19-25` is still raw exact-match, gated on `hashline_edit` (`plugin/hooks/create-tool-guard-hooks.ts:125-127`, default false at `config/schema/oh-my-opencode-config.ts:60-61`). The cross-check finding: upstream normalization strips only a leading `mcp_` (`plugin/tool-execute-before.ts:38-48`, pinned at `tool-execute-before-mcp-prefix.test.ts:21-60`), so `mcp_background_output` becomes `background_output` but `mcp_Lean-ctx_ctx_read` becomes `Lean-ctx_ctx_read` - never bare `read`. The remaining gate is therefore unreachable for server-qualified names even when enabled. Three further literal comparisons surfaced and are worth separate reachability review rather than assuming they are covered: `plan-format-validator/hook.ts:9`, `prometheus-md-only/constants.ts:12`, and the unwired `hashline-edit-diff-enhancer/hook.ts:31-33`.

**Fix status (2026-09-02):** partially fixed, unchanged. Severity stays `papercut`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Still unfixed, and this update records a NEAR-MISS worth keeping. This pass's verifier reported the finding FIXED, citing `.agents/skills/opencode-qa/SKILL.md:190-191` and quoting "reminder matcher rejects a no-reminder stream and accepts a reminder marker" as positive/negative-control wording. The cross-check refuted it: that line is a cell in the helper-script self-test table, describing what `scripts/blocked-escalation-probe.sh` asserts about itself. It is not guidance to a QA author about constructing a probe, and the 2026-08-27 update above had already dismissed the same line as an incidental hit. `grep -rn "positive control\|negative assertion\|positive-control" .agents/skills/opencode-qa/ .agents/skills/codex-qa/` returns nothing. A verifier finding a plausible string and stopping is the exact structural failure this skill's cross-check step was written for.

**Fix status (2026-09-02):** still unfixed, confirmed by cross-check after a verifier false-positive. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged. `.omo/plans` is still ignored via `.omo/*` at `.gitignore:2`, with only `.omo/rules/` and `.omo/evidence/` unignored at `:3-6`, plus a bare `plans/` pattern at `:59`. Force-add still works, and is still undocumented where an agent would find it: no `git add -f`, `force-add`, or plan-visibility note in `.opencode/skills/work-with-pr/SKILL.md` (which creates worktrees at `:65-73`), in `~/.config/opencode/skills/start-work/SKILL.md` (which tells agents to read `.omo/plans` at `:57-75`), in `.omo/rules/`, or in root `AGENTS.md`. The discoverability gap is exactly as scoped on 2026-08-27.

**Fix status (2026-09-02):** still unfixed. Severity stays `papercut`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Ownership split re-confirmed; nothing has moved on either side. Our own stdio layer has no respawn by design: `packages/mcp-stdio-core/src/server.ts:58-97` marks the server closed on idle and exits the read loop, `:68-76` and `:172-195` do the same for the parent watchdog, `:143-160` logs `output_error` and stops - there is no restart path anywhere, and the default idle timeout there is 10 minutes (`:37`, `:61-64`), unrelated to the observed 30. `packages/omo-opencode/src/mcp/` holds MCP definitions and builders, not a client lifecycle manager, so the "tools report as nonexistent" presentation remains OpenCode-side as the original diagnosis said.

**Fix status (2026-09-02):** still unfixed, both halves external. Severity unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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



**Update (2026-09-02, recurrence):** the same failure class recurred today in this repo, in the same subsystem, and is worth recording against this entry because the shape is identical. Fixing the cancelled-blocked-reminder defect (2026-08-28 entry below) required changing `cancelTask`, and a first attempt cleared blocked state unconditionally. **Every gate was green:** 1108 scoped tests, a full 15714-test root suite whose failure list was byte-identical to the pre-change baseline, and a clean `bun run typecheck`. The change nonetheless disabled background-task parking completely, because `report_blocked` parks a child BY calling `cancelTask`, so the cleanup disarmed timers the park had just armed.

What the unit suite could not see is that two existing tests which LOOKED like they pinned the wrong behavior were in fact the only assertions that a parked task keeps blocked metadata while cancelled. The prior lesson said to enumerate what a rewritten test carried before repurposing it; the recurrence adds a second rule: **a green suite after a behavior change is not evidence when the changed function is reused by another feature under a different `source`/mode argument.** Only the live `opencode-qa` escalation probe caught it. Generalization: when a fix adds a cleanup or guard to a shared lifecycle function, enumerate every caller and what each one means by that call, before assuming the cleanup is universally correct.

**Fix status (2026-09-02):** the original 2026-08-25 finding remains as previously assessed. This update records a recurrence of the failure class, not a change to that status.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Still open on its own terms, with one partial mitigation that does NOT address the dirty tree. `400a4a723 fix(background-agent): record completion reasons` added a `completionReason` field (`packages/omo-opencode/src/features/background-agent/types.ts:117-120`), and the notification template now renders it (`background-task-notification-template.ts:58-69`), so a reader can at least see WHY a lane ended - terminal status, todo-gate expiry, idle status, session gone, idle event. None of those is "the worktree is dirty". Nothing inspects git state before marking a lane `completed`: the reason producer's own test file enumerates every supported reason (`completion-reason.test.ts:37-90`) and no dirty-tree case exists, and there is no test file named for dirty/yield/abandoned in either the feature or the tool directory. Cross-checked the todo gate and `unfinishedTodoCount` (`types.ts:115-118`) - those bound an unfinished-todo lane, not an uncommitted-work lane - and the `noReply` path (`parent-wake-flush-runner.ts:196-211`), which concerns parent liveness.

**Fix status (2026-09-02):** still unfixed. Severity stays `blocker`. Contained fix: extend `completionReason` with a dirty-worktree determination made at completion time, and pin it with a test that completes a lane over a dirty tree.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, both halves re-confirmed at current line numbers. The retained ceiling is real: `PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS = 300_000` at `parent-wake-flush-runner.ts:28`, applied at `:303-308` against `lastAdmitOnlyDepositAt ?? noReplyAdmittedAt ?? queuedAt`, with the busy-parent branch admitting at `:60-81`; pinned at `parent-wake-midbatch-starvation.test.ts:348-385` (asserts `body.noReply === true` at `:373-381`). The actionable half is equally unchanged: `shouldForceDispatchAfterActiveDefer` still reads `wake.shouldReply && getQueuedAgeMs(wake) >= PENDING_PARENT_WAKE_MAX_ACTIVE_DEFER_MS` at `:295-297`, so a park with `shouldReply === false` can never satisfy it and receives only a `forceNoReply: true` admission at `:70-76`. Cross-checked for a compensating manager-side path and found none: `notifyBlockedTask` queues before cancellation (`manager.ts:2675-2685`), `cancelTask` can suppress the follow-up (`:2763-2783`), and cleanup retention only tracks `shouldReply` wakes (`:2647-2656`). The six blocked-* test files cover notify, retention, resume, races and escalation, but none exercises a busy parent receiving an actionable wake after a `report_blocked` park.

**Fix status (2026-09-02):** partially fixed, unchanged. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged. The repo-side mitigation this entry proposed - a one-line agent-facing hint about `engine_interface` and the incompatible empty `paths` field - is still absent from every place an agent would read it: no match in root `AGENTS.md`, `/Users/tim/.config/opencode/AGENTS.md`, or `.omo/rules/`. Upstream ownership of the underlying request-shape defect is unchanged.

**Fix status (2026-09-02):** still unfixed, upstream ownership, repo-side hint still unwritten.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Still partially fixed, and the residual is narrower than the 2026-08-27 line implies. Request-time guidance now carries the surrounding facts: the foreground cap and its relationship to the measured ~59s client abort (root `AGENTS.md:128`), the duration-routing table (`:101-124`), and the "verify by effect, not by status line" rule (`:130-132`). The user-global copy matches at `:101-134`. What is still absent everywhere is the single linking sentence - after a foreground timeout, probe the job's terminal status if an id exists, THEN verify the disk effect - so an agent has all the parts and no instruction to assemble them at the moment it is holding a timeout.

**Fix status (2026-09-02):** partially fixed, unchanged in substance. Severity stays `costly`. Contained fix: one sentence in root `AGENTS.md` next to the duration table, mirrored user-global.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Now fixed. The detached-shell-vs-task wake-contract distinction lives in request-time guidance, not only in the hook directory: root `AGENTS.md:109-120` states that `task(run_in_background=true)` notifies while `ctx_shell(run_in_background=true)` never does, names the collision as "the entire trap" (`:122-126`), and gives the polling rule at `:134`. The user-global copy carries the same wording independently at `/Users/tim/.config/opencode/AGENTS.md:109-126` and `:134`. The hook-directory copy at `packages/omo-opencode/src/hooks/unpolled-shell-job/AGENTS.md:8-24` still exists but is no longer the only location, which was the entire residual.

**Fix status (2026-09-02):** fixed. Severity `costly` retained for the record; the wording is unpinned by tests, so it can regress silently.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02) Re-checked in the full-log pass; no change. Settled by removal.

**Fix status (2026-09-02):** fixed, unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Claim B re-confirmed in source, unchanged. Injection fires only from `tool.execute.after` for tracked file tools (`rules-injector/hook.ts:87-97`), the processor loads a per-session cache (`injection-processor.ts:115-125`), and real-path dedupe suppresses any rule already injected once (`:167-175`). The hook's own directory doc states the intent plainly - "Per-session dedup prevents re-injection" (`rules-injector/AGENTS.md:44-51`). So the delivery model is: attached to one tool output, once per session, never restated. Cross-checked whether anything compensates - root `AGENTS.md:263-271` describes rules as auto-loaded and path-scoped but names no durable recall, `/Users/tim/.config/opencode/AGENTS.md:96-99` likewise, and `~/.omo/rules/harness-findings.md:1-5` carries no re-injection instruction. Claim A (Gradle capacity starvation between file-disjoint lanes) was not re-probed this pass and stands as originally reported.

**Fix status (2026-09-02):** both claims still unfixed. Claim B severity stays `blocker`; Claim A stays `costly` and is now the older, less-verified half.

**RETRACTION - Claim B (2026-09-02, second pass, verified against dev @ 4eccb91fa):** Claim B is **stale as written**, and the two verification passes above (2026-08-27, 2026-09-02 first pass) were both wrong on the decisive point. Each traced the real-path/content-hash dedupe at `injection-processor.ts:167-175` and concluded "injected once per session, never restated" without reading the ~50 lines directly above it. Those lines are the reset:

- `hook.ts:119-125` handles `session.compacted` and calls `clearSessionState(sessionID)`.
- `injection-processor.ts:114-130` independently compares the cache's `compactionEpoch` against `transcriptHydration.getCompactionEpoch(sessionID)` and, on mismatch, replaces `contentHashes` and `realPaths` with empty sets.
- The epoch itself is derived from the compaction message ID during transcript hydration (`transcript-hydration.ts:143-170`), so the reset still fires when the `session.compacted` event is missed entirely.

So the dedupe is per-compaction-epoch, not per-session. A rule that was injected before a compaction boundary is re-injected in full after it, which is the exact recall behavior Claim B asserted was absent. The claim's premise - that a rule can be injected once and then be permanently absent from context - does not hold for the case that motivated it, an incident occurring after a long-running session compacted.

The real gap was coverage, not behavior: nothing pinned the redelivery, so it could regress silently and re-confirm the claim by accident. `7e1f4d45d test(rules-injector): pin full-body rule redelivery across a compaction boundary` adds that test to `hooks/rules-injector/hook.test.ts` (+46 lines); the rules-injector suite is 122 pass.

**Residual, and it is real.** Two things survive this retraction and neither is fixed:
1. The documented compaction-marker residual at `transcript-hydration.ts:54-56` - when an SDK emits only a part-level marker before the summary, the summary stays inside the scanned window, so a verbatim `[Rule: X]` banner quoted into that summary can suppress X on the next pass. That is a narrower failure than Claim B described, but it is the same class.
2. Within a single uncompacted session the delivery model is still one-shot and still attached to a tool output. Claim B's design objection to that model stands; its factual claim about permanent absence does not.

**Claim A is untouched by this retraction.** Gradle/resource capacity starvation between file-disjoint lanes was not re-probed in this pass either, and stands as originally reported.

**Fix status (2026-09-02, second pass):** Claim B severity revised `blocker` -> `costly`, scoped to the residual above rather than to permanent absence. Claim A stays `costly` and is now the oldest unverified half of this entry.

**Last verified:** 2026-09-02 (4eccb91fa)

## 2026-08-27 — Background-agent todo-gate tests used an unpinned historical clock

**Severity:** costly
**Area:** background-agent tests

**What happened:** Three todo-gate cases used a `2026-08-17` fixture from `manager.polling.test.ts:396` but called unmocked `Date.now()`. As wall-clock time moved beyond the 60-second grace period, they failed on the next unrelated edit to `manager.ts` despite unchanged production behavior.

**Root cause:** only one of four tests in the block pinned `Date.now`; the other three compared historical fixture timestamps against real time.

**Fix:** added one `withFixedNow(fixedNow, fn)` helper with `finally` restoration and ran all four cases through it. Expectations retain their todo-gate behavior; only clock source is deterministic.



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Fixed, and this entry had no fix-status line, so it is recorded now. All four todo-gate cases run through the `withFixedNow(fixedNow, fn)` helper at `packages/omo-opencode/src/features/background-agent/manager.polling.test.ts:417-424`, which assigns `Date.now = () => fixedNow` at `:419` and restores the original in `finally` at `:423`. The four call sites are `:428`, `:451`, `:473`, `:497`. The `2026-08-17T12:00:00.000Z` fixture still exists at `:396` but is no longer compared against real time. Sibling suites pin their own clocks independently at `task-poller.test.ts:1044`, `:1079`, `:1104` and `completion-reason.test.ts:50`.

**Fix status (2026-09-02):** fixed. Severity `costly` retained for the record.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
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

**Update (2026-08-28, second):** the worst variant of this gap is not a crash but a **silently wrong test target**. A lane migrating the OpenCode rules-injector onto `@oh-my-opencode/rules-engine` inside `.worktrees/opencode-bundled-rules` found its own edits were not what the tests exercised:

```
$ ls -d .worktrees/opencode-bundled-rules/node_modules
(no output — directory does not exist)
$ bun -e 'console.log(import.meta.resolve("@oh-my-opencode/rules-engine/engine"))'
file:///Users/tim/git/oh-my-openagent/packages/rules-engine/src/engine/index.ts
```

With no worktree-local `node_modules`, Bun's resolution walks *upward* out of the worktree and lands on the main checkout's workspace symlinks. A cross-package change therefore compiles and runs green while testing the main checkout's copy of the dependency — the TDD red/green signal is real but measures the wrong tree. This is the same escape mechanism already logged for the Codex `sync:skills` probe (see the 2026-08-27 shared-skills entry), now confirmed to apply to ordinary workspace imports under `bun test`, which makes it a general hazard for any worktree lane touching two packages at once.

`bun install` in the worktree fixes it, but installing is not the lesson — **verifying** is. After install, assert the resolution actually points inside the worktree before trusting any result:

```bash
cd <worktree> && bun install
bun -e 'console.log(import.meta.resolve("@oh-my-opencode/<pkg>"))'   # must contain .worktrees/<lane>
```

A lane brief that says only "run `bun install` first" still permits this failure, because a lane that skips the install gets green tests rather than an error. Single-package lanes are unaffected in practice, which is why this went unnoticed until a cross-package migration hit it.

**Fix status:** worked around

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Partially fixed since. `script/agent/setup.sh:55-58` now runs `bun install --ignore-scripts` unconditionally, so a fresh worktree that runs setup gets `node_modules`. The `work-with-pr` skill also instructs a dependency install inside the new worktree (`.opencode/skills/work-with-pr/SKILL.md:65-83`). Two residuals: that skill uses a plain `bun install`, which walks straight into the submodule/`prepare` failure recorded in the 2026-09-02 worktree-submodule entry below, and the LSP workspace-resolution half of this entry was not re-checked and remains as originally reported.

**Fix status (2026-09-02):** partially fixed - dependency install is now unconditional in `setup.sh`; the `bun install` route used by `work-with-pr` is still the failing one, and the LSP half is unverified.

**Last verified:** 2026-09-02 (64d608f6d)

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



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Diagnosis partly refuted, and the remaining half is narrower than recorded. The entry's own hypothesis was that `args.globs` arrives `undefined`; current source confirms nothing normalizes that case, because `executeRecordLesson` calls `args.globs.map(...)` unguarded at `packages/omo-opencode/src/tools/record-lesson/tool.ts:53`, which reproduces the exact `args.globs.map` error text. So the crash path is real, but its cause is an absent-argument case, not glob-content rejection. The content rule is well scoped and does NOT reject legitimate input: `isUniversalGlob` rejects only patterns matching every probe group at `validation.ts:29-32`, fires at `:53`, and rootless type globs such as `**/*.ts` are explicitly accepted, pinned at `validation.test.ts:157-169` with scoped-glob acceptance at `:87-99`. No commit in `git log` names a globs fix.

**Fix status (2026-09-02, revised):** still unfixed, cause corrected. The actionable fix is an arity/undefined guard before `tool.ts:53` that returns a readable error naming the missing field, not a change to `validateGlobs`. The original "rejects a well-formed array" framing is retracted: well-formed arrays are accepted. Severity revised `costly` -> `papercut`, since the failure is loud, immediate, and has a working workaround (write the rule to a file), not silent.


**Update (2026-09-02, fixed):** fixed locally in `da182869d` on branch `fix/harness-findings-batch`. Five guards for the required fields now sit ahead of the first dereference at `packages/omo-opencode/src/tools/record-lesson/tool.ts:53-57`, so an absent argument returns a field-naming error in the same style as the neighbouring citations check instead of `undefined is not an object`. This covers both reported crash sites: `args.globs.map` in `tool.ts` and the `value.replaceAll` reached through `canonicalizeLessonText` in `render.ts`. Glob CONTENT validation was not touched, per the corrected diagnosis above - `validation.ts` always accepted well-formed rootless globs. 137 tests pass in that directory, failing-first confirmed.

**Fix status (2026-09-02):** fixed in `da182869d`. Severity `papercut` (as revised earlier today) retained.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
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



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Still open, cross-checked against three candidate compensating mechanisms rather than one. `handleSessionErrorEvent` classifies a live session with a non-terminal error as transient and returns without touching child task status at `packages/omo-opencode/src/features/background-agent/manager.ts:2323-2333`. The two mechanisms that DO terminalize are both scoped elsewhere and neither covers an interrupted-but-present parent: `session.deleted` cancels direct and descendant tasks at `manager.ts:2108-2157`, and manager shutdown aborts child sessions and archives non-terminal tasks at `manager.ts:3631-3695`. The collector remains `DEFAULT_STALE_TIMEOUT_MS = 2_700_000` at `constants.ts:7`, consumed at `task-poller.ts:237-238` and fired via `interruptStaleTask()` at `:355-372`, which matches the entry's 45-minute claim exactly. `git log -15 -- manager.ts` shows recent work on adoption, blocked expiry, and completion reasons, but no commit subject naming parent abort or interrupt propagation.

**Fix status (2026-09-02):** still unfixed, confirmed. Severity stays `costly`. Contained fix: on `session.error` with an abort-shaped error, look up child tasks by `parentSessionId` and terminalize them, rather than waiting for the reaper.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, and the cross-check found the neighbouring mechanisms that do NOT cover it. `session.error` resolves only the task owning the errored session and hands it to `handleSessionErrorEvent` (`manager.ts:2088-2123`); an abort-shaped error whose child session still exists takes the transient branch and returns (`:2345-2355`). Nothing in that path looks up children by `parentSessionId`. Terminalization does exist, but for a different trigger: `session.deleted` collects the task plus descendants and cancels them (`:2126-2175`), which requires the parent session to be GONE, not merely interrupted; and manager shutdown aborts running children (`:3678-3703`), which is host teardown. The reaper is unchanged at `DEFAULT_STALE_TIMEOUT_MS = 2_700_000` (`constants.ts:7`, consumed at `task-poller.ts:237-238`), and it measures CHILD inactivity (`task-poller.ts:249-252`, `:324-330`) - which is also why the separate 2026-08-28 "reaps healthy subagents when the parent idles" entry was retracted, and why that retraction does not bear on this finding.

**Fix status (2026-09-02):** still unfixed. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)
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

**Last verified:** not re-checked 2026-09-02 - still unfixed as written; not re-verified this pass

## 2026-08-27 — Completion reasons were hidden for clean background-task completions

**Severity:** costly
**Area:** background-agent notifications

**What happened:** Four completion call sites produce five union values: poller completion uses `terminal-session-status`, `todo-gate-expired`, `idle-status`, and `session-gone`; `session-idle-event-handler.ts:92` independently produces `session-idle-event` outside poller flow. Notification rendering nested reason text inside `unfinishedTodoCount > 0`, so clean completions omitted their discriminator.

**Root cause:** `background-task-notification-template.ts` made todo count and completion reason one nested suffix. A 916-pass feature suite hid this common-path defect because existing reason coverage used unfinished todos.

**Fix:** render todo count and completion reason as independent completed-task suffixes. Added regression coverage for clean completion, unfinished todos plus reason, and missing reason. Live isolated HTTP-server QA recorded `reason: session-gone` in `[ALL BACKGROUND TASKS COMPLETE]`.



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Fixed, and this entry had no fix-status line, so it is recorded now. `formatTaskSummaryLine()` emits the reason independently of the unfinished-todo clause: the todo condition is `task.unfinishedTodoCount && task.unfinishedTodoCount > 0` at `packages/omo-opencode/src/features/background-agent/background-task-notification-template.ts:63`, while the reason is emitted by the separate ternary ``task.completionReason ? `, reason: ${task.completionReason}` : ""`` at `:65`. The only suppression left is a genuinely absent reason. Regression coverage exists for the exact clean-completion case at `background-task-notification-template.test.ts:509-524`, asserting `reason: session-gone` at `:523`, with unfinished-todo and missing-reason cases at `:445-458` and `:460-473`. The producer stores the reason before notifying at `manager.ts:2954-2955`, and every reason variant is covered at `completion-reason.test.ts:38-89`. Closed by `400a4a723 fix(background-agent): record completion reasons` (2026-08-27).

**Fix status (2026-09-02):** fixed in `400a4a723`. Severity `costly` retained for the record.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
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



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Mechanism closed in source, not pinned by a test. The described failure needed a relative path to survive into containment checking; `resolveFilePath()` now absolutizes any relative extraction with `resolve(workspaceDirectory, path)` at `packages/omo-opencode/src/hooks/rules-injector/path-resolution.ts:7-10`, before `findProjectRoot()` receives it at `injection-processor.ts:107-110`. The `output.title` fallback that produced the slash-less string still exists at `output-path.ts:17-19`, so the input is unchanged; what changed is that it can no longer reach the predicate unresolved. Containment is now the shared `isSameOrChildPath`, which itself calls `resolve(childPath)` at `packages/rules-engine/src/engine/engine-paths.ts:30-33`, exported at `engine/index.ts:24-27`. The three dev commits named in the review brief are all present in that code: `29267ea11` (the shared export), `613fb82c4` (discovery through the engine finder, `finder.ts:60-65`), `129c3a894` (explicit plugin root, `finder.ts:72-94`). No test covers `/tmp` -> `/private/tmp`; the nearest are generic temp-dir cases at `project-root-finder.test.ts:12-71`.

**Fix status (2026-09-02, revised):** effectively fixed in `29267ea11` + `613fb82c4` + `129c3a894`, unpinned. Severity revised `costly` -> `papercut`: double resolution now makes the slash-loss path unreachable, and the residual is missing regression coverage for a symlinked project root. The contained follow-up is one test with a symlinked `/tmp` project.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
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

**Update (2026-08-31, third observation — reproduces on a NORMALLY-COMPLETED session, not just an aborted one):** Observed again in the `onara` repo while running a two-lane plan review. Two reviewer lanes were dispatched together and both **completed normally** (`reason: session-idle-event`, results collected successfully). Minutes later, both were resumed for a delta re-review in the same `task()` batch. The `oracle` lane resumed correctly (`Agent: oracle`, `Status: running`). The `momus` lane, dispatched in the *same* batch, was adopted as `Agent: continue`, `Status: interrupt`, and died with the documented `Agent "continue" not found`.

```
task(task_id="ses_fa91f400affeDG0GdvCKNhPkWp", ...)   # oracle
  -> Background Task ID: bg_77b3d0ad   Agent: oracle    Status: running        # healthy

task(task_id="ses_fa91f820cffdFObRI0784Ub1KK", ...)   # momus, same batch
  -> Background Task ID: bg_afd4569c   Agent: continue  Status: interrupt
  -> [INTERRUPT] Agent "continue" not found.
```

Two things this adds to the entry above:

1. **The precondition is broader than recorded.** The workaround says "do not resume a session that has been aborted or stale-cancelled" — but this session was neither. It completed cleanly and its result was collected. So a normally-finished session can *also* lose its agent binding, and the existing workaround does not cover the case. Resuming any older session is a gamble; two sessions of the same age, resumed in one batch, behaved differently.

2. **`background_cancel` cannot clean up the corpse.** `background_cancel(taskId="bg_afd4569c")` returns `Cannot cancel task: current status is "interrupt". Only running or pending tasks can be cancelled.` The failed task then stays in the registry and fires an `[ACTION REQUIRED]` notification, which reads as a live problem needing a decision when the orchestrator has already routed around it. Minor, but it costs a turn to re-read and dismiss.

**Practical detection rule (cheap, and it is the reliable one):** the returned `Agent:` field is the tell. A healthy resume echoes the ORIGINAL agent name (`oracle`, `momus`); a poisoned one says `continue`. Check that field on every resume before waiting on the task — it is visible immediately at the call site, unlike the `interrupt` status which can arrive later. If it says `continue`, discard the id and respawn fresh; do not count that lane's verdict, since an adopted session has "no original model, no fallback chain, no category, and no loaded skill content" and would be reviewing under an unknown model.

**Fix status:** unfixed (reproduced 3×, now including a cleanly-completed session)

**Update (2026-09-02, fourth and fifth observations — reproduces on the `plan` agent, and twice in one session):** Observed twice more in the `onara` repo, both times resuming a **`plan` (Prometheus)** session that had completed normally (`reason: session-idle-event`, result collected and spliced to disk). Both resumes were for follow-up revisions to the same work plan. Both were adopted as `Agent: continue`, `Status: interrupt`, and died with the documented error. This extends the affected set beyond `momus`/reviewer lanes to the planning agent, which is the one most likely to be resumed — a long plan is precisely the session you least want to re-brief from scratch.

```
task(task_id="ses_fa1ea5361ffeuHK00K4nB0Kdo8", ...)   # plan, completed normally
  -> Background Task ID: bg_78617aea   Agent: continue  Status: interrupt
  -> [INTERRUPT] Agent "continue" not found.

task(task_id="ses_f9f237b5effdpcMP56NPVqxzgz", ...)   # plan, completed normally
  -> Background Task ID: bg_0996e645   Agent: continue  Status: interrupt
  -> [INTERRUPT] Agent "continue" not found.
```

Three things these add:

1. **The `Agent:` detection rule from the previous update HELD in both cases** — `Agent: continue` was visible immediately at the call site, before any status change. It is the reliable tell; recommend keeping it as the standard pre-wait check on every resume.
2. **`background_cancel` still cannot clean up the corpse, confirming the previous update.** `background_cancel(taskId="bg_0996e645")` → `Cannot cancel task: current status is "interrupt". Only running or pending tasks can be cancelled.` The dead task then fires `[ALL BACKGROUND TASKS FINISHED - 1 FAILED]` with `**ACTION REQUIRED:**`, which arrives *after* the orchestrator has already respawned and routed around it — so the notification describes a resolved problem as if it needed a decision. Costs a turn to re-read and dismiss, every time.
3. **The respawn workaround is cheap when plan state is on disk.** Both times, recovery was to spawn a FRESH `plan` agent whose brief said "read the plan from disk in full before doing anything" and restated the binding decisions. The plan file was the durable state; nothing was lost but the conversation. This is a concrete argument for the general habit of writing plan/spec artifacts to disk rather than holding them in a session — the artifact survives the harness defect.

**Fix status:** unfixed (reproduced 5×: aborted sessions, a cleanly-completed reviewer session, and twice on a cleanly-completed `plan` session)



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Still open, and I confirmed the agent name is genuinely fictitious rather than a sentinel the runtime understands. `resume()` passes the literal `agent: "continue"` into `adoptRunningSession()` at `packages/omo-opencode/src/features/background-agent/manager.ts:1434`; that value is stored verbatim as `task.agent` at `:719` and registered through `setSessionAgent()` at `:730`. Cross-check: `grep '"continue"'` across the whole background-agent feature returns that one line and nothing else, and there is no `agent === "continue"` branch, no continuation-marker constant, and no registration under `src/agents/` or `src/config/` — so nothing downstream special-cases it. What HAS landed since the entry was written is a real guard chain in front of adoption: session existence at `:1406-1413`, liveness probe at `:1415-1421`, transcript validation at `:1422-1427`, plus a separate stale-task reconciliation path for already-tracked tasks at `:1463-1483`. Those validate the SESSION, never the AGENT, so they do not close this. `git log -15 -- manager.ts` shows nine adoption/resume commits (`2934be9e0`, `c40e4fa26`, `866c45f55`, `e690b6ca0`, `3d3985f27`, `29d878800`, `3014085e3`, `67339856a`, `42a60fec3`); every subject concerns rollback, liveness, or dispatch — none names the agent identity.

**Fix status (2026-09-02):** still unfixed, confirmed with a negative cross-check. Severity revised `costly` -> `blocker`: five recorded reproductions across aborted, cleanly-completed reviewer, and twice-completed `plan` sessions, and recurrence outranks the original guess. The fix is contained — carry the original `task.agent` through the adoption path, or reject adoption when the agent is unresolvable, instead of inventing a name.

**Update (2026-09-02, FIXED):** root-caused and fixed. `resume()` now recovers the agent and model the orphaned session actually ran under, instead of inventing a name.

The mechanism, confirmed against source: the literal `agent: "continue"` at `manager.ts:1434` was passed into `adoptRunningSession()`, stored verbatim as `task.agent` (`:719`), registered via `setSessionAgent()` (`:730`), and then sent as the prompt body's `agent` field (`:1601`). Nothing downstream special-cased it, so OpenCode rejected it as an unregistered agent. The earlier hypothesis that it was a placeholder never expected to dispatch was correct.

Three things the original entry did not capture:

1. **The fabrication had a second live site.** `sync-continuation.ts:207` passed `resumeAgent ?? "continue"` into the same `adoptRunningSession()` on the wall-clock-yield path, poisoning adopted tasks through a different door. Two further `"continue"` literals in that file (`:117` toast label, `:194` poll label) never reach dispatch and were left alone.
2. **The sync path already had the recovery logic.** `resolveResumeContext()` (`sync-continuation.ts:55-92`) walks the transcript for agent, model and variant. The background path was the odd one out. That resolver had its own latent bug: it did not skip compaction messages, so it could return `resumeAgent: "compaction"` - the same defect class under a different fictitious name. Fixed in the same change.
3. **`validateSessionHasOutput()` cannot be reused as the fetch.** It short-circuits on an `observedOutputSessions` cache set during normal polling, so on a cleanly-completed session - four of the five reproductions - it returns `true` without fetching anything. The fix does its own transcript fetch on the adoption path.

The fix reuses `resolvePromptContextFromSessionMessages()`, which `manager.ts` already imported: it is newest-first, skips compaction messages and compaction agent names, merges agent and model independently, and falls back to a compaction checkpoint. A disk-backed twin covers the case where the server fetch fails.

**When the agent is unrecoverable, adoption is now REFUSED** rather than falling back to a registered agent. Disclosure was already being emitted (`background-continuation.ts:43`) and all five reproductions read past it, so disclosure is not an adequate control; a silent substitution would let a reviewer or `plan` lane return an authoritative-looking verdict under the wrong persona. The error tells the caller to respawn fresh, which was the entry's own recommended workaround.

Also corrected: the `:2293` agent-not-found handler now names the real agent and prescribes respawn. It deliberately does NOT gain the launch path's fallback retry - the dispatched prompt is never persisted on the task (`prompt` is `"[already prompted]"` for adopted sessions), so a retry would replay a placeholder. Persisting the resume prompt is left as a separate change.

**Live QA:** proven on a real `opencode serve` across a mid-turn `SIGKILL` restart. Fixed build adopted `agent: explore` (the child's real agent) and the session gained messages (`midpre=2 midpost=4`). With the fix reverted and the bundle rebuilt, the same probe observed `agent: continue` and `midpost=2` - unchanged, meaning the lane never ran, exactly the reported symptom. The probe's normal-mode assertion was confirmed RED against the unfixed build. Evidence: `.omo/evidence/20260902-adopt-agent-identity/`.

**Fix status:** fixed. Agent identity is carried through adoption; unrecoverable agents refuse instead of substituting.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
## 2026-08-27 — Blocked reply contract was unpinned and terminal parks expired without a parent-visible wake

**Severity:** costly
**Area:** background-agent notifications

**Correction:** Earlier finding claimed a blocked wake never qualified for reply delivery. That reading became stale at `8f7f768ab`. `manager.ts` now computes `shouldReply` with `allComplete || isTaskFailure || isBlocked`; blocked wakes qualify. The former `blocked-notify.test.ts` guard was false because its sole task made `allComplete` true. Removing `|| isBlocked` kept that old test green.

**Fix:** Repaired pin gives parent a second running sibling, proves `allComplete` false, and mutation proof fails when `|| isBlocked` is removed. Terminal blocked expiry now enqueues its cancelled notification before pending-parent cleanup, exposing `Blocked task expired unanswered` to the parent. No active-defer ceiling changed because forced replies into unsafe Electron-hosted environments retain crash risk from issue #4120.

**Residuals:** Reply delivery still follows existing safety gating. This correction does not introduce a blocked-specific forced-dispatch route.

**Fix status:** fixed



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Fixed, confirmed in code and history, and the SHA in the original line needs a correction. Both halves hold: the reply contract is `const shouldReply = allComplete || isTaskFailure || isBlocked` at `packages/omo-opencode/src/features/background-agent/manager.ts:3089-3091`, pinned by a test asserting `shouldReply === true` with `allComplete === false` at `blocked-notify.test.ts:126-160`; terminal expiry marks the task cancelled and enqueues a parent notification at `manager.ts:2679-2692`, dispatched through `sendParentWakePrompt` at `parent-wake-flush-runner.ts:166-184` and pinned at `blocked-expiry-notification.test.ts:72-99`. Correction to the entry: `8f7f768ab` is real but is `fix(background-agent): reset blocked notification episodes`, dated 2026-08-09 — it predates this finding and is not what closed it. The wake half was closed by `24e74bc5a fix(background-agent): notify parent when blocked task expires` (2026-08-28, 5 insertions in `manager.ts`), with coverage added in `444a44ca9 test(background-agent): pin blocked expiry notification` and `7889bd3c4 test(background-agent): cover running blocked expiry`.

**Fix status (2026-09-02, revised):** fixed in `24e74bc5a` + `444a44ca9` + `7889bd3c4`. The `8f7f768ab` attribution in the line above is retracted as a misattribution. Severity `costly` retained for the record.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
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

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, and the repo-side coverage is narrower than it looks. Guidance exists for the adjacent problem - root `AGENTS.md:268` claims meta-audit coverage for `mock.module()` without restore, and `.omo/rules/test-discipline.md:48-52` documents that `script/run-ci-tests.ts` auto-isolates files using `mock.module()` and names cross-test contamination as a state leak. None of it covers SPY call history surviving another file's `mock.restore()`, which is this entry's actual mechanism. The workaround remains local to the affected test.

**Fix status (2026-09-02):** still unfixed upstream; repo-side guidance covers `mock.module` restore but not spy call history. Severity unchanged.

**Last verified:** 2026-09-02 (64d608f6d)

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



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Still open, with the resolution mechanism identified precisely. The script never consults git at all — no `--show-toplevel`, no `--git-common-dir`, no `process.cwd()`. It takes whatever `sharedSkillsRootPath()` returns at `packages/omo-codex/plugin/scripts/sync-skills.mjs:6-10`, and that helper probes `./skills/`, `../skills/`, `../../skills/` relative to its own resolved module URL and returns the first hit at `packages/shared-skills/index.mjs:16-23`. Module-URL resolution is exactly what escapes a worktree when the package resolves through the main checkout's `node_modules`, which ties this to the missing-`node_modules` finding above. There is no worktree-boundary check and no loud failure: the copy proceeds straight from that path at `sync-skills.mjs:257-265`, guarded only by `isCliEntry()` at `:273-275`. The two commits touching this resolution, `c6cf711ce fix(shared-skills): resolve the skills directory in the Codex marketplace layout` (2026-08-04) and merge `b06be3b50` (2026-08-08), both predate the 2026-08-28 observation and address the marketplace layout, not worktrees.

**Fix status (2026-09-02):** still unfixed, confirmed. Severity stays `costly`: it writes generated output silently from the wrong tree. Contained fix: assert the resolved root is inside the same working tree as the destination, and fail loudly when it is not.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, with the resolution mechanism now pinned precisely. `packages/omo-codex/plugin/scripts/sync-skills.mjs:9` derives its DESTINATION root from `import.meta.url`, but takes its SOURCE from `sharedSkillsRootPath()` (`:7-10`), which probes `./skills/`, `../skills/`, `../../skills/` relative to the resolved `@oh-my-opencode/shared-skills` module URL (`packages/shared-skills/index.mjs:16-22`). Neither file contains `git rev-parse`, `--show-toplevel`, or `--git-common-dir`, so when Node resolves that dependency to the main checkout the source comes from there while the destination stays worktree-local. The copy then runs with no containment assertion (`sync-skills.mjs:257-269`); the only guard is `isCliEntry()` at `:273-275`. All three invocation sites are unguarded (`omo-codex/plugin/package.json:25-30`, `omo-codex/package.json:27-31`, `src/install/codex-cache-install.ts:80-86`), and existing tests cover package wiring and generated-copy drift only (`plugin/test/sync-skills.test.mjs:77-123`). The sibling `omo-senpi` sync script is path-relative and unaffected.

**Fix status (2026-09-02):** still unfixed, mechanism fully localized. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)
## 2026-08-28 — `qa-sandbox.sh` does not isolate `HOME`, so QA overwrote the operator's real `~/.omo/omo.jsonc`

**Severity:** dangerous — destroys real user configuration
**Area:** QA tooling
**Observed in:** oh-my-openagent, live-hook QA of the `unpolled-shell-job` message change

**What happened:** a QA subagent was told to isolate with `source script/agent/qa-sandbox.sh`, then to pin every agent and category to a mock model per the recipe in `blocked-escalation-probe.sh`. That recipe writes the agent/category pins to `$HOME/.omo/omo.jsonc`, because that is where the plugin actually reads them. `qa-sandbox.sh` never sets `HOME`, so `$HOME` was still the operator's real home. The operator's live config — 11 agent model routes, 8 category routes, `team_mode`, `background_task`, `runtime_fallback`, `lessons` — was replaced by a single line of mock-model pins.

**Evidence:**
```
$ sed -n '15,29p' script/agent/qa-sandbox.sh
export XDG_DATA_HOME="$OMO_QA_ROOT/data"
export XDG_CONFIG_HOME="$OMO_QA_ROOT/config"
export XDG_CACHE_HOME="$OMO_QA_ROOT/cache"
export XDG_STATE_HOME="$OMO_QA_ROOT/state"
export CODEX_HOME="$OMO_QA_ROOT/codex"
# ... no HOME anywhere in the file

$ cat ~/.omo/omo.jsonc          # after the QA run
{"[opencode]":{"agents":{"sisyphus":{"model":"mockprov/mock-model"}, ... }}}
```

**Root cause:** two isolation mechanisms disagree about `HOME`, and the weaker one advertises itself as equivalent to the stronger one. `oqa_mk_isolated_xdg` (`.agents/skills/opencode-qa/scripts/lib/common.sh:69-80`) creates `$root/home` and rewrites `HOME`, which is why it also needs `oqa_preserve_home_opencode_bin` (`common.sh:57-65`) to relink `$HOME/.opencode/bin`. `qa-sandbox.sh` isolates only the four `XDG_*` vars plus `CODEX_HOME`. The plugin's own unified config chain is `$HOME/.omo/omo.json[c]`, which is **not** an XDG path, so XDG isolation does not cover it at all.

**Why it is costly:** the script's header states it "mirrors the opencode-qa (`oqa_mk_isolated_xdg`) ... skill conventions" and that "the running machine's `~/.config/opencode` and `~/.codex` are untouched". Both sentences are true and both are irrelevant to the file that got destroyed. An agent that sources the documented sandbox helper, sees `[qa-sandbox] host ... are untouched`, and then follows the documented mock-model recipe will silently overwrite real user config while believing it is isolated. There is no warning and no backup: the plugin writes timestamped `.bak` files on *migrations*, not on third-party writes, so the newest backup here was six days stale and predated a `lessons` enable.

**Recovery, for the next person:** `~/.omo/` retains migration-era backups (`omo.jsonc.bak.*`). Diff the newest against what the config should contain, restore it, then re-apply anything enabled after that backup's timestamp — the backup NAME encodes what it predates (`pre-lessons-enable-...` meant `lessons` had to be re-added by hand). Preserve the clobbered file first for comparison rather than deleting it.

**Suggested real fix:** `qa-sandbox.sh` must export an isolated `HOME` (with the `.opencode/bin` relink that `oqa_preserve_home_opencode_bin` already implements), or its header must stop claiming parity with `oqa_mk_isolated_xdg` and state plainly that `$HOME/.omo/**` is NOT isolated. A guard that refuses to write agent/category pins when `HOME` equals the real home would turn a silent destruction into a loud failure.

**Fix status:** unfixed; config restored by hand from `omo.jsonc.bak.pre-lessons-enable-20260822T163914` plus a re-added `lessons` block



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Fixed, both halves, same day as the incident. `export HOME="$OMO_QA_ROOT/home"` at `script/agent/qa-sandbox.sh:56`, with the `.opencode/bin` relink at `:61-64`; the four `XDG_*` vars at `:33-36`; `CODEX_HOME` at `:42`. The second half matters as much as the first: because project layers are collected by walking `cwd` upward to `$HOME` at `packages/omo-config-core/src/loader/paths.ts:84-99` and outrank the user layer at `:104-112`, HOME isolation alone would still let a cwd under the real home claim the operator's `~/.omo` as a project layer. `OMO_QA_PROJ` closes that at `qa-sandbox.sh:82-83`, with the `cd` requirement stated at `:20-25`, `:79-81`, `:104-107` and mirrored in root `AGENTS.md:229-231`. Both behaviors are pinned by tests that execute the helper: HOME differs from the real home and stays under `OMO_QA_ROOT` at `script/agent-env.test.ts:62-91`; `OMO_QA_PROJ` exists inside the sandbox at `:98-124`. Commits: `2d405002d fix(qa-sandbox): isolate HOME so QA cannot overwrite the real ~/.omo config` and `87068442f fix(qa-sandbox): also isolate cwd via OMO_QA_PROJ, closing the project-layer leak`, both 2026-08-28.

**Fix status (2026-09-02):** fixed in `2d405002d` + `87068442f`, pinned by `script/agent-env.test.ts:62-91` and `:98-124`. Severity `dangerous` retained for the record — the destruction happened, and the entry should keep saying so.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
## 2026-08-28 — A cancelled blocked subagent keeps emitting "CHILD AWAITING RESPONSE" reminders, urging the parent to resume it

**Severity:** costly — the urged action can be destructive
**Area:** background tasks
**Observed in:** oh-my-openagent, after cancelling the QA subagent that had overwritten `~/.omo/omo.jsonc`

**What happened:** a background QA subagent called `report_blocked` and parked. It was cancelled. Ten minutes later the parent received a `[BACKGROUND TASK BLOCKED] (reminder 1 of 1, waiting 10m)` system reminder for that same task, ending in `**CHILD AWAITING RESPONSE:** Answer the child to unblock it.` and a copy-paste `task(task_id=..., prompt=...)` invocation. The two inspection paths disagree about the task's state:

```
$ background_cancel(taskId="bg_67de996b")
[ERROR] Cannot cancel task: current status is "cancelled".
Only running or pending tasks can be cancelled.

$ background_output(task_id="bg_67de996b")
| Status | **BLOCKED** |
> **Child needs your answer:** Reply with the requested information using this exact invocation:
> task(task_id="ses_...", prompt="<your answer>")
```

**Root cause / hypothesis (unverified):** the blocked-escalation reminder appears to be scheduled off the parked-task record and not reconciled against cancellation, so cancelling clears the run state that `background_cancel` checks while leaving the escalation record that `background_output` and the reminder scheduler read. Not traced in the harness source.

**Why it is costly:** the reminder is an instruction, not a notification, and it arrives with a ready-to-paste invocation. In this case the parked task was cancelled precisely *because* it had destroyed the operator's real `~/.omo/omo.jsonc`, and a replacement task was already running against a fixed sandbox. An agent that trusts the reminder resumes a run that is both superseded and known-harmful. The generic hazard is broader: a cancelled task is cancelled for a reason, and the reminder does not carry that reason.

**Workaround:** before answering any `CHILD AWAITING RESPONSE` reminder, check the task's real state with `background_cancel` (which reports `already cancelled`) rather than `background_output` alone, and confirm no replacement task supersedes it. Do not treat the reminder's suggested invocation as authorization to resume.

**Fix status:** unfixed

**Update (same session, 20 minutes later):** the ignored task reached a terminal state on its own, confirming the escalation is time-boxed rather than indefinite:

```
[BACKGROUND TASK CANCELLED]
**ID:** `bg_67de996b` | Duration: 28m 36s
**Error:** Blocked task expired unanswered
```

So the sequence for a cancelled-then-blocked task is: cancel → `background_cancel` reports `cancelled` while `background_output` still reports `BLOCKED` → one `CHILD AWAITING RESPONSE` reminder at ~10 min → expiry at ~28 min. Ignoring the reminder is therefore safe and self-resolving; the hazard is confined to that one reminder window, where the copy-paste invocation is the only thing urging a resume. Note the final notice is labelled `Error` and `ACTION REQUIRED` even though expiry was the correct outcome, which is a second, milder instance of the same problem: terminal states for deliberately-abandoned tasks are reported as failures needing attention.



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Still open, and the cross-check makes the fix smaller than it looked. The reminder gate checks only blocked-ness, never terminal status: `if (!task || !isTaskBlocked(task)) return` at `packages/omo-opencode/src/features/background-agent/manager.ts:2665-2667`, where `isTaskBlocked` tests `task.blockedAt !== undefined` and nothing else at `blocked-state.ts:3-5`; the text is emitted at `background-task-notification-template.ts:172`. Cancellation sets `status = "cancelled"` at `manager.ts:2790-2795` but never clears `blockedAt`/`blockedReason` nor disarms the timer — `blockedNotificationTaskIds.delete()` happens only on the early-return path at `:2745-2748`. The decisive cross-check: `BlockedEscalation.cancel()` already EXISTS at `blocked-escalation.ts:58` and is fully implemented, but grepping its call sites in `manager.ts` returns only `claim()` at `:1651` (accepted resume) and `arm()` at `:2662` — `cancel()` is never called from the cancellation path at all. Blocked fields are otherwise cleared only on accepted resume at `:1650-1654` or expiry at `:2679-2688`. Existing tests named for the cancelled case do not cover it: `blocked-resume.test.ts:68-84` and `background-task-notification-template.test.ts:83-110` both assert actionable blocked output for a cancelled task, which pins the current behavior rather than the desired one.

**Fix status (2026-09-02):** still unfixed, confirmed. Severity stays `costly` — the urged action is destructive. This is now one of the most contained fixes in the log: call the existing `this.blockedEscalation.cancel(taskId)` and clear the blocked metadata in `cancelTask`, then flip the two tests that currently pin the wrong behavior.


**Update (2026-09-02, fixed):** fixed locally in `c9dca1003` on branch `fix/harness-findings-batch`. `cancelTask` now calls the already-existing `this.blockedEscalation.cancel(taskId)` and clears `blockedAt` / `blockedReason` / `blockedNotificationTaskIds` at `packages/omo-opencode/src/features/background-agent/manager.ts:2796-2806`.

The fix is NOT unconditional, and the reason is the whole lesson of this entry. **A park is implemented AS a cancellation:** `report_blocked` sets `blockedAt`, calls `notifyBlockedTask` which arms escalation, then calls `cancelTask(source: "report_blocked", skipNotification: true)` at `packages/omo-opencode/src/tools/report-blocked/tools.ts:36-46`. The first version of this fix cleared blocked state on every cancellation and therefore disarmed the timers the park had just armed. That version passed 1108 scoped unit tests AND a full 15714-test root suite with zero new failures, and still broke the feature outright. The live `opencode-qa` escalation probe caught it: `FAIL: no reminder wake observed / FAIL: task never expired / REMINDER_COUNT=0`. After gating on `source !== "report_blocked"`, the same probe reports `BLOCKED_AT_S=7 / REMINDER_AT_S=64 / EXPIRY_AT_S=122 / REMINDER_COUNT=1 / ESCALATION PROBE PASS` against opencode 1.18.20, with isolation confirmed by session identity (`PARENT_IN_REAL_DB=0`, `CHILD_IN_REAL_DB=0`). Evidence: `.omo/evidence/20260902-harness-findings-batch/`.

This also retroactively justifies the two tests the review flagged as "pinning the wrong behavior". `background-task-notification-template.test.ts:83-110` asserts actionable blocked output for a cancelled task, and it is correct to do so: a parked task legitimately IS a cancelled task carrying blocked metadata. Both tests were left unchanged. Paired coverage now pins both directions at `blocked-escalation.test.ts` - a terminal cancel emits zero reminders, a `report_blocked` park keeps `blockedAt` and still fires exactly one - and the buggy version could not satisfy both simultaneously.

**Fix status (2026-09-02):** fixed in `c9dca1003`, proven on the real harness. Severity `costly` retained for the record.

**Update (2026-09-02, the fix above did NOT fix this):** the claim on the line above is retracted. `c9dca1003` closed a real hole, but not this one, and the "proven on the real harness" wording was not supported: the probe cited for it never cancels anything, so it could only prove the timers fire.

A park leaves the task `status: "cancelled"` with `blockedAt` still set. The cleanup `c9dca1003` added sits after `cancelTask`'s early return at `manager.ts:2745`, which fires for any task that is not `running` or `pending` - so the cancel meant to retire a parked task never reached it. `background_cancel` refused the task before even calling `cancelTask`, which is the `[ERROR] ... current status is "cancelled"` in the transcript above, so no path existed at all. What `c9dca1003` actually fixed is the narrower case of a task blocked while still running, reachable through the circuit breaker and `session.deleted`.

The unit test added alongside it passed against the live defect because it set `task.status = "running"` before cancelling, constructing a state the park path never produces.

Found by a 6-lane `review-work` gate; three lanes reached it independently, one with a reproduction against the branch tip.

**Fix status (2026-09-02, revised):** fixed in `8479eaa22`. The early-return branch now disarms the escalation and clears `blockedAt`/`blockedReason`, excluding the park itself (`source === "report_blocked"`) and any cancellation already in flight; `background_cancel` routes a blocked terminal task through instead of refusing it. Proven on a real harness by `blocked-escalation-probe.sh --dismiss`: the parent dismisses the child at +10s and no reminder or expiry follows (`REMINDER_COUNT=0`, `EXPIRY_AT_S=none`). Negative control with both halves reverted goes red and reproduces this entry exactly (`DISMISSED_AT_S=none`, reminder at +62s, expiry at +123s). Evidence: `.omo/evidence/20260902-harness-findings-batch/blocked-dismiss/`.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
## 2026-08-28 — A repo's own "no regression" gate reported all 90 pre-existing failures as regressions outside Docker

**Severity:** costly
**Area:** third-party repo tooling (9router); the pattern is general
**Observed in:** ~/git/9router while adding a feature

**What happened:** the project's `CLAUDE.md` states the suite is deliberately not all-green and that regressions must be judged with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Following that instruction, the gate reported 90 regressions on a tree whose only change was additive — which taken at face value would have blocked a clean change, or prompted "fixing" 90 unrelated tests.

**Evidence:**
```
$ node tests/__baseline__/verify-no-regression.mjs /tmp/vitest-after.json
❌ REGRESSION: 90 test pass→fail:
  - undefined :: AUDIT-002: API key masking ...
  - undefined :: request normalization ...        # every entry prefixed "undefined ::"

$ head -1 tests/__baseline__/known-fails.txt
tests/unit/claude-header-forwarding.test.js :: proxyAwareFetch — ...
```

**Root cause:** the gate derives each test's identity with `f.name.split("/app/")[1]`, assuming the suite ran inside a container rooted at `/app`. From a normal checkout that split yields `undefined`, so every key becomes `undefined :: <test name>`, matches nothing in `known-fails.txt`, and is classified as a new failure. The gate is not wrong about the data; it is silently keyed to an environment its own docs never mention.

**Why it is costly:** a trusted tool fails loudly in a way that looks like the developer's fault. The instruction to use it is explicit, so the natural reading is "my change broke 90 tests." Recovering requires disbelieving the project's documented gate — exactly the instinct a careful agent suppresses.

**Workaround:** compare failure SETS by name across two runs on the same tree, rather than trusting the gate or a count:
```
baseline: stash the change, vitest run --reporter=json --outputFile=before.json
after:    restore the change, vitest run --reporter=json --outputFile=after.json
diff the sets of "<file> :: <fullName>" where status === "failed"
```
That produced 90 before, 90 after, 0 new, 0 fixed — a clean result the gate could not express. Raw counts are also unreliable: an earlier comparison read 94 vs 90 purely because the new test file existed in one run and not the other. Compare names, never totals.

**Fix status:** worked around; upstream gate unfixed (needs the `/app/` assumption replaced with a repo-relative path)

**Last verified:** not re-checked 2026-09-02 - external repo (`~/git/9router`), not verifiable from here

## 2026-08-28 — Model-family cache invalidation misses OMO-owned agent and category overrides after a proxy alias resolves

**Severity:** warning
**Area:** model routing
**Observed in:** oh-my-openagent review of `feat/upstream-model-detection`

**What happened:** the new upstream-model observer correctly learns `onara/momus → onara/gpt-5.6-sol` from a real response and invalidates the cached agent roster by adding resolved identities to `createAgentConfigCacheKey`. But the key walks only OpenCode's `config.model` and `config.agent[*].model`. OMO's own overrides live separately in `pluginConfig.agents` and `pluginConfig.categories` (loaded from `~/.omo/omo.jsonc`), so an agent/category that exists only there can retain a stale baked prompt/permission shape after an observation.

**Evidence:**
```
category model resolves to: openai/gpt-5.6-sol
isGptModel(onara/ultrabrain): true
roster rebuilt after CATEGORY observation? false (1 -> 1)

roster rebuilt after pluginConfig.agents observation? false (1 -> 1)
CONTROL rebuilt? true (1 -> 2)
```

**Why it is not a merge blocker:** per-call consumers already read the registry fresh: `resolveDeepCategoryPromptAppend` (`tools/delegate-task/openai-categories.ts:70`) runs per delegation and `resolveCompatibleModelSettings` (`plugin/chat-params.ts:118`) runs per request. Category-routed prompt selection and reasoning-effort compatibility therefore improve immediately. The stale surface is narrower: a baked agent prompt/tool-permission shape whose model exists only in OMO config and never surfaces in `config.agent`. That is strictly less broken than before the upstream-model mechanism existed.

**Follow-up:** extend `collectResolvedModelIdentity` to accept and walk `pluginConfig.agents` / `pluginConfig.categories` model ids too, then add the category and OMO-override reproductions as regression tests.

**Fix status:** known follow-up; not fixed in the initial upstream-model change




**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Still open, confirmed at the cache key itself. `createAgentConfigCacheKey()` serializes only four OpenCode config fields — `agent`, `default_agent`, `model`, `skills` — at `packages/omo-opencode/src/plugin-handlers/config-handler.ts:67-74`, and is called with only the OpenCode `config` at `:110`. Neither `pluginConfig.agents` nor `pluginConfig.categories` participates, so an OMO-side override changes nothing about the key and the stale roster is served. This compounds with the related 2026-08-28 `model_family` entry below: `model_family` exists on `AgentOverrideConfigSchema` at `packages/omo-opencode/src/config/schema/agent-overrides.ts:7-16` but is still absent from `CategoryConfigSchema` at `categories.ts:5-16`, so the category half of that change never landed either. No regression test covers a category override invalidating the roster cache; the nearest category tests at `config-handler.test.ts:936-977` exercise configuration behavior only. Note the separate `shared/model-capabilities-cache.ts:16-59` is keyed by filename and is a different cache — not this defect.

**Fix status (2026-09-02):** still unfixed, confirmed. Severity revised `warning` -> `costly`: a stale roster silently serves the wrong prompt architecture, which is the same class of silent-wrong-result the log elsewhere rates `costly`. Contained fix: fold the OMO agent and category override identities into the cache key at `config-handler.ts:67-74`, and add `model_family` to `CategoryConfigSchema`.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged. `createAgentConfigCacheKey()` still serializes only OpenCode's `agent`, `default_agent`, `model` and `skills` (`plugin-handlers/config-handler.ts:67-74`) and is built from the OpenCode `config` alone (`:94-110`), so `pluginConfig.agents` and `pluginConfig.categories` cannot influence it and a cached roster is reused at `:110-137`. Cross-checked the obvious compensators and none applies: the model-capabilities snapshot cache is a separate filename-keyed store (`shared/model-capabilities-cache.ts:16-59`) that does not rebuild the roster, and category resolution happens fresh per delegation (`tools/delegate-task/category-resolver.ts:124-217`) without feeding category identity back into the cache key.

**Fix status (2026-09-02):** still unfixed. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)
## 2026-08-28 — `staleTimeoutMs` reaps *healthy, working* subagents when the parent idles

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara` — whole-diff review gate over a 136-commit / 173-file / 35k-line merge

**What happened:** Three review lanes were launched with `task(run_in_background=true)`. The
guidance for that mechanism is explicit and correct: it *notifies*, so the parent should end
its turn and await the `<system-reminder>`. I did. Two of the three lanes were then cancelled
at 49m with "Stale timeout (no activity for 45min)" — while they were demonstrably still
working. Their session transcripts show tool calls and substantive reasoning right up to the
cancellation, mid-verification of confirmed findings.

**Evidence:**
```
bg_87abe93d  Whole-diff integration review  [CANCELLED] Stale timeout (no activity for 45min)
bg_00738864  Frontend backend contract seam [CANCELLED] Stale timeout (no activity for 45min)
bg_291fe814  Dead code audit                [completed] 21m49s   <- finished under the limit

# the "inactive" lane, 40 minutes in, seconds before it was reaped:
[assistant (oracle)] 13:08:24  "Strong lead: `reorderLegExercises` writes leg-local 0-based
                                sortOrder into a day-global column. Verifying."
[assistant (oracle)] 13:09:14  "Confirmed two strong leads. Now verifying the discipline
                                prefix handling and clear/copy paths."
[assistant (oracle)] 13:09:47  <last activity, then cancelled>
```

**Root cause / hypothesis (hypothesis):** the inactivity timer appears to measure the
*parent's* activity, not the child's. The documented contract for `task(run_in_background=true)`
is "it notifies, so you can safely end the turn"; doing exactly that makes the parent idle,
and any child outliving 45min is then reaped regardless of its own progress. The one lane that
survived did so only by finishing in 21m. This is distinct from the two neighbouring entries
above: not a zombie surviving an abort, and not a dead-but-row-present task — these children
were alive, producing output, and killed anyway.

**Why it is costly:** the failure is silently biased against exactly the work most worth
delegating. Short lanes always survive; long analytical lanes on large diffs never do, and
they are the ones a human cannot cheaply redo. Worse, the guidance actively steers you into
it — "end your turn and wait" is the correct instruction for the notifying mechanism, and it
is what starves the child. The reminder also says **do NOT create a replacement task**, so the
obvious recovery is closed off too. Two of three lanes' analysis was lost; one confirmed
defect (`TrainingService.kt:972`, leg-local `sortOrder` written into a day-global column) was
recoverable only by reading the dead session's transcript and re-deriving it by hand.

**Workaround:** three, in order of preference.
1. **Scope the work to fit.** Split one broad lane into several narrow ones (backend-only,
   frontend-only, one seam each) so each finishes well inside 45min. Fixes the cause, not the
   symptom.
2. **Keep the parent busy.** Do genuine non-overlapping work between waits so the parent is
   never idle for 45 consecutive minutes. Polling purely to reset a timer is waste, but real
   parallel work is free.
3. **Raise `background_task.staleTimeoutMs`** in `.omo/omo.jsonc` when a long lane is
   genuinely warranted. Note the setting was not present in that repo, so the 45min default
   applied silently — nothing surfaces it at launch time.

Recovering a reaped lane: `session_read(session_id=..., from_end=true)` still returns the
child's transcript, including leads it had confirmed before dying. Not a substitute for the
report, but far better than discarding the run — and worth doing before any re-run, so the
replacement is not re-deriving what is already on record.

**Fix status:** worked around. Two candidate fixes: measure inactivity against the *child's*
last activity rather than the parent's, or exempt a task from the reaper while its session
shows recent tool calls. Also a docs gap — "it notifies, so you can safely end the turn"
should carry the caveat that ending the turn is what starts the child's death clock.



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Diagnosis refuted for the mechanism as written; a narrower residual remains. The reaper measures the CHILD, not the parent: the session id comes from `task.sessionId` at `packages/omo-opencode/src/features/background-agent/task-poller.ts:249-252`, refreshed through `refreshTaskActivityFromSession(task, getSessionActivity)` at `:324-330`, which reads `task.sessionId` at `task-activity-refresh.ts:30-39` and fetches that child's metadata at `session-activity.ts:28-47`. Fresh child activity short-circuits the reap at `task-poller.ts:324-330`, and child stream events count as activity at `session-stream-activity.ts:98-152`. Both paths are pinned: `task-poller-session-activity.test.ts:43-71` and `manager-session-activity.test.ts:155-204`, plus tool-call activity at `:268-319`. So parent idling alone does not reap a child that is doing work. The residual I confirmed by reading the surrounding block rather than the cited lines: when the activity lookup is UNAVAILABLE, `deferForUnavailableActivity(task)` grants a deferral that is deliberately bounded — `task-poller.ts:132-135` states an unreachable session must eventually lose its reprieve (`b505e8363 fix(background-agent): bound the activity-lookup stale deferral`). A healthy child behind a persistently failing status endpoint therefore still gets reaped, which is a fail-safe choice, not the parent-idle mechanism this entry describes.

**Fix status (2026-09-02, revised):** diagnosis wrong as written. The parent-idle claim is retracted: inactivity is measured against child activity at `task-poller.ts:249-252` and `:324-330`. Severity revised `costly` -> `papercut`, covering only the bounded-deferral residual. Separately, root `AGENTS.md`'s claim that "every tool call resets" the timer is imprecise — what resets it is child task activity, persisted child-session metadata, or child stream events, not a parent tool call. That wording is worth correcting.

**Update (2026-09-02, self-correction):** the update above closed with a proposed doc fix, claiming the user-global `AGENTS.md` line "every tool call resets it" was imprecise. That proposal is retracted before it was applied. I checked the write site rather than inferring from the reaper: `task.progress.lastUpdate` is refreshed on every message part observed on the child session at `packages/omo-opencode/src/features/background-agent/manager.ts:1964`, with the tool-call branch immediately below at `:1969-1985`. The sentence is addressed to a working agent about its own session, and for that reader every tool call it makes does reset its own timer. The wording is correct as written and needs no change. Recorded because a review that proposes an unnecessary edit is itself a finding: the near-miss came from reading the consumer (`task-poller.ts`) and not the producer (`manager.ts:1964`).

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)
## 2026-08-28: `ctx_shell` client aborts at ~59 s, and blocking waits can saturate server pool

**Severity:** costly
**Area:** tools
**Observed in:** lean-ctx and oh-my-openagent, during live harness QA

**What happened:** The MCP client aborts a foreground `ctx_shell` call at a measured ~59 s, not ~110 s. The old `LEAN_CTX_SHELL_FG_CAP_MS` default of `110_000` left a 59 to 110 s dead zone where commands died before detach, while supervising one 4m48s Gradle run cost about 30 model round trips because `status` returned immediately and no blocking wait existed.

**Evidence:**
```
sleep 45, 52, 56, 58: returned normally
sleep 60, 75: MCP error -32001: Request timed out
progress notifications do NOT reset the client abort timer
mcp.lean-ctx in opencode.json: command, enabled, type; no environment key
rust/src/cli/dispatch/server.rs:39-40: worker_threads = parallelism.clamp(1,4), max_blocking_threads = (worker_threads*4).clamp(8,32)
18-core host: worker_threads=4, max_blocking_threads=16
N=1 0.160 s, N=2 0.164 s, N=4 0.160 s, N=6 0.161 s, N=8 0.157 s, N=12 0.157 s, N=16 20.138 s, N=18 20.322 s, N=24 20.143 s
one wait: unrelated echo returned at 1.776 s while wait ran to 21.241 s
```

**Root cause:** The MCP client has a measured ~59 s abort ceiling. `LEAN_CTX_SHELL_FG_CAP_MS` defaulted to `110_000` on the false premise of a ~120 s host abort, creating the dead zone. The `mcp.lean-ctx` block has no `environment` key, so `LEAN_CTX_SHELL_TIMEOUT_MS` is not pinned there and the effective fallback remains the 2-minute `DEFAULT_TIMEOUT`. A server-side blocking wait occupies one Tokio blocking-pool slot. Measured unrelated tools remain unaffected through 12 waiters and starve for a full wait duration at 16 or more, matching `max_blocking_threads=16`.

**Workaround:** Use `background_action="wait"`, with `wait_timeout_ms` default 45 s, maximum 50 s, silently clamped, and the effective bound echoed in the header. Live QA supervised a 5-minute job in 7 `tools/call` messages, 1 launch plus 6 waits, versus about 30 status polls. `wait` does not make jobs notify, so call it again on timeout and never end a turn with a detached job outstanding. Restart the MCP client or session after `lean-ctx dev-install`, because an already-running stdio child keeps the old binary and old schema. A bounded semaphore or dedicated wait pool is NOT YET IMPLEMENTED.

**Fix status:** fixed in `28af1aec3` for foreground cap and blocking wait; pool saturation needs follow-up.

**Last verified:** not re-checked 2026-09-02 - skipped as settled (fixed in `28af1aec3`); re-verify only on a full-log pass

## 2026-08-28: `model_family` lands for agents only, so proxy-aliased categories still get the wrong prompt

**Severity:** costly
**Area:** config
**Observed in:** oh-my-openagent, configuring a 9router-backed `onara/*` alias setup after merging `model_family`

**What happened:** Model-family detection is text-based, so a proxy alias carries no vendor signal and every `onara/*` agent got Claude-shaped prompts regardless of what the router actually served. `model_family` (merged `2d1e83fa4`, plus build hotfix `53dd98f3c`) fixes that by letting the operator declare the intended primary architecture, but it was added ONLY to `AgentOverrideConfigSchema`. Categories have no such field, so half the roster is still guessing. The work is real but half-finished.

**Evidence:**
```
$ grep -rn "model_family" packages/omo-opencode/src/config/schema/*.ts
packages/omo-opencode/src/config/schema/agent-overrides.ts:13:  model_family: z.enum(Object.values(ModelFamily)).optional(),

$ grep -n "z\.\|model" packages/omo-opencode/src/config/schema/categories.ts
5:export const CategoryConfigSchema = z.object({
8:  model: z.string().optional(),
(no model_family)
```
Verified live, with an adequate token budget, that aliases genuinely straddle vendors:
```
oracle      claude-opus-5
sisyphus    claude-opus-5
auditor     gpt-5.6-sol
momus       gpt-5.6-sol
hephaestus  gpt-5.6-sol
ultrabrain  gpt-5.6-sol
```
`ultrabrain` and `deep` are CATEGORIES, so they cannot express `model_family` today and keep inferring from alias text.

**Root cause:** `model_family` was scoped to the agent-override schema because that is where prompt/reasoning/tool routing is applied at roster construction. Category-routed work (`sisyphus-junior` spawned via `category`) resolves its model through a different path (`packages/delegate-core/src/model-selection.ts`) that never sees an architecture declaration.

**Remaining work — this finding is the tracking note:**
1. Add `model_family` to `CategoryConfigSchema` and thread it through category model resolution, so `ultrabrain`, `deep`, `visual-engineering`, `writing`, `quick`, `artistry`, `unspecified-*` get correct prompt/reasoning treatment.
2. Decide precedence when an agent inherits from a category (`agents.<x>.category`): does the agent's `model_family` win, or the category's? Today the question is unanswerable because only one side can declare it.
3. Audit the remaining agents with no `model_family` set (`sisyphus`, `prometheus`, `explore`, `librarian`, `multimodal-looker`, `metis`, `atlas`, `sisyphus-junior`) — under a proxy alias every one of them is still guessing, even though `sisyphus` is verified Claude-backed.
4. Consider a `doctor` check that flags a configured proxy-style model whose family cannot be detected from text and has no `model_family` declared. That is precisely the silent-wrong-prompt case, and nothing surfaces it today.
5. Revisit whether the `models` catalog (`docs/reference/omo-json.md`) should carry architecture per entry, so one declaration serves every agent and category referencing that catalog key instead of repeating it per consumer.

**Workaround:** declare `model_family` per agent for the vendor-straddling ones. Categories have no workaround — they stay text-inferred until item 1 lands.

**Fix status:** partially fixed — agents in `2d1e83fa4`; categories, precedence, catalog, and doctor check all unfixed.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged, all three residuals confirmed. The agent half works: `model_family` is declared in `config/schema/agent-overrides.ts:7-19` and applied via `resolveModelForConfiguredFamily(model, override?.model_family)` in `agents/builtin-agents/general-agents.ts:107-110`, with the special agents reading it too (`sisyphus-agent.ts:84-105`, `hephaestus-agent.ts:84-134`, `atlas-agent.ts:67`). The category half does not exist at the schema level - `config/schema/categories.ts:5-20` carries `model`, `models`, fallback, reasoning and prompt settings and no `model_family` - and nothing in the category path reads one (`tools/delegate-task/category-resolver.ts:109-217`, `subagent-model-resolution.ts:31-77` resolve model and variant only). No doctor check exists: `cli/doctor/checks/model-resolution.ts:61-90` inspects `model` and `variant` overrides, and the checks directory has no `model_family` match at all.

**Fix status (2026-09-02):** partially fixed, unchanged. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

## 2026-08-28: `max_tokens: 1` probes make thinking models look unavailable, and a router fail over to another vendor

**Severity:** costly
**Area:** provider
**Observed in:** oh-my-openagent, verifying which upstream a 9router `onara/*` alias actually serves

**What happened:** To confirm alias-to-vendor mapping I probed the router with `max_tokens: 1` to keep it cheap. Every alias came back GPT, including ones known to be Claude-backed. I concluded Claude routing was down and rewrote a just-written config to match the "measurement". Both the measurement and the rewrite were wrong: a thinking model spends the budget on reasoning, emits ZERO content blocks, and returns 200 OK with an empty stream. The router correctly scores that 503 and fails the combo over to the next vendor — so a one-token probe of a Claude-primary combo reliably reports GPT.

**Evidence:** router log, my probe and a real session side by side:
```
[21:26:48] 🟢 ▶ POST sisyphus → claude/claude-opus-4-8 · FMT: openai→claude · STREAM · 1 MSG
[21:26:49] 🟢 ✗ EMPTY STREAM · claude/claude-opus-4-8 · 200 OK with no content blocks
[21:26:49] ⚠️ [AUTH] NOT locked [503] — request-shape error, not an account fault
[21:26:49] ⚠️ [COMBO] Model cc/claude-opus-4-8 failed, trying next {"status":503}
[21:26:49] ℹ️ [COMBO] Trying model 3/6: cx/gpt-5.6-terra

[21:26:47] 🟣 ▶ POST sisyphus → claude/claude-opus-5 · FMT: claude (passthrough) · STREAM · 435 MSG
[21:26:48] ℹ️ [COMBO] Model cc/claude-opus-5 succeeded
```
`1 MSG` is the probe, `435 MSG` the real session, same alias, same minute, opposite verdicts. Re-probed with `max_tokens: 1024`:
```
oracle  →  "model":"claude-opus-5"
```
The router message names the class outright: **request-shape error, not an account fault**.

**Second, compounding defect:** the endpoint streams SSE, so `curl ... | jq` fails with `parse error: Invalid numeric literal at line 1, column 5` even on a perfectly good response. Piping to `grep -o '"model":"[^"]*"' | head -1` works.

**Root cause:** `max_tokens` caps reasoning plus output on thinking models, so a tiny budget is consumed before any content block is emitted. Empty stream is indistinguishable from upstream failure at the router boundary, so combo fallback is the correct behavior — the probe was lying, not the router.

**Why it is costly:** it fails in the most expensive direction. It does not error; it returns a plausible wrong answer that looks like infrastructure truth. It cost a config rewrite in the wrong direction, and it would have silently corrupted exactly the `model_family` values the previous finding is about. The operator caught it, not the evidence.

**Workaround:** probe with `max_tokens: 512` or more and a trivial prompt; parse SSE with `grep`, not `jq`. Better: do not infer routing intent from live traffic at all — read the combo definition. When a probe contradicts known configuration, suspect the probe first.

**Fix status:** unfixed — worth a documented probe recipe in the QA skills, since "ask the router what it served" is a recurring need.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged. Neither QA skill has gained a probe recipe: `grep` for `max_tokens`, `which model`, and router-probe wording across `.agents/skills/opencode-qa/` and `.agents/skills/codex-qa/` returns nothing. Both skills carry generic probe inventories (`opencode-qa/SKILL.md:62-63,96-99,188-191`; `codex-qa/SKILL.md:58-69,94`) with no guidance on constructing a capability probe that a thinking model will survive.

**Fix status (2026-09-02):** still unfixed.

**Last verified:** 2026-09-02 (64d608f6d)

## 2026-08-30 — `[background:… completed, exit 0]` does not match the terminal-status regex, so the unpolled-job warning re-fires forever on finished jobs

**Severity:** papercut
**Area:** background tasks
**Observed in:** `~/git/onara`, orchestrating a 26-task review-follow-up plan across parallel lane worktrees

**What happened:** the `unpolled-background-shell-jobs` warning fired three times in one session for jobs that had already completed, whose output I had already read and acted on. Each time I followed the warning's own option A — `ctx_shell(background_action="status", job_id=…)` — and each time the same job was listed again on the next turn. Only `background_action="cancel"` actually cleared them.

**Root cause (verified in source, not a hypothesis):** the tracker retires a polled job only when the parsed status field is in `TERMINAL_STATUSES` (`packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts:169`, via `isTerminalStatus`). That parse uses `STATUS_FIELD_PATTERN` (`tracker.ts:44`):

```
/(?:^|\[background:\s*\S+\s+|\bstatus:\s*)([a-z][a-z _-]*?)(?:\]|$|\n)/im
```

The capture group must be followed by `]`, end-of-line, or newline. lean-ctx's real terminal wording is `[background:shell_… completed, exit 0]` — there is a `, exit 0` between `completed` and the `]`, so the group never matches. Confirmed by running the actual regex against the exact strings I received:

```
"[background:shell_1cf6ef5020f57041 completed, exit 0]"   captured: undefined  -> terminal: false
"[background:shell_6805685d6b4cee28 failed, exit 1]"      captured: undefined  -> terminal: false
"[background:shell_abc completed]"                        captured: "completed" -> terminal: true
```

So the *hypothetical* clean form parses and the *actual* form does not. `tracker.ts:167-168` then treats the unparseable status as "still running" — a deliberate fail-safe ("an unparseable status is treated as still running, so an unrecognised wording leaves the guard armed rather than silently disarming it"). That default is right; it is the wording drift that is wrong.

`not found` fails for a second reason: the reply is `[background:shell_… not found — already finished or cancelled]`, whose captured token would be `not found` → normalises to `notfound`, which IS in the set — but the `—` em-dash tail again prevents the group from reaching a `]`.

**Why this is only a papercut:** `cancel` calls `clearJob` unconditionally (`tracker.ts:169`), so the documented escape hatch works. The cost is a wasted turn per occurrence plus the message's own advice being wrong in its most-recommended branch — option A is presented first and option C explicitly says a status call "clears it on a terminal status or `not found`", which is exactly what does not happen.

**Workaround:** use `background_action="cancel"` for an already-consumed job, not `status`. `cancel` on a finished job is harmless and returns `not found`.

**Suggested fix:** make the terminal test tolerant of a trailing clause — e.g. allow `,` as a terminator in `STATUS_FIELD_PATTERN`, or match the status token then ignore the remainder of the bracket. Worth pinning with the *observed* lean-ctx strings above as fixtures, since `tracker.test.ts` presumably uses the clean form that already passes.

**Fix status:** unfixed

**Update (2026-09-01, `~/git/onara`, composition-program-generation wave):** reproduced exactly, twice in one session, and the workaround is confirmed. Four already-consumed jobs were listed; I called `background_action="status"` on all four, receiving three `[background:… completed, exit 0]` and one `[background:… not found or expired]`. **All four were listed again on the very next turn.** A subsequent `cancel` on the same four returned `[background:… not found — already finished or cancelled]` and they did not reappear. This confirms both halves of the analysis above: the `, exit 0` tail defeats the terminal parse, and `not found` with the em-dash tail defeats it too. Note the message's option C is actively misleading — it states a `status` call "clears it on a terminal status or `not found`", and neither clears it. Recommend swapping options A and B in the warning text until the regex is fixed, since the first-listed option is the one that does not work.



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Still open, and I confirmed it by executing the regex rather than reading it. `STATUS_FIELD_PATTERN` is `/(?:^|\[background:\s*\S+\s+|\bstatus:\s*)([a-z][a-z _-]*?)(?:\]|$|\n)/im` at `packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts:44`; the capture must be followed immediately by `]`, end-of-input, or a newline, so a trailing `, exit 0` breaks it. Run against the literal strings: `[background:shell_1cf6ef5020f57041 completed, exit 0]` captures `null` (not terminal); `[background:shell_abc failed, exit 1]` captures `null`; `[background:shell_abc completed]` captures `completed`; `status: completed\nexit code: 0` captures `completed`. So both terminal forms carrying an exit clause fail, and the failure is not limited to success. No compensating path exists: `isTerminalStatus` consults only that capture against `TERMINAL_STATUSES` at `:106-110`, `recordToolCall` clears only on an explicit cancel or a terminal parse at `:162-171`, and the unknown-job adoption branch at `:173-184` checks positive running status only. No test uses the bracketed exit form — `tracker.test.ts:51-60` uses `status: completed` with `exit code: 0`, which parses fine and is why this slipped through. `git log` on the tracker shows `b9b0a8b5c`, `9d29ba39b`, `49cb2a704`, none touching the regex.

**Fix status (2026-09-02):** still unfixed, confirmed empirically. Severity revised `papercut` -> `costly`: the same regex miss also swallows `failed, exit 1`, so a genuinely failed job is indistinguishable from a running one, which is a wrong-result bug rather than noise. Contained fix: allow `,` as a capture terminator, and add both bracketed exit forms as fixtures.


**Update (2026-09-02, fixed):** fixed locally in `7788a7d9a` on branch `fix/harness-findings-batch`. One character class at `packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts:44`: the capture terminator `(?:\]|$|\n)` became `(?:,|\]|$|\n)`. Verified against strings this QA session itself received from `ctx_shell`, not hand-written fixtures - `[background:shell_de62a206c9573559 completed, exit 0]` and `[background:shell_abc failed, exit 1]` both go from capturing `null` to capturing a terminal status, while `[background:... started]` and `status: completed\nexit code: 0` are unchanged, and `arbitrary prose completed, exit 0` still does not read as terminal. Table: `.omo/evidence/20260902-harness-findings-batch/tracker-regex-real-strings.txt`. Six fixtures added to `tracker.test.ts`, failing-first confirmed.

**Fix status (2026-09-02):** fixed in `7788a7d9a`. Severity `costly` (as re-scored earlier today) retained for the record - the same miss made a `failed, exit 1` job read as still running, which was the more consequential half.

**Update (2026-09-02, that fix opened a fail-open; corrected in `7918492a8`):** `7788a7d9a` added a bare `,` to the terminator alternation. That was too wide. The `^` alternative in `STATUS_FIELD_PATTERN` anchors at the start of ANY line under the `m` flag, not the status line, so a bare comma let a log-tail line parse as the status field:

```
"failed, 3 tests\nstatus: running"            -> parsed "failed"    -> TERMINAL
"completed, moving to next module\nstatus: running" -> "completed" -> TERMINAL
"exited, restarting worker\nstatus: running"  -> parsed "exited"    -> TERMINAL
```

All three are still-running jobs, retired on their first poll. That is exactly the failure the `TERMINAL_STATUSES` comment four lines above warns about, and it is the dangerous direction: the guard disarms silently on the long noisy builds it exists for. The fixtures added with `7788a7d9a` all put the header first, where leftmost-match hides the hole.

`7918492a8` narrows the terminator to `,\s*exit\b`. That keeps every real terminal wording (`completed, exit 0`, `failed, exit 1`, `cancelled, exit 143`, `timed out, exit 124`) and leaves comma-bearing prose unparseable, so it still reads as running. Four fixtures now pin the body-first shapes; reverting to the bare comma turns all four red.

Found by the cross-engine code-quality lane of a `review-work` gate, in a change that had already passed a 28-case regex probe and the full suite. The probe missed it because every fixture in it was header-first.

**Update (2026-09-02, second defect, still open):** `7788a7d9a` fixed the exit-clause half and left a second one open in the same function. Found when the `<unpolled-background-shell-jobs>` warning fired TWICE on the same five job ids, after I had already cleared each one with `background_action="status"`.

`TERMINAL_STATUSES` does contain `notfound` (`packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts:34`), and `isTerminalStatus` strips spaces, underscores and hyphens before the lookup at `:109`. Neither of the two real clear-attempt replies survives that normalization:

- `[background:shell_x not found or expired]` captures `not found or expired`, normalizes to `notfoundorexpired`, which is not in the set.
- `[background:shell_x not found — already finished or cancelled]` captures `null` outright, because the em dash is outside the `[a-z _-]` character class.

So a job cleared through `status` never deregisters, and the warning re-fires forever on jobs that are already gone. `cancel` clears reliably because it takes a different path. Note the `opencode-qa`-adjacent guidance in the warning text itself asserts that `status` "clears it on a terminal status or `not found`" - that claim is false against this code, so the docs and the implementation disagree.

Deliberately NOT fixed in the same batch: the `7788a7d9a` change is already committed and its evidence recorded, and the branch is going into review. Bundling a second regex change into a reviewed branch after the fact is how the first `cancelTask` attempt went wrong. Contained fix for a follow-up: match a `not found` prefix rather than requiring exact-token equality, add both literal reply strings as fixtures, and correct the warning text.

**Severity:** `costly`. It is the same wrong-result class as the exit-clause half - a finished job reads as outstanding - and it burns a turn every time it recurs.

**Update (2026-09-02, fixed):** fixed on branch `fix/tracker-notfound`. The contained fix proposed above turned out to be the wrong shape, and observing the defect fire again in the session that fixed it is what showed why.

Matching a `not found` prefix inside the status FIELD would have required widening `STATUS_FIELD_PATTERN` to reach past the trailing clause, and that reopens the log-tail fail-open `7918492a8` had just closed. The not-found reply is therefore matched separately from the status field, by a new `NOT_FOUND_REPLY_PATTERN` = `/\[background:\s*(\S+?)\s+not\s+found\b/i`, and `notfound` is removed from `TERMINAL_STATUSES` where it never matched anything real.

The match is anchored to the id that was actually polled, and that anchor is load-bearing rather than defensive. Three cancels in one turn of the fixing session emitted three `[background:<id> not found ...]` lines into the shared log; a running job whose tail quotes another job's not-found reply would be retired by a job-agnostic matcher. Both hazards are pinned by fixtures: a quoted foreign not-found line and a `module not found` compile error, each alongside `status: running`. Mutation-verified - removing the matcher turns 3 tests red, dropping the id anchor turns 1 red, dropping the bracket anchor turns 3 red.

The false claim in the warning text is corrected in the same change: option C now says a `status` call clears the job "whether it reports a terminal status or that the id is already gone", which is true of the new code.

**Caveat on the earlier recommendation:** the 2026-09-01 update above suggested swapping options A and B in the warning until the regex was fixed. That was not done and is now moot. Anyone reading this entry as a live workaround should stop at this line.

**Update (2026-09-02, correction — the `wait` half was never broken, and I said twice that it was):** while clearing jobs after the fix above, I twice told the user that jobs consumed via `background_action="wait"` cannot be deregistered, calling it a known limit of the hook's inputs. That was wrong, and I asserted it a second time without checking. Executing the tracker against the exact replies my own `wait` calls had returned:

```
[background:shell_fcd9eaf4eeb588ea completed, exit 0]                 -> outstanding: []
[background:shell_73d4ec0671b40bf5 wait timed out ... still running]  -> outstanding: [shell_73d4ec0671b40bf5]
```

Both correct. `recordToolCall` branches on `args.background_action !== undefined`, not on its value, so `"wait"` has always taken the same clearing path as `"status"` (`tracker.ts`, the `backgroundAction !== undefined` block).

**Where the false claim came from:** `tracker.test.ts` has a test named `keeps a job tracked when its result was consumed without a terminal poll`. That test is real and its case IS unobservable - it waits on a marker file and reads it with `ctx_read`, so no `ctx_shell` call ever reaches the tracker. I generalized it from "consumption via a non-ctx_shell tool" to "consumption via wait", which is not analogous: `wait` is a `ctx_shell` call carrying the job id and terminal output.

**Why the warnings fired anyway, and it was not the tracker:** the running opencode process started at 11:23:13; `7788a7d9a`, which taught `STATUS_FIELD_PATTERN` to parse the trailing `, exit N` clause, was committed at 12:30:30 - 67 minutes later. The live session was therefore running a pre-fix bundle in which `[background:<id> completed, exit 0]` parsed to `undefined` and left the job tracked. Reproduced by running the old regex against that literal string. A plugin fix does not reach a session that started before it was built; that is worth checking before concluding a guard is broken.

**Fixed in `88d2cb9b2`:** three tests now pin `wait` (terminal clears, timeout keeps, not-found clears), mutation-verified by restricting the clearing branch to `"status"` only, which turns two of them red. The warning text itself had a real defect exposed by this: it never mentioned `wait` at all, teaching a marker-file loop plus a follow-up `status` call, so an agent paid two calls per job where one would do - and the omission is what made the guard look unfixable here. `wait` is now option A. The AGENTS.md claim that clearing on observed completion is "not implementable from the hook's inputs" is narrowed to the marker-file case it actually covers.

**Lesson, restated because I had already recorded a version of it:** the recorded lesson from the earlier fix in this same session was that a probe never observed red is not evidence. The same discipline applies to a claim about behavior: an assertion never executed is not a finding. I had the tracker source and a one-line test available both times I made the claim.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)

## 2026-08-30 — An answered blocked task can still expire, discarding an in-flight lane's uncommitted work

**Severity:** costly
**Area:** background tasks
**Observed in:** `~/git/onara`, wave-2 lane `bg_6620fbc1` of a parallel review-follow-up plan

**What happened:** a background lane called `report_blocked` with two legitimate design questions. I answered via `task(task_id="ses_…", prompt=…)`; the harness confirmed `[BACKGROUND TASK ANSWER ACCEPTED] Task bg_6620fbc1 resumed with parent answer` and the task reported `running`. It then produced substantial correct work — a new `ModalityLegRows.kt`, changes across 7 files. Later the same task was reported:

```
**Failed:**
- `bg_6620fbc1`: … [CANCELLED] - Reason: Plan conflicts with current code and TDD proof: …
```

with the **original, already-answered block reason** as the failure text, and on the following turn:

```
- `bg_6620fbc1`: … [CANCELLED] - Blocked task expired unanswered
```

It had been answered — twice, both times acknowledged. All of its work was uncommitted at the moment it died.

**Contrast with the 2026-08-28 entry** ("a cancelled blocked subagent keeps emitting CHILD AWAITING RESPONSE"): there, an *unanswered* park was cancelled and the stale reminder urged a resume. Here the park was **answered and acknowledged**, the task resumed and did real work, and the expiry fired anyway carrying the stale reason. Same subsystem, opposite direction.

**Root cause / hypothesis (partially verified):** the resume path does claim the escalation — `manager.ts:1651` calls `this.blockedEscalation.claim(existingTask.id)`, and `claim` clears both the reminder and expiry timers (`blocked-escalation.ts:49-56`). So the intended disarm exists. What I could **not** establish from source is why it did not take effect here; the reported failure text is `task.error` set at `manager.ts:2687` inside `expireBlockedTask`, which returns early unless `isTaskBlocked(task)` — implying the task was considered blocked *again* at expiry time. A second `report_blocked` from the resumed lane, whose park then expired while inheriting the original reason, is consistent with everything observed and would make the wording — not the expiry — the primary defect. I did not confirm it. Labelling this a hypothesis deliberately.

**Why it is costly:** the expiry notice is indistinguishable from a genuine never-answered park, and it arrives attached to the *first* question rather than whatever the lane was actually stuck on. An orchestrator that trusts it concludes the answer was never delivered. In this case the work survived only because uncommitted changes persist in the lane worktree and I inspected `git status` instead of the notification — the surviving diff turned out to be better than the approach I had originally rejected, so trusting the report would have discarded a correct implementation.

**Workaround:** when a lane reports `[CANCELLED] Blocked task expired unanswered`, do not treat it as "no work happened". Check the worktree (`git log` + `git status --porcelain`) before re-dispatching, and resume from the surviving diff rather than restarting the task. More generally: for background lanes, **git state is the ground truth and the notification is a hint** — this is the third distinct notification-vs-reality mismatch in this session alone (see also the `[ALL BACKGROUND TASKS FINISHED - 2 FAILED]` report for two tasks that were both still `running`).

**Fix status:** unfixed — the disarm-on-resume path exists and looks correct, so the actionable half is the *reporting*: an expiry that follows an accepted answer should not surface the original block reason, and ideally should be labelled distinctly from a never-answered park.



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Partially fixed, and the split is exactly where the entry predicted. The timer half is closed: `resume()` calls `this.blockedEscalation.claim(existingTask.id)` at `packages/omo-opencode/src/features/background-agent/manager.ts:1650-1651`, and `claim()` clears both the reminder and expiry timers at `blocked-escalation.ts:49-55`; the completion timer is cleared separately at `manager.ts:1664-1668`. There is also a race guard the entry did not credit — `shouldDeferExpiry: (taskId) => this.resumingBlockedTaskIds.has(taskId)` at `manager.ts:313-319`, populated during resume at `:1489-1505`, makes expiry re-arm instead of firing while an accepted answer is still in flight, at `blocked-escalation.ts:36-46`, pinned at `blocked-races.test.ts:51-79`. The reporting half is untouched: every expiry writes `task.error = "Blocked task expired unanswered"` at `manager.ts:2679-2687` and logs the same wording at `:2694-2698`, with no answered/resumed field on `BackgroundTask` to distinguish the cases at `types.ts:111-114` — `resumingBlockedTaskIds` is transient and deleted after dispatch at `:1716-1724`.

**Fix status (2026-09-02):** partially fixed. Timer loss closed by `claim()` plus the expiry-deferral race guard; reporting still labels an answered-then-expired park as `expired unanswered`. Severity revised `costly` -> `papercut`, since work is no longer discarded and the residual is a misleading label. Contained fix: persist an answered flag and emit distinct expiry text.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Reporting half re-confirmed open, and the fix is larger than a label change. `claim()` disarms both timers (`blocked-escalation.ts:49-55`) and resume calls it after a successful dispatch (`manager.ts:1668-1671`); the race guard consults `resumingBlockedTaskIds` (`manager.ts:317-323`, marked at `:1504-1508`) and expiry defers and rearms (`blocked-escalation.ts:36-46`), pinned at `blocked-races.test.ts:52-79`. But `expireBlockedTask()` checks only `isTaskBlocked(task)` and then unconditionally sets `task.error = "Blocked task expired unanswered"` (`manager.ts:2701-2709`, repeated in the log line at `:2716`). The cross-check that matters: `BackgroundTask` has no durable answered-state field at all - `types.ts:111-118` carries `blockedParkCount`, `blockedAt`, `blockedReason` and todo metadata, with no `answeredAt`/`claimedAt`/reply marker - and `resumingBlockedTaskIds` is transient manager state that is cleared by the time a later expiry fires. So the label cannot consult anything; a correct fix has to persist park-answer state first.

**Fix status (2026-09-02):** partially fixed, unchanged. Severity stays `costly`. Contained fix is bigger than previously scoped: add a durable answered marker to `BackgroundTask`, set it on accepted resume, then branch the expiry label on it.

**Last verified:** 2026-09-02 (64d608f6d)
## 2026-09-01 — A file edit reported "applied successfully" landed in the MAIN checkout instead of the target worktree

**Severity:** costly
**Area:** tools
**Observed in:** `~/git/onara`, merging a 6-todo feature branch built across 7 parallel lane worktrees

**What happened:** while fixing a merge-seam compile error I called `mcp_Edit` with an **absolute** path inside a worktree (`/Users/tim/git/onara/.worktrees/composition-program-generation/backend_kt/src/.../PeriodizationModels.kt`) to add a one-line `@Serializable` annotation. The tool returned `Edit applied successfully.` The subsequent `./gradlew compileKotlin` failed with the *identical* error, and re-reading the file showed the annotation absent. Re-applying the same change via a Python script (which asserted the replacement and printed the on-disk result) worked first time.

The stray write surfaced ~40 minutes later, when `git merge` aborted:

```
error: Your local changes to the following files would be overwritten by merge:
	backend_kt/src/test/kotlin/com/onara/tasks/ProgramGenerationTaskTest.kt
Please commit your changes or stash them before you merge.
```

`git status` in the **main checkout** showed three modified files — including `PeriodizationModels.kt` carrying exactly the `@Serializable` line I had "applied" to the worktree.

**Evidence:** the three dirty main-tree files were all partial fragments of this feature's work (bare imports, a constructor stub), each a strict **subset** of what was already committed on the branch:

```
$ diff <(git show composition-program-generation:$f) "$f" | head -3
133d132
< /** One phase of a compiled custom composition, preserving child and same-day order for generation. */
< data class CompositionPreviewBlock(
```

i.e. every difference is a line present on the branch and missing from the main tree — no unique work was stranded. Two of the three files were never touched by me directly in this session, so at least one subagent wrote through as well.

**Root cause / hypothesis (unverified):** something in the edit path resolves against the session's original project root (`/Users/tim/git/onara`) rather than the absolute path given, or a cached file handle from a same-named path in the main tree wins. I did not read the tool source, so this is a hypothesis. What is *certain* is the mismatch between the success report and the on-disk result — the tool reported success for a write that did not reach the named file.

**Why it is costly:** it is silent in three ways at once. The edit reports success; the target worktree is unchanged so the original error persists and reads as "my fix was wrong" rather than "my fix went elsewhere"; and the main checkout accumulates dirt that only surfaces at merge time, long after the causing turn. Because the debris looks like plausible in-progress work on files the feature genuinely touches, the tempting recovery — `git checkout -- .` — risks discarding real work. Here it happened to be safe, but only a per-file `diff` against the branch proved that.

**Workaround:** after any edit that matters, **verify on disk** rather than trusting the success line (re-read the file, or `git diff --stat` in the intended worktree). Before merging a branch built in worktrees, check the main checkout with `git status --porcelain` and, if dirty, diff each file against the branch (`diff <(git show <branch>:$f) "$f"`) to establish whether anything is unique before cleaning. Back up with both a file copy and a labelled `git stash` — uncommitted work has no other recovery path.

**Fix status:** unfixed



**Update:** (verified 2026-09-02 against `dev` @ 4e68569cb) Could not confirm the mechanism; the missing guard is confirmed. `hashline_edit` is OMO-owned, accepts an absolute `filePath` at `packages/omo-opencode/src/tools/hashline-edit/tools.ts:14-20`, and writes it unchanged — `args.filePath` is assigned at `hashline-edit-executor.ts:79-83`, read via `bunFile(filePath)` at `:98-99`, written via `bunWrite(filePath, writeContent)` at `:126`. `context.directory` is used only as the formatter's cwd at `:128-130`, never compared against the target, so there is no worktree containment check anywhere on this path. The repo does own a containment helper, but neither instance covers this: `isPathInsideDirectory` at `hooks/write-existing-file-guard/hook.ts:40-43` is used by a handler that deliberately RETURNS on outside-session paths rather than rejecting them at `tool-execute-before-handler.ts:128-133`; the Prometheus validator at `hooks/prometheus-md-only/path-policy.ts:14-38` is scoped to Prometheus planning writes at `hook.ts:40-62`. No `.omo/rules/` entry covers absolute-path or outside-worktree edits. What could NOT be established is whether OMO's `hashline_edit` or the upstream harness edit tool produced the observed write — the entry itself marks its mechanism unverified, and no evidence in source settles it.

**Fix status (2026-09-02):** still unfixed, mechanism unconfirmed. Classification is conditional: (a) an OMO defect if `hashline_edit` performed the write, since it has no containment check; (b) upstream otherwise. Severity stays `costly`. Next step is reproduction, not a fix — drive `hashline_edit` from a worktree context with an absolute path outside it and assert which tree changes; only then decide whether to add validation before `hashline-edit-executor.ts:98`.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Still UNCONFIRMED as an incident, but the vulnerability half is now proven and should not be restated as conditional. `hashline_edit` accepts an absolute `filePath` (`tools/hashline-edit/tools.ts:14-20`), forwards it unchanged (`hashline-edit-executor.ts:79-83`), and reads and writes it directly (`:98-99`, `:124-126`), including the rename target (`:150-153`). `context.directory` is used only as the formatter's cwd (`:128-130`) and never constrains the target; there is no `resolve`/`relative`/containment assertion in either file. OMO already owns such a helper - `hooks/write-existing-file-guard/hook.ts:36-43` normalizes and tests containment - and applies it to guarded tools (`tool-execute-before-handler.ts:128-131`), though even there an outside-session path merely returns rather than rejecting (`:131-133`). Existing hashline tests use absolute temp paths only (`tools.test.ts:35-52`, `:196-216`, `:239-258`); none covers a relative path from a different cwd, a worktree, or containment. So: a wrong-tree write through this tool is demonstrably POSSIBLE, and this specific incident still cannot be attributed to it without a reproduction.

**Fix status (2026-09-02):** mechanism still unattributed; the missing-containment vulnerability is now confirmed independently of the incident. Severity stays `costly`.

**Update:** (2026-09-02, REPRODUCED against real isolated OpenCode 1.18.20, plugin built from dev @ `f548b2d49`) The vulnerability is no longer a source inference. It was driven end to end in a live harness and the evidence is under `.omo/evidence/20260902-hashline-edit-containment/`.

Case 1, the positive control, edited an absolute path inside the session's own worktree: the worktree file changed, the main checkout did not. Case 2 then ran from that same worktree session and named an absolute path inside the MAIN CHECKOUT. `read` returned `1#VK|MAIN_BASELINE` from the main checkout, `edit` reported `Updated /Users/tim/git/oh-my-openagent/.../.containment-probe.txt`, and on disk that file became `MAIN_ABSOLUTE_APPLIED` while the worktree copy stayed `WORKTREE_BASELINE`. **No permission request of any kind was emitted** - no `external_directory` ask, no denial, no error. Artifacts: `20-case2-disk.txt`, `10-case1-disk.txt`, `05-anchor-proof.txt`, `99-verdict.md`.

So the verdict from the plan's rubric is **"attributed to unconstrained hashline capability, incident still unattributed."** The named target and the mutated file were the SAME file in both cases, so there is no wrong-path routing defect: the tool wrote exactly where it was told. The defect is that nothing checks where it is told to write. The original incident - a worktree lane appearing to modify the main checkout unintentionally - therefore still has no proven mechanism; the surviving candidate is an agent supplying a stale main-checkout absolute path, which this capability then silently honors.

One false signal is worth recording so it is not mistaken for a control later: an earlier attempt saw an `external_directory` permission ask on the LOGICAL `/tmp/...` spelling that vanished under the PHYSICAL `/private/tmp/...` path. That is a macOS symlink artifact, not containment. Case 2 used the physical spelling throughout and was never prompted.

Cases 3 (relative path) and 4 (rename destination escape) remain deferred.

**Fix status (2026-09-02, post-reproduction):** unfixed, and no longer conditional on attribution. Part B of `.omo/plans/hashline-edit-containment.md` is now justified on the reproduced capability alone: resolve and authorize every operand, including the rename destination, before the first read at `hashline-edit-executor.ts:98`. Severity stays `costly` - it needs an absolute path to trigger, so it is not remotely reachable, but it silently corrupts a tree the user is not looking at.

**Last verified:** 2026-09-02 (f548b2d49, live reproduction)

## 2026-09-02 - A sandboxed QA server loads NO omo plugin unless a project-level opencode.json registers it, and every hook silently no-ops

**Severity:** costly
**Area:** QA harness / opencode-qa isolation

**What happened:** four consecutive delegated attempts to reproduce the `hashline_edit` containment finding all recorded INCONCLUSIVE with the same symptom: a real native `read` in the sandbox returned numbered content with no `LINE#ID` anchor, so there was no anchor to drive `edit` with. Three of the four concluded, reasonably, that anchors were unavailable in that runtime. The real cause was that **the omo plugin was never loaded at all**: `GET /config` on the sandbox server returned `plugin: []`.

With no plugin, `hashline-read-enhancer` never runs, reads carry no anchors, and - this is the dangerous part - every other omo hook is equally absent while the server looks completely healthy. Sessions are created, prompts are answered, tools execute, `/config` returns 200. Nothing announces that the thing under test is not loaded.

Two compounding causes, both worth knowing separately:

1. **Config shape.** `hashline_edit` at the ROOT of `~/.omo/omo.jsonc` is rejected, because `OmoConfigSchema` is `.strict()` (`packages/omo-config-core/src/schema/config.ts:68`). The server logs `Migration validation failed ... Unrecognized key: "hashline_edit"` and continues. The accepted shape nests it under the harness block, which is an opaque record (`config.ts:16`): `{"[opencode]":{"hashline_edit":true}}`.
2. **Plugin registration location.** Writing the built plugin path into the sandbox's USER-level `$HOME/.config/opencode/opencode.json` did NOT register it - `/config` still returned `plugin: []`. Only a PROJECT-level `opencode.json` inside the session directory worked, after which `/config` reported `plugin: ['file:///.../dist/index.js']` and anchors appeared immediately (`1#MQ|WORKTREE_BASELINE`).

**Why it is costly:** the failure is silent and it inverts the conclusion. A probe that cannot observe its own subject reports "the feature did not happen", which reads as evidence ABOUT the feature rather than evidence about the harness. Here it produced four INCONCLUSIVE verdicts on a vulnerability that reproduces on the first try once the plugin is actually loaded. The same shape would let a QA run report "the hook did not fire" for any omo hook and be believed.

**Workaround:** in any sandboxed opencode QA that exercises omo behavior, assert the plugin is loaded BEFORE asserting anything about its effects:

```
curl -s "$URL/config" | python3 -c "import json,sys;print(json.load(sys.stdin).get('plugin'))"
# must be non-empty and contain your built dist path
```

Register it project-level, inside the session directory, not user-level. Nest omo settings under `[opencode]`. And treat any "the hook did not fire" result as unproven until the plugin list is shown non-empty in the same run - absence of an effect is only evidence when the producer of that effect is present.

**Fix status:** unfixed. The `opencode-qa` skill does not currently include a plugin-loaded precondition check, and neither `qa-sandbox.sh` nor the sandbox HOME registers the built plugin, so every sandboxed run starts with omo absent by default. Contained fix: have `qa-sandbox.sh` write a project-level `opencode.json` pointing at `dist/index.js`, and add the `/config` plugin assertion to the skill's standard preamble.

**Last verified:** 2026-09-02 (f548b2d49, observed directly during the containment reproduction)


## 2026-09-02 - A self-run QA probe validates the branch the author reasoned toward, not the incident the report describes

**Severity:** costly
**Area:** agent workflow / QA discipline
**Observed in:** oh-my-openagent (`fix/harness-findings-batch`)

Three fixes were implemented, unit-tested, run against a real-harness probe, and reported as done. A `review-work` gate then failed them on two blockers, each of which every self-run gate had passed.

**Blocker 1 - the fix did not reach the reported path.** The incident is a parked task that keeps demanding resume. The author reasoned to "cancellation must clear blocked state", placed the cleanup on `cancelTask`'s main path, and wrote a test for it. The test passed. It passed because it set `task.status = "running"` first - a state the park path never produces, since a park leaves the task `cancelled`. The real cancel takes an early return 50 lines earlier. Both the unit test and the live probe agreed with the author's model of the bug instead of the bug.

**Blocker 2 - the fix opened a fail-open in the guard it repaired.** Widening a regex terminator to a bare `,` let any log-tail line starting `failed,` / `completed,` / `exited,` retire a still-running job. A 28-case probe had been run against this exact question and reported zero over-matches - every fixture in it was header-first, where leftmost-match hides the hole.

**The common shape:** each verification was built by the same person, in the same sitting, from the same mental model as the fix. A test derived from a belief tests the belief. Both defects were live through a green 15,715-test suite, a clean typecheck, mutation testing that confirmed the tests had teeth, and a passing real-harness probe. Mutation testing does not help here - it proves a test pins *what it asserts*, not that the assertion describes the incident.

**What caught them:** six independent review lanes. Three reached blocker 1 separately (one reproducing it against the branch tip); the cross-engine code-quality lane found blocker 2 after the same lane's other engine missed it. The lanes were given the author's own weakest points as open questions, not as assertions.

**Workaround:** for a fix to a *reported* defect, derive the test from the report's observable symptom, not from the mechanism you believe causes it. Construct the failing state through the real production path (call `report_blocked`, do not hand-set `status`); if a test needs to force a field to make the new code reachable, that is the signal it is testing the wrong state. Then prove the probe red against the unfixed build - the negative control here reproduced the incident line for line, and would have failed the original fix immediately. For a widened parser, generate the adversarial direction explicitly: the fixtures that matter are the ones that put hostile input where the anchor can reach it.

**Fix status:** not a code defect; a process finding. Both underlying blockers fixed in `7918492a8` and `8479eaa22`.

**Last verified:** 2026-09-02 (n/a - process finding, no source claim to re-verify)

## 2026-09-02 — A fresh git worktree cannot initialize this repo's submodules, and `bun install`'s prepare script fails as a result

**Severity:** costly
**Area:** repo tooling / dev environment
**Observed in:** oh-my-openagent, creating a task worktree under `.worktrees/`

**What happened:** `git worktree add` followed by `bun install` in the new worktree fails during the `prepare` script, aborting the install before dependencies land. The failure is not obviously about submodules:

```
$ bun install
fatal: Unable to find current revision in submodule path 'packages/shared-skills/upstreams/open-design'
Error: [materialize-shared-upstreams] git submodule init failed
error: script "build:materialize-frontend" exited with code 1
error: prepare script from "oh-my-opencode" exited with 1
```

`bun install` still reports `exit 0` on the second run while having installed nothing new, so the failure is easy to miss; the tell is that root `node_modules` stays at its pre-install entry count.

**Root cause:** confirmed, not hypothesis. The `prepare` script runs `build:materialize-frontend`, which requires the four `packages/shared-skills/upstreams/*` submodules. A new worktree gets its own `.git/worktrees/<name>/modules/...` submodule dirs, and those start without the objects the recorded revisions point at. `git submodule update --init --recursive` alone does NOT fix it: the object is missing from the worktree's module, so the checkout fails with `Unable to find current revision`. In the `open-design` case `git cat-file -t <rev>` reported `commit` while `git rev-parse HEAD` reported an unborn HEAD - the object existed after a fetch but no checkout had been performed.

**Workaround (per submodule):** fetch from the main checkout's already-populated module, then check out the recorded revision explicitly.

```bash
p=packages/shared-skills/upstreams/<name>
rev=$(git ls-tree HEAD "$p" | awk '{print $3}')
git -C "$p" fetch /path/to/main/checkout/.git/modules/$p
git -C "$p" checkout --detach "$rev"
```

Repeat for all four (`open-design`, `designpowers`, `taste-skill`, `ui-ux-pro-max`), then re-run `bun run build:materialize-frontend` to confirm, then `bun install`.

**Why it is costly:** it blocks the very first step of the repo's own mandated worktree workflow, and the error text points at `build:materialize-frontend` rather than at worktree submodule state. A previous session misattributed the resulting three phantom `omo-senpi` TS2307 errors (`typebox`, `@earendil-works/pi-tui`) to a missing package-local `node_modules`; the real cause was this aborted install. Note `typebox` is absent from the main checkout too, so its absence alone is not the signal - the entry count of root `node_modules` is.

**Fix status:** unfixed; workaround only. A `postinstall`/setup step that performs the fetch-then-checkout fallback when a submodule revision is unresolvable would remove the manual step.

**Update:** (2026-09-02, verified against dev @ 64d608f6d) Unchanged; no fallback exists anywhere. The failure path is intact: root `package.json:130-131` runs `prepare` -> `bun run build`, whose `build:materialize-frontend` invokes `materialize-shared-upstreams.mjs --strict` (`:117-118`), and that script performs a plain `git submodule update --init --recursive` with no recovery (`packages/omo-codex/plugin/scripts/materialize-shared-upstreams.mjs:19-31`). `postinstall.mjs` never touches git at all - it verifies the platform binary, checks the OpenCode version, and invalidates the plugin cache (`:60-71`, `:108-124`, `:155-196`). `script/agent/setup.sh:65-68` runs the same plain update and merely warns on failure, which its own test pins as expected behaviour (`script/agent-setup-offline.test.ts:49-71` asserts exit 0 with `WARN: submodule init skipped`). Four submodules are declared (`.gitmodules:1-12`). `work-with-pr` still runs a bare `bun install` in the new worktree (`.opencode/skills/work-with-pr/SKILL.md:77-83`), so it walks into this every time.

**Fix status (2026-09-02):** still unfixed. Severity stays `costly`.

**Last verified:** 2026-09-02 (64d608f6d)

## 2026-09-02 - Zombie/stale background-job reminders fire for jobs already consumed

**Severity:** papercut
**Area:** background tasks
**Observed in:** `~/git/onara`, a 10-todo parallel orchestration wave

**What happened:** the `<unpolled-background-shell-jobs>` reminder repeatedly fired for `ctx_shell` jobs that had already completed and whose output had already been consumed via `background_action="wait"`. Calling `status` or `cancel` on them returned `not found - already finished or cancelled`, i.e. the registry was already empty by the time the reminder landed. The reminder text itself names this as case C, but it fired often enough in this wave (5+ occurrences) to be a real cost, not a rare edge.

**Evidence:** reminder text names the stale-registry case ("case C") as expected behaviour; every `status`/`cancel` call issued against a reminded job in this wave returned the same `not found — already finished or cancelled` line.

**Why it matters:** a prior wave in this same project acted on such a reminder and cancelled a lane that had already succeeded, destroying its work outright. That is the failure mode this pattern makes tempting.

**Workaround:** always verify against disk/git before acting on any block, completion, or job reminder. In this wave every job was independently confirmed by effect — build artifact present, commit SHA present, worktree present — rather than trusted from the status line alone.

**Fix status:** unfixed; workaround only.

**Update (2026-09-02, verified against dev @ 64d608f6d):** largely stale as written, with a narrower residual. Three fixes landed the same day this was observed: `7788a7d9a fix(hooks): parse a terminal shell status that carries an exit clause`, `b93318cd1 fix(hooks): deregister a detached shell job when a status poll reports the id is gone`, and `88d2cb9b2 fix(hooks): offer background_action="wait" as the unpolled-job warning's primary resolution`. Current tracker handles every `background_action` including `wait` (`packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts:198-211`), clears on terminal status or an id-anchored not-found reply (`:209-210`), and accepts both `completed, exit 0` and `failed, exit 1` (`:54`). Pinned at `tracker.test.ts:344-423`. The observed wave therefore almost certainly ran a bundle built before `7788a7d9a`, which is the same stale-bundle explanation already recorded for the 2026-08-30 regex entry.

The residual is a DIFFERENT bug, not this one: the tracker only observes `ctx_shell` calls (`tracker.ts:198-200`), so a job whose output is consumed by any other route stays registered and keeps being reminded about. That is "consumed elsewhere, still tracked", not "finished job still tracked", and it is documented by the test at `tracker.test.ts:388-408`.

**Fix status (2026-09-02, revised):** fixed for the reported symptom in `7788a7d9a` + `b93318cd1` + `88d2cb9b2`. Residual, still open: output consumed outside `ctx_shell` never deregisters the job. Severity stays `papercut`.

**Last verified:** 2026-09-02 (64d608f6d)

## 2026-09-02 - `agent: continue` orphan adoption is broken and unrecoverable

**Severity:** costly
**Area:** subagents
**Observed in:** `~/git/onara`, same 10-todo orchestration wave

**What happened:** calling `task(task_id="ses_...")` to continue a previous subagent session sometimes adopts it as `Agent: continue` instead of the original agent. The response itself warns "no original model, no fallback chain, no category, and no loaded skill content." It then fails outright with `Agent "continue" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.` It cannot be cancelled either — `background_cancel` refuses with `Cannot cancel task: current status is "interrupt". Only running or pending tasks can be cancelled.` — so it lingers as a dead entry.

**Evidence:** occurred 6 times across this wave. It is intermittent, not deterministic — several continuations in the same wave adopted correctly as `Sisyphus-Junior`.

**Workaround:** check the returned `Agent:` field on every continuation. If it says `continue`, treat the continuation as failed and dispatch a fresh task with the prior context inlined into the prompt, rather than retrying the same continuation.

**Fix status:** unfixed; workaround only.

**Update (2026-09-02, verified against dev @ 64d608f6d):** this entry is a STALE DUPLICATE of the 2026-08-27 `continue`-adoption entry above, which was fixed the same day this one was written. `a307c362a fix(background-agent): adopt orphaned sessions under their real agent, never a fabricated one` (2026-09-02) landed before this entry was committed at 16:28; the entry records the pre-fix behaviour of a session that started on the older bundle. Current source recovers identity before adopting (`manager.ts:1433-1437`), REFUSES adoption when no agent can be recovered (`:1438-1444`), and passes the recovered `identity.agent`/`identity.model` into `adoptRunningSession()` (`:1447-1456`, stored at `:715-735`). The second fabrication site is closed too: `sync-continuation.ts:218` now reads `resumeAgent ?? FALLBACK_AGENT`, not `?? "continue"`. Remaining `"continue"` literals at `sync-continuation.ts:124` and `:201` are toast/poll labels that never reach dispatch. The `background_cancel` refusal on an `interrupt`-status task is a separate, still-real complaint and is NOT covered by that fix.

**Fix status (2026-09-02, revised):** fixed in `a307c362a`; entry retracted as a duplicate of the 2026-08-27 finding. The residual - a dead `interrupt`-status task cannot be cancelled - is not covered and remains open.

**Last verified:** 2026-09-02 (64d608f6d)

## 2026-09-02 - Verification gates dispatched before every content lane merges back produce false REJECTs

**Severity:** costly
**Area:** subagents / verification
**Observed in:** `~/git/onara`, same 10-todo orchestration wave

**What happened:** a final verification wave (gates F1-F5) was dispatched in parallel with a still-unmerged content lane. The lane had finished and committed to its own branch but had not yet been merged into the task branch. Two of the gates audit the task branch by contract, so an unmerged lane was indistinguishable from a lane that never ran — both returned a REJECT citing "Todo 7 never shipped." Both revised to APPROVE after the merge, costing a full gate cycle (~18 min each).

**Root cause:** ordering, not a gate defect. A gate that read the task branch had no way to see work still parked on a sibling branch, and should not guess at sibling branches — doing so would mean auditing something other than what actually merges to main. The failure mode is safe in the sense that it over-reports rather than under-reports.

**Workaround / rule:** merge every content lane back to the task branch before dispatching any verification gate. Parallelism between a content lane and a gate is only safe when the gate does not read the task branch.

**Fix status:** not a code defect; a process/ordering finding.

**Last verified:** 2026-09-02 (n/a - process finding, no source claim to re-verify)

## 2026-09-02 - Testing lesson: a test that constructs the object under test is structurally blind to a derivation bug

**Severity:** n/a (process/testing lesson, not a harness defect)
**Area:** testing discipline
**Observed in:** `~/git/onara`, same 10-todo orchestration wave

**What happened:** a fix deleted a hardcoded `trainingGoal = ENDURANCE` and pinned the fix with a test asserting `BUILD_MUSCLE`. That test passed, and always would have, because it consumed a hand-built skeleton fixture — the goal was an *input* to the test, never a derivation *output*. The identical defect survived one layer up in a sibling code path (`ProgramSkeletonService` inheriting the same hardcoded goal via a `copy()`), and three static review gates all returned APPROVE without seeing it. Only live-stack manual QA caught it — an HTTP 400 on the feature's own headline case.

**Root cause:** the test's inputs and the code's outputs shared the same fixture, so the assertion could not distinguish "the value is right" from "the value is whatever I put in." A round-trip check against fixed input data cannot expose a bug in the derivation step that produces that data in production.

**Fix:** the durable fix was a round-trip invariant at the derivation layer — `validate(derive(req), req) == emptyList()` — which is branch-agnostic and cannot be satisfied by a fixture that hand-sets the field under test.

**Fix status:** not a code defect; a process/testing finding.

**Last verified:** 2026-09-02 (n/a - process finding, no source claim to re-verify)

## 2026-09-02 - The findings review re-derives its scope each pass, so coverage rotates instead of accumulating

**Severity:** costly
**Area:** harness tooling / findings log
**Observed in:** `~/git/oh-my-openagent`, the `harness-findings-review` skill itself

**What happened:** two review passes ran on the same day. The morning pass committed as `3766a4806 docs(findings): verify the 15 unreviewed entries against dev and re-score them`. The afternoon pass, invoked with the same command and expecting a mostly-verified log, found 23 entries still carrying their 2026-08-27 verdict and 15 that had never been re-verified since capture. Of 61 total entries, no pass had ever covered all of them, and the two same-day passes covered disjoint subsets.

**Root cause:** the skill's inventory step scoped work by reading `**Fix status:**` dates and picking what "looked stale". That is a re-derivation, not a ledger. Each pass computes a fresh subset from whatever the previous pass happened to leave alone, so coverage rotates: entries move in and out of scope, and an untouched block can persist across many passes while every pass truthfully reports having verified everything it selected. Distribution at the time of observation, by each entry's newest status-line date: 16 at 2026-09-02, 3 at 2026-08-28, 23 at 2026-08-27, 4 older, 15 with no re-verification line at all.

**Why the signal is misleading:** a `**Fix status:**` line is only written when a verdict *changes*. An entry checked and found unchanged gets no new line, so it is indistinguishable from an entry nobody has looked at since it was captured. The field the scoping logic reads cannot express "verified, unchanged" - which is the most common outcome of a review pass.

**Fix:** the skill now requires a `**Last verified:** YYYY-MM-DD (<sha>)` line on every entry a pass checks, written even when nothing changed, and scopes the next pass by sorting on that field rather than on status dates. It also requires stating the coverage arithmetic out loud - total, checked, knowingly skipped - before dispatching.

**Fix status:** fixed in the skill (`.agents/skills/harness-findings-review/SKILL.md`, steps 1 and 5). The `**Last verified:**` field is introduced by this pass and is not yet present on entries older than it; coverage accounting is only reliable from 2026-09-02 forward.

**Last verified:** 2026-09-02 (earlier same-day pass, commit not recorded)

## 2026-09-02 - The findings-review skill ordered its verifier agent to run git, which that agent cannot do

**Severity:** costly
**Area:** subagents / harness tooling
**Observed in:** `~/git/oh-my-openagent`, an 18-verifier review pass

**What happened:** the `harness-findings-review` skill dispatches one background `explore` per entry and requires, in its mandatory cross-check step, that the verifier "run `git log --oneline -- <the file>` and read the subject lines", noting that "a fix commit naming the defect outranks a source read that missed it". `explore` has no shell. 15 of 18 verifiers returned some form of "no git-capable tool is available in this session" and declined to answer the history half.

**Root cause:** `createExploreAgent` allows exactly `READ_ONLY_FILE_TOOLS` plus four LSP tools - `packages/omo-opencode/src/agents/explore.ts:28-31` with `["read", "grep", "glob"]` at `packages/omo-opencode/src/shared/permission-compat.ts:27`. There is no bash, by design: `explore` is a contextual grep, not a shell. The skill asked its cheapest agent for the one piece of evidence that agent is structurally incapable of producing.

**The dangerous half is not the refusal.** Two verifiers did not refuse. They substituted `read` on `.git/logs/refs/heads/dev` and reasoned from it, reporting "no fix commit appears in the reflog after the observation" as though it were history. A reflog records the local checkout's own ref movements, not the branch's commit history; the conclusion was unfounded in both cases, and it arrived formatted identically to a cited, correct one. This is the same failure class the skill's own cross-check section was written to catch: a citation proves the agent read something, not that it read the right thing.

**Evidence:** in the same pass, orchestrator-run `git log --oneline --since=2026-08-27 -- packages/omo-opencode/src/features/background-agent/` returned 12 commits including `a307c362a`, `8479eaa22` and `400a4a723`, none of which any verifier could see.

**Fix:** the skill now assigns every git query to the orchestrator, batched before dispatch, with the resulting subject lines pasted into each verifier prompt as given fact. Verifier prompts are required to carry `Do NOT read .git/`. The verifier's job is narrowed to source-and-test reading, which keeps the two evidence directions independent - supplied history versus observed source - so a disagreement is signal rather than a silent gap.

**Fix status:** fixed in the skill (`.agents/skills/harness-findings-review/SKILL.md`, step 2 and the verifier-prompt contract). The underlying agent restriction is correct and unchanged; the defect was the instruction, not the permission.

**Last verified:** 2026-09-02 (64d608f6d)
