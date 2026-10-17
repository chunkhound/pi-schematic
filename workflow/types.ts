// WHY: one module owns every boundary type shared by the workflow runtime and its tests.
// The handle-name union is the single source of truth for the `workflow.<member>` surface.
import type { CodemodeSandbox, CodemodeSandboxOptions, CodemodeTool } from "@earendil-works/pi-codemode";
import type { ClassifierQuestion, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SchematicState, ChildUsageSink } from "../state.js";
import type { ModelSpend } from "../usage.js";
import type { ShellRun } from "./shell.js";

/**
 * Soft cost/time targets for one workflow run. Null means no target.
 * Crossing a target arms a deferred stop: the run ends at its next checkpoint, so the
 * final cost/time can exceed the target.
 */
export interface WorkflowLimits {
	/** Soft cumulative cost target across workflow sessions in USD, or null for none. */
	costLimit: number | null;
	/** Soft wall-clock target for the whole workflow in ms, or null for none. */
	timeBudgetMs: number | null;
	/** Explicit hard sandbox deadline in ms, set for a checkpoint-less run that passes
	 * `--workflow-time`; the sandbox kills the run at this deadline (recorded as `time-limit`).
	 * Null/absent means no explicit deadline: the sandbox derives its backstop from
	 * {@link timeBudgetMs}. */
	hardDeadlineMs?: number | null;
}

/** Host-reserved abort reasons. Workflow exit reasons must never reuse these. */
export type ReservedReason = "cost-limit" | "time-limit" | "cancelled" | "error";
/** Runtime form of the union; the single source every runtime check reads. */
export const RESERVED_REASONS = ["cost-limit", "time-limit", "cancelled", "error"] as const satisfies readonly ReservedReason[];
// Compile guard: adding a ReservedReason member without updating RESERVED_REASONS fails here.
type ReservedReasonsExhaustive = Exclude<ReservedReason, (typeof RESERVED_REASONS)[number]> extends never ? true : never;
const RESERVED_REASONS_EXHAUSTIVE: ReservedReasonsExhaustive = true;
void RESERVED_REASONS_EXHAUSTIVE;

/** Single exit-reason source: host + command derive the record reason here so a
 * controlled exit without a usable reason string is never reported as "returned". */
export function deriveExitReason(metadata: unknown): string {
	if (typeof metadata === "string") return metadata;
	if (metadata !== null && typeof metadata === "object" && typeof (metadata as { reason?: unknown }).reason === "string")
		return (metadata as { reason: string }).reason;
	if (metadata === null || metadata === undefined) return "returned";
	return JSON.stringify(metadata);
}

/** Transcript entry type of a run's single exit record; written append-first by the exit,
 * checkpoint, and hard-abort paths (docs/workflow-engine.md, Observable surfaces). */
export const WORKFLOW_EXIT_ENTRY_TYPE = "workflow-exit";
/** Transcript entry type of advisory engine-failure visibility; never carries the run outcome. */
export const WORKFLOW_ERROR_ENTRY_TYPE = "workflow-error";

/**
 * Wire shape of the single `workflow-exit` transcript entry. Every writer uses this shape:
 * `reason` is always derived first, and the path-specific payload rides in exactly one field.
 * A compatibility/version envelope is a deliberate follow-up; the type is the contract until then.
 */
export interface WorkflowExitEntry {
	/** Derived from the exit metadata before the write; the record's single reason source. */
	reason: string | null;
	/** `workflow.exit` metadata exactly as the workflow supplied it. */
	metadata?: unknown;
	/** Last checkpoint metadata salvaged by a checkpoint stop or a hard abort. */
	partial?: unknown;
	/** Host abort message for a hard abort (e.g. the deferred-stop escalation). */
	error?: string;
}

/** Structured diagnostic phase of a `workflow-error` entry; the single source for every
 * `phase` literal written into that entry. Run-scoped phases come from the command and the
 * limits dialog; `abort`/`effect`/`progress` come from the host's advisory reporters. */
export type WorkflowErrorPhase =
	| "start"
	| "reserve"
	| "exit-record"
	| "summary"
	| "cleanup"
	| "abort"
	| "effect"
	| "progress";
/** Ordered runtime form of the union. Nothing reads it yet; it exists so the compile guard
 * below fails when a member is added without updating this list. */
