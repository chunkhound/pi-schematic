// WHY: the end-of-run overview is persisted as one `workflow-summary` custom entry and
// rendered by an entry renderer. This module owns the entry shape and the pure
// builder; `summary-renderer.ts` owns the TUI component. Keeping the builder free
// of TUI imports lets tests assert the persisted contract without a terminal.
import type { ModelSpend } from "../usage.js";
import { WORKFLOW_ENTRY_VERSION, isNewerWorkflowEntry, workflowEntryVersion, type WorkflowEffect, type WorkflowHandleName, type WorkflowLimits, type WorkflowRunMetrics } from "./types.js";

/** Custom-entry type of the end-of-run overview; the renderer registers the same name. */
export const WORKFLOW_SUMMARY_ENTRY_TYPE = "workflow-summary";

/** Persisted overview data. Read by the entry renderer and the run's audit trail. */
export interface WorkflowRunSummaryData {
	/** Persisted schema version. Missing on legacy entries, read as v1. */
	v: number;
	workflow: string;
	/** Workflow exit reason, a reserved abort reason, or `returned`. */
	reason: string;
	error?: string;
	startedAt: string;
	endedAt: string;
	elapsedMs: number;
	/** `workflow.checkpoint` calls that passed. */
	checkpoints: number;
	/** `workflow.run` calls. */
	steps: number;
	/** Assistant messages = real model round-trips; `turns >= steps`. */
	turns: number;
	/** `workflow.classify` calls. */
	classifySteps: number;
	/** Invocation count per counted handle; the detailed technical breakdown. */
	activity: Partial<Record<WorkflowHandleName, number>>;
	costUsd: number;
	/** Spend rows, highest cost first; they sum to `costUsd`. */
	spend: ModelSpend[];
	/** Soft targets the run was given; used to explain a soft stop's overshoot. */
	limits: WorkflowLimits;
	/** True when the workflow declares no checkpoint: no soft target could apply. */
	unbounded: boolean;
	/** Cost/time at the first target crossing; null when no target was crossed. */
	crossedAt: { costUsd: number; elapsedMs: number } | null;
	/** Last `workflow.checkpoint(...)` metadata when a limit stopped the run; absent otherwise. */
	partial?: unknown;
	/** Bounded effect log, for the expanded per-command activity list. Never sent to the LLM. */
	effects?: WorkflowEffect[];
}

export function buildWorkflowSummary(
	workflow: string,
	reason: string,
	error: string | undefined,
	metrics: WorkflowRunMetrics,
	partial?: unknown,
): WorkflowRunSummaryData {
	return {
		v: WORKFLOW_ENTRY_VERSION,
		workflow,
		reason,
		...(error ? { error } : {}),
		startedAt: new Date(metrics.startedAt).toISOString(),
		endedAt: new Date(metrics.startedAt + metrics.elapsedMs).toISOString(),
		elapsedMs: metrics.elapsedMs,
		checkpoints: metrics.checkpoints,
		steps: metrics.steps,
		turns: metrics.turns,
		classifySteps: metrics.classifySteps,
		activity: metrics.activity,
		costUsd: metrics.costUsd,
		spend: metrics.spend,
		limits: metrics.limits,
		unbounded: metrics.unbounded,
		crossedAt: metrics.crossedAt,
		...(metrics.effects.length > 0 ? { effects: metrics.effects } : {}),
		...(partial !== undefined ? { partial } : {}),
	};
}

/** Read a persisted summary, accepting legacy entries without `v`. Returns null for a
 * malformed or newer entry so the renderer can show a safe fallback instead of throwing. */
export function readWorkflowSummaryData(data: unknown): WorkflowRunSummaryData | null {
	if (!data || typeof data !== "object" || isNewerWorkflowEntry(data)) return null;
	const entry = data as Partial<WorkflowRunSummaryData>;
	if (typeof entry.workflow !== "string" || typeof entry.reason !== "string") return null;
	if (typeof entry.startedAt !== "string" || typeof entry.elapsedMs !== "number") return null;
	if (!Array.isArray(entry.spend) || !entry.limits || typeof entry.limits !== "object") return null;
	return {
		v: workflowEntryVersion(data) ?? WORKFLOW_ENTRY_VERSION,
		workflow: entry.workflow,
		reason: entry.reason,
		...(entry.error !== undefined ? { error: entry.error } : {}),
		startedAt: entry.startedAt,
		endedAt: entry.endedAt ?? new Date(Date.parse(entry.startedAt) + entry.elapsedMs).toISOString(),
		elapsedMs: entry.elapsedMs,
		checkpoints: entry.checkpoints ?? 0,
		steps: entry.steps ?? 0,
		turns: entry.turns ?? 0,
		classifySteps: entry.classifySteps ?? 0,
		activity: entry.activity ?? {},
		costUsd: entry.costUsd ?? 0,
		spend: entry.spend,
		limits: entry.limits,
		unbounded: entry.unbounded ?? false,
		crossedAt: entry.crossedAt ?? null,
		...(entry.partial !== undefined ? { partial: entry.partial } : {}),
		...(entry.effects !== undefined ? { effects: entry.effects } : {}),
	};
}
