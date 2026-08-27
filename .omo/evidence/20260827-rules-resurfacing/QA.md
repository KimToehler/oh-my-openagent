WHAT WAS TESTED

- `bun test packages/omo-opencode/src/hooks/rules-injector/` exercises rule injection, compaction pin, real-path re-touch behavior, and real `tool.execute.after` hook boundary.
- `bun test packages/rules-engine/` verifies rules-engine regressions.
- `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json` checks adapter types.
- `git diff --check d1aa45f3d..HEAD` checks whitespace errors.
- Mutation proofs forced `shouldSurface` false, then true, while running injector and hook tests. False made positive real-path and hook tests fail. True made both within-gap negative tests fail. Each mutation was restored before next run.

WHAT WAS OBSERVED

- Original design was unreachable. `injection-processor.ts:195` adds injected rule `realPath` to `cache.realPaths`; later same-file touch reaches real-path dedupe at `:137` and continues before content-hash suppression at `:158`, where callback used to run.
- Green false pin at `injector.test.ts:626` asserted real-path suppression queued no reminder. It cemented broken behavior.
- 108 prior unit tests passed across defect because they tested store/callback routes without real hook real-path dedupe boundary.
- Permanent hook test drives `tool.execute.after` with disk-backed absolute paths, uses `RESURFACE_TOOL_CALL_GAP` untracked `bash` calls, then asserts bounded reminder includes rule path and imperative text but omits full frontmatter. It exposed defect before fix.
- Option B now checks real-path resurfacing at candidate-loop top. It parses and matches only when store says reminder is due. Existing real-path, content-hash, and transcript dedupe conditions retain semantics. Inject path still notes surfaced rule. Compaction reset still clears cache and re-injects full body.
- No live OpenCode session observed markers. macOS `/tmp` relative-symlink resolution made injector receive unresolvable path. This is QA-harness limitation, not feature evidence.

WHY IT IS ENOUGH

- Real hook-boundary test covers ordinary repeat-file route that false pin missed.
- Positive and negative mutation runs prove assertions reject permanently false and permanently true resurfacing decisions.
- Scoped unit, engine, type, and diff checks cover changed adapter behavior and compaction pin.

WHAT WAS OMITTED

- No live sandbox QA was attempted. Channel is deliberately closed by macOS `/tmp` relative-symlink defect.
- No secrets, environment dumps, provider tokens, authorization headers, or private session data recorded.
