// WHY: workflow shell effects run outside pi's tool pipeline (the host runs every
// effect as a direct call, never as a native tool row), so the LLM must never see them.
// Visibility is therefore UI-only: a live widget reuses pi's own `BashExecutionComponent`,
// and one `workflow-shell` CustomEntry per call is persisted for the transcript. Custom entries do not participate in LLM
// context, so the audit trail never pollutes the conversation.
import {
	BashExecutionComponent,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { workflowCard } from "./card.js";
import { safeAppendEntry } from "./errors.js";
import { WORKFLOW_ENTRY_VERSION, isNewerWorkflowEntry, type WorkflowEffect, type WorkflowEffectEvent } from "./types.js";

/** Custom-entry type of one shell audit row; the renderer registers the same name. */
export const WORKFLOW_SHELL_ENTRY_TYPE = "workflow-shell";
/** Custom-entry type carrying the workflow script's `console.log`/`text()` output. */
export const WORKFLOW_LOG_ENTRY_TYPE = "workflow-log";

const WIDGET_KEY = "workflow-activity";
const MAX_ENTRY_OUTPUT_LINES = 20;
// Cap the persisted preview: pi's display can reach ~50 KB, and one entry per shell call
// must not bloat the session file. The untruncated output stays in pi's temp file.
const MAX_ENTRY_OUTPUT_CHARS = 8 * 1024;

function boundedOutput(output: string | undefined): string | undefined {
	if (!output || output.length <= MAX_ENTRY_OUTPUT_CHARS) return output;
	return `\u2026\n${output.slice(-MAX_ENTRY_OUTPUT_CHARS)}`;
}

/**
 * Live shell view for one run. The widget is best-effort TUI; the per-call audit
 * entry always persists, including headless/RPC runs where no widget exists.
 */
export interface ShellActivity {
	onEffect(event: WorkflowEffectEvent): void;
	dispose(): void;
}

/** Read live so a `workflow.new` replacement reaches the current pi/context. */
export interface ShellActivityDeps {
	getPi: () => ExtensionAPI;
	getCtx: () => ExtensionCommandContext | null;
}

export function createShellActivity(deps: ShellActivityDeps): ShellActivity {
	let component: BashExecutionComponent | null = null;
	let tui: TUI | null = null;
	let mountedCtx: ExtensionCommandContext | null = null;
	let disposed = false;
	/** Complete-line prefix already fed to the component, so the next snapshot can be diffed. */
	let fed = "";

	/** Text up to the last \n: snapshots are append-only, so complete lines never change.
	 * A \r-redrawn partial line stays outside `fed`, so a progress bar never looks like
	 * head truncation and never triggers a remount. */
	const completePrefix = (display: string): string => {
		const cut = display.lastIndexOf("\n");
		return cut === -1 ? "" : display.slice(0, cut + 1);
	};

	const tuiCtx = (): ExtensionCommandContext | null => {
		const ctx = deps.getCtx();
		return ctx && ctx.hasUI && ctx.mode === "tui" ? ctx : null;
	};

	const mount = (command: string, initial: string): void => {
		const ctx = tuiCtx();
		if (!ctx) return;
		mountedCtx = ctx;
		fed = "";
		try {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(t) => {
					tui = t;
					component = new BashExecutionComponent(command, t);
					// Keep the invariant "component shows exactly `fed`": on a head-truncation
					// remount only complete lines are replayed, never the volatile partial tail.
					const replay = completePrefix(initial);
					if (replay) {
						component.appendOutput(replay);
						fed = replay;
					}
					return component;
				},
				{ placement: "aboveEditor" },
			);
		} catch {
			// A stale context mid-replacement drops the live view; the audit entry below still lands.
		}
	};

	const append = (display: string): void => {
		if (!component) return;
		const complete = completePrefix(display);
		if (fed && !complete.startsWith(fed)) {
			// pi's display truncates from the head once it overflows: remount with the full snapshot.
			mount(component.getCommand(), display);
			return;
		}
		const delta = complete.slice(fed.length);
		if (delta) component.appendOutput(delta);
		fed = complete;
	};

	/** Final feed: no further updates follow, so the trailing partial line can land too. */
	const flush = (display: string): void => {
		if (!component) return;
		if (!display.startsWith(fed)) mount(component.getCommand(), display);
		if (!component) return; // remount hit a stale context; the audit entry below still lands
		const tail = display.slice(fed.length);
		if (tail) component.appendOutput(tail);
		fed = display;
	};

	const onEffect = (event: WorkflowEffectEvent): void => {
		// A shell that outlives the run must not paint or persist after release: the run closed.
		if (disposed) return;
		if (event.effect.name !== "shell") return;
		if (event.phase === "start") {
			mount(event.effect.detail, "");
			return;
		}
		if (event.phase === "update") {
			append(event.display ?? "");
			tui?.requestRender();
			return;
		}
		// end: finish the component, then persist the audit row (LLM-invisible).
		flush(event.effect.output ?? "");
		// Advisory visibility: append before any UI paint, so a throwing render cannot
		// drop the mandatory audit row. A failed append never aborts the shell effect.
		safeAppendEntry(deps.getPi(), WORKFLOW_SHELL_ENTRY_TYPE, { v: WORKFLOW_ENTRY_VERSION, ...event.effect, output: boundedOutput(event.effect.output) });
		component?.setComplete(
			event.effect.exitCode ?? (event.effect.ok ? 0 : 1),
			Boolean(event.effect.killed),
			// The component reads only `truncated` from this shape, and pi's bash tool reports
			// truncation as a boolean, so the partial shape is intentional, not a mistake.
			event.effect.truncated ? ({ truncated: true } as TruncationResult) : undefined,
			event.effect.fullOutputPath,
		);
		tui?.requestRender();
	};

	const dispose = (): void => {
		disposed = true;
		component = null;
		tui = null;
		try {
			mountedCtx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Stale context: pi already dropped the widget when the session was replaced.
		}
		mountedCtx = null;
	};

	return { onEffect, dispose };
}

