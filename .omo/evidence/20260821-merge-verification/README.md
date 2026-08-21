# QA evidence: integration verification of the five harness fixes on `dev`

Each fix was verified on its own branch. None had ever been tested against the others, and
three of them touch the same subsystem (`features/background-agent/`), so this records the
verification of the merged result.

## What was merged

Five branches, merge commits per the repo's PR merge policy (never squash/rebase):

| Branch | Commit | What |
|---|---|---|
| `fix/shutdown-abort-status` | `9096d20da` | killed tasks no longer report `completed` |
| `fix/summary-park-dedupe` | `7d41a6f23` | park replay no longer invents failures |
| `fix/resume-liveness` | `8728fa5f1` | resume reconciles a stale `running` |
| `fix/status-honesty` | `cc13ab687` | status discloses session silence |
| `fix/poller-not-busy` | `d133f0f8d` | locks the session-existence probe |

Merged head: `2c8dd8898`. Zero conflicts; `git rev-list --count dev..<branch>` is 0 for all
five, so each is fully contained.

Three of these touch `manager.ts` (shutdown loop, resume guard, status-response comment) and
two touch the notification/reporting path, which is exactly why the merged tree needed its
own run rather than trusting five green branches.

## What was tested

Typecheck, build, and the full `bun test` suite on the merged tree, plus an explicit run of
the four test files added or extended by these fixes.

## What was observed

- `01-typecheck-merged.txt`: exit 0, 0 errors.
- `02-build-merged.txt`: exit 0. All five fixes are present in the built bundle:
  `dedupeByTaskId` 2, `probeSessionLiveness` 2, `reconcileStaleRunningTask` 2,
  `sessionNotBusy` 12, `describeRunningSilence` 2 occurrences in `dist/index.js`.
- `03-full-suite-merged.txt`: **15573 pass / 14 fail**.
- Compared against `04-full-suite-dev-baseline.txt` (pristine `dev`, 15551 pass / 14 fail):
  the failing set is **identical** after normalizing the `[Nms]` timing suffix. Zero new
  failures, zero previously-failing tests silently disappeared.
- `05-new-tests-on-merged.txt`: the four new/extended test files run **44 pass / 0 fail** on
  the merged tree.

The last check exists because bun prints only failures by default, so a green summary alone
does not prove the new tests executed rather than being skipped or not discovered. Running
them explicitly and counting 44 does.

## Why this is enough

The integration risk in this batch was collision inside `manager.ts` and double-handling in
the notification path. Both are covered: the merge applied cleanly, the full suite's failing
set is unchanged from baseline in both directions, and every assertion added by the five
fixes still holds when all five are present together.

## What was omitted

- The 14 remaining failures are pre-existing on `dev` and out of scope; they were neither
  fixed nor masked, and the byte-identical comparison is what demonstrates that.
- No live `opencode serve` run at merge time. Each branch carried its own real-surface QA
  (`.omo/evidence/20260821-*`); this record covers integration only.
- Nothing was pushed to a remote. These merges are local to `dev`.
