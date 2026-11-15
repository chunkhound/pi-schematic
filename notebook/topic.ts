import type { SchematicState } from "../state.js";

export type NotebookTopicSource = "human" | "agent";

export interface NotebookTopicBoundaryHint {
	from: string;
	to: string;
	source: NotebookTopicSource;
	/** Prevent repeated advisory nudges while waiting for handoff eligibility. */
	advisoryDelivered: boolean;
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

	const previous = state.activeNotebookTopic?.name ?? null;
	const changed = previous !== normalized;
	state.activeNotebookTopic = { name: normalized, source };

	const boundaryHint = changed && previous !== null ? { from: previous, to: normalized, source, advisoryDelivered: false } : null;
	// A repeated topic is no boundary, so it leaves a boundary still waiting for delivery in place.
	if (changed) {
		state.pendingTopicBoundaryHint = boundaryHint;
	}

	return {
		changed,
		previous,
		current: normalized,
		boundaryHint,
	};
}

export function clearActiveNotebookTopic(state: SchematicState): void {
	state.activeNotebookTopic = null;
	state.pendingTopicBoundaryHint = null;
}
