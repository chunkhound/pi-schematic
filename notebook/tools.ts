/**
 * Notebook tool definitions for the pi-schematic extension.
 *
 * Three tools: notebook_write (sequential, serialized write), notebook_read, notebook_index.
 * All read from the in-memory state.notebookPages Map and always return the current
 * list of page names in both result text and details.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { SchematicState } from "../state.js";
import { updateIndicators } from "../tui.js";
import { formatPageList, formatPagePreview, getPageNames, saveNotebookPage } from "./store.js";

// ── Parameter schemas ────────────────────────────────────────────────
// Extracted to const so type inference works through ToolDefinition<TParams>.

const notebookWriteParams = Type.Object({
	name: Type.String({
		description:
			"Kebab-case notebook page identifier. Prefer stable subject-oriented names; using an existing name overwrites that page (refinement).",
	}),
	content: Type.String({
		description:
			"Compact markdown for one notebook page. Capture only high-value knowledge for the current " +
			"work stream (user guidance, decisions, design, constraints); keep re-derivable code facts minimal. " +
			"Compact sections like Facts / Architecture / Decisions / Constraints / Open questions work well. Truncated at 50KB / 2000 lines.",
	}),
});

const notebookReadParams = Type.Object({
	name: Type.String({
		description: "Notebook page name to retrieve.",
	}),
});

const notebookIndexParams = Type.Object({});

type WriteArgs = Static<typeof notebookWriteParams>;
type ReadArgs = Static<typeof notebookReadParams>;
type IndexArgs = Static<typeof notebookIndexParams>;

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Creates notebook tool definitions (notebook_write, notebook_read, notebook_index).
 *
 * Shared by parent registration (withPromptHints=true) and child spawn
 * sessions (withPromptHints=false). The prompt hints (snippet, guidelines)
 * are only included for the parent — child agents don't need them.
 */
