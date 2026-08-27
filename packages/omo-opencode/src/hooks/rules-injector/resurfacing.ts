import { ContextCollector } from "../../features/context-injector";

export const RESURFACE_TOOL_CALL_GAP = 40;

export type ResurfacingStore = {
	recordToolCall(sessionID: string): void;
	shouldSurface(sessionID: string, realPath: string): boolean;
	noteSurfaced(sessionID: string, realPath: string): void;
	clearSession(sessionID: string): void;
};

export type RuleResurfacing = {
	recordToolCall(sessionID: string): void;
	noteInjected(sessionID: string, realPath: string): void;
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

export function createResurfacingStore(): ResurfacingStore {
	return {
		recordToolCall: () => undefined,
		shouldSurface: () => false,
		noteSurfaced: () => undefined,
		clearSession: () => undefined,
	};
}

export function createRuleResurfacing(
	_collector: ContextCollector,
): RuleResurfacing {
	const store = createResurfacingStore();
	return {
		recordToolCall: store.recordToolCall,
		noteInjected: store.noteSurfaced,
		handleSuppressedRule: () => undefined,
		clearSession: store.clearSession,
	};
}

export function buildRuleReminder(input: {
	relativePath: string;
	matchReason: string;
	body: string;
	description?: string;
}): string {
	void input;
	return "";
}
