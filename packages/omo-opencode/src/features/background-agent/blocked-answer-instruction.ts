export function buildBlockedAnswerInstruction(sessionId: string): string {
  return `Answer with \`task(task_id="${sessionId}", prompt="...")\`.`
}
