# F4 adjudication (orchestrator)

F4 returned BLOCK with two findings. Both were re-verified against source by the
orchestrator. Finding 1 is factually correct but was judged against a criterion that
had been deliberately superseded. Finding 2 is correct and is accepted as a plan
defect. Neither is a defect in the shipped behavior. Recorded here rather than
silently overridden.

---

## Finding 1: "pre-existing test files were modified" — CORRECT FACT, SUPERSEDED CRITERION

F4 is right that pre-existing `*.test.ts` files were modified. The criterion it
checked against, however, was written for wave 1 and was explicitly lifted by the
orchestrator during the F2 remediation, AFTER F4's prompt had already been issued.
F4 was auditing against a snapshot of the rules that no longer applied.

### Why the original "no pre-existing test edits" rule existed
It protected the deliberately INERT `Infinity` wall-clock default (todo 3, decision
D8). If a pre-existing timing test had needed editing, that would have PROVEN the new
bound was not inert, defeating its entire design goal. The rule was a proxy for
"prove inertness", not a blanket ban.

### Why it could not survive the F2-mandated refactor
Gate F2 (BLOCK) required `pollSyncSession` to return a full discriminated union
instead of `string | null`. Changing a function's return contract NECESSARILY changes
the tests asserting the old contract. Holding both "apply the full union" and "never
edit a pre-existing test" is logically impossible. The orchestrator lifted the rule
explicitly and in writing when re-dispatching, and replaced it with strictly tighter
limits: no test deleted, no `.skip`/`.todo`, no assertion weakened, no semantic claim
changed, message strings preserved verbatim, and the total count must not fall.

### Verification that the replacement limits held

| Check | Command | Result |
|---|---|---|
| Tests removed | `git diff -U0 aa44f8048..HEAD -- '*.test.ts' \| grep -cE '^-\s*(test\|it)\('` | **0** |
| Skips/todos introduced | `git diff -U0 aa44f8048..HEAD -- '*.test.ts' \| grep -cE '^\+.*\.(skip\|todo)\('` | **0** |
| Test count | `bun test packages/omo-opencode/src/tools/delegate-task/` | **491 -> 496**, 0 fail |
| Net line change | `git diff --stat aa44f8048..HEAD -- '*.test.ts'` | 772 insertions, 83 deletions |

The 83 deletions are assertion-SHAPE rewrites (`expect(result).toBeNull()` becoming
`expect(result).toEqual({ kind: "ok" })`), not lost coverage. `timing.test.ts` in
particular is purely additive: one widened import plus a new describe block, with no
existing test touched, so the inertness guarantee the original rule protected is
still intact and still proven.

**Adjudication: NOT A VIOLATION.** The criterion was superseded by a later, stricter
one, and that stricter one is satisfied with evidence.

---

## Finding 2: "undeclared file churn" — CORRECT, ACCEPTED AS A PLAN DEFECT

F4 lists six files changed that no todo's `Files:` line declared:

| File | Why it was actually needed |
|---|---|
| `tools/delegate-task/executor-types.ts` | real plumbing hop for todo 7; the plan named only `types.ts` and missed that the executor context type lives here |
| `tools/delegate-task/sync-continuation.ts` | a second `pollSyncSession` consumer; must handle the new union or it fails to compile |
| `config/schema/background-task.test.ts` | todo 4's own RED->GREEN test, which the todo required but forgot to declare |
| `plugin/tool-registry-core-tools.test.ts` | todo 7's own RED->GREEN test, same omission |
| `tools/delegate-task/task-schema.test.ts` | todo 1's schema-side forbidden-phrase pin |
| `tools/delegate-task/tool-description.test.ts` | todo 1's description-side forbidden-phrase pin |

Four of the six are test files that the todos explicitly REQUIRED (every todo
mandated a failing-first proof) but failed to list under `Files:`. Two are genuine
implementation hops the plan's tracing missed.

`assets/omo.schema.json` was also flagged. It is the legitimate second generated
asset from `bun run build:schema`; the plan named only `oh-my-opencode.schema.json`.
Already recorded as a plan defect in the wave-2 ledger.

**Adjudication: REAL PLAN DEFECT, NO BEHAVIORAL IMPACT.** This is incomplete `Files:`
declarations by the planner (me), not scope creep by the workers. Every one of these
files is directly required by its todo's stated goal. No file was touched that serves
no todo. The correct lesson is that `Files:` lines must include the test files a
todo's own TDD requirement implies, and must be traced through the real type
plumbing rather than assumed.

---

## Finding 3: "range has 10 commits, not 9"

Correct and immaterial. The count in the F4 prompt was written before the final
commits landed. The range is now 12 commits. No guardrail concerns commit count.

---

## What F4 correctly PASSED

Every substantive scope guardrail held, each proven by command:

- `run_in_background` default is still `false`; `.optional()` present, no `.default(true)`
- `tool-argument-preparation.ts` is byte-for-byte UNMODIFIED, so issue #4119's
  "omission must not throw" fix is fully intact
- the 30-minute inactivity window, `POLL_INTERVAL_MS`, and the 300-turn cap are
  untouched; the wall-clock bound is purely additive
- `call-omo-agent/` and `background-task/constants.ts` are unmodified
- `parent-wake-*` internals are unmodified
- no failing test was deleted or skipped
- the 4 pre-existing dirty build artifacts appear in ZERO commits
- commits are local-only, unpushed, no PR, no task worktree created

---

## Orchestrator verdict

**F4 downgraded from BLOCK to APPROVE-WITH-NOTES.** Finding 1 is not a violation
under the superseding criterion, which is satisfied with evidence. Finding 2 is a
genuine planning defect with zero behavioral impact, recorded here and in the ledger
rather than quietly dropped. No shipped behavior is affected by either.
