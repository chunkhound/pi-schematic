import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgenticodingState } from "../state.js";
import { getEffectiveModelGroups } from "./router.js";
import { MODALITY_FG, modalityLetterRun } from "./modality.js";
import type { ModelGroupModel, ResolvedModelGroup } from "./types.js";

const registeredUis = new WeakSet<object>();

function isUnavailable(group: ResolvedModelGroup, entry: ModelGroupModel): boolean {
	return group.validation.unavailableRefs.some((ref) => ref.provider === entry.provider && ref.modelId === entry.modelId);
}

function formatModelGroupRouteDetails(group: ResolvedModelGroup): string {
	if (group.models.length === 0) return "No models configured";
	return group.models
		.map((entry) => {
			const thinking = entry.thinkingLevel ?? "inherit";
			const unavailable = isUnavailable(group, entry) ? " (unavailable)" : "";
			return `${entry.provider}/${entry.modelId} • ${thinking}${unavailable}`;
		})
		.join("; ");
}

export type DescriptionColorizer = (color: ThemeColor, text: string) => string;

/**
 * Build one colored/muted single-letter capability run for a group, padded so
 * the subsequent per-model route column starts at the same offset across rows.
 * Handles an edge case where the group has no effective media modalities.
 */
function buildCapsLetters(group: ResolvedModelGroup, colorize: DescriptionColorizer): string {
	return modalityLetterRun(group.modalities?.effective, {
		render: (modality, letter) => colorize(MODALITY_FG[modality], letter),
		separator: colorize("muted", " "),
		// OpenRouter-style: text is the implied base, so only show I when image is
		// present; text-only rows keep the single T.
		hideTextWhenOtherMedia: true,
	});
}

/**
 * Assemble the `#`-mention tooltip description.
 *
 * With a colorizer: `T I  provider/model • thinking` — the colored media
 * letters (reasoning excluded) are padded to a fixed `capsWidth` column, then
 * the per-model route details in muted. The muted color is re-asserted after
 * every colored span and after the padding so the one-line row stays legible.
 *
 * Without a colorizer: the plain per-model route details are returned
 * unchanged (rows are inherently aligned to the left edge).
 */
function buildSuggestionDescription(route: string, letters: string, capsWidth: number, colorize?: DescriptionColorizer): string {
	if (!colorize) return route;
	const gap = colorize("muted", "  ");
	if (capsWidth === 0) return colorize("muted", route);
	const pad = Math.max(0, capsWidth - visibleWidth(letters));
	const padded = letters
		? `${letters}${colorize("muted", " ".repeat(pad))}`
		: colorize("muted", " ".repeat(capsWidth));
	return `${padded}${gap}${colorize("muted", route)}`;
}

export function createModelGroupAutocompleteProvider(state: AgenticodingState, colorize?: DescriptionColorizer) {
	return (current: any) => ({
		async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: unknown) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|[\t ])#([^\s#]*)$/);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const partial = (match[1] ?? "").toLowerCase();
			const groups = getEffectiveModelGroups(state.modelGroups.groups);
			const matched = groups.filter((group) => group.name.toLowerCase().startsWith(partial));
			const rows = matched.map((group) => ({
				value: `#${group.name}`,
				label: `#${group.name}`,
				route: formatModelGroupRouteDetails(group),
				letters: colorize ? buildCapsLetters(group, colorize) : "",
			}));
			// Align the route column across every visible suggestion row.
			const capsWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.letters)), 0);
			const items = rows.map((row) => ({
				value: row.value,
				label: row.label,
				description: buildSuggestionDescription(row.route, row.letters, capsWidth, colorize),
			}));
			return { prefix: `#${match[1] ?? ""}`, items };
		},

		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: unknown, prefix: string) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	});
}

export function registerModelGroupAutocomplete(ctx: ExtensionContext, state: AgenticodingState): void {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as unknown as {
		addAutocompleteProvider?: (factory: ReturnType<typeof createModelGroupAutocompleteProvider>) => void;
		theme?: { fg: (color: ThemeColor, text: string) => string };
	};
	if (typeof ui.addAutocompleteProvider !== "function") return;
	const key = ui as object;
	if (registeredUis.has(key)) return;
	registeredUis.add(key);
	// Lazy adapter so the colorizer reflects the live theme (not a snapshot).
	const colorize: DescriptionColorizer | undefined = ui.theme
		? (color, text) => ui.theme!.fg(color, text)
		: undefined;
	ui.addAutocompleteProvider(createModelGroupAutocompleteProvider(state, colorize));
}