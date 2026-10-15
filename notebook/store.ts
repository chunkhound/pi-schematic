/**
 * Shared notebook storage helpers.
 *
 * Keeps parent and spawned-child notebook writes on the same persistence path.
 */

import type { CustomEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/**
 * Render a byte limit as a binary unit with its exact byte count.
 * Derived from the applied limit so the user-facing cap cannot drift from the
 * truncation behavior.
 */
export function formatByteCap(bytes: number): string {
	for (const [unit, size] of [
		["MiB", 1024 * 1024],
		["KiB", 1024],
	] as const) {
		if (bytes % size === 0) return `${bytes / size} ${unit} (${bytes} bytes)`;
	}
	return `${bytes} bytes`;
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
				`Notebook page "${name}" rejected: first line exceeds ${formatByteCap(truncated.maxBytes)}. Split it into shorter lines or smaller pages.`,
			);
		}

		// A blank first line followed by an oversized line truncates to an empty
		// head. Reject it the same way instead of overwriting the prior body with
		// nothing (issue #42: never overwrite a page with nothing).
		if (truncated.truncated && truncated.outputBytes === 0) {
			throw new Error(
				`Notebook page "${name}" rejected: the first non-empty line exceeds ${formatByteCap(truncated.maxBytes)}, so truncation would retain no content. Split it into shorter lines or smaller pages.`,
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
 * Build the boundary drafts that discard `names` from the notebook. Pure: it
 * appends nothing and leaves state untouched; the handoff boundary writes the
 * drafts and rehydration applies them once they are on the branch.
 *
 * The active epoch marker comes first so a pass cut short after some survivors
 * keeps the branch on the prior generation; the next-epoch marker comes last.
 * The next epoch lies above the watermark, so it never reuses an epoch an
 * interrupted pass left behind.
 */
export function buildNotebookDiscardDrafts(
	state: SchematicState,
	names: readonly string[],
): { drafts: CustomEntryDraft[]; discarded: number } {
	const deleted = new Set(names.filter((name) => state.notebookPages.has(name)));
	if (deleted.size === 0) return { drafts: [], discarded: 0 };

	const nextEpoch = Math.max(state.epoch, state.discardEpochWatermark) + 1;
	const drafts: CustomEntryDraft[] = [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: state.epoch } },
	];
	for (const [name, content] of state.notebookPages) {
		if (deleted.has(name)) continue;
		drafts.push({
			type: "custom",
			customType: "notebook-entry",
			data: { version: 1, epoch: nextEpoch, name, content, clipped: state.clippedPages.has(name) },
		});
	}
	drafts.push({ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: nextEpoch } });
	return { drafts, discarded: deleted.size };
}
