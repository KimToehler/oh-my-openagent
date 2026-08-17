## What changed

Adds `harness-findings-review`, a **manual-invocation** skill that reviews and re-verifies
the harness findings log at `docs/troubleshooting/harness-findings.md`, and registers it in
`docs/AGENTS.md`.

## Why

The capture rule (`~/.omo/rules/harness-findings.md`) makes agents *write* findings. Nothing
made anyone *read them back*. The first review of that log found **three of five entries
already stale within hours of being written**:

- `<unpolled-background-shell-jobs>` "fires once, then stops" — diagnosis was wrong. The hook
  re-fires on every `session.idle` (`hook.ts:84-91`); the real defect was MCP tool results
  arriving with the payload in `content[]`, so jobs were never tracked at start. Already
  fixed on `dev` in `b9b0a8b5c` + `8810f3174` when the finding was written.
- Mid-batch parent-wake starvation — half fixed, and nobody knew.
- Two background-task entries confirmed genuinely still open.

A stale `unfixed` entry is worse than no entry: it is exactly the artifact the next agent
trusts, and it sends them to re-diagnose a solved problem.

## The load-bearing part: mandatory cross-check

During the review that motivated this skill, a verification agent reported the mid-batch
wake defect as fully open. It had checked `shouldForceDispatchAfterActiveDefer`, found it
still gated on `shouldReply`, and cited the line correctly — but a *second* ceiling
(`PENDING_PARENT_WAKE_MAX_RETAINED_ADMIT_DEFER_MS`, `parent-wake-flush-runner.ts:28`) had
been added elsewhere in the same file, pinned by a nine-test suite. The finding was
half-fixed, not open.

The failure is structural, not careless: an agent asked "is X still broken?" searches for X's
mechanism, finds it, and stops — it never asks whether something else now compensates. The
skill therefore **blocks a "still open" verdict from a single agent** and requires three
concrete counters (sibling mechanisms in the same file, test files named after the symptom,
`git log` subjects for that file).

Generalized in the skill as: *verify conclusions, not just citations.*

## Design decisions

- **Manual only.** Explicitly not wired into `/publish`, `/pre-publish-review`, a hook, or
  session start — it spawns one agent per entry and writes a tracked file. Requested by the
  user as manual after being offered manual / release-gated / both.
- **Append-only, including for retractions.** Matches the existing capture rule. A wrong
  diagnosis gets an explicit retraction, not a quiet softening.
- **Ends at a proposal.** Review does not start implementation; routing to `ulw-plan` /
  `work-with-pr` is the user's call.
- **Description is trigger-only.** Per `writing-skills`, a description that summarizes
  workflow gets followed *instead of* the skill body.

## QA / evidence

`.omo/evidence/20260817-harness-findings-review/`

Docs/skill-only change — no hook, tool, agent, config schema, or MCP is touched, so no
lifecycle event exists to assert on the wire. The real risk surface is discovery and parse,
driven end-to-end against the actual loader (`discoverProjectAgentsSkills`,
`skills-loader-core/.../loader.ts:173`) with a negative control:

| Root | Skills found | Present |
|---|---|---|
| main checkout (control) | 13 | no |
| worktree | 14 | **yes** |

Body parsed at 7643 chars; the three load-bearing rules (mandatory cross-check, manual-only,
append-never-rewrite) asserted present in the parsed output. Frontmatter 482 chars, under the
1024 limit, exactly two keys.

Two probe defects were found and corrected during QA (reading `skill.description` instead of
`definition.description`; calling `lazyContent` as a function when it is an object) — both
recorded in the evidence, since the first would have produced a false negative.

`opencode-qa` / `codex-qa` not run: `git diff --name-only dev...HEAD` shows only
`.agents/skills/` and `docs/` paths, nothing under `packages/omo-opencode/` or
`packages/omo-codex/`.

## Note for the merger

Per repo policy: **merge commit** (`gh pr merge --merge --delete-branch`), never squash or
rebase.

The findings-log verification itself is already on `dev` as `0fe5b8ad2`, committed separately
by explicit path per the capture rule — it is deliberately not part of this PR.
