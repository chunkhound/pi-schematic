/**
 * Handoff tool for the pi-schematic extension.
 *
 * Tools can trigger compaction directly, so handoff is implemented as a
 * deliberate compaction that replaces noisy context with a clean restart frame.
 *
 * Two roles are kept strictly separate: the successor's `nextInstruction` is
 * carried by the extension (a human `/handoff` direction wins) and delivered
 * verbatim, while `context` is the model-owned situational remainder. Notebook
 * pages remain durable memory fetched on demand.
 * This context executes nothing from the instruction — it is discarded at compaction.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { clearActiveNotebookTopic } from "../notebook/topic.js";
import {
	HANDOFF_IN_PROGRESS_STATUS,
	HANDOFF_REQUESTED_STATUS,
	HANDOFF_REQUIRED_STATUS,
} from "./copy.js";
import { appendHandoffReport, buildNextUserMessage, type HandoffPayload } from "./format.js";
import {
	MIN_HANDOFF_TOKENS,
	estimateHandoffContextTokens,
	formatHandoffContextUsage,
	isHandoffEligible,
	normalizeContextPercent,
} from "./eligibility.js";
import type { SchematicState } from "../state.js";
import { sendFollowUp } from "../follow-up.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

function validateHandoffRequest(nextInstruction: string, ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	if (!nextInstruction) {
		const pct = normalizeContextPercent(usage?.percent);
		throw new Error(
			`Context at ${pct === null ? "?" : Math.round(pct) + "%"}. Empty handoff nextInstruction rejected. Save findings to notebook, then call handoff with the instruction the successor must execute.`,
		);
	}

	const approximateTokens = estimateHandoffContextTokens(usage);
	if (approximateTokens === null) {
		throw new Error(
			"Context usage unavailable; handoff rejected. Continue working and retry.",
		);
	}
	if (approximateTokens < MIN_HANDOFF_TOKENS) {
		const tokenLabel = formatHandoffContextUsage(usage);
		const percent = normalizeContextPercent(usage?.percent);
		const pctLabel = percent === null ? "?" : `~${Math.round(percent)}%`;
		throw new Error(
			`Context at ${pctLabel} (${tokenLabel}); handoff unavailable yet. Continue working and retry.`,
		);
	}
}

/**
 * Resolve the two handoff roles. The extension owns the instruction — a human
 * `/handoff <direction>` wins over anything the model offers — while the model owns
 * the situational `context`. Verbatim means no paraphrase: surrounding whitespace is
 * normalized here (like `context`), inner bytes preserved, and `buildNextUserMessage`
 * owns context normalization.
 */
function resolveHandoffRequest(
	state: SchematicState,
	params: { nextInstruction?: string; context?: string },
): { nextInstruction: string; context: string } {
	const humanDirection = state.pendingRequestedHandoff?.nextInstruction ?? null;
	return {
		nextInstruction: (humanDirection ?? params.nextInstruction ?? "").trim(),
		context: params.context ?? "",
	};
}

function completeHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	successorMessage: string,
	report?: string,
	level: "info" | "warning" = "info",
): void {
	const reportText = report ?? "Handoff complete. Fresh context resumes with the queued instruction.";
	if (ctx.hasUI) {
		try {
			ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
			ctx.ui.notify(reportText, level);
		} catch (reportError) {
			// UI completion report failed after compaction succeeded. Surface it
			// through the remaining reporting channel instead of swallowing it. The
			// instruction must still reach the successor, so the report rides along.
			const message = reportError instanceof Error ? reportError.message : String(reportError);
			sendFollowUp(pi, appendHandoffReport(successorMessage, `UI completion notification failed (${message}); ${reportText}`));
			return;
		}
		// The TUI already made the operational outcome visible. Keep the successor
		// message strictly to its instruction and model-owned context.
		sendFollowUp(pi, successorMessage);
		return;
	}
	// Headless sessions have no TUI report, so keep an explicit report with the
	// successor message. followUp queues it safely while compaction settles.
	sendFollowUp(pi, report ? appendHandoffReport(successorMessage, report) : successorMessage);
}

function notifyHandoffFailure(
	ctx: ExtensionContext,
	error: Error,
	pendingRequest: SchematicState["pendingRequestedHandoff"],
	phase = "Handoff compaction",
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
	ctx.ui.notify(`${phase} failed: ${error.message}. The handoff can be retried.`, "error");
}

function sendHandoffFailure(pi: ExtensionAPI, error: Error, pendingRequest: SchematicState["pendingRequestedHandoff"]): void {
	const nextStep = pendingRequest
		? "The required handoff remains pending; retry when context usage is eligible. "
		: "No required handoff remains pending; retry when ready. ";
	// The agent run is active during tool execution, so this guidance must queue as
	// a follow-up turn instead of being rejected as "already processing".
	sendFollowUp(pi, `Handoff failed — ${error.message}. ${nextStep.trim()}`);
}

