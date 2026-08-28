# review-work: size gate, gate composition, cross-engine lane assignment

Change: prose-only edit to `packages/shared-skills/skills/review-work/SKILL.md`
(1 tracked file, +174/-7). No `src/` change, no runtime behavior change.

## What was tested

1. **Propagation to both generated copies.** The Senpi and Codex plugin copies
   of this skill are generated, not hand-maintained. Regenerated both and
   confirmed the four new sections landed in all three files.
   - `node packages/omo-senpi/plugin/scripts/sync-skills.mjs`
   - `npm run --prefix packages/omo-codex/plugin sync:skills`
2. **Codex overlay preservation.** `sync-skills.mjs:198-199` injects a
   Codex-only blocking-gate overlay into this skill, anchored on a body sentence
   the edit had to leave intact. Verified the overlay is still applied after
   regeneration.
3. **Drift gate.** `test/sync-skills.test.mjs` "generated copies have no
   hand-authored drift" - the test that would catch a stale or hand-edited
   generated copy.
4. **Senpi sync suite.** `bun test packages/omo-senpi/src/skills-sync.test.ts`.
5. **Packaging suite.** `bun test packages/shared-skills` (frontmatter parses,
   packaging entries intact).

## What was observed

- All three copies report `sections=4` (When to use / Relationship to other
  gates / Cross-engine lane assignment / Reconciling findings). See
  `propagation.txt`.
- Codex gate overlay still present after regeneration (count 1).
- Lane 4 promoted SUB -> MAIN consistently in all three copies, matching the new
  claim that review-work IS the security lane.
- `bun test packages/omo-senpi/src/skills-sync.test.ts` - 11 pass, 0 fail.
- `bun test packages/shared-skills` + packaging - 73 pass, 1 fail.
- Codex sync suites - 32 pass, 1 fail, including a PASS on "generated copies
  have no hand-authored drift".
- Both generated copies are gitignored build artifacts
  (`packages/omo-senpi/.gitignore:2`, `.gitignore:15`) and untracked by git, so
  the commit is one tracked file.

## Pre-existing failures, not caused by this change

Both failures are the same root cause: this worktree has uninitialized git
submodules under `packages/shared-skills/upstreams/`, so the third-party
frontend references are not materialized.

- `provenance-gate.test.ts` "each ATTRIBUTION pin equals the live submodule
  HEAD" - submodule status shows all four upstreams unpopulated (leading `-`).
  The same test passes in the main checkout (5 pass, 0 fail), confirming it is
  environmental.
- `sync-skills.test.mjs` "nested SKILL.md files are not packaged" - ENOENT on
  `skills/frontend/references/designpowers/vendor/skills`, a path that only
  exists after materialization.

The remaining `npm test` failures in the Codex plugin package all reference
built dist CLIs and fail because the worktree was never built.

## Harness defect found while running this QA

`packages/omo-codex/plugin/scripts/sync-skills.mjs` resolves its source through
`sharedSkillsRootPath()` (package resolution) while the Senpi script resolves
path-relatively. Run from a git worktree with no `node_modules`, the Codex
script's probe walks out of the worktree and silently reads the MAIN checkout's
shared skills, then writes the result into the worktree. The output looks
plausible and is wrong: the first regeneration attempt here produced a Codex
copy with none of the edits and a fresh mtime.

Worked around by symlinking `node_modules/@oh-my-opencode/shared-skills` into
the worktree before regenerating, then verifying the resolved path, then
removing the symlink. Logged for the findings file separately.

## What is not covered

No live-harness QA run: this change ships no code, only skill prose that a model
reads. Per `packages/shared-skills/AGENTS.md`, skill body wording is explicitly
not pinned by tests, so no new test accompanies it.

## Omitted

No secrets, tokens, credentials, or env dumps were produced by these commands;
nothing required redaction.
