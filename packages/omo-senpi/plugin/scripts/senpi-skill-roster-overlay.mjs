const rawSisyphusLeadPattern = /^\s*"lead": \{ "kind": "subagent_type", "subagent_type": "sisyphus" \},\n/m

function routeNamedAgent(content, agentName, categoryName) {
  return content.replaceAll(`subagent_type="${agentName}"`, `category="${categoryName}"`)
}

function dropRawSisyphusLead(content) {
  return content.replace(rawSisyphusLeadPattern, "")
}

export function applySenpiSkillRosterOverlay(skillName, content) {
  if (skillName === "review-work" || skillName === "visual-qa") {
    return routeNamedAgent(routeNamedAgent(content, "oracle", "unspecified-high"), "auditor", "unspecified-high")
  }
  if (skillName === "debugging") {
    return dropRawSisyphusLead(routeNamedAgent(content, "oracle", "deep"))
  }
  if (skillName === "refactor") {
    return dropRawSisyphusLead(routeNamedAgent(content, "plan", "deep"))
  }
  return content
}
