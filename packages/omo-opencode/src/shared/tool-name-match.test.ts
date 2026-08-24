import { describe, expect, it } from "bun:test";
import { matchesTrackedTool } from "./tool-name-match";

const trackedNames = ["read", "write", "edit", "multiedit"];

const cases: readonly { readonly input: unknown; readonly expected: boolean }[] = [
	{ input: "read", expected: true },
	{ input: "lean-ctx_ctx_read", expected: true },
	{ input: "mcp__server__read", expected: true },
	{ input: "mcp__server__multiedit", expected: true },
	{ input: "hashline_edit", expected: true },
	{ input: "todowrite", expected: false },
	{ input: "lean-ctx_ctx_shell", expected: false },
	{ input: "bash", expected: false },
	{ input: "spread", expected: false },
	{ input: "LEAN-CTX_CTX_READ", expected: true },
	{ input: undefined, expected: false },
	{ input: null, expected: false },
	{ input: 42, expected: false },
	{ input: "write", expected: true },
	{ input: "multiedit", expected: true },
	{ input: "edit", expected: true },
	{ input: "lean-ctx_ctx_write", expected: true },
	{ input: "mcp__x__edit", expected: true },
	{ input: "ctx_read", expected: true },
	{ input: "overwrite", expected: false },
	{ input: "credit", expected: false },
	{ input: "", expected: false },
	{ input: "READ", expected: true },
];

describe("matchesTrackedTool", () => {
	for (const { input, expected } of cases) {
		it(`#given tool name ${JSON.stringify(input)} #when matching tracked tools #then returns ${expected}`, () => {
			// given

			// when
			const result = matchesTrackedTool(input, trackedNames);

			// then
			expect(result).toBe(expected);
		});
	}

	it("#given empty tracked names #when matching tool #then returns false", () => {
		// given

		// when
		const result = matchesTrackedTool("read", []);

		// then
		expect(result).toBe(false);
	});
});
