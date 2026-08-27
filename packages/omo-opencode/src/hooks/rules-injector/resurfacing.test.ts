import { describe, expect, it } from "bun:test";
import { ContextCollector } from "../../features/context-injector";
import {
	buildRuleReminder,
	createRuleResurfacing,
	RESURFACE_TOOL_CALL_GAP,
} from "./resurfacing";

const SESSION_ID = "rules-resurfacing";
const RULE_PATH = ".omo/rules/internal-prompt-injection.md";
const REAL_PATH = "/rules/internal-prompt-injection.md";

describe("rule resurfacing", () => {
	it("#given a rule suppressed by content hash later in the session #when it matches again after the staleness gap #then a reminder is queued into the context collector", () => {
		// given
		const collector = new ContextCollector();
		const resurfacing = createRuleResurfacing(collector);
		resurfacing.noteInjected(SESSION_ID, REAL_PATH);
		for (let index = 0; index < RESURFACE_TOOL_CALL_GAP; index += 1) {
			resurfacing.recordToolCall(SESSION_ID);
		}

		// when
		resurfacing.handleSuppressedRule({
			sessionID: SESSION_ID,
			realPath: REAL_PATH,
			relativePath: RULE_PATH,
			matchReason: "matched",
			body: "NEVER inject raw prompts.",
		});

		// then
		expect(collector.consume(SESSION_ID).merged).toContain(
			"[Rule reminder: .omo/rules/internal-prompt-injection.md]",
		);
	});

	it("#given a rule injected on the immediately preceding tool call #when the same rule matches again #then no reminder is queued", () => {
		// given
		const collector = new ContextCollector();
		const resurfacing = createRuleResurfacing(collector);
		resurfacing.noteInjected(SESSION_ID, REAL_PATH);
		resurfacing.recordToolCall(SESSION_ID);

		// when
		resurfacing.handleSuppressedRule({
			sessionID: SESSION_ID,
			realPath: REAL_PATH,
			relativePath: RULE_PATH,
			matchReason: "matched",
			body: "NEVER inject raw prompts.",
		});

		// then
		expect(collector.hasPending(SESSION_ID)).toBe(false);
	});

	it("#given a rule suppressed by content hash with no watermark in this process #when it matches #then a reminder is queued", () => {
		// given
		const collector = new ContextCollector();
		const resurfacing = createRuleResurfacing(collector);

		// when
		resurfacing.handleSuppressedRule({
			sessionID: SESSION_ID,
			realPath: REAL_PATH,
			relativePath: RULE_PATH,
			matchReason: "matched",
			body: "NEVER inject raw prompts.",
		});

		// then
		expect(collector.hasPending(SESSION_ID)).toBe(true);
	});

	it("#given a rule body containing uppercase NEVER and MUST lines #when the reminder is built #then it carries those imperative lines and not the full body", () => {
		// given
		const body = `NEVER call session.prompt\nMUST route through the gate\n${"non-imperative ".repeat(100)}`;

		// when
		const reminder = buildRuleReminder({
			relativePath: RULE_PATH,
			matchReason: "matched",
			body,
		});

		// then
		expect(reminder).toContain("NEVER call session.prompt");
		expect(reminder.length).toBeLessThanOrEqual(600);
	});

	it("#given a rule body whose only imperative is sentence case #when the reminder is built #then that line is still extracted", () => {
		// given
		const body = "**Never do implementation, refactoring, or multi-file work directly on the repository's main working tree**";

		// when
		const reminder = buildRuleReminder({
			relativePath: "worktrees.md",
			matchReason: "matched",
			body,
			description: "Worktree discipline",
		});

		// then
		expect(reminder).toContain("Never do implementation");
	});

	it("#given a rule body with no imperative lines in any case #when the reminder is built #then it falls back to the frontmatter description", () => {
		// given
		const description = "Rule applies to this file.";

		// when
		const reminder = buildRuleReminder({
			relativePath: RULE_PATH,
			matchReason: "matched",
			body: "Context only.",
			description,
		});

		// then
		expect(reminder).toContain(description);
	});
});
