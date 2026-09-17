/**
 * Successor-message recovery after a deliberate handoff.
 *
 * Delivery is fire-and-forget (`pi.sendUserMessage` has no acknowledgement), so a
 * failed send is discovered by scanning the persisted branch: the newest handoff
 * compaction carries the exact payload, and its successor turn is the user message
 * built by `buildNextUserMessage`. Only when that message is absent does the caller
 * resend it. Recovery is trigger-driven, not autonomous: it runs on session_start,
 * session_tree, and a settled run, so a silently lost send heals on the next
 * user-triggered turn.
 *
 * Match rules:
 * - Pi persists user content as a string or content parts; extension sends become a
 *   single text part, so parts are joined to text before comparison.
 * - The headless variant appends an operational report after the payload prefix;
 *   that still counts as delivered.
 * - Only the newest handoff cut is considered. An unreadable payload there (older
 *   build, future version) means nothing is recovered, so an older superseded
 *   instruction is never resurrected.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { HANDOFF_REPORT_DELIMITER, buildNextUserMessage, type HandoffPayload } from "./format.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isHandoffCompaction(entry: SessionEntry): entry is Extract<SessionEntry, { type: "compaction" }> {
	return entry.type === "compaction" && isRecord(entry.details) && entry.details.handoff === true;
}

function getDetails(entry: SessionEntry): Record<string, unknown> | null {
	return isHandoffCompaction(entry) && isRecord(entry.details) ? entry.details : null;
}

function getPayload(entry: SessionEntry): HandoffPayload | null {
	const details = getDetails(entry);
	const payload = details?.payload;
	if (!isRecord(payload) || payload.version !== 1) return null;
	if (typeof payload.nextInstruction !== "string" || typeof payload.context !== "string") return null;
	return { version: 1, nextInstruction: payload.nextInstruction, context: payload.context };
}

function getRecoveryKey(entry: SessionEntry): string | null {
	const recoveryKey = getDetails(entry)?.recoveryKey;
	return typeof recoveryKey === "string" ? recoveryKey : null;
}

/** Join persisted content parts the way Pi normalizes array input for user messages. */
function extractMessageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function isDeliveredSuccessorMessage(content: string, message: string): boolean {
	return content === message || content.startsWith(message + HANDOFF_REPORT_DELIMITER);
}

function hasDeliveredMessage(entries: SessionEntry[], start: number, message: string): boolean {
	return entries.slice(start).some((entry) =>
		entry.type === "message" && entry.message.role === "user" &&
		isDeliveredSuccessorMessage(extractMessageText(entry.message.content), message),
	);
}

/** Undelivered successor message paired with the persisted cut that owns it. */
export interface UndeliveredHandoffMessage {
	handoffEntryId: string;
	recoveryKey: string | null;
	message: string;
}

/** Recover the newest handoff payload only when its successor turn is absent. */
export function getUndeliveredHandoffMessage(entries: SessionEntry[]): UndeliveredHandoffMessage | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isHandoffCompaction(entry)) continue;
		// The newest handoff cut owns recovery. An unreadable payload means there is
		// nothing to recover — never fall through to an older, superseded instruction.
		const payload = getPayload(entry);
		if (!payload) return null;
		const message = buildNextUserMessage(payload);
		// Always resend the bare payload: a recovered headless delivery deliberately
		// drops the operational report rather than re-announcing stale page counts.
		return hasDeliveredMessage(entries, index + 1, message)
			? null
			: {
				handoffEntryId: entry.id,
				recoveryKey: getRecoveryKey(entry),
				message,
			};
	}
	return null;
}