function failHandoff(
	pi: ExtensionAPI,
	state: SchematicState,
	ctx: ExtensionContext,
	rawError: unknown,
): void {
	const error = rawError instanceof Error ? rawError : new Error(String(rawError));
	state.pendingHandoff = null;
	state.pendingHandoffDelivery = null;
	state.pendingNotebookDiscard = null;
	// An interrupted discard left staged survivors + a stray generation marker in
	// the branch; rehydration ignores them, so the orphaned entries are harmless.
	const pendingRequest = state.pendingRequestedHandoff;
	if (pendingRequest) pendingRequest.toolCalled = false;
	notifyHandoffFailure(ctx, error, pendingRequest);
	sendHandoffFailure(pi, error, pendingRequest);
}

function finalizeHandoffState(state: SchematicState): void {
	// Completion side of the two-phase clear contract (compact.ts clears
	// pendingHandoff at the cut). Every successful compaction finalizes the
	// remaining durable state — including when the discard commit failed.
	state.pendingHandoff = null;
	state.pendingHandoffDelivery = null;
	state.pendingRequestedHandoff = null;
	state.pendingNotebookDiscard = null;
	clearActiveNotebookTopic(state);
	// Readonly is live, not frozen into the summary: announce the ON posture on the
	// first post-handoff turn. OFF-to-OFF stays silent; ON-to-OFF and OFF-to-ON are
	// covered by rehydration on session start and tree navigation.
	if (state.readonlyEnabled) state.readonlyNudgePending = true;
}

function createHandoffCallbacks(
	pi: ExtensionAPI,
	state: SchematicState,
	ctx: ExtensionContext,
	generation: number,
	commitDiscard: (() => void) | undefined,
	discardRequested: boolean,
	payload: HandoffPayload,
	recoveryKey: string,
): { onComplete: () => void; onError: (error: unknown) => void } {
	let settled = false;
	const clearInFlight = () => {
		// Pair generation with handoffCompactionGeneration: only clear this
		// reservation if it is still the active one. A newer handoff will have
		// bumped handoffGeneration and set its own reservation.
		if (state.handoffCompactionGeneration !== generation) return;
		state.handoffCompactionGeneration = null;
		if (state.pendingHandoff?.generation === generation) state.pendingHandoff = null;
	};
	const isCurrent = () => state.handoffGeneration === generation;
	const complete = (report?: string, level: "info" | "warning" = "info") => {
		const successorMessage = buildNextUserMessage(payload);
		try {
			completeHandoff(pi, ctx, successorMessage, report, level);
			// A direct delivery is also an outstanding request: latch it so recovery
			// triggers cannot duplicate it before the run settles and persistence
			// proves delivery. Settle clears the latch (index.ts), after which the
			// branch scan is authoritative.
			state.recoveryRequestedMessage = { handoffEntryId: null, recoveryKey, message: successorMessage };
		} catch (error) {
			// Real Pi's sendUserMessage is fire-and-forget and never throws here; this
			// path guards a host that rejects synchronously. The persisted payload is the
			// recovery source, so complete the successful cut rather than retaining a stale
			// handoff bypass, topic, or readonly posture while recovery retries delivery.
			clearInFlight();
			if (isCurrent()) {
				finalizeHandoffState(state);
				notifyHandoffFailure(
					ctx,
					error instanceof Error ? error : new Error(String(error)),
					state.pendingRequestedHandoff,
					"Successor delivery",
				);
			}
			throw error;
		}
		clearInFlight();
		if (isCurrent()) finalizeHandoffState(state);
	};
	return {
		onComplete: () => {
			if (settled) return;
			settled = true;
			if (!isCurrent()) return;
			// Capture the discard outcome before commit clears the pending record.
			const discarded = state.pendingNotebookDiscard?.deleted.length ?? 0;
			// Commit the discard first, before any state mutation or reporting that
			// could throw. This ensures a post-commit failure never claims pages
			// were retained when the commit already succeeded.
			try {
				// Pi does not await compact callbacks. The next epoch becomes visible
				// only after compaction has succeeded.
				commitDiscard?.();
			} catch (commitError) {
				clearInFlight();
				if (!isCurrent()) return;
				// Compaction succeeded but the discard commit failed. Pages are retained;
				// the successor still receives an explicit warning before finalization.
				const message = commitError instanceof Error ? commitError.message : String(commitError);
				complete(`Handoff completed, but notebook discard was not persisted (${message}); retained all notebook pages.`, "warning");
				return;
			}
			// The payload remains recoverable until queue-safe delivery returns. Make
			// retention observable only after the successor has been accepted.
			complete(discardRequested
				? `Handoff complete. Notebook: ${state.notebookPages.size} page${state.notebookPages.size === 1 ? "" : "s"} kept` +
					(discarded > 0 ? `, ${discarded} discarded.` : ".")
				: undefined);
		},
		onError: (error) => {
			if (settled) return;
			settled = true;
			clearInFlight();
			if (isCurrent()) failHandoff(pi, state, ctx, error);
		},
	};
}

