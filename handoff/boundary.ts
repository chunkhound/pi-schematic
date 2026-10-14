/**
 * Handoff lifecycle: writes a staged handoff as one turn_end boundary.
 *
 * The handoff tool only stages its request. At the end of that turn the cut
 * (retain-none compaction), the successor message and a hidden system-prompt
 * note are returned as boundary drafts together with any notebook discard, and
 * the same run continues with the successor turn. Pi does not acknowledge a
 * boundary result — a later turn_end handler or draft validation can drop it —
 * so the handoff completes only once its cut is found on the branch, at the
 * next turn_start or when the run settles. Tool calls sharing the assistant
 * message with handoff are refused so nothing runs between staging and the cut.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { buildNotebookDiscardDrafts } from "../notebook/store.js";
import { reconstructNotebook } from "../notebook/rehydration.js";
import { clearActiveNotebookTopic } from "../notebook/topic.js";
import type { SchematicState, StagedHandoff } from "../state.js";
import { sendFollowUp } from "../follow-up.js";
import { STATUS_KEY_HANDOFF, updateIndicators } from "../tui.js";
import {
	HANDOFF_EXTRA_CALL_REFUSAL,
	HANDOFF_REQUESTED_STATUS,
	HANDOFF_REQUIRED_STATUS,
	HANDOFF_SIBLING_REFUSAL,
	HANDOFF_SUCCESSOR_NOT_RUN,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
	REASON_NO_BOUNDARY,
	REASON_RESULT_MISSING,
} from "./copy.js";
import { isHandoffEligible } from "./eligibility.js";
import {
	HANDOFF_FAILED_CUSTOM_TYPE,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SUCCESSOR_CUSTOM_TYPE,
	buildContinuationFrame,
	buildHandoffSystemPromptNote,
	buildNextUserMessage,
	formatHandoffComplete,
	formatHandoffFailure,
} from "./format.js";

const HANDOFF_TOOL_NAME = "handoff";

/**
 * Drafts that write `staged` as one boundary: notebook discard, cut, successor,
 * note. Pure — reads state and mutates nothing.
 */
export function buildHandoffBoundaryDrafts(
	state: SchematicState,
	staged: StagedHandoff,
): { drafts: SessionBoundaryDraft[]; discarded: number } {
	const notebook = buildNotebookDiscardDrafts(state, staged.discardPages);
	const discardRequested = staged.discardPages.length > 0;
	// Headless sessions have no UI report; the discard outcome rides in the
	// successor's details so the successor content stays the verbatim payload.
	const report = discardRequested
		? formatHandoffComplete(true, state.notebookPages.size - notebook.discarded, notebook.discarded)
		: undefined;
	const drafts: SessionBoundaryDraft[] = [
		...notebook.drafts,
		{
			type: "compaction",
			summary: buildContinuationFrame(),
			firstKeptEntryId: null,
			details: { handoff: true, handoffId: staged.handoffId },
		},
		{
			type: "custom_message",
			customType: HANDOFF_SUCCESSOR_CUSTOM_TYPE,
			content: buildNextUserMessage({ nextInstruction: staged.nextInstruction, context: staged.context }),
			display: true,
			details: report === undefined ? { handoffId: staged.handoffId } : { handoffId: staged.handoffId, report },
		},
		{
			type: "custom_message",
			customType: HANDOFF_NOTE_CUSTOM_TYPE,
			content: buildHandoffSystemPromptNote(),
			display: false,
			details: { handoffId: staged.handoffId },
		},
	];
	return { drafts, discarded: notebook.discarded };
}

/** The compaction entry on `branch` written for `handoffId`, if pi persisted it. */
export function findHandoffCut(branch: readonly SessionEntry[], handoffId: string): SessionEntry | undefined {
	return branch.find((entry) =>
		entry.type === "compaction" &&
		typeof entry.details === "object" && entry.details !== null &&
		(entry.details as Record<string, unknown>).handoffId === handoffId);
}

/** Settle the durable handoff state once the cut is confirmed on the branch. */
export function finalizeHandoffState(state: SchematicState): void {
	state.pendingRequestedHandoff = null;
	clearActiveNotebookTopic(state);
	// Readonly is live, not frozen into the summary: announce the ON posture on the
	// first post-handoff request. OFF-to-OFF stays silent; ON-to-OFF and OFF-to-ON are
	// covered by rehydration on session start and tree navigation.
	if (state.readonlyEnabled) state.readonlyNudgePending = true;
}

function completeHandoff(
	state: SchematicState,
	ctx: ExtensionContext,
	staged: StagedHandoff,
	branch: readonly SessionEntry[],
	successorRan: boolean,
): void {
	// Pages, epoch and watermark follow what pi actually persisted.
	reconstructNotebook(state, branch);
	finalizeHandoffState(state);
	state.stagedHandoff = null;
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
	if (successorRan) {
		ctx.ui.notify(formatHandoffComplete(staged.discardPages.length > 0, state.notebookPages.size, staged.discarded), "info");
	} else {
		ctx.ui.notify(HANDOFF_SUCCESSOR_NOT_RUN, "warning");
	}
	updateIndicators(ctx, state);
}

