import { ContextCollector } from "../../features/context-injector";
import { log } from "../../shared";

export const RESURFACE_TOOL_CALL_GAP = 40;

export type ResurfacingStore = {
	recordToolCall(sessionID: string): void;
	shouldSurface(sessionID: string, realPath: string): boolean;
	getGap(sessionID: string, realPath: string): number | null;
	noteSurfaced(sessionID: string, realPath: string): void;
	clearSession(sessionID: string): void;
};

export type RuleResurfacing = {
	recordToolCall(sessionID: string): void;
	noteInjected(sessionID: string, realPath: string): void;
	shouldSurface(sessionID: string, realPath: string): boolean;
	handleSuppressedRule(input: {
		sessionID: string;
		realPath: string;
		relativePath: string;
		matchReason: string;
		body: string;
		description?: string;
	}): void;
	clearSession(sessionID: string): void;
};

type ResurfacingSessionState = {
	toolCallCount: number;
	lastSurfacedAtCall: Map<string, number>;
};

export function createResurfacingStore(): ResurfacingStore {
	const sessions = new Map<string, ResurfacingSessionState>();

	function getSession(sessionID: string): ResurfacingSessionState {
		let state = sessions.get(sessionID);
		if (!state) {
			state = { toolCallCount: 0, lastSurfacedAtCall: new Map() };
			sessions.set(sessionID, state);
		}
		return state;
	}

	return {
		recordToolCall: (sessionID) => {
			getSession(sessionID).toolCallCount += 1;
		},
		shouldSurface: (sessionID, realPath) => {
			const gap = getSession(sessionID).lastSurfacedAtCall.get(realPath);
			return gap === undefined || getSession(sessionID).toolCallCount - gap >= RESURFACE_TOOL_CALL_GAP;
		},
		getGap: (sessionID, realPath) => {
			const state = getSession(sessionID);
			const last = state.lastSurfacedAtCall.get(realPath);
			return last === undefined ? null : state.toolCallCount - last;
		},
		noteSurfaced: (sessionID, realPath) => {
			const state = getSession(sessionID);
			state.lastSurfacedAtCall.set(realPath, state.toolCallCount);
		},
		clearSession: (sessionID) => {
			sessions.delete(sessionID);
		},
	};
}

export function createRuleResurfacing(
	collector: ContextCollector,
): RuleResurfacing {
	const store = createResurfacingStore();
	return {
		recordToolCall: store.recordToolCall,
		noteInjected: store.noteSurfaced,
		shouldSurface: store.shouldSurface,
		handleSuppressedRule: (input) => {
			const gap = store.getGap(input.sessionID, input.realPath);
			const shouldSurface = store.shouldSurface(input.sessionID, input.realPath);
			const reminder = buildRuleReminder(input);
			log("[rules-injector] Resurfacing decision", {
				sessionID: input.sessionID,
				rulePath: input.relativePath,
				gap,
				decision: shouldSurface ? "surface" : "suppress",
			});
			if (!shouldSurface) return;
			collector.register(input.sessionID, {
				id: `rule-reminder:${input.relativePath}`,
				source: "rules-injector",
				content: reminder,
			});
			store.noteSurfaced(input.sessionID, input.realPath);
		},
		clearSession: store.clearSession,
	};
}

export function buildRuleReminder(input: {
	relativePath: string;
	matchReason: string;
	body: string;
	description?: string;
}): string {
	const imperativeLines = input.body
		.split("\n")
		.filter((line) => /never|must|always|forbidden|do not|don't/i.test(line))
		.slice(0, 5);
	const content = imperativeLines.length > 0
		? imperativeLines.join("\n")
		: (input.description ?? "");
	return `[Rule reminder: ${input.relativePath}] [Match: ${input.matchReason}]\n${content}`.slice(0, 600);
}
