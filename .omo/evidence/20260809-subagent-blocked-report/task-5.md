# Task 5 Evidence: Fix Three Background-Task Default Documentation Drifts

## WHAT WAS TESTED

**Test file**: `packages/omo-opencode/src/config/schema/background-task-defaults.test.ts`

Created a new drift-guard test that reads both runtime constants and schema documentation to detect when JSDoc prose diverges from actual values. The test extracts numeric defaults from Zod schema `.describe()` fields and compares them to their runtime counterparts.

**Commands run**:
```bash
# RED - before fixes (proves test catches the drift)
bun test packages/omo-opencode/src/config/schema/background-task-defaults.test.ts

# GREEN - after fixes
bun test packages/omo-opencode/src/config/schema/background-task-defaults.test.ts

# Schema regeneration
bun run build:schema

# Typecheck package
bun run build
```

## WHAT WAS OBSERVED

### RED OUTPUT (Initial Run Before Fixes)

Test caught THREE failing assertions (all drifts present):

```
bun test v1.3.14 (d1632b29)

packages/omo-opencode/src/config/schema/background-task-defaults.test.ts:
error: expect(received).toBe(expected)

Expected: 2700000
Received: null

      at <anonymous> (…/background-task-defaults.test.ts:23:35)
(fail) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for staleTimeoutMs matches runtime constant [1.14ms]

error: expect(received).toBe(expected)

Expected: 3600000
Received: null

      at <anonymous> (…/background-task-defaults.test.ts:38:35)
(fail) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for messageStalenessTimeoutMs matches runtime constant [0.10ms]

error: expect(received).toBe(expected)

Expected: 4000
Received: null

      at <anonymous> (…/background-task-defaults.test.ts:53:35)
(fail) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for maxToolCalls matches runtime constant [0.07ms]

 1 pass
 3 fail
 4 expect() calls
Ran 4 tests across 1 file. [75.00ms]

[exit:1]
```

**Root cause**: Zod fields in `background-task.ts` did not have `.describe()` with numeric default values in the description strings. Test received `null` when extracting numbers from missing descriptions.

### FIXES APPLIED

Updated `packages/omo-opencode/src/config/schema/background-task.ts`:

**Drift 1**: `staleTimeoutMs`
- Old JSDoc: "default: 180000 = 3 minutes"
- **Actual runtime constant** from `constants.ts:7`: `DEFAULT_STALE_TIMEOUT_MS = 2_700_000` (45 minutes)
- Fixed to: "default: 2700000 = 45 minutes"

**Drift 2**: `messageStalenessTimeoutMs`
- Old JSDoc: "default: 1800000 = 30 minutes"
- **Actual runtime constant** from `constants.ts:8`: `DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS = 3_600_000` (60 minutes)
- Fixed to: "default: 3600000 = 60 minutes"

**Drift 3**: `maxToolCalls`
- Old JSDoc: "default: 200"
- **Actual runtime constant** from `constants.ts:9`: `DEFAULT_MAX_TOOL_CALLS = 4000`
- Fixed to: "default: 4000"

All three fields updated to include `.describe()` with corrected prose so test can extract the documented default and verify it matches the constant.

### GREEN OUTPUT (After Fixes)

```
bun test v1.3.14 (d1632b29)

 4 pass
 0 fail
 7 expect() calls
Ran 4 tests across 1 file. [82.00ms]
```

All four tests passing (three new drift checks + one guard for `BackgroundTaskStatus` union cardinality).

### DELIBERATE REVERT + RED (Failure Scenario)

Temporarily reverted `staleTimeoutMs` description to old wrong value:
```
"default: 180000 = 3 minutes"
```

**Test output (RED, as expected)**:
```
bun test v1.3.14 (d1632b29)

[…]
error: expect(received).toBe(expected)

Expected: 2700000
Received: 180000

      at <anonymous> (…/background-task-defaults.test.ts:25:35)
(fail) background-task schema defaults > #given runtime constants > #when schema JSDoc is parsed > #then documented default for staleTimeoutMs matches runtime constant [0.54ms]

 3 pass
 1 fail
 6 expect() calls
Ran 4 tests across 1 file. [82.00ms]

[exit:1]
```

**Proof**: Guard successfully caught the drift when a single number was wrong (received 180000, expected 2700000).

Immediately restored correct value and re-verified GREEN.

### ACCEPTANCE CRITERIA VERIFICATION

✅ Test file passes: `bun test packages/omo-opencode/src/config/schema/background-task-defaults.test.ts` → 4 pass

✅ Schema regeneration: `bun run build:schema` → "JSON Schemas generated: assets/omo.schema.json, assets/oh-my-opencode.schema.json"

✅ Schema asset diff: Only description fields changed (no structural changes to the schema itself)

✅ Build succeeds: `bun run build` → "build: all steps completed"

✅ Typecheck: Main opencode package has no new type errors introduced

## WHY IT IS ENOUGH

1. **Three drift-guard assertions** directly compare documented defaults (extracted from Zod `.describe()` strings) to runtime constants read from `constants.ts:4-23`.

2. **Failure scenario proves detection**: Reverting one correct value to its old wrong state immediately triggered a RED test, proving the guard actually catches this class of drift.

3. **Runtime constant sourcing is authoritative**: Values read from `constants.ts` are the single source of truth (configuration fallback happens at `task-poller.ts:209-213`).

4. **Persistent guard prevents regression**: The test file lives in the codebase and will run on every `bun test` invocation, catching future drift if someone updates a constant without updating JSDoc prose.

5. **No runtime behavior changed**: Only documentation (JSDoc comments and Zod descriptions) was corrected; no `.min()` bounds, no field types, no defaults were modified.

## WHAT WAS OMITTED

- No redacted credentials or auth headers in output (test is purely schema/constant comparison).
- No verbose error logs included (only the essential test output showing RED/GREEN/failure scenarios).
- Build/typecheck output was tail-checked for pass/fail status; full verbose output not pasted (80+ lines of unrelated pi-goal pre-existing errors).
