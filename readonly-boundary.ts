/**
 * Readonly topic boundary promotion logic.
 *
 * Boundary predicates and state transitions extracted from index.ts so the
 * context hook stays focused on message injection. A human-set topic boundary
 * in readonly mode that meets the
 * token eligibility threshold auto-activates the same handoff bypass that
 * explicit /handoff creates.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isHandoffEligible } from "./handoff/eligibility.js";
import { HANDOFF_REQUIRED_STATUS } from "./handoff/copy.js";
import { buildReadonlyBoundaryPromotionNotification } from "./notifications.js";
import type { SchematicState } from "./state.js";
import { STATUS_KEY_HANDOFF } from "./tui.js";

/** Can the queued human-set topic boundary be promoted to a handoff bypass right now? */
export function canPromoteBoundary(
	state: SchematicState,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
): boolean {
	const boundary = state.pendingTopicBoundaryHint;
	return boundary !== null && boundary.source === "human" && isHandoffEligible(usage);
}

/** Consume a boundary that cannot authorize a readonly handoff. */
export function discardNonHumanBoundary(state: SchematicState): boolean {
	const boundary = state.pendingTopicBoundaryHint;
	if (!boundary || boundary.source === "human") return false;
	state.pendingTopicBoundaryHint = null;
	return true;
}

/** Create pendingRequestedHandoff from the queued topic boundary and notify the user. */
export function promoteBoundary(state: SchematicState, ctx: ExtensionContext): void {
	state.pendingRequestedHandoff = {
		toolCalled: false,
		enforcementAttempts: 0,
		// A topic boundary carries no human direction, so the model must supply the instruction.
		nextInstruction: null,
	};
	if (ctx.hasUI) {
		if (ctx.ui.theme) {
			ctx.ui.setStatus(
				STATUS_KEY_HANDOFF,
				ctx.ui.theme.fg("accent", HANDOFF_REQUIRED_STATUS),
			);
		}
		ctx.ui.notify(buildReadonlyBoundaryPromotionNotification(), "warning");
	}
}

/**
 * Mark a human-set boundary as having delivered its advisory nudge.
 * Returns true the first time (so the caller knows to retain the hint for later
 * promotion); returns false on subsequent calls (already-advised, silent skip).
 */
export function markBoundaryAdvisory(state: SchematicState): boolean {
	const boundary = state.pendingTopicBoundaryHint;
	if (!boundary || boundary.source !== "human") return false;
	if (boundary.advisoryDelivered) return false;
	boundary.advisoryDelivered = true;
	return true;
}
