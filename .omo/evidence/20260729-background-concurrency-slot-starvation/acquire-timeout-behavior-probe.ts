/**
 * Behavioral probe for: stop stranded concurrency slots starving queued tasks.
 *
 * `concurrency.ts` has NO logging, so the acquire/timeout path is invisible in
 * the plugin log - a log-grep probe can never prove it. This drives the real
 * ConcurrencyManager instead, with real contention and a real wall-clock timer
 * (no mocks, no frozen Date.now - a frozen clock produces false results here).
 *
 * Proves:
 *   B1  a waiter blocked by a STRANDED slot fails on the acquire timeout
 *       instead of parking forever
 *   B2  that failure is isolated: a later waiter still gets the slot once it
 *       is legitimately released (the queue is not abandoned)
 *   B4  acquireTimeoutMs=0 disables the timeout (documented escape hatch)
 *
 * Run: bun run acquire-timeout-behavior-probe.ts
 */

import { ConcurrencyManager } from "../../../packages/omo-opencode/src/features/background-agent/concurrency"

let failures = 0
const log = (msg: string) => console.log(`[probe] ${msg}`)
const pass = (msg: string) => log(`PASS ${msg}`)
const fail = (msg: string) => {
  failures++
  console.error(`[probe] FAIL: ${msg}`)
}

const MODEL = "openai/gpt-fake"

async function b1StrandedSlotTimesOut(): Promise<void> {
  // limit 1, timeout 1.5s
  const mgr = new ConcurrencyManager({
    modelConcurrency: { [MODEL]: 1 },
    acquireTimeoutMs: 1500,
  })

  // Task A takes the only slot and NEVER releases it - this is the stranded
  // slot that caused the starvation.
  await mgr.acquire(MODEL, "task-a")
  log("B1: task-a holds the only slot and never releases (stranded)")

  const started = Date.now()
  let message = ""
  // Guarded race: a bare await on a never-settling acquire would hang the
  // probe instead of reporting a failure.
  const outcome = await Promise.race([
    mgr.acquire(MODEL, "task-b").then(
      () => "acquired",
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error)
        return "rejected"
      },
    ),
    new Promise<string>((r) => setTimeout(() => r("still-waiting"), 6000)),
  ])
  const elapsed = Date.now() - started

  if (outcome !== "rejected") {
    fail(`B1: expected task-b to be rejected, got "${outcome}" after ${elapsed}ms`)
    return
  }
  if (elapsed < 1200 || elapsed > 6000) {
    fail(`B1: rejection timing implausible (${elapsed}ms, expected ~1500ms)`)
    return
  }
  if (!/concurrency slot/i.test(message)) {
    fail(`B1: rejection message not actionable: ${message}`)
    return
  }
  pass(`B1: stranded slot rejected the waiter after ${elapsed}ms`)
  log(`B1: message = ${message}`)
}

async function b2FailureIsIsolated(): Promise<void> {
  const mgr = new ConcurrencyManager({
    modelConcurrency: { [MODEL]: 1 },
    acquireTimeoutMs: 1200,
  })

  await mgr.acquire(MODEL, "holder")

  // Waiter 1 will time out. Waiter 2 must still be servable afterwards.
  const w1 = mgr.acquire(MODEL, "waiter-timeout").then(
    () => "acquired",
    (e: unknown) => `rejected:${e instanceof Error ? e.message : String(e)}`,
  )

  const w1Result = await Promise.race([
    w1,
    new Promise<string>((r) => setTimeout(() => r("still-waiting"), 6000)),
  ])
  if (!w1Result.startsWith("rejected")) {
    fail(`B2: waiter-1 should have timed out, got ${w1Result}`)
    return
  }

  // Now release the holder. A later waiter must get the slot - proving the
  // timeout did not corrupt or abandon the queue.
  const w2 = mgr.acquire(MODEL, "waiter-after")
  mgr.release(MODEL)

  const settled = await Promise.race([
    w2.then(() => "acquired", () => "rejected"),
    new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
  ])

  if (settled !== "acquired") {
    fail(`B2: later waiter did not get the released slot (got "${settled}")`)
    return
  }
  pass("B2: acquire timeout is isolated - the queue still serves later waiters")
}

async function b4ZeroDisablesTimeout(): Promise<void> {
  const mgr = new ConcurrencyManager({
    modelConcurrency: { [MODEL]: 1 },
    acquireTimeoutMs: 0,
  })

  await mgr.acquire(MODEL, "holder")

  const waiter = mgr.acquire(MODEL, "patient").then(() => "acquired", () => "rejected")
  const settled = await Promise.race([
    waiter,
    new Promise<string>((r) => setTimeout(() => r("still-waiting"), 1500)),
  ])

  if (settled !== "still-waiting") {
    fail(`B4: acquireTimeoutMs=0 should disable the timeout, waiter was "${settled}"`)
    return
  }
  pass("B4: acquireTimeoutMs=0 disables the timeout (waiter still parked)")

  // Drain so the process can exit cleanly.
  mgr.release(MODEL)
  await waiter
}

async function main(): Promise<void> {
  log(`started ${new Date().toISOString()}`)
  await b1StrandedSlotTimesOut()
  await b2FailureIsIsolated()
  await b4ZeroDisablesTimeout()

  if (failures === 0) {
    log("BEHAVIOR PROBE PASS")
    process.exit(0)
  }
  console.error(`[probe] BEHAVIOR PROBE FAILED (${failures} failure(s))`)
  process.exit(1)
}

void main()
