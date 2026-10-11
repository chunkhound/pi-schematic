// WHY: notebook reads are pure state lookups and the write buffers one compact
// preview so the next `workflow.run` can show what changed without injecting a
// custom_message mid-run. Persistence stays in notebook/store.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPagePreview, getPageNames, saveNotebookPage } from "../notebook/store.js";
import type { SchematicState } from "../state.js";
import type { NotebookPageInfo, NotebookTopic } from "./types.js";

export interface NotebookDeps {
	pi: ExtensionAPI;
	state: SchematicState;
	/** Host-owned buffer consumed by the next `workflow.run`. */
	bufferPreview: (preview: string) => void;
}

/** Pure inspector over persisted pages: names plus first-line previews, no provider work. */
export function notebookIndex(state: SchematicState): NotebookPageInfo[] {
	return getPageNames(state).map((name) => ({
		// getPageNames reads notebookPages.keys(), so the page is always present; no fallback.
		name,
		preview: formatPagePreview(state.notebookPages.get(name)!),
	}));
}

/**
 * Inspector over one persisted page. Throws instead of returning "" so a typo'd or
 * missing page is a visible error, not a silent read that hides the miss from the run.
 */
export function notebookRead(state: SchematicState, name: unknown): string {
	if (typeof name !== "string") throw new Error("workflow.notebookRead requires a string page name");
	const page = state.notebookPages.get(name);
	if (page === undefined) throw new Error(`workflow.notebookRead: no page named "${name}"`);
	return page;
}

export function buildNotebookWritePreview(name: string, preview: string): string {
	return `Notebook page "${name}" written: ${preview}`;
}

export function parseNotebookWrite(args: unknown): { name: string; content: string } {
	const value = args as { name?: unknown; content?: unknown } | null;
	if (!value || typeof value.name !== "string" || typeof value.content !== "string")
		throw new Error("workflow.notebookWrite requires { name, content } as strings");
	return { name: value.name, content: value.content };
}

/** Persist one page and buffer its preview for the next run. Returns null (JSON-safe). */
export async function notebookWrite(deps: NotebookDeps, args: unknown): Promise<null> {
	const { name, content } = parseNotebookWrite(args);
	const { preview } = await saveNotebookPage(deps.pi, deps.state, name, content);
	deps.bufferPreview(buildNotebookWritePreview(name, preview));
	return null;
}

/** Read-only inspector over the active topic; `source` records who set it (human wins). */
export function notebookTopic(state: SchematicState): NotebookTopic {
	return { topic: state.activeNotebookTopic, source: state.activeNotebookTopicSource };
}
