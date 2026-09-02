# QA evidence: harness-findings fix batch (2026-09-02)

Branch `fix/harness-findings-batch`, local only, no PR. Three defects confirmed open by the
2026-09-02 findings review, fixed here. OpenCode-side change, so `opencode-qa` is the gate.

## WHAT WAS TESTED

### 1. Cancelled blocked subagent keeps urging the parent to resume it
Findings entry: 2026-08-28, `costly - the urged action can be destructive`.

- **Change:** `packages/omo-opencode/src/features/background-agent/manager.ts:2796-2806`.
  `cancelTask` now disarms `blockedEscalation` and clears `blockedAt` / `blockedReason` /
  `blockedNotificationTaskIds`, but ONLY when `source !== "report_blocked"`.
- **Surface driven:** the real `opencode serve` harness under an isolated sandbox, via
  `.agents/skills/opencode-qa/scripts/blocked-escalation-probe.sh`, which drives a live
  park -> reminder -> expiry cycle against a mock model with `blockedRewakeMs=60000`
  and `blockedExpiryMs=120000`.
- **Behavior it was meant to prove:** a terminal cancellation stops the reminder, and a
  park (which is *implemented as* a cancellation) does not.

### 2. `[background:... completed, exit 0]` never parses as terminal
Findings entry: 2026-08-30, re-scored `papercut -> costly` during review.

- **Change:** `packages/omo-opencode/src/hooks/unpolled-shell-job/tracker.ts:44`, one
  character class: `(?:\]|$|\n)` -> `(?:,|\]|$|\n)`.
- **Surface driven:** the regex executed against verbatim strings this QA session itself
  received from `ctx_shell` background jobs. See `tracker-regex-real-strings.txt`.

### 3. `record_lesson` throws an unreadable TypeError on a missing argument
Findings entry: 2026-08-27, re-scored `costly -> papercut` during review (diagnosis corrected:
well-formed globs were always accepted; the crash is an absent-argument case).

- **Change:** `packages/omo-opencode/src/tools/record-lesson/tool.ts:53-57`, five guards
  before the first dereference.
- **Surface driven:** unit tests only. This tool is not reachable from the escalation probe,
  and the failure mode is a synchronous input-validation error with no harness wiring.

## WHAT WAS OBSERVED

### The probe caught a real regression in my own first fix
This is the load-bearing part of this record. The first version of the `cancelTask` change
cleared blocked state unconditionally. It passed **1108 scoped unit tests and a full
15714-test suite with zero new failures**, and still broke the feature.

Probe run 1, before the discriminator (`blocked-escalation/` was overwritten by run 2,
transcript preserved here):

```
observed: blocked wake at +7s
FAIL: no reminder wake observed
FAIL: task never expired
FAIL: expected exactly 1 reminder, saw 0
REMINDER_AT_S=none
EXPIRY_AT_S=none
REMINDER_COUNT=0
ESCALATION PROBE FAIL (3)
```

Root cause: `report_blocked` parks a child by *calling* `cancelTask`
(`packages/omo-opencode/src/tools/report-blocked/tools.ts:36-46`) after setting `blockedAt`
and arming escalation. Unconditional cleanup therefore disarmed the timers the park had
just armed. A parked task legitimately IS a cancelled task carrying blocked metadata, which
is also why `background-task-notification-template.test.ts:83-110` was right to keep
asserting actionable blocked output for a cancelled task.

Probe run 2, after gating on `source !== "report_blocked"` (artifacts in
`blocked-escalation/`):

```
observed: blocked wake at +7s
observed: reminder at +64s
observed: expiry at +122s
BLOCKED_AT_S=7
REMINDER_AT_S=64
EXPIRY_AT_S=122
REMINDER_COUNT=1
ESCALATION PROBE PASS
OPENCODE_VERSION=1.18.20
```

### Isolation proof
```
REAL_DB_BEFORE=3514
REAL_DB_AFTER=3514
PARENT_IN_REAL_DB=0
CHILD_IN_REAL_DB=0
```
Session identity is the authoritative check, not the count: neither the parent
(`ses_f9e57b2e9ffeMD0OhLbVgp0GLW`) nor the child (`ses_f9e57abe6ffew5Sfcnv7YRmmX4`) appears
in the real `~/.local/share/opencode/opencode.db`.

### Tracker regex, real strings from this session
Full table in `tracker-regex-real-strings.txt`. Summary:

| string | old | new |
|---|---|---|
| `[background:shell_de62a206c9573559 completed, exit 0]` | null, not terminal | `completed`, TERM |
| `[background:shell_abc failed, exit 1]` | null, not terminal | `failed`, TERM |
| `[background:shell_1231134ea9cf1e99 started]` | `started`, not terminal | `started`, not terminal |
| `status: completed\nexit code: 0\n` | `completed`, TERM | `completed`, TERM |
| `[background:shell_abc arbitrary prose completed, exit 0]` | null | `arbitraryprosecompleted`, not terminal |

The failure was never success-only: `failed, exit 1` was equally unparseable, so a failed job
read as still-running. Over-matching is bounded, proven by the last row.

### Regression baseline
Full root suite, my six files stashed then restored, failure lists diffed:

```
before: 15 failures
after:  15 failures
diff:   IDENTICAL - all 15 pre-existing, 0 caused by this branch
```
Scoped suites: 934 pass / 0 fail (background-agent + report-blocked), 41 pass / 0 fail
(unpolled-shell-job), 137 pass / 0 fail (record-lesson). `bun run typecheck` clean.

## WHY IT IS ENOUGH

- Defect 1 is proven on the **real harness**, not a fake timer: the probe wires the real
  manager to real timers and observes real SSE wakes. Both directions are pinned by paired
  unit tests that the buggy version could not satisfy simultaneously - terminal cancel emits
  0 reminders, park emits exactly 1 and keeps `blockedAt` set. Verified failing-first against
  the old code.
- Defect 2 is proven against strings the harness actually produced during this session,
  not hand-written fixtures, plus a negative case bounding over-match.
- The baseline diff makes "no regressions" a measured claim rather than an assumption.

## RESIDUAL RISK

- The probe overrides both escalation knobs to 60s/120s, so it proves the WIRING and cannot
  detect a changed shipped default. Defaults stay pinned separately in
  `blocked-escalation.test.ts`.
- Defect 3 has no live-harness coverage (see above). Unit-tested only.
- The probe does not cover the branch where a park's own abort FAILED; that path is unit
  tested and unchanged by this work.
- 15 pre-existing suite failures remain untouched and out of scope for this branch.

## WHAT WAS OMITTED

- `blocked-escalation/escalation-mock-requests.log` is a 600 KB raw mock-model request log,
  kept as-is because it contains only synthetic prompts against a local mock. No provider
  credentials, tokens, or auth headers were captured; the probe never contacts a real
  provider.
- Probe run 1's artifact directory was overwritten by run 2. Its failing output is quoted
  verbatim above rather than reconstructed.
