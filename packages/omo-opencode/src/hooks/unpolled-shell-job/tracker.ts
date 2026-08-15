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

/** A poll result naming any of these means the job is no longer owed a poll. */
const TERMINAL_STATUS_PATTERN = /\b(completed|finished|succeeded|failed|cancelled|canceled|timed[ _-]?out|exited)\b/i

export type OutstandingJob = {
  readonly jobId: string
  readonly command: string
}

export type ObservedToolCall = {
  readonly sessionID: string
  readonly tool: string
  readonly args?: Record<string, unknown>
  readonly output?: string
}

const jobsBySession = new Map<string, Map<string, OutstandingJob>>()

/** @internal For testing only. Pass a sessionID to clear one session, omit to clear all. */
export function _resetForTesting(sessionID?: string): void {
  if (sessionID === undefined) {
    jobsBySession.clear()
    return
  }
  jobsBySession.delete(sessionID)
}

export function forgetSession(sessionID: string): void {
  jobsBySession.delete(sessionID)
}

export function getOutstandingJobs(sessionID: string): readonly OutstandingJob[] {
  return [...(jobsBySession.get(sessionID)?.values() ?? [])]
}

function isCtxShell(tool: string): boolean {
  return tool.endsWith(CTX_SHELL_TOOL_SUFFIX)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function clearJob(sessionID: string, jobId: string): void {
  const jobs = jobsBySession.get(sessionID)
  if (jobs === undefined) return
  jobs.delete(jobId)
  if (jobs.size === 0) jobsBySession.delete(sessionID)
}

function trackJob(sessionID: string, jobId: string, command: string): void {
  const jobs = jobsBySession.get(sessionID) ?? new Map<string, OutstandingJob>()
  if (!jobs.has(jobId)) jobs.set(jobId, { jobId, command })
  jobsBySession.set(sessionID, jobs)
}

export function recordToolCall({ sessionID, tool, args, output }: ObservedToolCall): void {
  if (!isCtxShell(tool)) return

  const backgroundAction = asString(args?.background_action)
  if (backgroundAction !== undefined) {
    const polledJobId = asString(args?.job_id)
    if (polledJobId === undefined) return
    // A cancel always retires the job; a status only retires it once it reports terminal.
    if (backgroundAction === "cancel" || TERMINAL_STATUS_PATTERN.test(output ?? "")) {
      clearJob(sessionID, polledJobId)
      return
    }
    // A poll naming a job we never registered means the start message did not match
    // JOB_ID_PATTERN (e.g. lean-ctx reworded it). Adopt it so the job is still guarded
    // rather than silently untracked.
    trackJob(sessionID, polledJobId, "(started before it was tracked)")
    return
  }

  if (args?.run_in_background !== true) return

  const jobId = JOB_ID_PATTERN.exec(output ?? "")?.[0]
  if (jobId === undefined) return

  trackJob(sessionID, jobId, asString(args?.command)?.trim() ?? "(unknown command)")
}
