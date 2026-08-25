export const branchCounts = {
  title: 0,
  "parent-tool-call": 0,
  "parent-hold": 0,
  "restart-parent": 0,
  "restart-parent-midturn": 0,
  "child-midturn": 0,
  "midturn-resume": 0,
  "restart-resume": 0,
  "active-control": 0,
  "absent-control": 0,
  child: 0,
  wake: 0,
  default: 0,
}

export const latches = {
  parentToolCallIssued: false,
  parentHoldIssued: false,
  restartResumeIssued: false,
  activeControlIssued: false,
  absentControlIssued: false,
  midturnResumeIssued: false,
}

export function hasToolResult(inputStr) {
  return (
    inputStr.includes('"type":"function_call_output"') ||
    inputStr.includes('"type": "function_call_output"') ||
    inputStr.includes('"type":"tool_result"') ||
    inputStr.includes('"type": "tool_result"') ||
    inputStr.includes('"role":"tool"') ||
    inputStr.includes('"role": "tool"')
  )
}

export function selectBranch(inputStr) {
  const isTitle = inputStr.includes("Generate a title")
  const isSplitProbe = inputStr.includes("Run the split probe")
  const isRestartParent = inputStr.includes("SPLIT_CHILD_TASK: restart-happy")
  const isMidturnParent = inputStr.includes("SPLIT_CHILD_TASK: restart-midturn")
  const isMidturnChild = inputStr.includes("SPLIT_CHILD_TASK: hang-midturn")
  const isMidturnResume = inputStr.includes("SPLIT_MIDTURN_ADOPT:")
  const isRestartResume = inputStr.includes("SPLIT_RESUME_ADOPT:")
  const isActiveControl = inputStr.includes("SPLIT_ACTIVE_CONTROL:")
  const isAbsentControl = inputStr.includes("SPLIT_ABSENT_CONTROL:")
  const isChild = inputStr.includes("SPLIT_CHILD_TASK")
  const isWake = inputStr.includes("[BACKGROUND TASK")
  const hasResult = hasToolResult(inputStr)

  if (isTitle) return "title"
  if (isRestartParent) return "restart-parent"
  if (isMidturnParent) return "restart-parent-midturn"
  if (isMidturnChild) return "child-midturn"
  if (isMidturnResume && !latches.midturnResumeIssued) {
    latches.midturnResumeIssued = true
    return "midturn-resume"
  }
  if (isRestartResume && !latches.restartResumeIssued) {
    latches.restartResumeIssued = true
    return "restart-resume"
  }
  if (isActiveControl && !latches.activeControlIssued) {
    latches.activeControlIssued = true
    return "active-control"
  }
  if (isAbsentControl && !latches.absentControlIssued) {
    latches.absentControlIssued = true
    return "absent-control"
  }
  if (isChild && !isSplitProbe) return "child"
  if (isWake) return "wake"
  if (isSplitProbe && !hasResult && !latches.parentToolCallIssued) return "parent-tool-call"
  if (isSplitProbe && (hasResult || latches.parentToolCallIssued) && !latches.parentHoldIssued) return "parent-hold"
  return "default"
}
