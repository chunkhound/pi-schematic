import { contentText, type ModelThinkingLevel, type StopReason, type TextContent, type Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type SpawnOutcome = "running" | "success" | "aborted" | "error";

/** Advisory spawn notice type (event-subscription failure). Informational, never a run
 * error, so it must not reuse the workflow error entry type. */
export const SPAWN_NOTICE_ENTRY_TYPE = "spawn-notice";

export type SpawnRouteDetails =
	// provider/modelId are optional only to read sessions persisted before they were added;
	// every new write sets them so the spend ledger never splits one model across two rows.
	| { status: "inherited"; provider?: string; modelId?: string }
	| { status: "routed"; group: string; provider: string; modelId: string }
	| { status: "unknown-fallback"; requestedGroup: string; provider: string; modelId: string };

export type SpawnResultDetails = {
	model: string;
	/** Effective child-session level after Pi applies model capability clamping. */
	thinking: ModelThinkingLevel;
	truncated: boolean;
	outcome: SpawnOutcome;
	route?: SpawnRouteDetails;
	stats?: Record<string, number>;
	statsUnavailable?: boolean;
};

export type SpawnToolResult = { content: TextContent[]; details: SpawnResultDetails; usage: Usage; isError?: true };

/** Maps the failure stop reasons to their outcome; every other stop reason has none. */
export function getStopReasonOutcome(stopReason: StopReason | undefined): SpawnOutcome | undefined {
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return undefined;
}

/**
 * Returns all text blocks from the last assistant message, joined by newlines.
 */
export function getLastAssistantText(messages: AgentSession["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = contentText(msg.content).trim();
		if (text) return text;
	}
	return "";
}
