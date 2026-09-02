/**
 * Tracks detached `ctx_shell` jobs so a turn cannot end while one is still owed a poll.
 *
 * `task(run_in_background=true)` and `ctx_shell(run_in_background=true)` share a
 * parameter name but have opposite completion contracts: the former delivers a
 * `<system-reminder>`, the latter never notifies at all. An agent that ends its turn
 * "waiting" for a detached ctx_shell job waits forever — in a subagent until
 * stale-cancellation, in a main session until a human notices.
 */

/** Tool name for lean-ctx's shell, as it appears in opencode tool events. */
const CTX_SHELL_TOOL_SUFFIX = "ctx_shell"

/** Job ids look like `shell_09e11136fc3e37b6`. */
const JOB_ID_PATTERN = /\bshell_[a-f0-9]{8,}\b/

/**
 * Status values that mean the job is no longer owed a poll.
 *
 * Matched against the parsed status *field* only — never against the free-form body.
 * A running job's log tail routinely contains these words ("Task :compileKotlin FAILED",
 * "12 tests completed"), and scanning the whole output for them retires the job on its
 * first poll, silently disarming the guard for exactly the long noisy builds it exists for.
 */
const TERMINAL_STATUSES = new Set([
  "completed",
  "finished",
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "timedout",
  "exited",
])

/**
 * Status values that prove the job is still alive, and so is worth adopting when we never
 * saw its start message.
 */
const RUNNING_STATUSES = new Set(["running", "started", "active", "inprogress", "pending"])

/**
 * lean-ctx reports `[background:shell_... running]`, `[background:shell_... completed, exit 0]`,
 * or a `status: running` line.
 *
 * The comma terminator is deliberately narrowed to `,\s*exit\b` rather than a bare `,`.
 * The leading `^` alternative anchors at the start of ANY line under the `m` flag, not just
 * the status line, so a bare comma lets a log-tail line like `failed, 3 tests` parse as the
 * status field and retire a job that is still running. That is the exact fail-open documented
 * on TERMINAL_STATUSES above. Requiring the `exit` clause keeps the real terminal wordings
 * (`completed, exit 0`, `failed, exit 1`, `cancelled, exit 143`, `timed out, exit 124`)
 * while leaving arbitrary comma-bearing prose unparseable, and therefore still running.
 */
const STATUS_FIELD_PATTERN = /(?:^|\[background:\s*\S+\s+|\bstatus:\s*)([a-z][a-z _-]*?)(?:,\s*exit\b|\]|$|\n)/im

/**
 * A reaped id draws `[background:<id> not found ...]`, which is terminal: the job is gone,
 * so no further poll can ever resolve it and leaving it tracked warns forever.
 *
 * This cannot be a TERMINAL_STATUSES entry. Those are matched against the parsed status
 * field, and every wording lean-ctx actually emits carries a trailing clause that the field
 * parser either mangles or drops entirely:
 *
 *   `[background:shell_x not found or expired]`            → `notfoundorexpired`, not in the set
 *   `[background:shell_x not found — already finished ...]` → unparseable, `—` is outside `[a-z _-]`
 *
 * so the `notfound` entry only ever matched a bare `[background:<id> not found]` wording.
 * Widening the field parser to reach the clause is not the fix — it reopens the log-tail
 * fail-open documented on TERMINAL_STATUSES. Instead this matches the not-found reply
 * directly, anchored to the id that was polled.
 *
 * Anchoring to the polled id is load-bearing, not decoration. A running job's log tail can
 * quote another job's not-found reply verbatim (an agent reaping several jobs prints exactly
 * that), and a job-agnostic matcher would retire the still-running job that merely reported
 * it. Requiring the bracket to name the polled id keeps the unparseable-means-running
 * default intact for every other wording.
 */
