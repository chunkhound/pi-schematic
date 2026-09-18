/**
 * Successor-message recovery after a deliberate handoff.
 *
 * Delivery is fire-and-forget (`pi.sendUserMessage` has no acknowledgement), so a
 * failed send is discovered from the active branch and durable session history:
 * the newest handoff compaction carries the exact payload, whose successor turn
 * is expected to be the user message built by `buildNextUserMessage`. Any user
 * turn after the cut ends recovery, and a matching successor retained outside
 * the active branch proves delivery while that turn is being edited. Only an
 * absent successor with no newer user turn is resent. Recovery is trigger-driven,
 * not autonomous: it runs on session_start, session_tree, and a settled run, so
 * a silently lost send heals on the next user-triggered turn.
 *
 * Supersession rules:
 * - Only the newest handoff cut is considered. An unreadable payload there (older
 *   build, future version) means nothing is recovered, so an older superseded
 *   instruction is never resurrected.
 * - A user turn after the cut — the delivered successor or a different message —
 *   ends recovery. Recovery never appends an obsolete instruction after newer
 *   user intent.
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

// Any persisted `role:user` entry counts as superseding — human or synthetic.
// A malformed message entry without content is not a user turn, so recovery
// proceeds instead of throwing.
function isUserTurn(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

function hasUserTurnAfterCut(entries: SessionEntry[]): boolean {
	return entries.some(isUserTurn);
}

function getMessageText(entry: SessionEntry): string | null {
	if (entry.type !== "message" || entry.message?.role !== "user") return null;
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function hasDeliveredSuccessor(entries: SessionEntry[], cutId: string, message: string): boolean {
	const cutIndex = entries.findIndex((entry) => entry.id === cutId);
	return cutIndex !== -1 && entries.slice(cutIndex + 1).some((entry) => {
		const content = getMessageText(entry);
		return content === message || content?.startsWith(message + HANDOFF_REPORT_DELIMITER) === true;
	});
}

/** Undelivered successor message paired with the persisted cut that owns it. */
export interface UndeliveredHandoffMessage {
	handoffEntryId: string;
	recoveryKey: string | null;
	message: string;
}

/** Recover the newest handoff payload only when it was never persisted. */
export function getUndeliveredHandoffMessage(
	entries: SessionEntry[],
	allEntries: SessionEntry[] = entries,
): UndeliveredHandoffMessage | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isHandoffCompaction(entry)) continue;
		// The newest handoff cut owns recovery. An unreadable payload means there is
		// nothing to recover — never fall through to an older, superseded instruction.
		const payload = getPayload(entry);
		if (!payload) return null;
		const message = buildNextUserMessage(payload);
		// Any user turn after the cut ends recovery: the successor itself proves
		// delivery, and a different turn means the user moved on. Resending the
		// instruction in either case would append obsolete intent to newer input.
		// Non-user entries are operational history, not a new instruction.
		if (hasUserTurnAfterCut(entries.slice(index + 1)) || hasDeliveredSuccessor(allEntries, entry.id, message)) return null;
		// Always resend the bare payload: a recovered headless delivery deliberately
		// drops the operational report rather than re-announcing stale page counts.
		return { handoffEntryId: entry.id, recoveryKey: getRecoveryKey(entry), message };
	}
	return null;
}
