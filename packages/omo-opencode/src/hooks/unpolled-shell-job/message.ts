import type { OutstandingJob } from "./tracker"

export function buildUnpolledShellJobMessage(jobs: readonly OutstandingJob[]): string {
  const lines = jobs.map((job) => `- \`${job.jobId}\` — \`${job.command}\``)
  const plural = jobs.length === 1 ? "job is" : "jobs are"

  return [
    `<unpolled-background-shell-jobs>`,
    `You are ending your turn with ${jobs.length} detached \`ctx_shell\` ${plural} still outstanding:`,
    ...lines,
    ``,
    `\`ctx_shell(run_in_background=true)\` **does not notify** on completion — unlike`,
    `\`task(run_in_background=true)\`, no \`<system-reminder>\` will ever arrive for it. If you`,
    `end the turn expecting one, the work stalls until a human intervenes.`,
    ``,
    `Poll it now, in this turn:`,
    `\`ctx_shell(background_action="status", job_id="${jobs[0]?.jobId ?? "shell_..."}")\``,
    ``,
    `If you no longer need the result, cancel it explicitly with`,
    `\`background_action="cancel"\`. Either way, do not yield while it is outstanding.`,
    `</unpolled-background-shell-jobs>`,
  ].join("\n")
}
