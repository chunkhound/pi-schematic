/**
 * Notebook rehydration for the pi-schematic extension.
 *
 * `reconstructNotebook` rebuilds the in-memory notebook state from the active
 * session branch. It runs on session start and on session-tree navigation so
 * pages, the committed generation epoch, and the discard high-water mark
 * always follow the branch the agent is actually working on (branch-scoped
 * persistence). `ensureNotebookToolsActive` guarantees notebook_read /
 * notebook_index remain available after rehydration.
 */

import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface NotebookEntryData {
	version: number;
	epoch: number;
	name: string;
	content: string;
}

interface NotebookGenerationData {
	version: number;
	epoch: number;
}

interface NotebookCandidate {
	epoch: number;
	content: string;
}

// ── Rehydration entry types ───────────────────────────────────────────

const PAGE_ENTRY_TYPES = new Set(["notebook-entry", "ledger-entry"]);
const GENERATION_ENTRY_TYPE = "notebook-generation";

function isNotebookEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Accept version 1 (current) or absent (legacy); reject unknown future versions. */
function isKnownNotebookVersion(value: unknown): boolean {
	return value === undefined || value === 1;
}

// ── Reconstruction ────────────────────────────────────────────────────

/**
 * Rebuild `state.notebookPages`, `state.epoch`, and
 * `state.discardEpochWatermark` from a session branch.
 *
 * `state.epoch` stays the latest **committed** generation (the newest
 * `notebook-generation` marker). `state.discardEpochWatermark` is derived from
 * the maximum valid observed page/generation epoch — which includes survivor
 * entries staged by an interrupted discard that never committed. A restart (or
 * a retry on a restarted process) therefore cannot reuse that staged epoch and
 * resurrect orphaned survivors; the next prepare moves past it.
 */
export function reconstructNotebook(state: SchematicState, branch: readonly SessionEntry[]): void {
	// A generation is visible only after its marker is appended. Staged
	// survivor entries from an interrupted discard therefore cannot eclipse
	// the last durable notebook generation.
	let committedEpoch: number | null = null;
	let maxObservedEpoch = 0;
	for (const entry of branch) {
		if (entry?.type !== "custom") continue;
		const customEntry = entry as CustomEntry;
		if (customEntry.customType === GENERATION_ENTRY_TYPE) {
			const data = customEntry.data as NotebookGenerationData;
			if (isKnownNotebookVersion(data?.version) && isNotebookEpoch(data?.epoch)) {
				committedEpoch = Math.max(committedEpoch ?? 0, data.epoch);
				maxObservedEpoch = Math.max(maxObservedEpoch, data.epoch);
			}
			continue;
		}
		if (!PAGE_ENTRY_TYPES.has(customEntry.customType)) continue;
		const data = customEntry.data as NotebookEntryData;
		if (isKnownNotebookVersion(data?.version) && data?.name && typeof data.content === "string") {
			if (isNotebookEpoch(data.epoch)) {
				maxObservedEpoch = Math.max(maxObservedEpoch, data.epoch);
			}
		}
	}

	const currentEpoch = committedEpoch ?? maxObservedEpoch;
	state.epoch = currentEpoch;
	state.discardEpochWatermark = maxObservedEpoch;

	// Scan newest-to-oldest, retaining only the committed generation. This
	// order intentionally ignores newer staged entries for the same page.
	const candidates = new Map<string, NotebookCandidate>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom") continue;
		const customEntry = entry as CustomEntry;
		if (!PAGE_ENTRY_TYPES.has(customEntry.customType)) continue;
		const data = customEntry.data as NotebookEntryData;
		const epoch = isNotebookEpoch(data?.epoch) ? data.epoch : 0;
		if (!isKnownNotebookVersion(data?.version) || !data?.name || typeof data.content !== "string" || epoch !== currentEpoch || candidates.has(data.name)) continue;
		candidates.set(data.name, { epoch, content: data.content });
	}

	state.notebookPages.clear();
	for (const [name, candidate] of candidates) state.notebookPages.set(name, candidate.content);
}

/** Ensure notebook_read and notebook_index are active so the LLM can fetch pages. */
export function ensureNotebookToolsActive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	let changed = false;
	if (!active.includes("notebook_read")) {
		active.push("notebook_read");
		changed = true;
	}
	if (!active.includes("notebook_index")) {
		active.push("notebook_index");
		changed = true;
	}
	if (changed) pi.setActiveTools(active);
}

// ── Registration ──────────────────────────────────────────────────────

export function registerNotebookRehydration(
	pi: ExtensionAPI,
	state: SchematicState,
): void {
	pi.on("session_start", async (_event, ctx) => {
		reconstructNotebook(state, ctx.sessionManager.getBranch());
		ensureNotebookToolsActive(pi);
	});
}
