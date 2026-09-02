# parallel-worktree-safety — evidence bundle

## What was built
User-global overrides + global rule to stop Atlas start-work from racing parallel
subagents in one shared git worktree. Ships as HOME config (no repo commits):
- ~/.config/opencode/skills/start-work/SKILL.md  (verbatim + A/B/D blocks)
- ~/.config/opencode/skills/ulw-plan/            (verbatim + required Files: field)
- ~/.omo/rules/worktree-parallel-safety.md       (global A/B/D rule, ungated)
- ~/.agents/skills/port-agent-skills/SKILL.md    (registers the override pairs for re-sync)

## Design (user-locked)
- B-schema: ulw-plan todos carry a required `Files:` line -> start-work serializes lanes with intersecting file-sets (deterministic; inference fallback when absent).
- Hard-gate the net: D (commit hygiene) unconditional; A (per-lane worktree) hard on HEAVY 2+-lane waves; B deterministic via Files:.
- Self-contained text in each consumer (works even if rule injection off).

## Verified (this session)
- T3 start-work: verbatim-base CLEAN (perl ABD-strip diff empty vs shipped @388e5f7fe), 3 ABD blocks, frontmatter intact.
- T4 ulw-plan: verbatim-base CLEAN on SKILL.md + full-workflow.md (double-space strip artifact FIXED post-hoc), Files: field present (5 hits), intent-*/openai.yaml byte-identical, node --check OK, scaffold smoke emits Files:.
- T5 rule: 35 lines, globs "**/*" ungated, D/B/A present.
- T6 port-agent-skills: additions-only (0 deletions, 9 additions), both pairs registered, backup kept.
- Loader-precedence: discoverAllSkills() resolves BOTH names to the override paths at scope=opencode -> override shadows shipped (see loader-precedence.txt).
- QA harness: assert-dispatch --self-test PASS (flags git add -A, same-burst overlap, out-of-scope commit); isolation proven (real opencode.db 681==681).

## NOT done (honest)
- Live dispatch-behavior proof (override actually serializes overlapping lanes in a real run):
  BLOCKED in sandbox because onara/* provider does not resolve headless. Harness is READY;
  proof must run either against a headless-resolvable model or by dogfooding on a real onara start-work session.
- Deferred: upstream reference edit to packages/shared-skills (start-work + ulw-plan + Codex dual copy) via work-with-pr. The FORK-ADAPTATION header names base @388e5f7fe as the re-sync anchor until then.

## Omitted from artifacts
- No provider tokens/secrets captured. Isolation env sourced but not dumped.
