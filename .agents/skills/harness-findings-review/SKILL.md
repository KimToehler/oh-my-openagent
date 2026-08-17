---
name: harness-findings-review
description: "Use when asked to review, triage, re-verify, or act on the harness findings log at docs/troubleshooting/harness-findings.md - including when entries may be stale, when a finding's fix status is untrusted, or when deciding which harness defects to fix next. Triggers: 'review the findings', 'triage harness findings', 'are the findings still accurate', 'what harness defects are still open', 'harness-findings-review', 'findings review'."
---

# Harness Findings Review

The capture rule (`~/.omo/rules/harness-findings.md`) makes agents *write* findings. Nothing
makes anyone *read them back*. This is the read side.

**Core principle: a stale `unfixed` entry is worse than no entry.** It is exactly the
artifact the next agent trusts, and it sends them to re-diagnose a solved problem. Entries
rot at the speed the harness is fixed, which is fast — the first review of this log found
three of five entries already stale within hours of being written.

## Manual invocation only

Run when a human asks. Do NOT wire this into `/publish`, `/pre-publish-review`, a hook, or
any session-start path. A verification pass spawns one agent per entry and appends to a
tracked file; that is not something to do behind the user's back.

If you notice stale entries while doing other work, say so and offer this skill. Do not run
it uninvited.

## The log

`docs/troubleshooting/harness-findings.md` in `~/git/oh-my-openagent` (tracked).

## Workflow

### 1. Inventory

Read the log's headings only — do not load all entries into context:

```bash
grep -n "^## 20\|^\*\*Severity:\|^\*\*Fix status" docs/troubleshooting/harness-findings.md
```

Build a table: entry title, current severity, current fix status, line range. Skip entries
already marked `fixed in <sha>` **unless** the user asked for a full re-verification —
those are settled.

### 2. Dispatch one verifier per entry

One background `explore` per entry, all in parallel. Each verifier gets the entry text and
must answer with evidence, not opinion.

Required in every verifier prompt:

- The full entry, quoted.
- The specific claims to check, enumerated. Not "verify this entry" — list the mechanisms.
- **Output contract: every conclusion carries a `file:line` or a commit SHA.** A conclusion
  without a citation is not a conclusion.
- **Explicit permission to say "I could not confirm this."** Verifiers that feel obliged to
  return a verdict will invent one.
- `Do NOT edit any file.` Verification is read-only.

Ask each verifier to check both directions:

- Is the described mechanism still present in source? (finding still open)
- Is there a commit, test, or code path that closes it? (finding fixed)

Searching only for the defect finds the defect. Searching only for the fix finds the fix.

### 3. Cross-check every "still open" verdict — MANDATORY

**A single verifier's "still open" is not a verdict. Confirm it yourself before writing it
down.**

This step exists because it has already failed in practice. On the first review pass, a
verifier reported a mid-batch parent-wake defect as fully open, having checked
`shouldForceDispatchAfterActiveDefer` and found it still gated on `shouldReply`. Correct,
cited — and wrong. A *second* ceiling
(`PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS`) had been added elsewhere in the same
file, with a nine-test suite pinning it. The finding was half-fixed, not open.

The failure mode is structural, not careless: an agent asked "is X still broken?" searches
for X's mechanism, finds it, and stops. It never asks whether something *else* now
compensates.

Before accepting "still open":

- Check for a sibling mechanism in the same file — a second ceiling, guard, fallback, or
  retry path.
- Look for test files named after the defect. A test file named for the symptom usually
  means someone fixed the symptom. `ls` the directory and read the `#given` lines.
- Run `git log --oneline -- <the file>` and read the subject lines. A fix commit naming the
  defect outranks a source read that missed it.

If any of those turn up something the verifier did not address, re-verify that point
yourself before writing.

### 4. Append, never rewrite

Every result becomes an `**Update:** (YYYY-MM-DD, verified against <branch> source)` line
appended to the existing entry. The original text stays exactly as written — the history of
what we believed and when is the point.

This applies to entries that turn out to be **wrong**, not just outdated. When a diagnosis
is retracted, say so plainly and say what the real cause was. Do not quietly soften it.

Four outcomes, each with its own shape:

| Outcome | What the Update says |
|---|---|
| Fixed | What closed it, the SHA, the `file:line` of the current code, and the test that pins it. |
| Still open | Confirmation at `file:line` that the mechanism is unchanged, plus what you cross-checked to be sure. |
| Partially fixed | Which half closed and which half did not — separately, each cited. Then revise the fix status to `partially fixed`. |
| Diagnosis wrong | Retract the claim explicitly, give the real cause with evidence, and revise the fix status with `(revised)`. |

Then revise the `**Fix status:**` line — by appending a new one, not editing the old.

### 5. Re-score severity

Original severity was assigned in the heat of being blocked. Re-score against what is now
known:

- A `blocker` with a documented workaround that reliably works is `costly`.
- A `costly` that has recurred across three repos is a `blocker` — recurrence outranks the
  original guess.
- Anything whose real fix is wording in an instruction file is `docs-gap`, no matter how
  much time it burned.
- A finding whose mechanism is confirmed fixed keeps its original severity in the heading;
  the Update carries the resolution. Do not rewrite history to look calmer than it was.

### 6. Report, then route

Report to the user: what is now fixed, what is still open ranked by severity, and what
changed its mind. Keep it to a screen.

Then propose the top open findings as work — `ulw-plan` for anything needing design, or
`work-with-pr` directly for a contained fix. **Propose, do not start.** The user asked for
a review; implementation is a separate decision.

### 7. Commit the log alone

Per the capture rule, by explicit path, on its own:

```bash
git add docs/troubleshooting/harness-findings.md
git commit -m "docs(findings): verify entries against <branch> and record <what changed>"
```

Never `git add -A` — the harness repo usually has unrelated work in progress.

## Quick reference

| Step | Output |
|---|---|
| Inventory | Table of entries: title, severity, status, lines |
| Dispatch | 1 background `explore` per entry, parallel, read-only |
| Cross-check | Every "still open" independently confirmed |
| Append | `**Update:**` lines, original text untouched |
| Re-score | Severity by recurrence, not by original guess |
| Route | Propose top findings to `ulw-plan` / `work-with-pr` |
| Commit | One file, explicit path |

## Common mistakes

**Trusting a cited conclusion.** Citations prove the agent read *something*. They do not
prove it read *enough*. Cross-check the verdict, not the quote.

**Editing an entry instead of appending.** The log is append-only by rule. A tidied log
loses the record of what was believed and when, which is most of its value.

**Marking something fixed because a commit message says so.** Read the code. Commit
subjects describe intent, and intent misses.

**Batch-verifying several entries in one agent.** Each entry needs its own search strategy;
one agent handling five will do the first properly and skim the rest.

**Running this automatically.** See the manual-invocation section. It writes to a tracked
file.

**Starting the fixes.** Review ends at a proposal. Implementation is the user's call.
