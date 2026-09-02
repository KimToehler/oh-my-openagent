import { loadSharedSkillTemplate } from "../skill-file-loader"
import type { BuiltinSkill } from "../types"

export const reviewWorkSkill: BuiltinSkill = {
	name: "review-work",
	description:
		"Post-implementation merge gate and review orchestrator. Launches 5 parallel background sub-agents: Oracle (goal/constraint verification), Oracle (code quality, run twice cross-engine when two differently-backed reviewers exist), Oracle (security), unspecified-high (hands-on QA execution), unspecified-high (context mining from GitHub/git/Slack/Notion). All must pass for review to pass. This IS the security lane - a process that points at a separate security review is satisfied by running this. USE before merging any PR whose change is production code that is multi-file, cross-cutting, or adds a new surface; SKIP for typo, formatting, docs-only, dependency-bump, or revert changes, and state that you skipped it. Triggers: 'review work', 'review my work', 'review changes', 'QA my work', 'verify implementation', 'check my work', 'validate changes', 'post-implementation review', 'ready to merge', 'before merging'.",
	template: loadSharedSkillTemplate("review-work"),
}
