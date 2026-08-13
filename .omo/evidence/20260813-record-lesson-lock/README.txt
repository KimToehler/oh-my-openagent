WHAT WAS TESTED
bun test packages/omo-opencode/src/tools/record-lesson/ packages/omo-opencode/src/config/schema/lessons.test.ts
bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
bash .agents/skills/opencode-qa/scripts/lib/common.sh --self-check

WHAT WAS OBSERVED
101 tests passed, 0 failed, 173 assertions across 8 files. Targeted omo-opencode tsgo emitted no errors. OpenCode QA common self-check passed and proved isolated XDG sandbox cleanup.

WHY IT IS ENOUGH
Unit tests cover configured-directory rejection, HOME and OMO_LESSONS_DIR resolution, exclusive lock retry ordering, lock cleanup on failure, dedup, cap, containment, and lesson id invariants. Targeted typecheck covers changed adapter package. QA self-check covers harness isolation without writing real OpenCode sessions.

WHAT WAS OMITTED
No provider-backed OpenCode prompt was run because record_lesson is disabled by default and behavior is fully dependency-injected at tool boundary. No secrets or environment dumps captured.
