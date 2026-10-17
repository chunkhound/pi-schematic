// WHY: one module derives every digest value from raw session entries so the host
// never duplicates usage/entry parsing. Pure: callers pass the branch in.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EntriesOptions, WorkflowEntry, StateDigest, RunModel } from "./types.js";

// AgentMessage widens to custom roles; the digest reads only these optional fields.
// Assistant entries record the model that answered; see pi's docs/session-format.md
// (ships in @earendil-works/pi-coding-agent, not this repo).
export type AnyMessage = { role?: string; content?: unknown; toolName?: string; provider?: string; model?: string; responseModel?: string; thinkingLevel?: string; stopReason?: string };
type ContentBlock = { type?: string; text?: string; name?: string };

/** Newest assistant message at an index strictly after `after` (default: whole branch).
 * Single owner for the backward assistant scan; host and run-registry call it. */
export function lastAssistant(entries: readonly SessionEntry[], after = -1): { index: number; message: AnyMessage } | null {
	for (let i = entries.length - 1; i > after; i--) {
		const entry = entries[i];
		if (entry.type === "message" && (entry.message as AnyMessage).role === "assistant")
			return { index: i, message: entry.message as AnyMessage };
	}
	return null;
}

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
function buildEntryDigest(entry: SessionEntry): WorkflowEntry {
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

export function buildEntryDigests(
	entries: readonly SessionEntry[],
	options: EntriesOptions,
): WorkflowEntry[] {
	// An unknown id throws: a typo must never read as the whole branch.
	let tail: readonly SessionEntry[];
	if (!options.after) {
		tail = entries;
	} else {
		const index = entries.findIndex((entry) => entry.id === options.after);
		if (index < 0) throw new Error(`workflow.entries: unknown after id "${options.after}"`);
		tail = entries.slice(index + 1);
	}
	// A cap must be a finite non-negative integer: NaN or a fraction would silently read as "no cap".
	const limit = options.limit;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
		throw new Error(`workflow.entries: limit must be a non-negative integer, got ${String(limit)}`);
	const capped = limit === undefined || limit >= tail.length ? tail : tail.slice(Math.max(0, tail.length - limit));
	return capped.map(buildEntryDigest);
}

/** The run's final assistant text; "" when the branch has none (send failure, empty run). */
export function lastAssistantText(entries: readonly SessionEntry[]): string {
	const found = lastAssistant(entries);
	return found ? contentText(found.message.content) : "";
}

/** The model that wrote a run's final assistant turn. WHY backwards scan: the settled run's
 * last assistant entry is the turn whose model the workflow attributes the result to.
 * WHY responseModel first: pi records it only when the provider answered with a model other
 * than the requested one (a fallback), and it names the model that actually wrote the turn. */
export function lastAssistantModel(branch: readonly SessionEntry[]): RunModel | null {
	const found = lastAssistant(branch);
	if (!found) return null;
	const model = found.message.responseModel ?? found.message.model;
	if (!model) return null;
	return {
		provider: found.message.provider ?? null,
		model,
		...(found.message.thinkingLevel ? { thinkingLevel: found.message.thinkingLevel } : {}),
	};
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
