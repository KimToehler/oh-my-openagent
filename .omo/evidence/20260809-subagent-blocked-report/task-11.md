# Todo 11 Evidence

## WHAT WAS TESTED

- `bun test packages/omo-opencode/src/config/schema/background-task-defaults.test.ts` before implementation and after implementation.
- Temporary `DEFAULT_BLOCKED_EXPIRY_MS = 1_800_000` collision regression.
- `bun run build:schema` and `git diff --stat assets/`.
- `bun run typecheck`.

## WHAT WAS OBSERVED

### Initial RED

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/config/schema/background-task-defaults.test.ts:

# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'DEFAULT_BLOCKED_EXPIRY_MS' not found in module '/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/features/background-agent/constants.ts'.
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [85.00ms]
```

### GREEN

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/config/schema/background-task-defaults.test.ts:
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for staleTimeoutMs matches runtime constant [0.55ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for messageStalenessTimeoutMs matches runtime constant [0.06ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for maxToolCalls matches runtime constant [0.04ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for blockedRewakeMs matches runtime constant [0.04ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for blockedExpiryMs matches runtime constant [0.03ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then blocked expiry remains strictly below terminal task TTL [0.04ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then schema rejects blocked rewake at or after expiry [0.70ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then schema rejects blocked expiry at or after terminal task TTL [0.08ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then BackgroundTaskStatus has no new 'blocked' member [0.04ms]

 9 pass
 0 fail
 12 expect() calls
Ran 9 tests across 1 file. [154.00ms]
```

### Deliberate collision RED

```text
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/config/schema/background-task-defaults.test.ts:
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for staleTimeoutMs matches runtime constant [0.47ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for messageStalenessTimeoutMs matches runtime constant [0.06ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for maxToolCalls matches runtime constant [0.09ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for blockedRewakeMs matches runtime constant [0.04ms]
82 |         // when
83 |         const defaultMatch = (innerSchema.description || "").match(/default:\s*(\d+)/)
84 |         const documentedDefault = defaultMatch ? parseInt(defaultMatch[1], 10) : null
85 | 
86 |         // then
87 |         expect(documentedDefault).toBe(DEFAULT_BLOCKED_EXPIRY_MS)
                                       ^
error: expect(received).toBe(expected)

Expected: 1800000
Received: 1200000

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/config/schema/background-task-defaults.test.ts:87:35)
(fail) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for blockedExpiryMs matches runtime constant [4.71ms]
93 | 
94 |         // when
95 |         const blockedExpiryMs = DEFAULT_BLOCKED_EXPIRY_MS
96 | 
97 |         // then
98 |         expect(blockedExpiryMs).toBeLessThan(
                                     ^
error: expect(received).toBeLessThan(expected)

Expected: < 1800000
Received: 1800000

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report/packages/omo-opencode/src/config/schema/background-task-defaults.test.ts:98:33)
(fail) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then blocked expiry remains strictly below terminal task TTL [0.27ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then schema rejects blocked rewake at or after expiry [0.63ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then schema rejects blocked expiry at or after terminal task TTL [0.07ms]
(pass) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then BackgroundTaskStatus has no new 'blocked' member [0.04ms]

 7 pass
 2 fail
 12 expect() calls
Ran 9 tests across 1 file. [79.00ms]
```

### Schema generation

```text
$ bun run script/build-schema.ts
Generating JSON Schemas...
✓ JSON Schemas generated: assets/omo.schema.json, assets/oh-my-opencode.schema.json
 assets/oh-my-opencode.schema.json | 10 ++++++++++
 assets/omo.schema.json            | 20 ++++++++++++++++++++
 2 files changed, 30 insertions(+)
```

### Typecheck

```text
$ tsgo --noEmit && bun run typecheck:script && bun run typecheck:packages
$ tsgo --noEmit -p script/tsconfig.json
$ tsgo --noEmit -p packages/rules-engine/tsconfig.json && tsgo --noEmit -p packages/delegate-core/tsconfig.json && tsgo --noEmit -p packages/mcp-stdio-core/tsconfig.json && tsgo --noEmit -p packages/mcp-client-core/tsconfig.json && tsgo --noEmit -p packages/git-bash-mcp/tsconfig.json && tsgo --noEmit -p packages/lsp-core/tsconfig.json && tsgo --noEmit -p packages/utils/tsconfig.json && tsgo --noEmit -p packages/model-core/tsconfig.json && tsgo --noEmit -p packages/omo-config-core/tsconfig.json && tsgo --noEmit -p packages/prompts-core/tsconfig.json && tsgo --noEmit -p packages/comment-checker-core/tsconfig.json && tsgo --noEmit -p packages/hashline-core/tsconfig.json && tsgo --noEmit -p packages/tmux-core/tsconfig.json && tsgo --noEmit -p packages/team-core/tsconfig.json && tsgo --noEmit -p packages/openclaw-core/tsconfig.json && tsgo --noEmit -p packages/boulder-state/tsconfig.json && tsgo --noEmit -p packages/telemetry-core/tsconfig.json && tsgo --noEmit -p packages/claude-code-compat-core/tsconfig.json && tsgo --noEmit -p packages/skills-loader-core/tsconfig.json && tsgo --noEmit -p packages/agents-md-core/tsconfig.json && tsgo --noEmit -p packages/omo-codex/plugin/shared/tsconfig.json && tsgo --noEmit -p packages/omo-codex/tsconfig.json && tsgo --noEmit -p packages/omo-senpi/tsconfig.json && tsgo --noEmit -p packages/senpi-task/tsconfig.json && tsgo --noEmit -p packages/pi-goal/tsconfig.json && tsgo --noEmit -p packages/pi-webfetch/tsconfig.json && tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

### LSP diagnostics

```text
Request initialize failed with message: Could not find a valid TypeScript installation. Please ensure that the "typescript" dependency is installed in the workspace or that a valid `tsserver.path` is specified. Exiting.
```

## WHY IT IS ENOUGH

Tests pin description defaults to runtime constants, both ordering invariants, and exact terminal TTL collision. Generated schemas contain both knobs. Full typecheck exits 0. Deliberate 30-minute value fails before terminal purge can become timing-dependent.

## WHAT WAS OMITTED

No secret-bearing logs or environment dumps captured. LSP server could not initialize; successful repo typecheck supplies compiler verification. Schema generation dirtied only two required asset files, so no extra generated files required reverting.
