# OpenCode bundled rules migration QA

## Scope

Six migration defects were reviewed: C1 containment, C2 canonical real paths, H3 ordering, M4(i) GitHub instruction filtering, M4(ii) Sisyphus compatibility, M4(iii) nested `CONTEXT.md`, and M5 plugin-root discovery.

## Defect record

### C1: project containment

- Red: project `.omo/rules` symlink could point outside project root; external rule content was candidate input.
- Green: `safeRealpathSync()` resolves root and candidate paths. `isSameOrChildPath()` rejects non-global escaped candidates. Regression: `#given external project rule symlink #when matching target file #then does not inject escaped content`.

### C2: canonical real paths

- Red: candidate paths used non-canonical aliases, breaking real-path duplicate identity across macOS `/var` and `/private/var`.
- Green: OpenCode adapter derives candidate `realPath` via `safeRealpathSync()` before duplicate handling. Existing scanner behavior was restored to `dev`; no shared scanner change remains in this migration.

### H3: source priority before content-hash dedupe

- Red:

```text
$ bun test packages/omo-opencode/src/hooks/rules-injector/injector.test.ts

bun test v1.4.0 (1381054db)

--- stderr ---

packages/omo-opencode/src/hooks/rules-injector/injector.test.ts:
844 | 		// when
845 | 		const output = createOutput();
846 | 		await processor.processFilePathForInjection(targetFile, "session-1", output);
847 | 
848 | 		// then
849 | 		expect(output.output).toContain("[Rule: .omo/rules/shared.md]");
                              ^
error: expect(received).toContain(expected)

Expected to contain: "[Rule: .omo/rules/shared.md]"
Received: "\n\n[Rule: bundled-rules/shared.md]\n[Match: alwaysApply]\nShared rule content.\n"

      at <anonymous> (/Users/tim/git/oh-my-openagent/.worktrees/opencode-bundled-rules/packages/omo-opencode/src/hooks/rules-injector/injector.test.ts:849:25)
(fail) createRuleInjectionProcessor > #given same-content user and bundled rules #when injecting #then user-home rule wins [1.78ms]

 23 pass
 1 fail
 35 expect() calls
Ran 24 tests across 1 file. [104.00ms]

[exit:1]
```

- Green: adapter wraps `findRuleCandidates(...)` in shared `sortCandidates(...)`. Test proves `~/.omo/rules` source priority 100 wins over `plugin-bundled` priority 200 before first-wins content-hash dedupe.

### M4(i): GitHub instruction suffix filtering

- Red: migration discovery admitted arbitrary files in `.github/instructions`.
- Green: adapter retains `GITHUB_INSTRUCTIONS_PATTERN` filter. Prior worker verified regression coverage; no rerun in this continuation.

### M4(ii): Sisyphus rules compatibility

- Deliberate behavior drop: engine candidate discovery cannot express `.sisyphus/rules`, while OpenCode adapter now consumes candidates rather than legacy `findRuleFiles`. Adapter-side `setSisyphusRuleDeprecationLogger(log)` could never observe candidates and was dead wiring. Removed it explicitly. `.sisyphus/rules` discovery and deprecation warning are not preserved by this adapter path.
- Green: `bun test packages/omo-opencode/src/hooks/rules-injector/rule-scan-cache.test.ts` passed after removal, proving legacy finder cache consumers remain valid.

### M4(iii): nested CONTEXT.md

- New behavior retained deliberately. Engine scans `CONTEXT.md` at each path base between target file and project root.
- Green: `#given a nested CONTEXT.md #when injecting for a child file #then injects nested context rule` asserts injected output identifies `src/CONTEXT.md`.

### M5: plugin-bundled root

- Red: OpenCode adapter had no explicit plugin-root handoff for bundled-rule discovery.
- Green: adapter passes `pluginRoot` to `findRuleCandidates`. `#given an explicit OpenCode plugin root #when bundled rule matches #then injects bundled rule` proves fixture-bundled discovery without shipping assets.

## Gate output

```text
$ bun test packages/omo-opencode/src/hooks/rules-injector/ packages/rules-engine/src/engine/

bun test v1.4.0 (1381054db)

 133 pass
 0 fail
 227 expect() calls
Ran 133 tests across 22 files. [151.00ms]
```

```text
$ npm --prefix packages/omo-codex/plugin/components/rules test

> @code-yeongyu/codex-rules@5.0.0-beta.7 test
> npm run build --silent && vitest --run --no-file-parallelism

Bundled 51 modules in 8ms

  cli.js  155.41 KB  (entry point)


 RUN  v4.1.8 /Users/tim/git/oh-my-openagent/.worktrees/opencode-bundled-rules/packages/omo-codex/plugin/components/rules


 Test Files  30 passed (30)
      Tests  168 passed (168)
   Start at  21:55:52
   Duration  2.22s (transform 114ms, setup 0ms, import 389ms, tests 811ms, environment 1ms)
```

```text
$ bun run build
...
build: all steps completed

$ bun run script/build.ts
```

```text
$ bunx tsc --emitDeclarationOnly
```

Exit status: `0`. No compiler output.

## Why enough

H3 has observed red and green evidence. Scoped OpenCode suite covers adapter discovery, matching, caching, containment, output and H3/M4(iii)/M5 fixtures. Codex rules suite remains 30/30 files and 168 tests. Full build and declaration emit pass. Generated Codex and Senpi artifacts were restored after build.

## Omitted

No live model prompt. No bundled production rule asset ships. No credentials, auth headers, provider configuration or private environment data recorded.
