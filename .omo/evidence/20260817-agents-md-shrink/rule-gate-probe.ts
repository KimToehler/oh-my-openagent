// QA probe: proves .omo/rules/internal-prompt-injection.md is PATH-GATED (lazy),
// not alwaysApply (eager). Drives the real rules-engine matcher.
import { readFileSync } from "node:fs"
import { matchRule } from "../../../packages/rules-engine/src/engine/matcher"
import type { RuleFrontmatter } from "../../../packages/rules-engine/src/engine/types"

const RULE = ".omo/rules/internal-prompt-injection.md"
const raw = readFileSync(RULE, "utf8")

const fmBlock = raw.split("---")[1] ?? ""
const globs = fmBlock
	.split("\n")
	.filter((l) => l.trim().startsWith("- "))
	.map((l) => l.trim().slice(2).replace(/^"|"$/g, ""))

const frontmatter = { globs } as RuleFrontmatter

console.log(`rule: ${RULE}`)
console.log(`globs parsed: ${globs.length}`)
console.log(`alwaysApply in frontmatter: ${/^alwaysApply:/m.test(fmBlock)}`)
console.log("")

const targets = [
	// MUST match (a real dispatch route)
	["packages/omo-opencode/src/shared/prompt-async-gate.ts", true],
	["packages/omo-opencode/src/hooks/goal/index.ts", true],
	["packages/omo-opencode/src/features/background-agent/manager.ts", true],
	["packages/omo-opencode/src/cli/run/runner.ts", true],
	// MUST NOT match (unrelated files - proves it is not always-on)
	["packages/omo-opencode/src/config/schema/team-mode.ts", false],
	["packages/web/app/page.tsx", false],
	["AGENTS.md", false],
	["docs/guide/team-mode.md", false],
] as const

let failures = 0
for (const [path, expected] of targets) {
	const result = matchRule({
		frontmatter,
		isSingleFile: false,
		pathBases: {
			projectRelative: path,
			basename: path.split("/").pop() ?? path,
		},
	})
	const ok = result.matched === expected
	if (!ok) failures++
	console.log(
		`${ok ? "PASS" : "FAIL"}  matched=${String(result.matched).padEnd(5)} expected=${String(expected).padEnd(5)} reason=${String(result.reason).padEnd(12)} ${path}`,
	)
}

console.log("")
console.log(failures === 0 ? "RESULT: PATH-GATED as intended (0 failures)" : `RESULT: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
