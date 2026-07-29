# QA evidence: stranded concurrency slots starving queued tasks

**Change under test:** `a456466d1` fix(background-agent): stop stranded concurrency slots starving queued tasks, plus `30c348999` chore(schema): regenerate config schema for acquireTimeoutMs
**Branch:** `fix/background-concurrency-deadlock` (2 commits ahead of `dev`)
**Date:** 2026-07-29
**Environment:** macOS, bun 1.3.14, opencode 1.18.0

## What was tested

The change adds `background_task.acquireTimeoutMs` (default 600000, `0` disables) so a
task waiting on a concurrency slot fails instead of parking forever, records
`concurrencyKey` ownership before `startTask`, and fails only the affected task on an
acquire error instead of rethrowing and abandoning the rest of the queue.

Two probes, because the two halves need different instruments.

### 1. `acquire-timeout-behavior-probe.ts` - the behavior itself

`concurrency.ts` imports only a type and emits **no log lines at all**, so the
acquire/timeout path is invisible to any log-based check. This probe drives the real
`ConcurrencyManager` with real contention and a real wall-clock timer - no mocks, and
deliberately **no frozen `Date.now`** (a frozen clock produces false results on this code).

| Case | Behavior asserted |
|---|---|
| B1 | A waiter blocked by a stranded slot (holder never releases) is rejected on the acquire timeout, with an actionable message |
| B2 | That rejection is isolated - after a legitimate `release()`, a later waiter still gets the slot |
| B4 | `acquireTimeoutMs: 0` disables the timeout (documented escape hatch) |

```bash
bun run acquire-timeout-behavior-probe.ts
```

### 2. `concurrency-acquire-probe.sh` - the integration half

Drives a **real** `opencode run` in an isolated XDG sandbox with our plugin loaded from
source and a local fake LLM (no real API call), asserting the plugin loads and actually
launches a background task, and that the host DB is untouched.

```bash
bash concurrency-acquire-probe.sh --self-test          # harness assertions
bash concurrency-acquire-probe.sh --evidence-dir "$PWD"
```

## What was observed

**Behavior probe, with the fix (`behavior-probe.out`, exit 0):**

```
PASS B1: stranded slot rejected the waiter after 1502ms
B1: message = Timed out after 1500ms waiting for a concurrency slot on "openai/gpt-fake". This usually means a slot was not released by a previous task.
PASS B2: acquire timeout is isolated - the queue still serves later waiters
PASS B4: acquireTimeoutMs=0 disables the timeout (waiter still parked)
BEHAVIOR PROBE PASS
```

**Negative control - same probe with `concurrency.ts` reverted to `dev`
(`behavior-probe-without-fix.out`, exit 1):**

```
FAIL: B1: expected task-b to be rejected, got "still-waiting" after 6001ms
FAIL: B2: waiter-1 should have timed out, got still-waiting
PASS B4: acquireTimeoutMs=0 disables the timeout (waiter still parked)
BEHAVIOR PROBE FAILED (2 failure(s))
```

The waiter parking forever is exactly the reported starvation, so the probe is red
without the fix and green with it. B4 passes in both runs, correctly - that path is
unchanged by the commit. `concurrency.ts` was restored to `HEAD` afterwards and the
tree verified clean.

**Sandbox integration probe (`metadata.txt`, `run.jsonl`, `fake-llm.log`,
`plugin-background-agent.log`):**

```
opencode run exit=0 (9 json lines)
plugin log lines produced by THIS run: 164
PASS B-RUN / PASS B0 / PASS B-TASK / PASS B3
host session count BEFORE: 879 -> AFTER: 879
```

The plugin log confirms a real background task through the queue:

```
[background-agent] Task queued: {"taskId":"bg_f8b79cd8","key":"openai/gpt-fake","queueLength":1}
[background-agent] Starting task: {"taskId":"bg_f8b79cd8","agent":"explore",...}
```

**Unit gate:** `bun test packages/omo-opencode/src/features/background-agent/`
-> **751 pass, 0 fail**, 1906 expect() calls across 60 files.

**Typecheck:** `npx tsgo --noEmit -p packages/omo-opencode/tsconfig.json` reports exactly
2 errors, both `TS2307` in `shared/typescript-native-source-parser.ts`
(`typescript/unstable/{async,ast}`). Verified pre-existing: `git diff dev..HEAD` shows
that file is untouched by this branch.

## Why this is enough

The acquire timeout is proven by direct execution against the shipped class, with a
negative control establishing that the probe actually detects the bug's absence - not
merely that the code runs. Isolation is proven by an unchanged host session count
(879 before and after) across every sandbox run. The integration probe proves the plugin
loads and reaches the background-task queue inside a real opencode, so the unit-level
proof is not happening in a vacuum.

Residual risk: the sandbox run exercises a single background task (`queueLength: 1`), so
end-to-end contention across two concurrently launched tasks inside a live opencode is
not directly demonstrated - contention is proven at the class level instead. The
`concurrencyKey`-ownership-before-`startTask` change is covered by
`manager-concurrency-slot-leak.test.ts` (137 lines) rather than by a live probe, because
the window it closes is a few awaits wide and is not reliably reproducible from outside.

## What was omitted

No secrets, tokens, or auth headers are included. The fake LLM uses the literal
`"fake-key"` and binds to loopback, so no provider credential is present in any
artifact. `run.stderr` is retained but empty. Host paths appear in `metadata.txt` and the
plugin log excerpt; no private repository content is included beyond this project's own
file paths.

## Files

| File | Contents |
|---|---|
| `acquire-timeout-behavior-probe.ts` | Behavior probe (B1/B2/B4) against the real `ConcurrencyManager` |
| `behavior-probe.out` | Behavior probe output WITH the fix (exit 0) |
| `behavior-probe-without-fix.out` | Negative control, `concurrency.ts` reverted to `dev` (exit 1) |
| `concurrency-acquire-probe.sh` | Isolated sandbox integration probe (ships `--self-test`) |
| `metadata.txt` | Host session counts, opencode version, run exit, capture time |
| `run.jsonl` | `opencode run --format json` event stream from the sandbox |
| `plugin-background-agent.log` | Background-agent lines produced by that run only |
| `fake-llm.log` | Fake provider branch trace (proves no real API call) |
| `run.stderr` | stderr from the sandbox run (empty) |