const NOT_FOUND_REPLY_PATTERN = /\[background:\s*(\S+?)\s+not\s+found\b/i

/**
 * Jobs older than this are dropped on the next write.
 *
 * `session.deleted` is not guaranteed: `client.session.abort()` does not reliably emit it
 * (see background-agent/manager.ts), and aborted subagents are the heaviest users of
 * detached shells — so session-scoped cleanup alone would leak exactly the sessions that
 * matter. A detached job that is still unresolved after this long is not worth guarding.
 */
const JOB_TTL_MS = 2 * 60 * 60 * 1000

/** Hard ceiling per session, so one runaway session cannot grow without bound. */
const MAX_JOBS_PER_SESSION = 64

export type OutstandingJob = {
  readonly jobId: string
  readonly command: string
  readonly firstSeenAt: number
}

export type ObservedToolCall = {
  readonly sessionID: string
  readonly tool: string
  readonly args?: Record<string, unknown>
  readonly output?: string
}

const jobsBySession = new Map<string, Map<string, OutstandingJob>>()
/** Job ids already retired, so a late "not found" poll cannot resurrect them. */
const retiredBySession = new Map<string, Set<string>>()

/** @internal For testing only. Pass a sessionID to clear one session, omit to clear all. */
export function _resetForTesting(sessionID?: string): void {
  if (sessionID === undefined) {
    jobsBySession.clear()
    retiredBySession.clear()
    return
  }
  jobsBySession.delete(sessionID)
  retiredBySession.delete(sessionID)
}

export function forgetSession(sessionID: string): void {
  jobsBySession.delete(sessionID)
  retiredBySession.delete(sessionID)
}

export function getOutstandingJobs(sessionID: string): readonly OutstandingJob[] {
  return [...(jobsBySession.get(sessionID)?.values() ?? [])]
}

function isCtxShell(tool: unknown): boolean {
  // `tool` is typed string but arrives from opencode's runtime plugin input, which the
  // surrounding file documents as best-effort. Guard like utils/codegraph/guidance.ts does.
  return typeof tool === "string" && tool.endsWith(CTX_SHELL_TOOL_SUFFIX)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isTerminalStatus(output: string | undefined): boolean {
  const status = STATUS_FIELD_PATTERN.exec(output ?? "")?.[1]
  if (status === undefined) return false
  return TERMINAL_STATUSES.has(status.trim().replace(/[ _-]/g, "").toLowerCase())
}

function isNotFoundReply(output: string | undefined, jobId: string): boolean {
  const named = NOT_FOUND_REPLY_PATTERN.exec(output ?? "")?.[1]
  return named !== undefined && named === jobId
}

function isRunningStatus(output: string | undefined): boolean {
  const status = STATUS_FIELD_PATTERN.exec(output ?? "")?.[1]
  if (status === undefined) return false
  return RUNNING_STATUSES.has(status.trim().replace(/[ _-]/g, "").toLowerCase())
}

function clearJob(sessionID: string, jobId: string): void {
  const retired = retiredBySession.get(sessionID) ?? new Set<string>()
  retired.add(jobId)
  // Bounded: drop the oldest ids once the set outgrows the per-session job ceiling.
  while (retired.size > MAX_JOBS_PER_SESSION) {
    const oldest = retired.values().next().value
    if (oldest === undefined) break
    retired.delete(oldest)
  }
  retiredBySession.set(sessionID, retired)

  const jobs = jobsBySession.get(sessionID)
  if (jobs === undefined) return
  jobs.delete(jobId)
  if (jobs.size === 0) jobsBySession.delete(sessionID)
}

function pruneExpired(jobs: Map<string, OutstandingJob>, now: number): void {
  for (const [jobId, job] of jobs) {
    if (now - job.firstSeenAt > JOB_TTL_MS) jobs.delete(jobId)
  }
  // Oldest-first eviction; Map preserves insertion order.
  while (jobs.size > MAX_JOBS_PER_SESSION) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined) break
    jobs.delete(oldest)
  }
}

function trackJob(sessionID: string, jobId: string, command: string): void {
  const jobs = jobsBySession.get(sessionID) ?? new Map<string, OutstandingJob>()
  const now = Date.now()
  if (!jobs.has(jobId)) jobs.set(jobId, { jobId, command, firstSeenAt: now })
  pruneExpired(jobs, now)
  if (jobs.size === 0) {
    jobsBySession.delete(sessionID)
    return
  }
  jobsBySession.set(sessionID, jobs)
}

export function recordToolCall({ sessionID, tool, args, output }: ObservedToolCall): void {
  if (!isCtxShell(tool)) return

  const backgroundAction = asString(args?.background_action)
  if (backgroundAction !== undefined) {
    const polledJobId = asString(args?.job_id)
    if (polledJobId === undefined) return
    // A cancel always retires the job; a status only retires it once the parsed status
    // field reports terminal, or the reply says this exact id is gone. An unparseable
    // status is treated as still running, so an unrecognised wording leaves the guard
    // armed rather than silently disarming it.
    if (backgroundAction === "cancel" || isTerminalStatus(output) || isNotFoundReply(output, polledJobId)) {
      clearJob(sessionID, polledJobId)
      return
    }
    // A poll naming a job we never registered means the start message did not match
    // JOB_ID_PATTERN (e.g. lean-ctx reworded it). Adopt it so the job is still guarded
    // rather than silently untracked, but ONLY on positive evidence that it is still
    // running: adopting whenever the status merely failed to parse turns a payload we
    // cannot read into a permanent phantom that every cleanup poll re-creates.
    // Never re-adopt one we already retired, or a "job not found" reply for a reaped id
    // would resurrect it and warn forever.
    if (backgroundAction !== "status") return
    if (!isRunningStatus(output)) return
    if (retiredBySession.get(sessionID)?.has(polledJobId) === true) return
    trackJob(sessionID, polledJobId, "(started before it was tracked)")
    return
  }

  if (args?.run_in_background !== true) return

  const jobId = JOB_ID_PATTERN.exec(output ?? "")?.[0]
  if (jobId === undefined) return

  trackJob(sessionID, jobId, asString(args?.command)?.trim() ?? "(unknown command)")
}