export const WORKFLOW_ERROR_PHASES = ["start", "reserve", "exit-record", "summary", "cleanup", "abort", "effect", "progress"] as const satisfies readonly WorkflowErrorPhase[];
// Compile guard: adding a WorkflowErrorPhase member without updating WORKFLOW_ERROR_PHASES fails here.
type WorkflowErrorPhasesExhaustive = Exclude<WorkflowErrorPhase, (typeof WORKFLOW_ERROR_PHASES)[number]> extends never ? true : never;
const WORKFLOW_ERROR_PHASES_EXHAUSTIVE: WorkflowErrorPhasesExhaustive = true;
void WORKFLOW_ERROR_PHASES_EXHAUSTIVE;

/**
 * Final exit outcome of one workflow run.
 * Exactly one exit record per finished run; headless runs included.
 */
export interface ExitRecord {
	/** Derived from the exit metadata by {@link deriveExitReason}; a checkpoint stop records the reserved stop reason instead. */
	reason: string | undefined;
	/** `workflow.exit` metadata exactly as the workflow supplied it. */
	metadata: unknown;
	/** Last checkpoint metadata salvaged by a checkpoint stop or a hard abort. */
	partial?: unknown;
	/** True when the exit was triggered at a checkpoint by a deferred stop, not by `workflow.exit`. */
	checkpoint?: boolean;
	/** Host abort message (e.g. the deferred-stop escalation); reaches the exit entry and the summary. docs/workflows.md (Exit). */
	error?: string;
}

/** One stop outcome, the single input the host turns into both the `workflow-exit` entry and
 * the {@link ExitRecord}. `reason` is fully derived before the call: a workflow reason, a
 * reserved token, or `returned`. */
export interface ExitOutcome {
	reason: string;
	/** `workflow.exit` metadata exactly as the workflow supplied it. */
	metadata?: unknown;
	/** Last checkpoint metadata salvaged by a checkpoint stop or a hard abort. */
	partial?: unknown;
	/** Host abort message for a hard abort or an infrastructure failure. */
	error?: string;
	/** True when the run stopped at a checkpoint due to a deferred target stop. */
	checkpoint?: boolean;
}

/**
 * Last safe exit point reached; salvaged as the run's partial result on any later stop.
 * The engine stops at a checkpoint, never mid-effect, so the metadata is always consistent.
 */
export interface CheckpointRecord {
	metadata: unknown;
	at: number;
}

/**
 * Compact JSON digest of the active conversation.
 * The workflow reads this to control context growth and make decisions.
 */
export interface StateDigest {
	sessionId: string;
	leafId: string | null;
	messageCount: number;
	contextPercent: number | null;
	cost: number;
	settledRuns: number;
	readonly: boolean;
	lastResponse: string;
	activeTools: string[];
	notebookTopic: string | null;
	notebookTopicSource: "human" | "agent" | null;
}

/**
 * Structured output contract for one `workflow.run` call.
 * Presence arms the host-owned `workflow_output` tool for the run only.
 */
export interface StructuredOutputRequest {
	/** JSON Schema object the submitted value must match. Omit to accept any JSON object. */
	schema?: Record<string, unknown>;
	/** Extra model-facing guidance appended to the output tool's description for this run. */
	instructions?: string;
}

/**
 * Options for one `workflow.run` call.
 * Model and thinking overrides apply for the run and restore after.
 */
export interface RunOptions {
	/** Extra text appended to the prompt line. */
	args?: string;
	/** Extra context appended as a fenced block (text or JSON). */
	input?: unknown;
	/** Chat model override, set for the run and restored after. */
	model?: { provider: string; id: string };
	/** Thinking level override, set for the run and restored after. */
	thinking?: string;
	/** Request structured output. When set, the run resolves with `output`, or rejects. */
	output?: StructuredOutputRequest;
}

/**
 * The model that produced a settled run's final assistant turn.
 * The host derives it from the branch entry, so group-routed turns report the concrete member,
 * not the requested group. `model` is the provider's id; `provider` is null only when unrecorded.
 */
export interface RunModel {
	provider: string | null;
	model: string;
	thinkingLevel?: string;
}

/**
 * Result of one settled `workflow.run` call.
 * Entry IDs bound the settled run; usage sums the run's entries.
 */
export interface RunResult {
	text: string;
	fromEntryId: string | null;
	toEntryId: string | null;
	/** Aggregated usage of the entries the settled run appended. */
	usage: Usage;
	/** Conversation digest captured after the run settled. */
	state: StateDigest;
	/** Model of the run's final assistant turn; null when the branch names none. */
	model: RunModel | null;
	/** Validated object from the injected output tool. Present iff `options.output` was set. */
	output?: unknown;
}

