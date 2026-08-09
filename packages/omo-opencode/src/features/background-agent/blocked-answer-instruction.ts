export function buildBlockedAnswerInstruction(sessionId: string): string {
  return `**Child needs your answer:** Reply with the requested information using this exact invocation:\n\`task(task_id="${sessionId}", prompt="<your answer>")\``
}
