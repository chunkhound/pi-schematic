import type { Usage } from "@earendil-works/pi-ai";
import { registeredState } from "../process-state.js";

export type ThinkingValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const CHILD_USAGE_BY_CALL_KEY = "pi-schematic.child-usage-by-call";
/** Advisory spawn notice type (backfill loss, event-subscription failure). Informational,
 * never a run error, so it must not reuse the workflow error entry type. */
export const SPAWN_NOTICE_ENTRY_TYPE = "spawn-notice";
/** Bound for the backfill map; a lost tool_result delivery must not leak without limit. */
export const MAX_CHILD_USAGE_ENTRIES = 100;
export type SpawnOutcome = "running" | "success" | "aborted" | "error";

export type SpawnRouteDetails =
	// provider/modelId are optional only to read sessions persisted before they were added;
	// every new write sets them so the ledger never splits one model across two rows.
	| { status: "inherited"; provider?: string; modelId?: string }
	| { status: "routed"; group: string; provider: string; modelId: string }
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

/** One error-path backfill record: the usage plus the child identity for spend attribution. */
export type ChildUsageRecord = { usage: Usage; provider: string | null; model: string };

// Child usage keyed by tool-call id. Success results carry usage directly; Pi
// builds error results itself, so the tool_result hook backfills from here.
// Invariant: pi emits a tool_result for every tool call, so every entry set on an
// error path is consumed and deleted by that hook before process teardown. No
// eager eviction is safe here: clearChildSession runs in the same finally that sets
// this entry, and deleting it early would break error-result usage attribution.
// Registered process-wide (process-state.ts): jiti can load this module twice, and
// the writer (executeSpawn) and reader (tool_result hook) must share one map.
export function childUsageByCall(): Map<string, ChildUsageRecord> {
	return registeredState(CHILD_USAGE_BY_CALL_KEY, () => new Map());
}

/** Drops every pending backfill entry; called when a session reset abandons in-flight calls. */
export function clearChildUsageBackfill(): void {
	childUsageByCall().clear();
}

/**
 * Bounded error-path usage record with oldest-first eviction; the tool_result hook consumes
 * entries. Returns the evicted key, if any, so callers can report the loss.
 */
export function recordChildUsage(map: Map<string, ChildUsageRecord>, toolCallId: string, record: ChildUsageRecord): string | null {
	if (!map.has(toolCallId) && map.size >= MAX_CHILD_USAGE_ENTRIES) {
		const oldest = map.keys().next();
		if (!oldest.done) {
			const evicted = oldest.value;
			map.delete(evicted);
			map.set(toolCallId, record);
			return evicted;
		}
	}
	map.set(toolCallId, record);
	return null;
}
