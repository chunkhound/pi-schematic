/**
 * /handoff command for the pi-schematic extension.
 *
 * Stores the human direction as the successor's instruction, then asks the LLM to
 * prepare this context for the cut: curate the notebook and supply the remaining
 * situational context. The handoff tool performs the actual compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HANDOFF_REQUESTED_STATUS, HANDOFF_REQUIRED_STATUS } from "./copy.js";
import { isHandoffEligible } from "./eligibility.js";
import {
	READONLY_HANDOFF_EXCEPTION_NOTIFICATION,
	buildReadonlyHandoffCommandNotice,
} from "../notifications.js";
import type { SchematicState } from "../state.js";
import { STATUS_KEY_HANDOFF } from "../tui.js";

export function registerHandoffCommand(pi: ExtensionAPI, state: SchematicState): void {
	pi.registerCommand("handoff", {
		description:
			"Store the next context's instruction verbatim from your direction, have the LLM " +
			"curate the notebook and supply the remaining context, then perform the handoff automatically.",

		handler: async (args, ctx) => {
			const direction = args;
			if (!direction.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /handoff <direction>", "error");
				return;
			}

			if (state.handoffCompactionGeneration !== null) {
				throw new Error("Handoff compaction already in progress; wait for it to complete before requesting another handoff.");
			}
			// Invalidate queued work from an earlier request before replacing its intent.
			state.handoffGeneration++;
			state.pendingHandoff = null;
			state.pendingHandoffDelivery = null;
			state.pendingRequestedHandoff = {
				toolCalled: false,
				enforcementAttempts: 0,
				nextInstruction: direction,
			};

			if (ctx.hasUI && state.readonlyEnabled) {
				ctx.ui.notify(
					READONLY_HANDOFF_EXCEPTION_NOTIFICATION,
					"info",
				);
			}

			// Show live progress indicator in footer
			if (ctx.hasUI && ctx.ui.theme) {
				const status = isHandoffEligible(ctx.getContextUsage())
					? HANDOFF_REQUIRED_STATUS
					: HANDOFF_REQUESTED_STATUS;
				ctx.ui.setStatus(
					STATUS_KEY_HANDOFF,
					ctx.ui.theme.fg("accent", status),
				);
			}

			const readonlyNotice = state.readonlyEnabled
				? buildReadonlyHandoffCommandNotice()
				: "\n\nA real handoff is required in the current session. Do not continue normal work instead.";

			pi.sendUserMessage(
				`Handoff requested. The next context will execute this instruction verbatim:
<next-instruction>
${direction}
</next-instruction>

Do NOT start this instruction. This context is discarded at compaction, so acting on it now is wasted.

Preparation duties for this context:
1. Curate the notebook for what the instruction needs: refresh non-recoverable knowledge (user guidance, decisions, design, task scope) and discard pages holding only recoverable code facts.
2. Call the handoff tool with \`context\`: the situational context still missing from the notebook — current state, blockers, unresolved questions, failed paths worth avoiding, and the concrete next step. Do NOT repeat the instruction; it is already stored and will be delivered verbatim.${readonlyNotice}`,
				ctx.isIdle() ? undefined : { deliverAs: "followUp" },
			);
		},
	});
}
