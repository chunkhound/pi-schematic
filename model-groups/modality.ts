import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { MODEL_GROUP_MODALITIES, type ModelGroupModality } from "./types.js";

/**
 * Single-letter color/letter lexicon for a group's modality capabilities.
 * Shared by the model-groups TUI list and the `#`-mention autocomplete so both
 * render the same colored letters (T=text blue, I=image green, R=reasoning purple).
 */
export const MODALITY_FG: Record<ModelGroupModality, ThemeColor> = {
	text: "syntaxKeyword",
	image: "success",
	reasoning: "thinkingHigh",
};

export const MODALITY_LETTER: Record<ModelGroupModality, string> = {
	text: "T",
	image: "I",
	reasoning: "R",
};

export interface ModalityLetterRunOptions {
	/** Include the reasoning letter. Defaults to false, so capability rows omit R unless requested. */
	includeReasoning?: boolean;
	/**
	 * OpenRouter-style consolidation: when the visible media set contains any
	 * non-text modality (image), drop the text letter — text is the always-present
	 * base, so showing it alongside image is redundant. Text-only groups still
	 * render T. Default false (preserves the full-text-significant list rows).
	 */
	hideTextWhenOtherMedia?: boolean;
	/** Render one colored/letter token (e.g. a theme colorizer). Defaults to identity. */
	render?(modality: ModelGroupModality, letter: string): string;
	/** Separator between colored letters. Default " ". */
	separator?: string;
}

/**
 * Build a compact single-letter capability run for an effective modality set,
 * ordered per MODEL_GROUP_MODALITIES (text first). Reasoning is omitted unless
 * includeReasoning is set. Returns "" for an empty/absent set.
 */
export function modalityLetterRun(
	effective: readonly ModelGroupModality[] | null | undefined,
	options: ModalityLetterRunOptions = {},
): string {
	if (!effective || effective.length === 0) return "";
	const includeReasoning = options.includeReasoning ?? false;
	const hideTextWhenOtherMedia = options.hideTextWhenOtherMedia ?? false;
	const render = options.render ?? ((_modality: ModelGroupModality, letter: string) => letter);
	const separator = options.separator ?? " ";
	const seen = new Set(effective);
	const rendered: string[] = [];
	let hasOtherMedia = false;
	for (const modality of MODEL_GROUP_MODALITIES) {
		if (!seen.has(modality)) continue;
		if (!includeReasoning && modality === "reasoning") continue;
		if (modality !== "text") hasOtherMedia = true;
	}
	for (const modality of MODEL_GROUP_MODALITIES) {
		if (!seen.has(modality)) continue;
		if (!includeReasoning && modality === "reasoning") continue;
		if (hideTextWhenOtherMedia && modality === "text" && hasOtherMedia) continue;
		rendered.push(render(modality, MODALITY_LETTER[modality]));
	}
	if (rendered.length === 0) return "";
	return rendered.join(separator);
}