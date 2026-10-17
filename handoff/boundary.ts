/**
 * Handoff lifecycle: stages the request in the handoff tool, writes it as one
 * turn_end boundary, and completes only once the cut is found on the branch
 * with its successor after it and no later compaction.
 * Pi does not acknowledge a boundary result: a later turn_end handler or draft
 * validation can drop it.
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
import { STATUS_KEY_HANDOFF, updateIndicators } from "../tui.js";
import {
	HANDOFF_EXTRA_CALL_REFUSAL,
	HANDOFF_FAILED_IN_RUN_REFUSAL,
	HANDOFF_REQUESTED_STATUS,
	HANDOFF_REQUIRED_STATUS,
	HANDOFF_NOT_ALONE_REFUSAL,
	HANDOFF_SUCCESSOR_NOT_RUN,
	REASON_ABORTED,
	REASON_NOT_PERSISTED,
	REASON_NO_BOUNDARY,
	REASON_RESULT_MISSING,
	REASON_SUCCESSOR_NOT_PERSISTED,
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
	formatLostSuccessorFailure,
} from "./format.js";
import { HANDOFF_TOOL_NAME } from "./tool.js";
import { settleExhaustsHandoffBudget } from "../watchdog.js";

/**
 * Drafts that write `staged` as one boundary: notebook discard, cut, successor,
 * note. Pure — reads state and mutates nothing.
 */
function buildHandoffBoundaryDrafts(
	state: SchematicState,
	staged: StagedHandoff,
): { drafts: SessionBoundaryDraft[]; discarded: number } {
	const notebook = buildNotebookDiscardDrafts(state, staged.discardPages);
	const discardRequested = staged.discardPages.length > 0;
	// Headless sessions have no UI report; the discard outcome rides in the
	// successor's details so the successor content stays the verbatim instruction and context.
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

/** The `handoffId` of a handoff cut, or undefined for any other entry. */
function getHandoffId(entry: SessionEntry): string | undefined {
	if (entry.type !== "compaction") return undefined;
	const details: unknown = entry.details;
	if (typeof details !== "object" || details === null) return undefined;
	const { handoff, handoffId } = details as Record<string, unknown>;
	return handoff === true && typeof handoffId === "string" ? handoffId : undefined;
}

/** The compaction entry on `branch` written for `handoffId`, if pi persisted it. */
function findHandoffCut(branch: readonly SessionEntry[], handoffId: string): SessionEntry | undefined {
	// The cut sits at or near the leaf; scan from there.
	for (let index = branch.length - 1; index >= 0; index--) {
		if (getHandoffId(branch[index]) === handoffId) return branch[index];
	}
	return undefined;
}

/** The `handoffId` in a successor's details, or undefined when it has none. */
function successorHandoffId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const { handoffId } = details as Record<string, unknown>;
	return typeof handoffId === "string" ? handoffId : undefined;
}

/**
 * Whether the successor of `handoffId` follows `cut` on `branch` with no later
 * compaction, which would hide it from the model's context.
 */
function successorFollowsCut(branch: readonly SessionEntry[], cut: SessionEntry, handoffId: string): boolean {
	let found = false;
	for (const entry of branch.slice(branch.indexOf(cut) + 1)) {
		if (entry.type === "compaction") return false;
		if (entry.type === "custom_message" && entry.customType === HANDOFF_SUCCESSOR_CUSTOM_TYPE &&
			successorHandoffId(entry.details) === handoffId) found = true;
	}
	return found;
}

/** Settle the durable handoff state once the cut is confirmed on the branch. */
function finalizeHandoffState(state: SchematicState): void {
	state.pendingRequestedHandoff = null;
	clearActiveNotebookTopic(state);
	// Announce ON readonly on the first post-handoff request; rehydration covers other transitions.
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
): void {
	state.stagedHandoff = null;
	state.handoffFailedInRun = true;
	const request = state.pendingRequestedHandoff;
	// On the attempt that exhausts the enforcement budget the watchdog cancels the
	// request in this run's settle, so the failure must not call it pending.
	if (request) request.toolCalled = false;
	const exhausted = request !== null && settleExhaustsHandoffBudget(request);
	const pendingRequest = exhausted ? null : request;
	// Never start a run from here: a cause that drops every cut (another
	// extension's turn_end handler) would otherwise retry without bound.
	pi.sendMessage(
		{ customType: HANDOFF_FAILED_CUSTOM_TYPE, content: formatHandoffFailure(reason, pendingRequest !== null), display: true },
		{ triggerTurn: false },
	);
	notifyHandoffFailure(ctx, reason, pendingRequest);
}