export function createNotebookToolDefinitions(
	pi: ExtensionAPI,
	state: SchematicState,
	options?: { withPromptHints?: boolean; isStale?: () => boolean },
): ToolDefinition[] {
	const withHints = options?.withPromptHints ?? false;
	const assertFresh = () => {
		if (options?.isStale?.()) {
			throw new Error("Spawn invalidated by reset.");
		}
	};

	const notebookWrite: ToolDefinition<typeof notebookWriteParams> = {
		name: "notebook_write",
		label: "Notebook Write",
		description:
			"Write or refine a compact notebook page that grounds future contexts. " +
			"One page covers one subject, thread, or subsystem. " +
			"Same name overwrites the previous page (refinement). " +
			"Writes are serialized via a process-local lock; same-name writes overwrite in completion order. " +
			"Always returns the current list of up to date pages.",
		...(withHints
			? {
					promptSnippet: "Write or refine a compact notebook page",
					promptGuidelines: [
						"Reuse or refine an existing page when possible.",
						"Prefer stable subject-oriented pages over workflow-phase pages.",
						"Don't hoard re-derivable code facts; store what can't be recovered from code (user guidance, decisions, design, scope).",
						"Write for a fresh context: keep reusable facts, architecture, decisions, constraints, expensive discoveries, and durable open questions.",
						"Avoid transient task state, scratch reasoning, transcripts, logs, or large tool output; the immediate next task belongs in handoff.",
					],
				}
			: {}),
		executionMode: "sequential",
		parameters: notebookWriteParams,
		renderCall(args: WriteArgs, theme, _context) {
			const preview = formatPagePreview(args.content).trim();

			let text = theme.fg("toolTitle", theme.bold("notebook_write ")) +
				theme.fg("accent", `"${args.name}"`);
			if (preview) {
				text += ": " + theme.fg("dim", preview);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context: { args: WriteArgs }) {
			const details = result.details as { entries: string[]; preview: string };

			let text = theme.fg("success", "\u2713 Saved ") + theme.fg("accent", `"${context.args.name}"`);
			if (details.preview) {
				text += ": " + theme.fg("dim", details.preview);
			}
			if (expanded) {
				text += "\n" + theme.fg("dim", details.entries.join("\n"));
			}
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params: WriteArgs, _signal, onUpdate, ctx) {
			assertFresh();
			const saved = await saveNotebookPage(pi, state, params.name, params.content, assertFresh);
			updateIndicators(ctx, state);

			onUpdate?.({
				content: [{
					type: "text" as const,
					text: `Saved "${params.name}"` + (saved.preview ? `: ${saved.preview}` : ""),
				}],
				details: { entries: saved.entries, preview: saved.preview },
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved notebook page "${params.name}".` +
							(saved.preview ? `\n${saved.preview}` : "") +
							`\n\nNotebook Pages:\n${formatPageList(state) || "(empty)"}`,
					},
				],
				details: { entries: saved.entries, preview: saved.preview },
			};
		},
	};

	const notebookRead: ToolDefinition<typeof notebookReadParams> = {
		name: "notebook_read",
		label: "Notebook Read",
		description:
			"Read a notebook page's full body by name. " +
			"Open one notebook page to recover state for that topic or thread. " +
			"Always returns the current notebook page names.",
		...(withHints
			? {
					promptSnippet: "Read a notebook page by name",
					promptGuidelines: [
						"Use notebook_read to ground a fresh context, resume a subject, or check prior findings.",
						"Open only relevant pages on demand; verify stale notes before relying on them.",
					],
				}
			: {}),
		parameters: notebookReadParams,
		renderResult(result, { expanded }, theme, context: { args: ReadArgs }) {
			const details = result.details as { entries: string[]; found: boolean; body?: string };
			if (!details.found) {
				return new Text(
					theme.fg("error", "\u2717 ") + theme.fg("muted", `"${context.args.name}" not found`),
					0,
					0,
				);
			}
			let text = theme.fg("success", "\u2713 ") + theme.fg("accent", `"${context.args.name}"`);
			if (expanded && details.body) {
				text += "\n" + theme.fg("toolOutput", details.body.trim());
			}
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params: ReadArgs, _signal, _onUpdate, _ctx) {
			assertFresh();
			const content = state.notebookPages.get(params.name);
			const names = getPageNames(state);

			if (content === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Notebook page "${params.name}" not found.` +
								`\n\nNotebook Pages:\n${formatPageList(state) || "(empty)"}`,
						},
					],
					details: { entries: names, found: false },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`--- ${params.name} ---\n${content}\n` +
							`---\nNotebook Pages:\n${formatPageList(state) || "(empty)"}`,
					},
				],
				details: { entries: names, found: true, body: content },
			};
		},
	};

	const notebookIndex: ToolDefinition<typeof notebookIndexParams> = {
		name: "notebook_index",
		label: "Notebook Index",
		description:
			"Scan the notebook index as name + first-line preview. " +
			"Use this like a pocket notebook index. " +
			"Always returns the current notebook page names.",
		...(withHints
			? {
					promptSnippet: "List pages via notebook index",
					promptGuidelines: [
						"Scan the index before new work, after handoff, before replanning, or when stuck.",
						"Use the index to find relevant memory pages, then open only those pages with notebook_read.",
					],
				}
			: {}),
		parameters: notebookIndexParams,
		renderResult(result, { expanded }, theme, _context) {
			const entries = (result.details as { entries: string[] }).entries;
			if (entries.length === 0) {
				return new Text(theme.fg("dim", "\u{1F4D2} (empty)"), 0, 0);
			}
			let text = theme.fg("muted", `\u{1F4D2} ${entries.length} page${entries.length === 1 ? "" : "s"}`);
			if (expanded) {
				text += "\n" + theme.fg("dim", entries.join("\n"));
			}
			return new Text(text, 0, 0);
		},

		async execute() {
			assertFresh();
			const names = getPageNames(state);
			return {
				content: [
					{
						type: "text" as const,
						text: `Notebook Pages:\n${formatPageList(state) || "(empty)"}`,
					},
				],
				details: { entries: names },
			};
		},
	};

	return [notebookWrite, notebookRead, notebookIndex];
}

// ── Registration ──────────────────────────────────────────────────────

export function registerNotebookTools(
	pi: ExtensionAPI,
	state: SchematicState,
): void {
	const tools = createNotebookToolDefinitions(pi, state, { withPromptHints: true });
	for (const tool of tools) {
		pi.registerTool(tool);
	}
}