/**
 * Result of one `workflow.shell` call.
 * `ok` mirrors pi's bash-tool error flag; the mapping lives in workflow/shell.ts (toShellResult), pinned by docs/workflows.md (workflow.shell).
 */
export interface ShellResult {
	ok: boolean;
	exitCode: number | null;
	/** Programmatic output (pi's structured content, up to 1 MiB, sanitized). */
	output: string;
	/** pi's display text (last lines / 50 KB); for the UI, not the workflow. */
	display: string;
	truncated: boolean;
	killed: boolean;
	/** Temp file holding the untruncated output; present only when truncated. */
	fullOutputPath?: string;
	wallTimeSeconds?: number;
}

/**
 * Options for one `workflow.shell` call.
 * Readonly applies the bash guard without changing the run posture.
 */
export interface ShellOptions {
	/** Apply the readonly bash guard to this call without changing the run posture. */
	readonly?: boolean;
	/** Timeout in seconds, matching pi's bash tool. */
	timeout?: number;
}

/**
 * Snapshot returned by `workflow.budget()`. Remaining values measure to the soft targets,
 * not to a hard stop: they can reach zero while the run still continues to its next checkpoint.
 * A null remainder means no target; null survives JSON round trips, unlike an infinity sentinel.
 * WARNING: in JS `null <= 0` is true, so authors must null-check a remainder before any
 * `<= 0` comparison, or an unset target reads as exhausted.
 */
export interface Budget {
	cost: number;
	/** Remaining to the soft cost target; null when no target (null-check before `<= 0`). */
	costRemaining: number | null;
	/** Remaining to the soft time target; null when no target (null-check before `<= 0`). */
	timeRemainingMs: number | null;
}

export interface ClassifierRequest {
	model: { provider: string; id: string };
	state: Record<string, unknown>;
	questions: Record<string, ClassifierQuestion>;
}

export interface WorkflowEntry {
	id: string;
	role: string;
	type: string;
	text: string;
	toolNames: string[];
}

export interface EntriesOptions {
	/** Only entries strictly after this entry id. */
	after?: string;
	/** Keep at most this many of the newest matching entries. */
	limit?: number;
}

export interface NotebookPageInfo {
	name: string;
	preview: string;
}

export interface NotebookTopic {
	topic: string | null;
	source: "human" | "agent" | null;
}

export type WorkflowHandleName =
	| "run"
	| "handoff"
	| "classify"
	| "shell"
	| "state"
	| "entries"
	| "notebookIndex"
	| "notebookRead"
	| "notebookWrite"
	| "notebookTopic"
	| "budget"
	| "readonly"
	| "new"
	| "checkpoint"
	| "exit";

/** Live progress of one workflow run, read by the command's status ticker. */
export interface WorkflowProgress {
	/** `workflow.checkpoint` calls that passed; the human-readable progress marker. */
	checkpoints: number;
	costUsd: number;
	elapsedMs: number;
	/** Armed deferred stop: the named soft target was crossed and the run ends at its next checkpoint. */
	pendingStop: ReservedReason | null;
	/** The configured soft targets, so the bar can show current-vs-target. */
	limits: WorkflowLimits;
	/** True when the workflow declares no checkpoint: no soft target can stop it, so the
	 * surfaces show an unbounded indicator instead of a checkpoint count. */
	unbounded: boolean;
	/** Detail of the effect currently running (shell command, run prompt); null between effects. */
	currentEffect: string | null;
}

/** Final run metrics for the end-of-run overview. */
export interface WorkflowRunMetrics {
	/** Epoch ms when the run began. */
	startedAt: number;
	elapsedMs: number;
	/** `workflow.checkpoint` calls that passed. */
	checkpoints: number;
	/** `workflow.run` calls (the user's definition of a workflow step). */
	steps: number;
	/** Assistant messages = real model round-trips; `turns >= steps` because one run may loop. */
	turns: number;
	/** `workflow.classify` calls. */
	classifySteps: number;
	/** Invocation count per counted handle; the detailed technical breakdown. */
	activity: Partial<Record<WorkflowHandleName, number>>;
	costUsd: number;
	/** Spend rows, highest cost first; they sum to `costUsd`. */
	spend: ModelSpend[];
	/** The soft targets the run was given; carried into the overview for target-vs-final. */
	limits: WorkflowLimits;
	/** True when the workflow declares no checkpoint: the overview states the run was unbounded. */
	unbounded: boolean;
	/** Cost/time when the first soft target was crossed; null when none was. Overshoot forensics. */
	crossedAt: { costUsd: number; elapsedMs: number } | null;
	/** Bounded log of effect calls, for the end-of-run overview. Never sent to the LLM. */
	effects: WorkflowEffect[];
}

