/**
 * Watchdog: primacy-zone reminder plus sticky enforcement for required handoff.
 *
 * Exposes nudge text generation and records the latest context usage at
 * `agent_end` for UI/state purposes. Actual reminder injection happens in the
 * `context` hook so it can appear before every LLM call in the same agent run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "./state.js";
import { isHandoffEligible, normalizeContextPercent } from "./handoff/eligibility.js";
import {
	READONLY_HANDOFF_RETRY_ADVICE,
	buildReadonlyHandoffWaitNotice,
	buildReadonlyRequestedHandoffContinuation,
} from "./notifications.js";
import { STATUS_KEY_HANDOFF } from "./tui.js";

/** Max turns a required handoff stays sticky before auto-clear.
 * 5 eligible turns gives the LLM ~2-3 response cycles to supply the instruction
 * and context, including one async compaction retry path where handoff/tool.ts
 * resets toolCalled=false after failure so enforcement can resume. */
export const MAX_HANDOFF_ATTEMPTS = 5;

type NudgeState = Pick<SchematicState, "activeNotebookTopic" | "pendingTopicBoundaryHint" | "readonlyEnabled" | "pendingRequestedHandoff">;

function buildRequestedHandoffNudge(state: NudgeState, eligible: boolean): string {
	if (!eligible) {
		const readonlyWait = state.readonlyEnabled
			? buildReadonlyHandoffWaitNotice()
			: "";
		return "A handoff is requested, but context is not yet ready for compaction. Continue working and retry handoff later." + readonlyWait;
	}
	const requestedHandoff = state.pendingRequestedHandoff!;
	const handoffArguments = requestedHandoff.nextInstruction === null
		? "the next instruction and the remaining context"
		: "only the remaining context";
	const readonlyContinuation = state.readonlyEnabled
		? buildReadonlyRequestedHandoffContinuation()
		: "The successor receives the instruction verbatim.";
	return `A real handoff is required in this session now.
Do not perform the new instruction here — this context is discarded at compaction.
Save durable findings to the notebook if needed, then call handoff with ${handoffArguments}.
${readonlyContinuation}`;
}

function buildHandoffCancellationNotice(readonly: boolean): string {
	const retryAdvice = readonly ? READONLY_HANDOFF_RETRY_ADVICE : "Use /handoff <direction> again to retry.";
	return `Required handoff cancelled after ${MAX_HANDOFF_ATTEMPTS} turns without completion. ${retryAdvice}`;
}

function buildBoundaryNudge(state: NudgeState, eligible: boolean): string {
	const boundary = state.pendingTopicBoundaryHint!;
	const action = eligible
		? "Prefer a deliberate handoff before continuing under the new topic: save durable findings to the notebook, then call handoff with the next instruction and the remaining context."
		: "Continue working until context is ready for handoff; this boundary remains advisory for now.";
	return `Notebook topic changed from ${boundary.from ?? "(unset)"} to ${boundary.to}.
Treat this as a strong task-boundary signal. ${action}
Only continue inline if this was merely a rename rather than a real pivot.`;
}


function buildDefaultNudge(pct: number | null, topic: string | null, eligible: boolean): string {
	const contextLead = pct === null
		? "Topic-aware context reminder."
		: pct >= 70
			? `Context at ${pct}% — topic discipline is urgent.`
			: pct >= 50
				? `Context at ${pct}% — topic discipline matters now.`
				: `Context at ${pct}% — choose your next step by topic fit.`;
	const pivotAdvice = eligible
		? "prefer a deliberate handoff"
		: "continue working until handoff is available";

	if (topic) {
		const urgency = pct !== null && pct >= 70
			? `If the work no longer fits this topic, ${pivotAdvice}. If it still fits and only a focused noisy branch is needed, spawn it instead of polluting the parent context.`
			: `If the current work still fits this topic, prefer spawn for isolated noisy subtasks. If it no longer fits, ${pivotAdvice} instead of dragging stale context forward.`;
		return `${contextLead}
Active notebook topic: ${topic}.
Use the topic as the current semantic frame. ${urgency}
Save durable findings to the notebook before handoff.`;
	}

	const noTopicUrgency = pct !== null && pct >= 70
		? eligible
			? "Assign a fresh topic in the next clean context after handoff."
			: "Assign a fresh topic now; continue working until handoff is available."
		: `Assign a short stable topic soon. If the work stays within that topic, prefer spawn for noisy subtasks. If the work shifts beyond it, ${pivotAdvice}.`;
	return `${contextLead}
No active notebook topic is set. ${noTopicUrgency}`;
}

/** Build a watchdog message using the caller's current handoff eligibility. */
export function buildNudge(state: NudgeState, percent: number | null, eligible: boolean): string {
	const pct = percent === null ? null : Math.round(percent);
	if (state.pendingRequestedHandoff) return buildRequestedHandoffNudge(state, eligible);
	if (state.pendingTopicBoundaryHint) return buildBoundaryNudge(state, eligible);
	return buildDefaultNudge(pct, state.activeNotebookTopic, eligible);
}

/**
 * Register the watchdog's `agent_end` handler.
 *
 * Must be called from the extension factory in index.ts after state creation.
 */
export function registerWatchdog(pi: ExtensionAPI, state: SchematicState): void {
	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		// ── Enforcement counter: prevent infinite handoff nudges ──
		// pendingRequestedHandoff is the sticky "user still expects a real
		// handoff" contract. It survives normal turns and even compaction-prep
		// failure recovery; only a successful handoff completion, reset, or maxed
		// retries should clear it.
		const requestedHandoff = state.pendingRequestedHandoff;
		if (requestedHandoff && !requestedHandoff.toolCalled && isHandoffEligible(ctx.getContextUsage())) {
			requestedHandoff.enforcementAttempts += 1;
			if (requestedHandoff.enforcementAttempts >= MAX_HANDOFF_ATTEMPTS) {
				const notice = buildHandoffCancellationNotice(state.readonlyEnabled);
				state.pendingRequestedHandoff = null;
				if (ctx.hasUI) {
					ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
					ctx.ui.notify(notice, "warning");
				}
			}
		}

		// ── Primacy-zone nudge ──────────────────────────────────────
		const usage = ctx.getContextUsage();
		const percent = normalizeContextPercent(usage?.percent);

		// Null or malformed usage — right after compaction or when the host cannot
		// provide a real percentage. Do not persist or display invalid values.
		if (percent === null) {
			state.lastContextPercent = null;
			return;
		}

		state.lastContextPercent = percent;

	});
}
