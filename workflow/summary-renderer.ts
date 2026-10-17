// WHY: the end-of-run overview must read at a glance. This module renders the
// persisted `workflow-summary` entry as a bordered card inside the transcript; the
// renderer runs only in interactive mode (HTML export included), so headless runs
// keep the entry as their record without needing a terminal.
import type { CustomEntry, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { formatCost, formatCompactTokens, formatElapsed, reasonLabel } from "../tui.js";
import { UNATTRIBUTED_MODEL } from "../usage.js";
import { workflowCard } from "./card.js";
import { WORKFLOW_SUMMARY_ENTRY_TYPE, type WorkflowRunSummaryData } from "./summary.js";
import { RESERVED_REASONS, type ReservedReason, type WorkflowHandleName } from "./types.js";

export const MAX_MODELS_COLLAPSED = 8;

/** Counted handles shown in the expanded detail ledger; the four headline counts stay on the `counts` row. */
export const DETAIL_LABELS: Partial<Record<WorkflowHandleName, string>> = {
	handoff: "handoff",
	shell: "shell",
	entries: "entries",
	notebookWrite: "notebook",
	readonly: "readonly",
	new: "new",
};

/** Handles whose counts are already on the headline row: run=steps, classify, checkpoint. */
export const HEADLINE_HANDLES = ["run", "classify", "checkpoint"] as const satisfies readonly WorkflowHandleName[];
/** Every handle the overview reports. A new counted handle must join one side; the test
 * pins this union so a new handle cannot disappear from both rows silently. */
export const COUNTED_HANDLES: readonly WorkflowHandleName[] = [
	...HEADLINE_HANDLES,
	...(Object.keys(DETAIL_LABELS) as WorkflowHandleName[]),
];

/** Map a free-form or reserved exit reason to a semantic tone. Reserved aborts stand out. */
export function reasonTone(reason: string): "error" | "warning" | "accent" {
	if (reason === "error") return "error";
	if ((RESERVED_REASONS as readonly string[]).includes(reason)) return "warning";
	return "accent";
}

/** The checkpoint payload is arbitrary JSON; compact one-line JSON keeps the row aligned. */
function formatPartial(partial: unknown): string {
	try {
		return JSON.stringify(partial) ?? String(partial);
	} catch {
		return String(partial);
	}
}

/** Always-visible headline rows; conditionals (target/error/stop) append below. */
function headlineRows(data: WorkflowRunSummaryData, theme: Theme): string[] {
	return [
		`${theme.fg("dim", "exit   ")}${theme.fg(reasonTone(data.reason), reasonLabel(data.reason))}`,
		`${theme.fg("dim", "time   ")}${theme.fg("text", formatElapsed(data.elapsedMs))}`,
		`${theme.fg("dim", "counts ")}${theme.fg("text", `checkpoints ${data.checkpoints}`)}${theme.fg(
			"dim",
			`   \u00B7   steps ${data.steps}   \u00B7   turns ${data.turns}   \u00B7   classify ${data.classifySteps}`,
		)}`,
		`${theme.fg("dim", "spend  ")}${theme.fg("accent", formatCost(data.costUsd))}`,
	];
}

// `partial` is the payload of the checkpoint where a limit/abort stopped the run; a null
// payload carries nothing, so the row appears only for a real value.
function stoppedRow(data: WorkflowRunSummaryData, theme: Theme): string | null {
	if (data.partial === undefined || data.partial === null) return null;
	return `${theme.fg("dim", "stopped")} ${theme.fg("muted", `at checkpoint ${formatPartial(data.partial)}`)}`;
}

/** Expanded-only rows: per-handle detail ledger, per-command effects, wall-clock bounds. */
function expandedRows(data: WorkflowRunSummaryData, theme: Theme): string[] {
	const rows = [detailRow(data, theme), ...effectRows(data, theme)].filter((row): row is string => row !== null);
	rows.push(`${theme.fg("dim", "start  ")}${theme.fg("muted", data.startedAt)}`);
	rows.push(`${theme.fg("dim", "end    ")}${theme.fg("muted", data.endedAt)}`);
	return rows;
}

function summaryRows(data: WorkflowRunSummaryData, expanded: boolean, theme: Theme): string[] {
	const rows = [...headlineRows(data, theme)];
	const target = targetRow(data, theme);
	if (target) rows.push(target);
	// Unbounded is expected, not a failure: an informative row, never a warning tone.
	if (data.unbounded) rows.push(`${theme.fg("dim", "limits ")}${theme.fg("muted", "unbounded \u2014 no checkpoint declared")}`);
	if (data.error) rows.push(`${theme.fg("dim", "error  ")}${theme.fg("error", data.error)}`);
	const stopped = stoppedRow(data, theme);
	if (stopped) rows.push(stopped);
	if (expanded) rows.push(...expandedRows(data, theme));
	return rows;
}

/** Expanded per-command ledger: the most recent effects, so shell calls are visible after a run. */
export const MAX_EFFECT_ROWS = 10;

function effectRows(data: WorkflowRunSummaryData, theme: Theme): string[] {
	const effects = data.effects ?? [];
	if (effects.length === 0) return [];
	const shown = effects.slice(-MAX_EFFECT_ROWS);
	const rows = shown.map((effect) => {
		const detail = effect.detail.length > 56 ? `${effect.detail.slice(0, 53)}...` : effect.detail;
		const status = effect.ok ? theme.fg("success", "ok") : theme.fg("error", "fail");
		const truncated = effect.truncated ? theme.fg("warning", " truncated") : "";
		return `  ${theme.fg("accent", "$ ")}${theme.fg("muted", detail)} ${status} ${theme.fg("dim", `${effect.durationMs}ms`)}${truncated}`;
	});
	const hidden = effects.length - shown.length;
	if (hidden > 0) rows.unshift(theme.fg("dim", `  \u2026 ${hidden} earlier`));
	return [theme.fg("dim", "effects"), ...rows];
}

/**
 * One-line overshoot forensics for a soft stop: what was asked, where it ended, and by how
 * much. Rendered only when a target was actually crossed, so other exits gain no noise.
 */
function targetRow(data: WorkflowRunSummaryData, theme: Theme): string | null {
	if (!data.crossedAt) return null;
	if (data.reason === ("cost-limit" satisfies ReservedReason) && data.limits.costLimit !== null) {
		return overshootRow(theme, formatCost, data.limits.costLimit, data.costUsd);
	}
	if (data.reason === ("time-limit" satisfies ReservedReason) && data.limits.timeBudgetMs !== null) {
		return overshootRow(theme, formatElapsed, data.limits.timeBudgetMs, data.elapsedMs);
	}
	return null;
}

/** `target X → actual Y (+delta, +pct%)`; one shape for every soft-limit kind. */
function overshootRow(theme: Theme, format: (value: number) => string, target: number, actual: number): string {
	const delta = actual - target;
	const overshoot = `(+${format(delta)}, +${Math.round((delta / target) * 100)}%)`;
	const from = theme.fg("muted", format(target));
	const to = theme.fg("accent", format(actual));
	return `${theme.fg("dim", "target ")}${from} \u2192 ${to}  ${theme.fg("dim", overshoot)}`;
}

/** Expanded ledger of the remaining counted handles; null when none were invoked. */
function detailRow(data: WorkflowRunSummaryData, theme: Theme): string | null {
	const parts: string[] = [];
	for (const [name, label] of Object.entries(DETAIL_LABELS) as Array<[WorkflowHandleName, string]>) {
		const count = data.activity[name] ?? 0;
		if (count > 0) parts.push(theme.fg("dim", `${label} ${count}`));
	}
	return parts.length > 0 ? `${theme.fg("dim", "detail ")}${parts.join(theme.fg("dim", " \u00B7 "))}` : null;
}

function modelRows(data: WorkflowRunSummaryData, expanded: boolean, theme: Theme): string[] {
	if (data.spend.length === 0) return [];
	const shown = expanded ? data.spend : data.spend.slice(0, MAX_MODELS_COLLAPSED);
	const width = Math.max(...shown.map((row) => row.key.length));
	const rows = shown.map((row) => {
		const attributed = row.model !== UNATTRIBUTED_MODEL;
		const label = theme.fg(attributed ? "muted" : "dim", row.key.padEnd(width));
		const tokens = theme.fg("dim", `${formatCompactTokens(row.inputTokens)} in \u00B7 ${formatCompactTokens(row.outputTokens)} out`);
		const line = `  ${label}   ${theme.fg("accent", formatCost(row.costUsd))}   ${tokens}`;
		if (!expanded) return line;
		const parts = [
			`cache ${formatCompactTokens(row.cacheReadTokens)}/${formatCompactTokens(row.cacheWriteTokens)}`,
			`${row.calls} ${row.calls === 1 ? "call" : "calls"}`,
		];
		return `${line}\n     ${theme.fg("dim", parts.join("  \u00B7  "))}`;
	});
	const hidden = data.spend.length - shown.length;
	if (hidden > 0) rows.push(theme.fg("dim", `  \u2026 ${hidden} more`));
	return rows;
}

export function renderWorkflowSummary(
	data: WorkflowRunSummaryData | undefined,
	expanded: boolean,
	theme: Theme,
): Component {
	const title = theme.fg("accent", theme.bold(`\u{1F6E0}\u{FE0F} workflow ${data?.workflow ?? ""}`));
	if (!data) return workflowCard(theme, title, []);
	const modelHeading = data.spend.length > 0 ? [theme.fg("dim", "by model")] : [];
	return workflowCard(theme, title, [...summaryRows(data, expanded, theme), ...modelHeading, ...modelRows(data, expanded, theme)]);
}

export function registerWorkflowSummaryRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<WorkflowRunSummaryData>(
		WORKFLOW_SUMMARY_ENTRY_TYPE,
		(entry: CustomEntry<WorkflowRunSummaryData>, { expanded }, theme) => renderWorkflowSummary(entry.data, expanded, theme),
	);
}
