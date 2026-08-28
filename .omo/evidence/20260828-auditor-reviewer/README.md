# Auditor reviewer QA evidence

## What was tested

- `bun test packages/omo-opencode/src/agents/auditor.test.ts packages/omo-opencode/src/agents/tool-restrictions.test.ts packages/model-core/src/model-requirements-invariants.test.ts packages/model-core/src/model-requirements-agents.test.ts`
  - Factory creates `auditor` as a subagent.
  - Permissions allow `read`, `grep`, and `glob`.
  - Permissions deny `write`, `edit`, `apply_patch`, `task`, and `call_omo_agent`.
  - Model-requirement invariant includes Auditor.
- `bun run build:schema`
  - Regenerated both committed JSON schemas from source configuration schemas.
- `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`
  - Checked OpenCode adapter types.
- `bash /Users/tim/git/oh-my-openagent/.agents/skills/opencode-qa/scripts/lib/common.sh --self-check`
  - Proved local QA helpers create and remove isolated XDG and HOME sandbox.
- `bash /Users/tim/git/oh-my-openagent/.agents/skills/opencode-qa/scripts/sse-hook-probe.sh --self-test`
  - Proved isolated OpenCode server SSE surface delivered `server.connected`.

## What was observed

- Targeted tests passed: `33 pass`, `0 fail`, `760 expect() calls`. Exact output: `targeted-tests.txt`.
- Schema generation completed for `assets/omo.schema.json` and `assets/oh-my-opencode.schema.json`.
- Scoped `tsgo` exited zero with no diagnostic output.
- QA helper reported isolated XDG sandbox removal and HOME containment.
- SSE probe reported `PASS: SSE /event opened and delivered server.connected`.
- Exact OpenCode QA output: `opencode-qa.txt`.

## Why this is enough

Factory and restriction tests prove Auditor has Oracle-class read-only file access plus explicit denial of all requested mutation and delegation tools. Model-core invariant proves fallback registration. Schema generation and typecheck prove built-in and override schemas compile. Isolated harness probes prove QA exercised OpenCode tooling without writing sessions or configuration into host paths.

## What was omitted

- No provider-backed prompt was sent because this change is static agent registration and permission policy, and no credentials or provider logs were required.
- No secrets, environment dumps, auth headers, or host configuration were captured.


## Oracle findings follow-up

### What was tested

- `bun test packages/shared-skills/review-work-auditor-lane.test.ts packages/omo-opencode/src/agents/builtin-agent-registration.test.ts packages/omo-opencode/src/agents/auditor.test.ts packages/omo-opencode/src/agents/tool-restrictions.test.ts packages/model-core/src/model-requirements-invariants.test.ts`
  - Auditor child receives full code-quality review body.
  - Every built-in agent is present in runtime fallback, team eligibility, migration, and model registries.
  - Read-only agents have task denial and hard team rejection.
  - Auditor's default chain starts with Claude Opus 5.
- `bun test packages/omo-opencode/src/tools/delegate-task/ packages/omo-opencode/src/plugin-handlers/ packages/team-core/src/`
  - Delegate-task, plugin tool configuration, and team parsing suites.
- `bun run build:schema`
  - Regenerated both schema artifacts after built-in agent schema changes.
- `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`
  - Checked adapter types.

### What was observed

- Focused suite: `23 pass`, `0 fail`, `736 expect() calls`.
- Requested scoped suite: `891 pass`, `1 skip`, `0 fail`, `2117 expect() calls`.
- Schema command completed: `✓ JSON Schemas generated: assets/omo.schema.json, assets/oh-my-opencode.schema.json`.
- `tsgo` exited zero with no diagnostics.
- Exact verification transcript: `oracle-findings-verification.txt`.

### Why this is enough

The Auditor invocation now contains the full code-quality payload rather than an unresolved cross-prompt reference. Registration-completeness test locks built-in parity across every requested registry and read-only tool-denial paths. Model assertion locks Claude-first default against Oracle's GPT-first chain.

### What was omitted

No provider request was made. Validation uses static agent registration, permission, model-resolution data, and isolated harness evidence only.


## Re-review minor findings follow-up

### What was tested

- Grep over all seven requested documentation and AGENTS paths verified the changed agent-count occurrences are now `12`, and `BuiltinAgentNameSchema` enumerates `auditor`.
- `bun test packages/omo-opencode/src/agents packages/team-core packages/model-core packages/utils/src/migration`
  - Verifies agent factory, display-name, team, model, and migration behavior.
- `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`
  - Checks adapter types.

### What was observed

- All requested count locations report `12`; exact grep output is in `minor-findings-verification.txt`.
- Targeted suite: `938 pass`, `1 skip`, `0 fail`, `2878 expect() calls`.
- `tsgo` exited zero with no diagnostics.

### Why this is enough

The count scan verifies only requested stale count locations were changed. Agent display-name suite locks Auditor's config-key identity and exact display-name map. Targeted packages cover all registration subsystems touched by Auditor.

### What was omitted

No generated assets changed and no live provider call was required for documentation and display-name registry corrections.