/**
 * One completed workflow effect, kept for user visibility only.
 * The host never sends it to the LLM; it feeds the overview and, for shell, the transcript entry.
 */
export interface WorkflowEffect {
	id: number;
	name: WorkflowHandleName;
	/** Human-readable detail: the shell command, run prompt, classifier keys. */
	detail: string;
	ok: boolean;
	durationMs: number;
	/** Shell only: process exit code (null when killed or never started). */
	exitCode?: number | null;
	/** Shell only: killed by abort/timeout. */
	killed?: boolean;
	/** Shell only: output was truncated and a full-output file exists. */
	truncated?: boolean;
	fullOutputPath?: string;
	/** Shell only: bounded display preview. */
	output?: string;
}

export type WorkflowEffectPhase = "start" | "update" | "end";

/** Pushed while an effect runs; the host never formats UI text. */
export interface WorkflowEffectEvent {
	phase: WorkflowEffectPhase;
	effect: WorkflowEffect;
	/** Shell streaming snapshot for the live view. */
	display?: string;
}

export interface WorkflowHost {
	/** Host-owned cancellation signal, wired to the sandbox and the active model turn. */
	readonly signal: AbortSignal;
	abort(reason: ReservedReason, message?: string): void;
	/** The single writer of the `workflow-exit` entry and {@link ExitRecord}. Append-first: a
	 * failed append aborts with `abortReason` and leaves the exit unset, so the infra path can
	 * still record the run's single exit. A call after a recorded exit is a no-op. */
	recordExit(outcome: ExitOutcome, abortReason: ReservedReason, messagePrefix?: string): void;
	/** The `workflow.<member>` handles exposed to the sandbox. */
	globals(): CodemodeTool[];
	exitRecord(): ExitRecord | null;
	/** Last `workflow.checkpoint(...)` metadata, or null when none was reached. */
	checkpointRecord(): CheckpointRecord | null;
	abortedReason(): ReservedReason | null;
	/** Snapshot of the current run state for the footer status and working message. */
	progress(): WorkflowProgress;
	/** Final run metrics for the end-of-run overview; call after the sandbox settles. */
	metrics(): WorkflowRunMetrics;
	/** The child-usage sink this host installed. A `workflow.new` replacement rebinds the
	 * new session's `state.childUsageSink` to this same value (command.ts rebindRun) so
	 * children spawned after the replacement still attribute spend to the run ledger. */
	readonly installedSink: ChildUsageSink | null;
	/** Reject pending correlations and clean up; command parent calls this. */
	dispose(): void;
	registry: import("./run-registry.js").RunRegistry;
}

export interface WorkflowHostDeps {
	pi: ExtensionAPI;
	state: SchematicState;
	limits: WorkflowLimits;
	/** True when the compiled workflow declares no checkpoint; surfaced in progress and metrics. */
	unbounded: boolean;
	/** Null while a session replacement is in flight: pi invalidates the old command ctx at
	 * `newSession` teardown and only `withSession` yields a valid one. Host effect handlers
	 * use {@link requireCtx}; progress and metrics degrade to committed spend instead. */
	getCtx: () => ExtensionCommandContext | null;
	setReadonly: (enabled: boolean) => boolean;
	/** Apply skill/prompt frontmatter (model routing + readonly) for one `workflow.run` turn before dispatch. */
	prepareRunFrontmatter: (text: string, ctx: ExtensionCommandContext) => Promise<void>;
	handoff: (direction: string) => Promise<void>;
	newSession: () => Promise<void>;
	/** Push a fresh snapshot when a host effect completes; the host never formats UI text. */
	onProgress?: (progress: WorkflowProgress) => void;
	/** UI channel owned by command.ts (the host never formats UI text or touches indicators).
	 * Optional so host tests can omit it; command.ts drops it when no UI is live. */
	notify?: (message: string, tone: "info" | "warning" | "error") => void;
	/** Mirror `/readonly`'s visible effect (indicator refresh + notice) for a workflow-driven toggle. */
	onReadonlyToggled?: (enabled: boolean) => void;
	/** Lifecycle of one effect call (start/stream/end), for the live widget and audit log. */
	onEffect?: (event: WorkflowEffectEvent) => void;
	/** Test seam: replaces pi's bash tool so host tests never spawn. */
	shellRun?: ShellRun;
}

/** Injectable seam for orchestration tests; production builds a real CodemodeSandbox. */
export type WorkflowSandboxFactory = (options: CodemodeSandboxOptions) => CodemodeSandbox;
