// WHY: one module derives every digest value from raw session entries so the host
// never duplicates usage/entry parsing. Pure: callers pass the branch in.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkflowEntry, StateDigest, RunModel } from "./types.js";

// AgentMessage widens to custom roles; the digest reads only these optional fields.
// Assistant entries record the model that answered; see pi's docs/session-format.md
// (ships in @earendil-works/pi-coding-agent, not this repo).
type AnyMessage = { role?: string; content?: unknown; toolName?: string; provider?: string; model?: string; responseModel?: string; thinkingLevel?: string };
type ContentBlock = { type?: string; text?: string; name?: string };

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text!)
		.join("");
}

function contentToolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return (content as ContentBlock[])
		.filter((block) => block?.type === "toolCall" && typeof block.name === "string")
		.map((block) => block.name!);
}

function messageToolNames(message: AnyMessage): string[] {
	if (message.role === "assistant") return contentToolNames(message.content);
	if (message.role === "toolResult" && message.toolName) return [message.toolName];
	return [];
}

function entryText(entry: SessionEntry): string {
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
	return "";
}

/** One compact entry for `workflow.entries`; tool-call names stay on assistant/toolResult rows. */
export function buildEntryDigest(entry: SessionEntry): WorkflowEntry {
	if (entry.type === "message") {
		const message = entry.message as AnyMessage;
		return {
			id: entry.id,
			role: message.role ?? "message",
			type: "message",
			text: contentText(message.content),
			toolNames: messageToolNames(message),
		};
	}
	return { id: entry.id, role: entry.type, type: entry.type, text: entryText(entry), toolNames: [] };
}

/** Entries strictly after `afterId`. An unknown id throws: a typo must never read as the whole branch. */
export function sliceAfter<T extends { id: string }>(entries: readonly T[], afterId: string | null | undefined): T[] {
	if (!afterId) return [...entries];
	const index = entries.findIndex((entry) => entry.id === afterId);
	if (index < 0) throw new Error(`workflow.entries: unknown after id "${afterId}"`);
	return entries.slice(index + 1);
}

/** A cap must be a finite non-negative integer: NaN or a fraction would silently read as "no cap". */
function validLimit(limit: number | undefined, available: number): number {
	if (limit === undefined) return available;
	if (!Number.isInteger(limit) || limit < 0) throw new Error(`workflow.entries: limit must be a non-negative integer, got ${String(limit)}`);
	return limit;
}

export function buildEntryDigests(
	entries: readonly SessionEntry[],
	options: { after?: string; limit?: number },
): WorkflowEntry[] {
	const after = sliceAfter(entries, options.after);
	const limit = validLimit(options.limit, after.length);
	const capped = limit >= after.length ? after : after.slice(after.length - limit);
	return capped.map(buildEntryDigest);
}

/** The run's final assistant text; "" when the branch has none (send failure, empty run). */
export function lastAssistantText(entries: readonly SessionEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && (entry.message as AnyMessage).role === "assistant")
			return contentText((entry.message as AnyMessage).content);
	}
	return "";
}

/** The model that wrote a run's final assistant turn. WHY backwards scan: the settled run's
 * last assistant entry is the turn whose model the workflow attributes the result to.
 * WHY responseModel first: pi records it only when the provider answered with a model other
 * than the requested one (a fallback), and it names the model that actually wrote the turn. */
export function lastAssistantModel(branch: readonly SessionEntry[]): RunModel | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || (entry.message as AnyMessage).role !== "assistant") continue;
		const message = entry.message as AnyMessage;
		const model = message.responseModel ?? message.model;
		if (!model) return null;
		return {
			provider: message.provider ?? null,
			model,
			...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
		};
	}
	return null;
}

/** Null-safe context-window percent; null when the provider exposed no usage. */
export function contextPercentOf(usage: { percent: number | null } | undefined): number | null {
	const percent = usage?.percent;
	return percent !== undefined && Number.isFinite(percent) ? percent : null;
}

export interface StateDigestInput {
	sessionId: string;
	leafId: string | null;
	branch: readonly SessionEntry[];
	/** Authoritative run cost, composed by the host from the same spend rows it reports. */
	cost: number;
	contextPercent: number | null;
	activeTools: readonly string[];
	readonly: boolean;
	notebookTopic: string | null;
	notebookTopicSource: "human" | "agent" | null;
	settledRuns: number;
}

/** One digest projection for `workflow.state`; every field derives from the branch at call time. */
export function buildStateDigest(input: StateDigestInput): StateDigest {
	return {
		sessionId: input.sessionId,
		leafId: input.leafId,
		messageCount: input.branch.filter((entry) => entry.type === "message").length,
		contextPercent: input.contextPercent,
		cost: input.cost,
		settledRuns: input.settledRuns,
		readonly: input.readonly,
		lastResponse: lastAssistantText(input.branch),
		activeTools: [...input.activeTools],
		notebookTopic: input.notebookTopic,
		notebookTopicSource: input.notebookTopicSource,
	};
}
