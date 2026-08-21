# QA evidence: resume() reconciles a stale `running` status against session liveness

Finding: `docs/troubleshooting/harness-findings.md` - "2026-08-17 - Dead task reports
`running`; resume requires cancel first".

Branch: `fix/resume-liveness` (off `dev`, not stacked - the resume region is far from the
shutdown/notification code touched by the two earlier fixes).

## What was tested

The reported symptom driven against the real `BackgroundManager`: a background task whose
child session has died, whose in-memory record still says `running`, receiving a
continuation prompt through `manager.resume()`.

Three scenarios, each run twice - once on pristine `dev`, once on the patched build:

| # | Scenario | Expected after fix |
|---|---|---|
| A | child session absent from the status registry, seen gone for 3+ polls | resume accepted |
| B | child session absent for a single poll (transient blip) | resume rejected |
| C | child session genuinely `busy` | resume rejected |

Driver: `10-qa-drive-script.ts` (run with `bun run qa-drive-resume.ts` from the worktree
root). It seeds a task with `status: "running"`, a 62-minute-old `startedAt`, and a held
concurrency slot, then calls the real `resume()`. The fake client deliberately keeps
`session.get()` resolving in every scenario, because that is what makes the row-existence
probe useless as a liveness signal.

## What was observed

`08-qa-drive-dev.txt` (before) vs `09-qa-drive-patched.txt` (after):

| Scenario | dev | patched |
|---|---|---|
| A - dead, 3+ missed polls | RESUME REJECTED | **RESUME ACCEPTED** |
| B - dead, 1 missed poll | RESUME REJECTED | RESUME REJECTED |
| C - genuinely busy | RESUME REJECTED | RESUME REJECTED |

Only scenario A changes. B and C keep the byte-identical rejection message
`Task bg_qa_stuck is currently running and cannot accept a continuation prompt`, which
three pre-existing assertions depend on (`manager.test.ts:1873`, `manager.test.ts:3219`,
`spawner.test.ts:74`).

### Unit tests

`01-red-baseline.txt` -> `02-green-after-fix.txt`: **5 pass / 3 fail -> 8 pass / 0 fail**.
The three red tests are the reconciliation cases; the five that were already green are the
fail-safe paths, included so the fix cannot silently widen the gate.

### Scoped suite

`03-scoped-suite-dev.txt` vs `04-scoped-suite-patched.txt`:
`874 pass / 4 fail` (dev) vs `885 pass / 4 fail` (patched). The failing set is identical
after normalizing the `[Nms]` timing suffix - the same 4 pre-existing failures
(3x `pollRunningTasks` todo-gate, 1x `ParentWakePendingQueue`).

### Typecheck and build

`05-typecheck-patched.txt` exit 0, 0 errors. `06-build-patched.txt` exit 0, with
`probeSessionLiveness` / `reconcileStaleRunningTask` present in `dist/index.js`.

`07-typecheck-pristine-worktree-artifact.txt` documents a false alarm worth recording: the
worktree first reported 3 `TS2307` errors for `@earendil-works/pi-tui`. Stashing the patch
and typechecking pristine `dev` **in the same worktree** reproduced all 3, proving it was
an incomplete `bun install` (the root install aborts on an unrelated `build:lsp-daemon`
prepare failure) and not the change. Re-running `bun install --ignore-scripts` fixed it.

## Why this is enough

The change alters exactly one decision - whether `resume()` rejects - and the QA drives
that decision on the real manager across the full trichotomy the implementation
distinguishes (active / terminal / absent), plus both fail-safe paths (status endpoint
throwing, `session.status` absent from the client) and the poller-claim race. The
rejection message is unchanged for every path that still rejects, so the existing
assertions remain meaningful rather than merely passing.

A correction to the finding is recorded in the log: its suggested fix (probe
`verifySessionExists()` before the guard) is a no-op, because that helper reports session
row existence and returns `true` for a dead child. The liveness signal is
`client.session.status()`, classified by `session-status-classifier.ts`.

## What was omitted

- No live `opencode serve` session was driven. Killing a real subagent mid-flight and
  observing the parent's resume is not reproducible on demand; the driver reproduces the
  same state deterministically through the real manager instead.
- The full `bun test` run is included (`11-full-suite-patched.txt`) but the failing set is
  compared at the scoped level, where the signal is not diluted by unrelated suites.
- No secrets, tokens, or environment dumps are present in these artifacts; the driver uses
  a fake in-process client and never contacts a provider.