function notifyHandoffFailure(
	ctx: ExtensionContext,
	reason: string,
	pendingRequest: SchematicState["pendingRequestedHandoff"],
): void {
	if (!ctx.hasUI) return;
	if (pendingRequest && ctx.ui.theme) {
		const status = isHandoffEligible(ctx.getContextUsage())
			? HANDOFF_REQUIRED_STATUS
			: HANDOFF_REQUESTED_STATUS;
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", status));
	} else {
		ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
	}
	ctx.ui.notify(`Handoff failed: ${reason}. The handoff can be retried.`, "error");
}

function failStagedHandoff(
	pi: ExtensionAPI,
	state: SchematicState,
	ctx: ExtensionContext,
	reason: string,
	aborted: boolean,
): void {
	state.stagedHandoff = null;
	const pendingRequest = state.pendingRequestedHandoff;
	// The watchdog's agent_settled handler runs after this one and counts the
	// attempt against the enforcement budget.
	if (pendingRequest) pendingRequest.toolCalled = false;
	const guidance = formatHandoffFailure(reason, pendingRequest !== null);
	if (aborted) {
		// An abort is the user's stop: persist the guidance for the next run without
		// starting one.
		pi.sendMessage({ customType: HANDOFF_FAILED_CUSTOM_TYPE, content: guidance, display: true }, { triggerTurn: false });
	} else {
		sendFollowUp(pi, guidance);
	}
	notifyHandoffFailure(ctx, reason, pendingRequest);
}

function resolveStagedHandoff(
	pi: ExtensionAPI,
	state: SchematicState,
	ctx: ExtensionContext,
	at: "turn_start" | "agent_settled",
	settledAborted: boolean,
): void {
	const staged = state.stagedHandoff;
	if (!staged) return;
	switch (staged.phase) {
		case "staged":
			// turn_end always moves a staged handoff on, so only a settle can see it.
			if (at === "agent_settled") {
				failStagedHandoff(pi, state, ctx, settledAborted ? REASON_ABORTED : REASON_NO_BOUNDARY, settledAborted);
			}
			return;
		case "declined":
			if (staged.declineReason === null) throw new Error("Declined handoff has no decline reason.");
			failStagedHandoff(pi, state, ctx, staged.declineReason, staged.declineReason === REASON_ABORTED || settledAborted);
			return;
		case "submitted": {
			const branch = ctx.sessionManager.getBranch();
			if (findHandoffCut(branch, staged.handoffId)) {
				completeHandoff(state, ctx, staged, branch, at === "turn_start");
			} else {
				failStagedHandoff(pi, state, ctx, REASON_NOT_PERSISTED, settledAborted);
			}
			return;
		}
	}
}

function declineReason(event: TurnEndEvent, ctx: ExtensionContext, staged: StagedHandoff): string | null {
	if (ctx.signal?.aborted === true || event.outcome === "aborted") return REASON_ABORTED;
	if (event.outcome !== "completed") return REASON_RESULT_MISSING;
	const result = event.toolResults.find((toolResult) => toolResult.toolCallId === staged.toolCallId);
	if (!result || result.isError) return REASON_RESULT_MISSING;
	return null;
}

/**
 * Register every handoff lifecycle handler. Call before `registerWatchdog` (its
 * agent_settled handler counts a failed attempt only after this one reset
 * `toolCalled`) and before index.ts's readonly tool_call handler (sibling
 * refusal wins over a readonly block).
 */
export function registerHandoffBoundary(pi: ExtensionAPI, state: SchematicState): void {
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		state.handoffRefusals.clear();
		const calls = event.message.content.filter((block) => block.type === "toolCall");
		const first = calls.find((call) => call.name === HANDOFF_TOOL_NAME);
		if (!first) return;
		for (const call of calls) {
			if (call.id === first.id) continue;
			state.handoffRefusals.set(
				call.id,
				call.name === HANDOFF_TOOL_NAME ? HANDOFF_EXTRA_CALL_REFUSAL : HANDOFF_SIBLING_REFUSAL,
			);
		}
	});

	pi.on("tool_call", async (event) => {
		const reason = state.handoffRefusals.get(event.toolCallId);
		if (reason) return { block: true, reason, terminate: true };
		return undefined;
	});

	pi.on("turn_end", async (event, ctx) => {
		state.handoffRefusals.clear();
		const staged = state.stagedHandoff;
		if (!staged || staged.phase !== "staged") return undefined;
		const reason = declineReason(event, ctx, staged);
		if (reason !== null) {
			staged.phase = "declined";
			staged.declineReason = reason;
			return undefined;
		}
		const { drafts, discarded } = buildHandoffBoundaryDrafts(state, staged);
		staged.phase = "submitted";
		staged.discarded = discarded;
		// The batch terminated, so pi would not request again on its own; continuing
		// gives exactly one more turn in this run, and it sees the successor.
		return { entries: [...event.entries, ...drafts], continue: true };
	});

	// First handler point after the commit and before the successor's context
	// event, so request, topic and readonly nudge are settled for its first request.
	pi.on("turn_start", async (_event, ctx) => {
		resolveStagedHandoff(pi, state, ctx, "turn_start", false);
	});

	pi.on("agent_settled", async (event, ctx) => {
		// Pi 1.1 reports an aborted run here; 0.99.2 does not, and there an abort is
		// seen only by turn_end through ctx.signal (the run's signal is gone by now).
		const aborted = "aborted" in event && event.aborted === true;
		resolveStagedHandoff(pi, state, ctx, "agent_settled", aborted);
	});
}