export function registerHandoffTool(
	pi: ExtensionAPI,
	state: SchematicState,
): void {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Clears the current context while keeping the notebook and clearing its topic.\n\n" +
			"WHEN TO USE:\n" +
			"  1. Context past ~30% and the current topic is no longer cleanly represented.\n" +
			"  2. Context is filled with mechanics irrelevant to what comes " +
			"next (research traces, planning deliberation, dead ends).\n" +
			"  3. The current topic is complete and a new distinct task starts.\n\n" +
			"Rule: one context, one topic. When the topic changes, call handoff.\n\n" +
			"AFTER HANDOFF the agent sees: the continuation frame, then one user message holding the next " +
			"instruction verbatim plus the remaining context, and the current notebook with optional pages discarded\n",
		promptSnippet: "Pivot to a new topic via deliberate handoff compaction",
		promptGuidelines: [
			"Handoff is preparation only: the successor executes the instruction, never this context. " +
				"Pass the instruction in nextInstruction (or rely on the stored /handoff direction) and do not act on it — this context is discarded at compaction.",
			"Before handoff, curate the notebook: save durable reusable knowledge, then write `context` with the situational remainder — current state, blockers, unresolved questions, failed paths worth avoiding, and the concrete next step. Do not repeat the instruction.",
			"Prune with discardPages: pages holding only recoverable code facts are discardable; " +
				"keep and refresh user guidance, decisions, design, and task scope.",
		],

		executionMode: "sequential",

		parameters: Type.Object({
			nextInstruction: Type.Optional(Type.String({
				description:
					"The instruction the successor must execute, verbatim.\n" +
					"Required only when no human `/handoff <direction>` direction is pending; when one is pending " +
					"the stored direction wins and this is ignored.\n" +
					"Never perform it here — this context is discarded at compaction.",
			})),
			context: Type.Optional(Type.String({
				description:
					"Situational context still missing from the notebook: current state, blockers, unresolved " +
					"questions, failed paths worth avoiding, and the concrete next step. Do not repeat the instruction.\n" +
					"The notebook holds reusable knowledge for this stream: user guidance, decisions, design, " +
					"constraints — plus code facts that are recoverable and discardable.",
			})),
			discardPages: Type.Optional(Type.Array(Type.String({
				description: "A notebook page name to discard.",
			}), {
				description:
					"Notebook page names to discard during this handoff. " +
					"Discard pages holding only recoverable code facts; keep non-recoverable knowledge (user guidance, decisions, design, task scope) unless superseded.",
			})),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.handoffCompactionGeneration !== null) {
				throw new Error("Handoff compaction already in progress; retry after it completes.");
			}
			const { nextInstruction, context } = resolveHandoffRequest(state, params);
			// validateHandoffRequest throws with a user-facing reason. Before the throw
			// reaches Pi (which will render a generic tool-error), send the richer
			// sendHandoffFailure message so the LLM gets actionable guidance. The
			// throw after this ensures Pi's tool-call lifecycle sees the rejection.
			try {
				validateHandoffRequest(nextInstruction, ctx);
			} catch (error) {
				sendHandoffFailure(pi, error instanceof Error ? error : new Error(String(error)), state.pendingRequestedHandoff);
				throw error;
			}
			const discardPages = [...new Set(params.discardPages ?? [])];
			const requestedHandoff = state.pendingRequestedHandoff;
			const generation = ++state.handoffGeneration;
			state.pendingHandoff = { generation };
			state.handoffCompactionGeneration = generation;
			if (requestedHandoff) requestedHandoff.toolCalled = true;
			// Built from the resolved fields, not the queue marker: compaction consumes
			// only the generation, while the successor's first turn always gets the message.
			const payload: HandoffPayload = { version: 1, nextInstruction, context };
			const recoveryKey = randomUUID();
			state.pendingHandoffDelivery = { generation, payload, recoveryKey };

			let commitDiscard: (() => void) | undefined;
			try {
				if (discardPages.length) {
					const store = await import("../notebook/store.js");
					await store.prepareNotebookDiscard(pi, state, generation, discardPages);
					commitDiscard = () => store.commitNotebookDiscard(pi, state, generation);
				}
				if (ctx.hasUI && ctx.ui.theme) {
					ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", HANDOFF_IN_PROGRESS_STATUS));
				}
				const callbacks = createHandoffCallbacks(pi, state, ctx, generation, commitDiscard, discardPages.length > 0, payload, recoveryKey);
				ctx.compact(callbacks);
			} catch (error) {
				const callbacks = createHandoffCallbacks(pi, state, ctx, generation, undefined, discardPages.length > 0, payload, recoveryKey);
				callbacks.onError(error);
				throw error;
			}

			return {
				content: [{ type: "text", text: "Handoff started." }],
				details: {},
				terminate: true,
			};
		},

	});
}
