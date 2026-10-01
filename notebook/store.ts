/**
 * Shared notebook storage helpers.
 *
 * Keeps parent and spawned-child notebook writes on the same persistence path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import { createWriteLock, __setSingletons, getSingletons } from "../runtime-singletons.js";

/** Reset write lock state. Only for test cleanup after concurrent runs. */
export function resetNotebookWriteLock(): void {
	__setSingletons(
		{ ...getSingletons(), writeLock: createWriteLock() },
		{ forceWriteLock: true },
	);
}

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
	const s = getSingletons();
	const lock = s.writeLock;
	if (s.writeContext.getStore()) {
		throw new Error(
			"Notebook write lock is not reentrant — saveNotebookPage called from within its own critical section.",
		);
	}
	let release: () => void;
	const prev = lock.tail;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	lock.pending += 1;
	lock.tail = next;
	await prev;
	try {
		return await s.writeContext.run(true, fn);
	} finally {
		lock.pending -= 1;
		release!();
	}
}

export function getPageNames(state: SchematicState): string[] {
	return Array.from(state.notebookPages.keys()).sort();
}

export const PREVIEW_MAX_CHARS = 80;
const ELLIPSIS_LENGTH = 3;

export function formatPagePreview(content: string): string {
	const firstLine = content.split("\n")[0] ?? "";
	return firstLine.length > PREVIEW_MAX_CHARS
		? firstLine.slice(0, PREVIEW_MAX_CHARS - ELLIPSIS_LENGTH) + "..."
		: firstLine;
}

export function formatPageList(state: SchematicState): string {
	const names = getPageNames(state);
	if (names.length === 0) return "";

	return names
		.map((name) => {
			const content = state.notebookPages.get(name)!;
			return `  ${name}: ${formatPagePreview(content)}`;
		})
		.join("\n");
}

/**
 * Human-facing `/notebook` selector preview. Adds the TUI clipped badge on top
 * of the plain preview; the badge is TUI-only and must never be fed back into
 * model-visible text (`formatPagePreview`/`formatPageList` stay untouched).
 */
export function formatPageTuiPreview(content: string, clipped: boolean): string {
	const preview = formatPagePreview(content);
	if (!clipped) return preview;
	return preview ? `${preview} [truncated]` : "[truncated]";
}

/** Ephemeral write-time truncation account; never persisted. */
export interface TruncationReport {
	truncatedBy: "lines" | "bytes";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
}

export async function saveNotebookPage(
	pi: ExtensionAPI,
	state: SchematicState,
	name: string,
	content: string,
	assertWritable?: () => void | Promise<void>,
): Promise<{ entries: string[]; preview: string; truncation: TruncationReport | null; clipped: boolean }> {
	return withWriteLock(async () => {
		await assertWritable?.();
		const truncated = truncateHead(content, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// A first line that alone exceeds the byte cap cannot be represented by
		// head truncation. Reject before any epoch/page/persist mutation so the
		// prior page and its clipped flag stay intact.
		if (truncated.firstLineExceedsLimit) {
			throw new Error(
				`Notebook page "${name}" rejected: first line exceeds 50 KiB (51200 bytes). Split it into shorter lines or smaller pages.`,
			);
		}

		const clipped = truncated.truncated;
		const truncation: TruncationReport | null = clipped
			? {
					truncatedBy: truncated.truncatedBy === "bytes" ? "bytes" : "lines",
					totalLines: truncated.totalLines,
					totalBytes: truncated.totalBytes,
					outputLines: truncated.outputLines,
					outputBytes: truncated.outputBytes,
				}
			: null;

		if (state.epoch === 0) {
			state.epoch = 1;
		}

		state.notebookPages.set(name, truncated.content);
		if (clipped) state.clippedPages.add(name);
		else state.clippedPages.delete(name);
		pi.appendEntry("notebook-entry", {
			version: 1,
			epoch: state.epoch,
			name,
			content: truncated.content,
			clipped,
		});

		return {
			entries: getPageNames(state),
			preview: formatPagePreview(truncated.content),
			truncation,
			clipped,
		};
	});
}

/**
 * Stage a discard without making it visible to rehydration. The active epoch
 * marker is durable before survivor entries are staged; only commit appends the
 * next marker. An interrupted handoff therefore keeps the active branch on the
 * prior generation.
 *
 * The agent is idle during compaction, so no notebook writes occur between
 * prepare and commit; the next context starts only after commit advances the
 * epoch. A write in that window would be staged at the stale epoch and dropped
 * on rehydration.
 */
export async function prepareNotebookDiscard(
	pi: ExtensionAPI,
	state: SchematicState,
	generation: number,
	names: string[],
): Promise<string[]> {
	return withWriteLock(async () => {
		const deleted = [...new Set(names)].filter((name) => state.notebookPages.has(name));
		if (deleted.length === 0) return deleted;

		const nextEpoch = Math.max(state.epoch, state.discardEpochWatermark) + 1;
		state.discardEpochWatermark = nextEpoch;
		pi.appendEntry("notebook-generation", { version: 1, epoch: state.epoch });
		const deletedSet = new Set(deleted);
		for (const [name, content] of state.notebookPages) {
			if (!deletedSet.has(name)) {
				pi.appendEntry("notebook-entry", {
					version: 1,
					epoch: nextEpoch,
					name,
					content,
					clipped: state.clippedPages.has(name),
				});
			}
		}
		state.pendingNotebookDiscard = { generation, nextEpoch, deleted };
		return deleted;
	});
}

/** Commit a prepared discard after Pi reports compaction success. */export function commitNotebookDiscard(
	pi: ExtensionAPI,
	state: SchematicState,
	generation: number,
): void {
	const pending = state.pendingNotebookDiscard;
	if (!pending || pending.generation !== generation) return;
	pi.appendEntry("notebook-generation", { version: 1, epoch: pending.nextEpoch });
	state.epoch = pending.nextEpoch;
	for (const name of pending.deleted) {
		state.notebookPages.delete(name);
		state.clippedPages.delete(name);
	}
	state.pendingNotebookDiscard = null;
	state.discardEpochWatermark = 0;
}
