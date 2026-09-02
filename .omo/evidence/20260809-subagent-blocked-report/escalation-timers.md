# Blocked-task escalation timers, proven on a real opencode harness

VERDICT: PASS. The 10-minute reminder and the 20-minute hard expiry, previously covered
only by fake-timer unit tests, are now observed firing on a REAL opencode harness with
the real plugin and ZERO credentials. Run exit 0.

This closes the gap recorded in `F3.md` under "STILL NOT PROVEN ON A REAL HARNESS".

## WHAT WAS TESTED

`.agents/skills/opencode-qa/scripts/blocked-escalation-probe.sh --evidence-dir <dir>`

A real `opencode serve` (1.18.15) in an isolated XDG sandbox, driven by the committed
opencode-qa mock model (`lib/mock-model.mjs`, merged as `a4b34ebe8`). Flow: parent
session delegates a background child, the child calls `report_blocked`, and the parent
then deliberately does NOT answer, so both escalation deadlines are allowed to elapse.

Both deadlines were shortened via the shipped config knobs, which carry a 1-minute
floor: `blockedRewakeMs=60000`, `blockedExpiryMs=120000`. That keeps the run at ~3
minutes instead of 20. It proves the WIRING, not the shipped default VALUES - a run
that overrides both knobs can never notice a changed default. The defaults are
therefore pinned separately in `blocked-escalation.test.ts` ("the shipped escalation
defaults": 10m reminder, 20m expiry, ordered, inside the terminal TTL).

## WHAT WAS OBSERVED

From `escalation-run-metadata.txt`, one run, all timings relative to prompt dispatch:

    BLOCKED_AT_S=7        blocked wake reached the parent
    REMINDER_AT_S=63      reminder wake, deadline was 60s
    EXPIRY_AT_S=122       hard expiry, deadline was 120s
    REMINDER_COUNT=1      exactly one reminder, never two

The reminder marker observed in the live SSE stream (`escalation-wakes.txt`):

    [BACKGROUND TASK BLOCKED]
    [BACKGROUND TASK BLOCKED] (reminder 1 of 1, waiting 1m)

`REMINDER_COUNT=1` is the assertion that would catch a re-arm leak: the escalation
timer re-arms itself when expiry is deferred (`armExpiry` in `blocked-escalation.ts`),
so a bug there would surface as 2+ reminders rather than a missing one.

## PRODUCT FINDING FOUND BY THIS PROBE

`expireBlockedTask` was externally INVISIBLE. Unlike `failBlockedTask` directly below
it, which calls `markForNotification` + `enqueueNotificationForParent`, expiry mutated
the task and scheduled its removal while notifying nobody, and logged nothing. The
parent is never told that the question it was asked has expired, and an operator
debugging a stuck park has no signal at all to look for.

The notification gap is DESIGNED behavior per the plan (expiry "clears the blocked
fields, leaves the task cancelled with an error noting it expired unanswered, and lets
normal cleanup reclaim it"), so this run did not change it. The missing observability
WAS fixed: expiry now logs `[background-agent] Blocked task expired unanswered:` with
task, session and parent-session ids, matching every other terminal transition.

This is also why the probe watches the plugin log for expiry rather than the SSE
stream. Watching SSE for an expiry wake waits forever, and reads exactly like a timer
that never fired.

## ISOLATION - PASSED

    PARENT_IN_REAL_DB=0
    CHILD_IN_REAL_DB=0

Isolation is asserted by session IDENTITY, not by a session COUNT. An earlier revision
compared `SELECT count(*) FROM session` before and after and reported leakage that did
not exist, because the operator was using opencode in another window during the run.
The authoritative check is that no session id this probe created appears in the real
DB. Both are absent.

All XDG dirs plus HOME pointed at a `mktemp` sandbox. The mock server and the spawned
`opencode serve` are killed at teardown.

## HOW THE PROBE WAS MADE TRUSTWORTHY

Six runs failed before the first pass, each with a plausible but WRONG cause. Each fix
is now a guard in the script, because every one of them failed SILENTLY and looked like
a broken feature:

1. `.opencode/oh-my-opencode.jsonc` is read by NOTHING but the migration engine.
2. The harness block key is literally `"[opencode]"`, WITH brackets. A plain
   `"opencode"` key is dropped without a warning.
3. Config must exist BEFORE the server starts; both opencode and the plugin read it
   once at startup.
4. The plugin resolves config from the directory opencode RUNS IN (`input.directory`),
   not from the session's `directory` field. Serving from the repo checkout made the
   plugin walk up to the operator's real `~/.omo/omo.jsonc` - proven by the run logging
   `teamModeEnabled:true`, a value that exists ONLY there - so every sandbox override
   was ignored and the run died on the operator's real agent model.
5. A stale `ENTRY - plugin loading` line from a PREVIOUS run answered for the current
   one. The assertion now only reads lines appended after this run began.
6. Parking a child ABORTS its session, so the child legitimately emits
   `MessageAbortedError`. Treating any `session.error` as fatal killed a run in which
   the feature was working correctly. The fail-fast is now scoped to the parent session
   and ignores abort errors.

The script asserts the plugin actually loaded against the sandbox project before
spending three minutes waiting on timers, so a config that silently did not apply can
never again masquerade as a timer failure.

`--self-test` covers the parts the script owns without spawning opencode: the mock
emits both scripted tool calls, the reminder matcher REJECTS a blocked wake with no
reminder and ACCEPTS a real marker, and the duplicate counter counts every occurrence.
A matcher that passed on both inputs is what would make an unfired timer look proven.

## WHAT WAS OMITTED

No credentials were used; the provider `apiKey` is the literal string `not-needed`. No
production behavior was changed to make this pass - the only production edit is the
added expiry log line. Sandbox roots, the server password and provider config were not
copied into this report. The shipped default timer VALUES are not proven by this run,
by design; they are pinned by unit test instead.
