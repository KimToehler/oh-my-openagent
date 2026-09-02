# F-wave adjudication (orchestrator)

Five gates ran in parallel. Raw verdicts: F1 REJECT, F2 REJECT, F3 BLOCKED, F4 APPROVE, F5 APPROVE.
Each blocking claim was re-verified directly rather than actioned on the report alone. Two were
real defects, two were auditor error.

## F1 REJECT - OVERTURNED (auditor error)

F1 rejected on "full suite 5 fail". It ran the suite ONLY in the worktree and attributed every
failure to this work. That inference is unsound without a baseline.

Differential, both suites run to completion:

| tree | pass | fail | files |
|---|---|---|---|
| `dev` (baseline) | 12829 | 4 | 1692 |
| worktree | 12840 | 4 | 1694 |

The two failure SETS are byte-identical: four `ulw-plan` skill-loader/dedup tests that already
fail on `dev` and are unrelated to background-agent. This work introduced ZERO failures and added
11 passing tests across 2 new files.

F1's fifth failure (generated Codex installer release version sync) did not reproduce in either
full run. Re-run in isolation: `packages/omo-codex/src/install` = 263 pass / 1 skip / 0 fail.
Load-order flake, not a defect.

F1's non-suite findings were verified and all PASS: `BackgroundTaskStatus` still exactly 6
members, `resume()` running guard unchanged, no inactivity/stall detector, no timeout values
changed, and the replacement race-(a) test confirmed load-bearing.

## F2 REJECT - UPHELD (real defect, fixed in `600c9668c`)

F2 finding 1 was correct and is the most serious issue the whole F-wave surfaced.
`resumingBlockedTaskIds.add()` ran BEFORE `await this.concurrencyManager.acquire(...)`, but the
matching delete lived only in the dispatch promise's `.finally()`. If acquire threw, the marker
leaked and `shouldDeferExpiry` would return true forever, making the task PERMANENTLY
un-expirable - the exact failure mode the escalation timer exists to prevent.

Proven, not assumed: with the guard, 0 leaked entries; without it, 1 leaked entry and the test
fails. The fix keeps the add BEFORE the await (moving it after would reopen the expiry window it
was introduced to close) and releases the marker in a `catch` that rethrows. Pinned by a
committed regression test in `blocked-races.test.ts`, not a throwaway probe.

F2 finding 2 (trailing whitespace, 6 lines in `background-task-defaults.test.ts`) was ours: fixed.

F2 finding 4 (en dash in `prompt-builder.test.ts:137`) was NOT ours. The dash sits in a
pre-existing `describe` title that this diff never touched; F2 flagged the file, not the change.
Left alone under the no-unrelated-churn rule.

F2 finding 3 (200 LOC violations) is acknowledged and NOT fixed. `manager.ts` at 2909 LOC is a
long-standing architectural smell that predates this work by far. Splitting it inside a feature
branch would be exactly the unrelated churn the repo rules forbid, and would put a large
behavior-preserving refactor next to a subtle concurrency fix in the same review. Recorded as
pre-existing debt.

## F3 BLOCKED - GENUINELY UNRESOLVED

The mandatory real-harness gate did NOT pass and is not being claimed as passed.

What it did prove: fresh build `BUILD_EXIT=0`, bundle contains `report_blocked` 5 times, 0
background-agent sources newer than the bundle, real OpenCode 1.18.15, and host DB session count
1670 before / 1670 after (isolation intact, real DB untouched).

Where it stopped: `ProviderAuthError: Anthropic API key is missing`. The parent run died before
its first prompt, so no child spawned, no `[BACKGROUND TASK BLOCKED]` wake was observed, and no
resume was observed. The sandbox has no credentials because `.env` does not exist in this repo
(only `.env.example`).

This means the end-to-end flow has NEVER been observed on a real harness. Every claim about this
feature remains unit/seam level. F5 independently reached the same conclusion (its finding 6).
Unblocking requires either isolated provider credentials in `.env` or a deterministic fake
provider able to drive parent-task, child-`report_blocked`, and resumed-child.

## F4 APPROVE

Scope clean. 7 files touched beyond the plan's `Files:` lines, all in-feature and justified
(generated schema twin, a 3-LOC DRY extraction, test files for authorized source, and the single
caller of an authorized function). No authorized path left untouched. Timeout values unchanged -
the schema JSDoc previously LIED about the real defaults and the diff corrects prose only. Its
advisory about the 4 dirty build artifacts was actioned: reverted, and the worktree is clean.

## F5 APPROVE (with findings)

Probe evidence complete, all four questions answered with captured output, probe demonstrably
predates the first production commit. Ordering is INFERRED rather than PROVEN because evidence is
gitignored, so no commit hash attests to it - three independent signals agree and none contradict.
No probe script survives anywhere on disk or in any commit on any branch, verified six ways,
including the throwaway `race-probe`/`mut-probe` files from wave 2.

Its finding 5 (the A1.3 reservation never runs on the production path because `report_blocked`
passes `skipNotification: true`, so the pinning test exercises a path production does not take) is
substantive, unfixed, and worth a follow-up. Its finding 7 (a failed abort can leave a live child
session attached to a task later marked cancelled) is a real edge case, also unfixed.

## Final state

Scoped suite 841 pass / 0 fail across 76 files. Typecheck exit 0, 0 errors, captured directly.
Commits: `7a42c0682`, `e20f7c07a`, `a6dd49298`, `02a4f30d3`, `600c9668c`.

NOT merge-ready by repo law: F3 is the mandatory QA gate for anything under
`packages/omo-opencode/`, and it is BLOCKED on missing credentials, not passed.
