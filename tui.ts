/**
 * Shared TUI indicator updates for the pi-schematic extension.
 *
 * Extracted from index.ts so that tool execute handlers can push live
 * updates to the TUI during tool execution — not just at turn boundaries.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContextPercent } from "./handoff/eligibility.js";
import { READONLY_HANDOFF_TRIGGER } from "./notifications.js";
import type { SchematicState } from "./state.js";

// ── TUI status / widget keys ─────────────────────────────────────────

/** Status bar key for the handoff-in-progress indicator. */
export const STATUS_KEY_HANDOFF = "pi-schematic-handoff";

/** Widget key for the high-context warning banner above the editor. */
export const WIDGET_KEY_WARNING = "pi-schematic-warning";

/** Status bar key for context usage percentage. */
export const STATUS_KEY_CTX = "pi-schematic-ctx";

/** Status bar key for notebook page count. */
export const STATUS_KEY_NOTEBOOK = "pi-schematic-notebook";

/** Status bar key for the active notebook topic. */
export const STATUS_KEY_TOPIC = "pi-schematic-topic";

/** Status bar key for the readonly mode indicator. */
export const STATUS_KEY_READONLY = "pi-schematic-readonly";

/** Update TUI indicators: context usage, notebook count, topic, warning widget. */
export function updateIndicators(ctx: ExtensionContext, state: SchematicState): void {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;

	// Context usage
	const usage = ctx.getContextUsage();
	const percent = normalizeContextPercent(usage?.percent);
	if (percent !== null) {
		const pct = Math.round(percent);
		const tone = pct >= 70 ? "error" : pct >= 50 ? "warning" : pct >= 30 ? "accent" : "dim";
		ctx.ui.setStatus(STATUS_KEY_CTX, theme.fg("dim", "ctx ") + theme.fg(tone, `${pct}%`));
	} else {
		ctx.ui.setStatus(STATUS_KEY_CTX, theme.fg("dim", "ctx --%"));
	}

	// Notebook page count — show 📒 0 in dim tone when empty so the feature is discoverable
	const count = state.notebookPages.size;
	ctx.ui.setStatus(STATUS_KEY_NOTEBOOK, count > 0
		? `\u{1F4D2} ${count}`
		: theme.fg("dim", "\u{1F4D2} 0"),
	);

	// Readonly mode indicator
	ctx.ui.setStatus(
		STATUS_KEY_READONLY,
		state.readonlyEnabled ? theme.fg("warning", "\u{1F512} readonly") : undefined,
	);

	// Active notebook topic — show a dim placeholder when unset so the frame is discoverable
	ctx.ui.setStatus(
		STATUS_KEY_TOPIC,
		state.activeNotebookTopic
			? `\u{1F9ED} ${state.activeNotebookTopic}`
			: theme.fg("dim", "\u{1F9ED} -"),
	);

	// High-context warning widget (above editor)
	if (percent !== null && percent >= 70) {
		const pct = Math.round(percent);
		const warning = state.readonlyEnabled
			? `Context at ${pct}% — readonly: same topic → spawn; different topic → ${READONLY_HANDOFF_TRIGGER}`
			: state.activeNotebookTopic
				? `Context at ${pct}% — use topic fit: same topic → spawn, different topic → handoff`
				: `Context at ${pct}% — no active topic; handoff soon unless you can assign one cleanly`;
		ctx.ui.setWidget(WIDGET_KEY_WARNING, [
			theme.fg("error", "\u26A0 ") + theme.fg("warning", warning),
		]);
	} else {
		ctx.ui.setWidget(WIDGET_KEY_WARNING, undefined);
	}
}
