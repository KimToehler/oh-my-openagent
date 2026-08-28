import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginInput } from "@opencode-ai/plugin";
import { ContextCollector } from "../../features/context-injector";
import { createDynamicTruncator } from "../../shared/dynamic-truncator";
import { resolveSessionEventID } from "../../shared/event-session-id";
import { matchesTrackedTool } from "../../shared/tool-name-match";
import {
	createSessionCacheStore,
	createSessionRuleScanCacheStore,
} from "./cache";
import { clearParsedRuleCache, createRuleInjectionProcessor } from "./injector";
import { getRuleInjectionFilePath } from "./output-path";
import { clearProjectRootCache } from "./project-root-finder";
import { createRuleResurfacing } from "./resurfacing";
import { createTranscriptHydrationStore } from "./transcript-hydration";

interface ToolExecuteInput {
	tool: string;
	sessionID: string;
	callID: string;
}

interface ToolExecuteOutput {
	title: string;
	output: string;
	metadata: unknown;
}

interface ToolExecuteBeforeOutput {
	args: unknown;
}

interface EventInput {
	event: {
		type: string;
		properties?: unknown;
	};
}

export function resolveOpenCodePluginRoot(moduleUrl = import.meta.url): string {
	const moduleDirectory = dirname(fileURLToPath(moduleUrl));
	if (basename(moduleDirectory) === "dist") return join(moduleDirectory, "..");
	return join(moduleDirectory, "..", "..", "..");
}

const TRACKED_TOOLS = ["read", "write", "edit", "multiedit"];

export function createRulesInjectorHook(
	ctx: PluginInput,
	modelCacheState?: { anthropicContext1MEnabled: boolean },
	options?: { skipClaudeUserRules?: boolean },
	collector?: ContextCollector,
) {
	const resurfacing = collector ? createRuleResurfacing(collector) : undefined;
	const truncator = createDynamicTruncator(ctx, modelCacheState);
	const { getSessionCache, clearSessionCache } = createSessionCacheStore();
	const { getSessionRuleScanCache, clearSessionRuleScanCache } =
		createSessionRuleScanCacheStore();
	const transcriptHydration = createTranscriptHydrationStore({
		client: ctx.client,
	});
	const { processFilePathForInjection } = createRuleInjectionProcessor({
		workspaceDirectory: ctx.directory,
		pluginRoot: resolveOpenCodePluginRoot(),
		truncator,
		getSessionCache,
		getSessionRuleScanCache,
		transcriptHydration,
		ruleFinderOptions: options?.skipClaudeUserRules
			? { skipClaudeUserRules: true }
			: undefined,
		onRuleSuppressed: resurfacing?.handleSuppressedRule,
		onRuleInjected: resurfacing?.noteInjected,
		shouldResurfaceRule: resurfacing?.shouldSurface,
	});

	function clearSessionState(sessionID: string, clearCollector = false): void {
		clearSessionCache(sessionID);
		clearSessionRuleScanCache(sessionID);
		transcriptHydration.clearSession(sessionID);
		resurfacing?.clearSession(sessionID);
		if (clearCollector) collector?.clear(sessionID);
		clearParsedRuleCache();
	}

	const toolExecuteAfter = async (
		input: ToolExecuteInput,
		output: ToolExecuteOutput,
	) => {
		resurfacing?.recordToolCall(input.sessionID);
		if (matchesTrackedTool(input.tool, TRACKED_TOOLS)) {
			const filePath = getRuleInjectionFilePath(output);
			if (!filePath) return;
			await processFilePathForInjection(filePath, input.sessionID, output);
			return;
		}
	};

	const toolExecuteBefore = async (
		input: ToolExecuteInput,
		output: ToolExecuteBeforeOutput,
	): Promise<void> => {
		void input;
		void output;
	};

	const eventHandler = async ({ event }: EventInput) => {
		const props = event.properties as Record<string, unknown> | undefined;

		if (event.type === "session.deleted") {
			const sessionID = resolveSessionEventID(props);
			if (sessionID) {
				clearSessionState(sessionID, true);
			}
			clearProjectRootCache();
		}

		if (event.type === "session.compacted") {
			const sessionID = resolveSessionEventID(props);
			if (sessionID) {
				clearSessionState(sessionID);
			}
			clearProjectRootCache();
		}
	};

	return {
		"tool.execute.before": toolExecuteBefore,
		"tool.execute.after": toolExecuteAfter,
		event: eventHandler,
	};
}
