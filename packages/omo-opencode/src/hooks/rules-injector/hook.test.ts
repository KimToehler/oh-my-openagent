import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextCollector } from "../../features/context-injector";
import { createRulesInjectorHook } from "./hook";
import { RESURFACE_TOOL_CALL_GAP } from "./resurfacing";

const SESSION_ID = "rules-injector-hook-test";

function makeContext(directory: string): PluginInput {
	return {
		client: {
			session: {
				messages: mock(async () => ({ data: [] })),
			},
		},
		directory,
	} as unknown as PluginInput;
}

describe("createRulesInjectorHook", () => {
	let projectRoot: string;
	let targetFile: string;

	beforeEach(() => {
		projectRoot = join(
			tmpdir(),
			`rules-injector-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		targetFile = join(projectRoot, "src", "index.ts");
		mkdirSync(join(projectRoot, ".git"), { recursive: true });
		mkdirSync(join(projectRoot, "src"), { recursive: true });
		mkdirSync(join(projectRoot, ".omo", "rules"), { recursive: true });
		writeFileSync(targetFile, "export const value = 1;\n");
		writeFileSync(
			join(projectRoot, ".omo", "rules", "typescript.md"),
			'---\nglobs: "src/**/*.ts"\n---\nMust use strict TypeScript.\n',
		);
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	async function executeAfter(tool: string): Promise<string> {
		const hook = createRulesInjectorHook(makeContext(projectRoot));
		const output = {
			title: "",
			output: "file content",
			metadata: { filePath: targetFile },
		};

		await hook["tool.execute.after"](
			{ tool, sessionID: SESSION_ID, callID: `${tool}-call` },
			output,
		);

		return output.output;
	}

	it("#given matching project rule #when lean-ctx_ctx_read completes #then injects the rule", async () => {
		expect(await executeAfter("lean-ctx_ctx_read")).toContain("[Rule: ");
	});

	it("#given matching project rule #when native read completes #then injects the rule", async () => {
		expect(await executeAfter("read")).toContain("[Rule: ");
	});

	it("#given matching project rule #when lean-ctx_ctx_shell completes #then injects nothing", async () => {
		expect(await executeAfter("lean-ctx_ctx_shell")).toBe("file content");
	});

	it("#given matching project rule #when bash completes #then injects nothing", async () => {
		expect(await executeAfter("bash")).toBe("file content");
	});

	it("#given matching project rule #when todowrite completes #then injects nothing", async () => {
		expect(await executeAfter("todowrite")).toBe("file content");
	});

	it("#given suppressed governed rule after gap #when hook runs #then queues concise reminder", async () => {
		const collector = new ContextCollector();
		const hook = createRulesInjectorHook(makeContext(projectRoot), undefined, undefined, collector);
		const output = () => ({
			title: "",
			output: "file content",
			metadata: { filePath: targetFile },
		});

		const baseline = output();
		await hook["tool.execute.after"](
			{ tool: "read", sessionID: SESSION_ID, callID: "baseline" },
			baseline,
		);
		expect(baseline.output).toContain("[Rule: ");

		for (let index = 0; index < RESURFACE_TOOL_CALL_GAP; index += 1) {
			await hook["tool.execute.after"](
				{ tool: "bash", sessionID: SESSION_ID, callID: `gap-${index}` },
				{ title: "", output: "", metadata: {} },
			);
		}

		await hook["tool.execute.after"](
			{ tool: "read", sessionID: SESSION_ID, callID: "resurface" },
			output(),
		);

		const pending = collector.getPending(SESSION_ID);
		const reminder = pending.entries.find((entry) =>
			entry.content.includes("[Rule reminder: .omo/rules/typescript.md]"),
		)?.content;
		expect(reminder).toBeDefined();
		expect(reminder).toContain("Must use strict TypeScript.");
		expect(reminder).not.toContain('globs: "src/**/*.ts"');
		expect(reminder?.length).toBeLessThanOrEqual(600);
	});

	it("#given suppressed governed rule before gap #when hook runs #then queues no reminder", async () => {
		const collector = new ContextCollector();
		const hook = createRulesInjectorHook(makeContext(projectRoot), undefined, undefined, collector);
		const output = () => ({
			title: "",
			output: "file content",
			metadata: { filePath: targetFile },
		});

		await hook["tool.execute.after"](
			{ tool: "read", sessionID: SESSION_ID, callID: "baseline" },
			output(),
		);
		for (let index = 0; index < 3; index += 1) {
			await hook["tool.execute.after"](
				{ tool: "bash", sessionID: SESSION_ID, callID: `gap-${index}` },
				{ title: "", output: "", metadata: {} },
			);
		}
		await hook["tool.execute.after"](
			{ tool: "read", sessionID: SESSION_ID, callID: "suppressed" },
			output(),
		);

		expect(collector.getPending(SESSION_ID).hasContent).toBe(false);
	});
});
