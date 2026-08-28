# Static model-family QA

## What was tested

- `bash .agents/skills/opencode-qa/scripts/lib/common.sh --self-check`
  - Validated OpenCode QA dependencies and XDG/HOME isolation helper.
- `source script/agent/qa-sandbox.sh && cd "$OMO_QA_PROJ" && opencode --version && bun test ...`
  - Drove installed OpenCode CLI in an isolated HOME/XDG/CODEX sandbox.
  - Executed schema acceptance/rejection and static startup routing tests from task worktree while sandboxed.
- Targeted normal-environment test suite:
  - `bun test packages/omo-opencode/src/config/schema.test.ts packages/model-core/src/model-family-detectors.test.ts packages/omo-opencode/src/agents/gpt-shared-prompt-identity.test.ts packages/omo-opencode/src/plugin-handlers/config-handler.test.ts`
- Scoped package typechecks:
  - `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`
  - `bunx tsgo --noEmit -p packages/model-core/tsconfig.json`

## What was observed

- QA helper self-check passed. It created and removed an isolated XDG sandbox and verified isolated HOME.
- Sandbox path was `/var/folders/c6/rmmgm5s52vsc2_g434mnp_nm0000gn/T/omo-qa-sandbox.XXXXXX.y74jSvheXS`; `HOME` and `OMO_QA_PROJ` both resolved below it.
- Installed CLI reported `1.18.20` in sandbox.
- Sandbox test run passed: `105 pass`, `0 fail`, `266 expect() calls`.
- Targeted suite passed: `157 pass`, `0 fail`, `388 expect() calls`.
- Scoped model-core and omo-opencode typechecks passed with no output.

## Why this is enough

- Schema tests prove explicit architecture acceptance and invalid architecture rejection.
- Model-core tests prove explicit static-family mapping and omitted-family preservation.
- GPT identity test proves static architecture routing wins over proxy model text at startup.
- Configuration-handler coverage protects startup registration behavior. Static resolver runs only while building startup agent configs; no response-time observer or roster mutation was added.
- Isolated OpenCode CLI execution proves sandbox isolation and real harness availability without touching user HOME/XDG config.

## Regression correction proof

- Hephaestus red:

```text
$ bun test packages/omo-opencode/src/agents/hephaestus/gpt-5-6-registration.test.ts
...
Expected: "proxy/primary"
Received: undefined

 7 pass
 1 fail
 32 expect() calls
Ran 8 tests across 1 file. [62.00ms]
```

- Sisyphus red:

```text
$ bun test packages/omo-opencode/src/plugin/sisyphus-runtime-prompt-reconciler.test.ts
...
error: expect(received).toEqual(expected)
...
- You are Sisyphus, an orchestration agent based on GPT-5.5.
+ <Role>
+ You are "Sisyphus" - Powerful AI Agent with orchestration capabilities from OhMyOpenCode.
```

- Correction green:

```text
$ bun test packages/omo-opencode/src/config/schema.test.ts packages/model-core/src/model-family-detectors.test.ts packages/omo-opencode/src/agents/gpt-shared-prompt-identity.test.ts packages/omo-opencode/src/plugin-handlers/config-handler.test.ts packages/omo-opencode/src/agents/hephaestus/gpt-5-6-registration.test.ts packages/omo-opencode/src/plugin/sisyphus-runtime-prompt-reconciler.test.ts && bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json && bunx tsgo --noEmit -p packages/model-core/tsconfig.json

bun test v1.4.0 (1381054db)

 166 pass
 0 fail
 422 expect() calls
Ran 166 tests across 6 files. [212.00ms]
```

- Hephaestus now uses static architecture for support checks and factory prompt selection while restoring `AgentConfig.model` to configured alias.
- `createSystemTransformHandler()` no longer invokes runtime Sisyphus prompt reconciliation. Startup prompt remains immutable when response model differs.

## Frontier tool-schema correction proof

- Red:

```text
$ bun test packages/omo-opencode/src/agents/builtin-agents/sisyphus-agent.test.ts packages/omo-opencode/src/agents/hephaestus/gpt-5-6-registration.test.ts
...
Expected path: "grep"
Expected value: "deny"
Unable to find property
...
 16 pass
 2 fail
 57 expect() calls
Ran 18 tests across 2 files. [69.00ms]
```

- Green:

```text
$ bun test packages/omo-opencode/src/config/schema.test.ts packages/model-core/src/model-family-detectors.test.ts packages/omo-opencode/src/agents/gpt-shared-prompt-identity.test.ts packages/omo-opencode/src/plugin-handlers/config-handler.test.ts packages/omo-opencode/src/agents/hephaestus/gpt-5-6-registration.test.ts packages/omo-opencode/src/plugin/sisyphus-runtime-prompt-reconciler.test.ts packages/omo-opencode/src/agents/builtin-agents/sisyphus-agent.test.ts && bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json && bunx tsgo --noEmit -p packages/model-core/tsconfig.json

bun test v1.4.0 (1381054db)

 176 pass
 0 fail
 448 expect() calls
Ran 176 tests across 7 files. [198.00ms]
```

- Explicit `model_family` now selects static architecture for Sisyphus and Hephaestus frontier `grep` and `glob` restrictions. Their `AgentConfig.model` fields still retain configured transport aliases. Without explicit `model_family`, existing post-override model behavior remains unchanged.

## What was omitted

- No provider-backed prompt was sent because this feature changes startup configuration routing and no credentials are needed for its tests. No secrets, environment dumps, auth headers, or host config contents recorded.
- LSP diagnostics could not initialize: workspace TypeScript installation was unavailable to LSP. Scoped `bunx tsgo` checks passed instead.
