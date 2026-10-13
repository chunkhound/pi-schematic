export type ThinkingValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SpawnOutcome = "running" | "success" | "aborted" | "error";

export type SpawnRouteDetails =
	| { status: "inherited" }
	| {
		status: "routed";
		group: string;
		provider: string;
		modelId: string;
		degraded?: boolean;
		unavailableRefs?: Array<{ provider: string; modelId: string }>;
	}
	| { status: "unknown-fallback"; requestedGroup: string; provider: string; modelId: string };

export type SpawnResultDetails = {
	model: string;
	/** Effective child-session level after Pi applies model capability clamping. */
	thinking: ThinkingValue;
	truncated: boolean;
	outcome: SpawnOutcome;
	route?: SpawnRouteDetails;
	stats?: Record<string, number>;
	statsUnavailable?: boolean;
};

// Widen content to accept AgentMessage variants (UserMessage may have string content,
// AssistantMessage has (TextContent | ThinkingContent | ToolCall)[] content).
// Functions reading from AgentMessage[] arrays cast via this type at call sites.
type AssistantMessageLike = {
	role: string;
	content?: unknown;
	stopReason?: unknown;
};

/**
 * Returns all text blocks from the last assistant message, joined by newlines.
 */
export function getLastAssistantText(messages: AssistantMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const blocks = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
		const text = blocks
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}
