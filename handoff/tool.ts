/**
 * Handoff tool for the pi-schematic extension.
 *
 * The tool validates and stages the handoff, then ends the tool batch. The cut
 * itself — a compaction that keeps no earlier context, followed by the successor
 * message — is written at the end of the same turn (handoff/boundary.ts), and
 * the run continues with the successor.
 *
 * Two roles are kept strictly separate: the successor's `nextInstruction` is
 * carried by the extension (a human `/handoff` direction wins) and delivered
 * verbatim, while `context` is the model-owned situational remainder. Notebook
 * pages remain durable memory fetched on demand.
 * This context executes nothing from the instruction — it is discarded at the cut.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
	HANDOFF_ALREADY_STAGED,
	HANDOFF_IN_PROGRESS_STATUS,
	HANDOFF_STAGED_RESULT,
} from "./copy.js";
import { formatHandoffFailure } from "./format.js";
import {
	MIN_HANDOFF_TOKENS,
	estimateHandoffContextTokens,
	formatHandoffContextUsage,
	normalizeContextPercent,
} from "./eligibility.js";
import type { SchematicState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

/** Name the handoff tool is registered and called under. */
export const HANDOFF_TOOL_NAME = "handoff";

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

export function registerHandoffTool(
	pi: ExtensionAPI,
	state: SchematicState,
): void {
	pi.registerTool({
		name: HANDOFF_TOOL_NAME,
		label: "Handoff",
		// Never callable through ctx.executeTool(): a nested call carries an id that never reaches
		// the turn's tool results, so the boundary would always decline it.
		exposure: "model-only",
		description:
			"Clears the current context while keeping the notebook and clearing its topic.\n\n" +
			"WHEN TO USE:\n" +
			"  1. Context past ~30% and the current topic is no longer cleanly represented.\n" +
			"  2. Context is filled with mechanics irrelevant to what comes " +
			"next (research traces, planning deliberation, dead ends).\n" +
			"  3. The current topic is complete and a new distinct task starts.\n\n" +
			"Rule: one context, one topic. When the topic changes, call handoff.\n\n" +
			"AFTER HANDOFF the agent sees: the continuation frame, then one message holding the next " +
			"instruction verbatim plus the remaining context, then a short note about the system prompt, " +
			"and the current notebook with optional pages discarded.\n" +
			"Call handoff alone in its message: a handoff that shares a message with other tool calls is refused, and the other calls are handled on their own.\n",
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

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.stagedHandoff) throw new Error(HANDOFF_ALREADY_STAGED);
			const { nextInstruction, context } = resolveHandoffRequest(state, params);
			// The error result is the only report of a rejected call: a queued follow-up
			// would outlive this run and reach a later successor.
			try {
				validateHandoffRequest(nextInstruction, ctx);
			} catch (error) {
				if (!state.pendingRequestedHandoff || !(error instanceof Error)) throw error;
				throw new Error(formatHandoffFailure(error.message, true));
			}
			// Status first: a throwing UI call must leave no staged handoff behind.
			if (ctx.hasUI && ctx.ui.theme) {
				ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", HANDOFF_IN_PROGRESS_STATUS));
			}
			state.stagedHandoff = {
				handoffId: randomUUID(),
				toolCallId,
				nextInstruction,
				context,
				discardPages: [...new Set(params.discardPages ?? [])],
				phase: "staged",
				declineReason: null,
				discarded: 0,
			};
			if (state.pendingRequestedHandoff) state.pendingRequestedHandoff.toolCalled = true;

			return {
				content: [{ type: "text", text: HANDOFF_STAGED_RESULT }],
				details: {},
				terminate: true,
			};
		},

	});
}
