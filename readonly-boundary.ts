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
import { newRequestedHandoff, type SchematicState } from "./state.js";
import { STATUS_KEY_HANDOFF } from "./tui.js";

/**
 * Can the queued topic boundary be promoted to a handoff bypass right now? Only a
 * human `/notebook` topic change queues one: the agent's topic tool sets a topic only
 * when none is set.
 */
export function canPromoteBoundary(state: SchematicState, usage: ReturnType<ExtensionContext["getContextUsage"]>): boolean {
	return state.pendingTopicBoundaryHint !== null && isHandoffEligible(usage);
}

/** Create pendingRequestedHandoff from the queued topic boundary and notify the user. */
export function promoteBoundary(state: SchematicState, ctx: ExtensionContext): void {
	// A topic boundary carries no human direction, so the model must supply the instruction.
	state.pendingRequestedHandoff = newRequestedHandoff(null);
	if (ctx.hasUI) {
		if (ctx.ui.theme) {
			ctx.ui.setStatus(STATUS_KEY_HANDOFF, ctx.ui.theme.fg("accent", HANDOFF_REQUIRED_STATUS));
		}
		ctx.ui.notify(buildReadonlyBoundaryPromotionNotification(), "warning");
	}
}

/**
 * Mark the queued topic boundary as having delivered its advisory nudge.
 * Returns true the first time (so the caller knows to retain the hint for later
 * promotion); returns false on subsequent calls (already-advised, silent skip).
 */
export function markBoundaryAdvisory(state: SchematicState): boolean {
	const boundary = state.pendingTopicBoundaryHint;
	if (boundary === null || boundary.advisoryDelivered === true) {
		return false;
	}
	boundary.advisoryDelivered = true;
	return true;
}