/**
 * Fail a handoff whose cut landed without its successor in context. The context
 * is already cut, so the request is settled as after a completed cut and not
 * retried; the failure message carries the instruction. At turn_start the run is
 * aborted, so the continuation turn never reaches the model without an instruction.
 */
function failLostSuccessor(
	pi: ExtensionAPI,
	state: SchematicState,
	ctx: ExtensionContext,
	staged: StagedHandoff,
	branch: readonly SessionEntry[],
	at: "turn_start" | "agent_settled",
): void {
	reconstructNotebook(state, branch);
	finalizeHandoffState(state);
	state.stagedHandoff = null;
	state.handoffFailedInRun = true;
	const successor = buildNextUserMessage({ nextInstruction: staged.nextInstruction, context: staged.context });
	pi.sendMessage(
		{ customType: HANDOFF_FAILED_CUSTOM_TYPE, content: formatLostSuccessorFailure(REASON_SUCCESSOR_NOT_PERSISTED, successor), display: true },
		{ triggerTurn: false },
	);
	if (at === "turn_start") ctx.abort();
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
	ctx.ui.notify(`Handoff failed: ${REASON_SUCCESSOR_NOT_PERSISTED}. The instruction is in the failure message.`, "error");
	updateIndicators(ctx, state);
}

function resolveStagedHandoff(
	pi: ExtensionAPI,
	state: SchematicState,
	ctx: ExtensionContext,
	at: "turn_start" | "agent_settled",
): void {
	const staged = state.stagedHandoff;
	if (!staged) return;
	switch (staged.phase) {
		case "staged":
			// Still staged means no boundary was submitted (pi skipped turn_end, or building
			// the drafts threw); only a settle fails it.
			if (at === "agent_settled") {
				failStagedHandoff(pi, state, ctx, REASON_NO_BOUNDARY);
			}
			return;
		case "declined":
			if (staged.declineReason === null) throw new Error("Declined handoff has no decline reason.");
			failStagedHandoff(pi, state, ctx, staged.declineReason);
			return;
		case "submitted": {
			const branch = ctx.sessionManager.getBranch();
			const cut = findHandoffCut(branch, staged.handoffId);
			if (cut && successorFollowsCut(branch, cut, staged.handoffId)) {
				completeHandoff(state, ctx, staged, branch, at === "turn_start");
			} else if (cut) {
				failLostSuccessor(pi, state, ctx, staged, branch, at);
			} else {
				// A later turn_end handler can drop the cut but keep the notebook drafts.
				reconstructNotebook(state, branch);
				failStagedHandoff(pi, state, ctx, REASON_NOT_PERSISTED);
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
 * `toolCalled`) and before index.ts's readonly tool_call handler (a handoff
 * refusal wins over a readonly block).
 */
export function registerHandoffBoundary(pi: ExtensionAPI, state: SchematicState): void {
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		state.handoffRefusals.clear();
		const calls = event.message.content.filter((block) => block.type === "toolCall");
		const handoffCalls = calls.filter((call) => call.name === HANDOFF_TOOL_NAME);
		if (handoffCalls.length === 0) return;
		// Nothing is staged when another call shares the message, so those calls go
		// to their own handlers and their results, lacking terminate, keep the batch
		// from ending the run.
		const alone = handoffCalls.length === calls.length;
		for (const call of alone ? handoffCalls.slice(1) : handoffCalls) {
			state.handoffRefusals.set(call.id, alone ? HANDOFF_EXTRA_CALL_REFUSAL : HANDOFF_NOT_ALONE_REFUSAL);
		}
	});

	pi.on("tool_call", async (event) => {
		const reason = state.handoffRefusals.get(event.toolCallId) ??
			(event.toolName === HANDOFF_TOOL_NAME && state.handoffFailedInRun ? HANDOFF_FAILED_IN_RUN_REFUSAL : undefined);
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
		resolveStagedHandoff(pi, state, ctx, "turn_start");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		resolveStagedHandoff(pi, state, ctx, "agent_settled");
		state.handoffFailedInRun = false;
	});
}
