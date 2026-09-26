import type { SchematicState } from "../state.js";

export type NotebookTopicSource = "human" | "agent";

export interface NotebookTopicBoundaryHint {
	from: string | null;
	to: string;
	source: NotebookTopicSource;
	/** Prevent repeated advisory nudges while waiting for handoff eligibility. */
	advisoryDelivered?: boolean;
}

export function normalizeNotebookTopic(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export function setActiveNotebookTopic(
	state: SchematicState,
	topic: string,
	source: NotebookTopicSource,
): { changed: boolean; previous: string | null; current: string; boundaryHint: NotebookTopicBoundaryHint | null } {
	const normalized = normalizeNotebookTopic(topic);
	if (!normalized) {
		throw new Error("Notebook topic cannot be empty.");
	}

	const previous = state.activeNotebookTopic;
	const changed = previous !== normalized;
	state.activeNotebookTopic = normalized;
	state.activeNotebookTopicSource = source;

	const boundaryHint = changed && previous !== null
		? { from: previous, to: normalized, source, advisoryDelivered: false }
		: null;
	state.pendingTopicBoundaryHint = boundaryHint;

	return {
		changed,
		previous,
		current: normalized,
		boundaryHint,
	};
}

export function clearActiveNotebookTopic(state: SchematicState): void {
	state.activeNotebookTopic = null;
	state.activeNotebookTopicSource = null;
	state.pendingTopicBoundaryHint = null;
}
