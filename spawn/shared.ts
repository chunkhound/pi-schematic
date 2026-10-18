import type { ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type SpawnOutcome = "running" | "success" | "aborted" | "error";

export type SpawnRouteDetails =
	| { status: "inherited" }
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

/**
 * Returns all text blocks from the last assistant message, joined by newlines.
 */
export function getLastAssistantText(messages: AgentSession["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}