/** Read a persisted shell audit entry, accepting legacy entries without `v`. */
function readWorkflowShellEntry(data: unknown): WorkflowEffect | null {
	if (!data || typeof data !== "object" || isNewerWorkflowEntry(data)) return null;
	const effect = data as Partial<WorkflowEffect>;
	if (effect.name !== "shell" || typeof effect.detail !== "string") return null;
	if (typeof effect.id !== "number" || typeof effect.ok !== "boolean" || typeof effect.durationMs !== "number") return null;
	return effect as WorkflowEffect;
}

/** Transcript card for one persisted shell effect; expanded reveals the output tail. */
export function renderWorkflowShellEntry(
	entry: CustomEntry<unknown>,
	expanded: boolean,
	theme: Theme,
): Component {
	const effect = readWorkflowShellEntry(entry.data);
	if (!effect) {
		const fallback = isNewerWorkflowEntry(entry.data)
			? "This shell entry was written by a newer schematic version and cannot be read here."
			: "This shell entry is unreadable and was skipped.";
		return workflowCard(theme, theme.fg("accent", "$ workflow"), [theme.fg("warning", fallback)]);
	}
	const status = effect.ok
		? theme.fg("success", "ok")
		: theme.fg("error", effect.killed ? "killed" : `exit ${effect.exitCode ?? "?"}`);
	const header = `${theme.fg("accent", "$ ")}${theme.fg("text", effect.detail)}  ${status}  ${theme.fg("dim", `${effect.durationMs}ms`)}`;
	const rows: string[] = [];
	if (expanded && effect.output) {
		const lines = effect.output.split("\n").slice(-MAX_ENTRY_OUTPUT_LINES);
		rows.push(theme.fg("dim", lines.map((line) => `  ${line}`).join("\n")));
	}
	if (effect.truncated && effect.fullOutputPath) rows.push(theme.fg("warning", `  truncated; full output: ${effect.fullOutputPath}`));
	return workflowCard(theme, header, rows);
}

/** Text card for the workflow script's own console output; LLM-invisible. */
export function renderWorkflowLogEntry(
	entry: CustomEntry<{ text: string }>,
	expanded: boolean,
	theme: Theme,
): Component {
	const lines = ((entry.data as { text?: string } | undefined)?.text ?? "").split("\n");
	const shown = expanded ? lines : lines.slice(-MAX_ENTRY_OUTPUT_LINES);
	return workflowCard(theme, theme.fg("accent", "workflow log"), [theme.fg("dim", shown.map((line) => `  ${line}`).join("\n"))]);
}

export function registerWorkflowShellRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<unknown>(WORKFLOW_SHELL_ENTRY_TYPE, (entry, { expanded }, theme) =>
		renderWorkflowShellEntry(entry, expanded, theme),
	);
	pi.registerEntryRenderer<{ text: string }>(WORKFLOW_LOG_ENTRY_TYPE, (entry, { expanded }, theme) =>
		renderWorkflowLogEntry(entry, expanded, theme),
	);
}
