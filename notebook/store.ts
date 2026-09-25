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

export async function saveNotebookPage(
	pi: ExtensionAPI,
	state: SchematicState,
	name: string,
	content: string,
	assertWritable?: () => void | Promise<void>,
): Promise<{ entries: string[]; preview: string }> {
	return withWriteLock(async () => {
		await assertWritable?.();
		const truncated = truncateHead(content, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		if (state.epoch === 0) {
			state.epoch = 1;
		}

		state.notebookPages.set(name, truncated.content);
		pi.appendEntry("notebook-entry", {
			version: 1,
			epoch: state.epoch,
			name,
			content: truncated.content,
		});

		return {
			entries: getPageNames(state),
			preview: formatPagePreview(truncated.content),
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
				pi.appendEntry("notebook-entry", { version: 1, epoch: nextEpoch, name, content });
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
	for (const name of pending.deleted) state.notebookPages.delete(name);
	state.pendingNotebookDiscard = null;
	state.discardEpochWatermark = 0;
}
