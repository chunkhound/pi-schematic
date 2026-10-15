// WHY: budget dialog is the run's first user decision (flags bypass, headless skips).
// Checkpoint-less workflows skip the dialog: no soft target can stop them. They still honor
// --workflow-time as the sandbox's hard deadline.
// Isolated so command.ts keeps orchestration only; notify lives here as the shared
// UI-notice helper (leaf module, no cycle back into command).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { safeAppendEntry } from "./errors.js";
import { MAX_TIME_BUDGET_MS, MAX_TIMEOUT_MS } from "./sandbox.js";
import { WORKFLOW_ERROR_ENTRY_TYPE, type WorkflowErrorPhase, type WorkflowLimits } from "./types.js";

/** UI notice when present, silent headless; transcript entries cover the silent path. */
export function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

// Workflows are long-running: cost is the true runaway guard. Both values are SOFT targets —
// crossing one arms a stop at the run's next checkpoint, so the final cost/time can run over.
// The sandbox deadline is a separate hard backstop at twice the time target. First entry = default.
const NO_TARGET = "No target";
const CUSTOM = "Custom…";
// The array is the UI order; the map is the value source. The Record type pins every
// non-special label to an entry, so a label added without a value fails compile.
const COST_PRESETS = ["$1", "$5", "$10", NO_TARGET, CUSTOM];
const TIME_PRESETS_BASE = ["1 hour", "4 hours", "8 hours", NO_TARGET, CUSTOM] as const;
// The time dialog speaks hours: presets and the custom input share this ms-per-hour.
const MS_PER_HOUR = 3_600_000;
export const TIME_PRESET_MS: Record<Exclude<(typeof TIME_PRESETS_BASE)[number], typeof NO_TARGET | typeof CUSTOM>, number> = {
	"1 hour": MS_PER_HOUR,
	"4 hours": 4 * MS_PER_HOUR,
	"8 hours": 8 * MS_PER_HOUR,
};
export const TIME_PRESETS: string[] = [...TIME_PRESETS_BASE];

/** One resolved-targets outcome. `cancelled.notified` tells the caller whether the reason is already shown. */
export type LimitsOutcome = { kind: "ok"; limits: WorkflowLimits } | { kind: "cancelled"; notified: boolean };

/** Flags bypass the dialog when they parse to a finite positive number; a present but
 * unparsable flag visibly cancels the run instead of silently falling back to unlimited.
 * A workflow with no checkpoint skips the dialog: only --workflow-time applies, as the
 * sandbox's hard deadline; cost flags are ignored and the decision is recorded. */
export async function resolveLimits(pi: ExtensionAPI, ctx: ExtensionCommandContext, hasCheckpoint: boolean): Promise<LimitsOutcome> {
	const rawCost = pi.getFlag("workflow-cost");
	const rawTime = pi.getFlag("workflow-time");
	if (!hasCheckpoint) return checkpointlessLimits(pi, ctx, rawCost, rawTime);
	const cost = parseLimitFlag(rawCost);
	const time = parseLimitFlag(rawTime);
	const invalid = invalidFlagsNotice(rawCost, cost, rawTime, time);
	if (invalid) return rejectInvalidFlags(pi, ctx, invalid);
	if (cost !== undefined || time !== undefined) return { kind: "ok", limits: { costLimit: cost ?? null, timeBudgetMs: time ?? null } };
	if (!ctx.hasUI) return headlessNoTarget(pi);
	const limits = await promptLimits(ctx);
	return limits ? { kind: "ok", limits } : { kind: "cancelled", notified: false };
}

/** Checkpoint-less run: no soft target can act, so only `--workflow-time` is honored, as
 * the sandbox's hard deadline. An absent flag keeps the run unbounded; cost flags stay ignored. */
function checkpointlessLimits(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawCost: boolean | string | undefined,
	rawTime: boolean | string | undefined,
): LimitsOutcome {
	const time = parseLimitFlag(rawTime);
	const invalid = invalidLimitFlag("--workflow-time", rawTime, time, "ms") ?? overMaxTimeNotice(rawTime, time, MAX_TIMEOUT_MS);
	if (invalid) return rejectInvalidFlags(pi, ctx, invalid);
	return time === undefined ? unboundedLimits(pi, ctx, rawCost, rawTime) : hardDeadlineLimits(pi, ctx, rawCost, time);
}

/** Checkpoint-less run with a valid `--workflow-time`: the value is the sandbox's hard
 * deadline (a kill recorded as `time-limit`), not a soft target, so no checkpoint is needed. */
function hardDeadlineLimits(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawCost: boolean | string | undefined,
	ms: number,
): LimitsOutcome {
	const ignored = presentFlagNames([["--workflow-cost", rawCost]]);
	const notice =
		"This workflow declares no checkpoint: --workflow-time is enforced as the sandbox hard deadline. Exceeding it stops the run with a time-limit exit." +
		(ignored.length > 0 ? ` Ignoring ${ignored.join(" and ")}: a cost target stops the run only at a checkpoint.` : "");
	notify(ctx, notice, ignored.length > 0 ? "warning" : "info");
	safeAppendEntry(pi, "workflow-limits", { costLimit: null, timeBudgetMs: null, hardDeadlineMs: ms, notice });
	return { kind: "ok", limits: { costLimit: null, timeBudgetMs: null, hardDeadlineMs: ms } };
}

/** Unbounded run: no checkpoint means no soft target can act, so none is offered and any
 * target flags are ignored. The live footer's `∞ unbounded` cell is the always-on indicator;
 * a UI-only transcript entry records the decision. One warning notice fires only when the
 * operator supplied target flags, because those flags silently have no effect. */
function unboundedLimits(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawCost: boolean | string | undefined,
	rawTime: boolean | string | undefined,
): LimitsOutcome {
	const flags = presentFlagNames([
		["--workflow-cost", rawCost],
		["--workflow-time", rawTime],
	]);
	const notice =
		"This workflow declares no checkpoint: it is unbounded. No cost or time target applies." +
		(flags.length > 0 ? ` Ignoring ${flags.join(" and ")}: a target stops the run only at a checkpoint.` : "");
	if (flags.length > 0) notify(ctx, notice, "warning");
	safeAppendEntry(pi, "workflow-limits", { costLimit: null, timeBudgetMs: null, unbounded: true, ...(flags.length > 0 ? { ignoredFlags: flags } : {}), notice });
	return { kind: "ok", limits: { costLimit: null, timeBudgetMs: null } };
}

/** Surface an invalid-flag failure: UI toast when present, transcript error entry headless, always cancel. */
function rejectInvalidFlags(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): LimitsOutcome {
	notify(ctx, message, "error");
	// WHY: `notify` no-ops headless, so the transcript carries the failure instead.
	if (!ctx.hasUI) pi.appendEntry(WORKFLOW_ERROR_ENTRY_TYPE, { phase: "start" satisfies WorkflowErrorPhase, error: message });
	return { kind: "cancelled", notified: true };
}

/** Names of flags the operator actually supplied; an absent flag or an empty-string value does not count. */
function presentFlagNames(flags: Array<[string, boolean | string | undefined]>): string[] {
	return flags.filter(([, raw]) => raw !== undefined && !(typeof raw === "string" && raw.trim() === "")).map(([name]) => name);
}

/** Headless runs set no targets: record the explicit no-target decision so the run never
 * looks silently unbounded in the transcript (notify no-ops without a UI). The append is
 * advisory — the run proceeds unbounded either way. */
function headlessNoTarget(pi: ExtensionAPI): LimitsOutcome {
	const limits: WorkflowLimits = { costLimit: null, timeBudgetMs: null };
	safeAppendEntry(pi, "workflow-limits", {
		...limits,
		headless: true,
		notice: "Headless run: no targets set; the workflow runs until it exits or is aborted.",
	});
	return { kind: "ok", limits };
}

function parseLimitFlag(value: boolean | string | undefined): number | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Names a present-but-unparsable flag (bare boolean, zero, negative, non-numeric); absent flags are not invalid. */
function invalidLimitFlag(name: string, raw: boolean | string | undefined, parsed: number | undefined, unit: string): string | null {
	if (raw === undefined || parsed !== undefined) return null;
	// An empty string flag carries no value the user typed, so it falls through to the dialog.
	if (typeof raw === "string" && raw.trim() === "") return null;
	return `Invalid ${name}: "${raw}" (expected a positive number in ${unit})`;
}

/** A time budget is invalid when its derived hard deadline (`2 × budget`) overflows the timer. */
function overMaxTimeNotice(raw: boolean | string | undefined, time: number | undefined, max: number): string | null {
	if (time === undefined || time <= max) return null;
	return `Invalid --workflow-time: "${raw}" (max ${max} ms; a longer budget would overrun the sandbox timer)`;
}

/** One notice naming EVERY invalid flag, so a bad cost flag does not hide a bad time flag. Null when all present flags parse. */
function invalidFlagsNotice(
	rawCost: boolean | string | undefined,
	cost: number | undefined,
	rawTime: boolean | string | undefined,
	time: number | undefined,
): string | null {
	const messages = [
		invalidLimitFlag("--workflow-cost", rawCost, cost, "USD"),
		invalidLimitFlag("--workflow-time", rawTime, time, "ms"),
		overMaxTimeNotice(rawTime, time, MAX_TIME_BUDGET_MS),
	].filter((message): message is string => message !== null);
	return messages.length > 0 ? messages.join("\n") : null;
}

interface LimitChoice {
	/** False cancels the whole run. */
	ok: boolean;
	value: number | null;
}

async function promptLimits(ctx: ExtensionCommandContext): Promise<WorkflowLimits | null> {
	// Each picker title restates the soft semantics at the point of choice; no pre-picker toast.
	const cost = await pickCost(ctx);
	if (!cost.ok) return null;
	const time = await pickTime(ctx);
	if (!time.ok) return null;
	return { costLimit: cost.value, timeBudgetMs: time.value };
}

async function pickCost(ctx: ExtensionCommandContext): Promise<LimitChoice> {
	const choice = await ctx.ui.select("Cost target (USD) — soft: stops at next checkpoint", COST_PRESETS);
	if (choice === undefined) return { ok: false, value: null };
	if (choice === NO_TARGET) return { ok: true, value: null };
	if (choice === CUSTOM) return customNumber(ctx, "Cost target (USD)", "USD", 1);
	// Fail loud like pickTime: an unknown label is a preset-list bug, never a silent no-target.
	const value = Number(choice.replace("$", ""));
	if (!Number.isFinite(value)) throw new Error(`Unknown cost preset: ${choice}`);
	return { ok: true, value };
}

async function pickTime(ctx: ExtensionCommandContext): Promise<LimitChoice> {
	const choice = await ctx.ui.select("Time target — soft: stops at next checkpoint", TIME_PRESETS);
	if (choice === undefined) return { ok: false, value: null };
	if (choice === NO_TARGET) return { ok: true, value: null };
	if (choice === CUSTOM) return customNumber(ctx, "Time target (hours)", "hours", MS_PER_HOUR, MAX_TIME_BUDGET_MS);
	// Fail loud: an unknown label here is a preset-list/map drift bug, not a user choice.
	const ms = TIME_PRESET_MS[choice as keyof typeof TIME_PRESET_MS];
	if (ms === undefined) throw new Error(`Unknown time preset: ${choice}`);
	return { ok: true, value: ms };
}

// A bad custom value re-prompts the input; only an explicit escape (undefined) cancels the run.
// `max` bounds the derived value (the time budget's hard-deadline ceiling).
async function customNumber(ctx: ExtensionCommandContext, title: string, placeholder: string, scale: number, max?: number): Promise<LimitChoice> {
	for (;;) {
		const raw = await ctx.ui.input(title, placeholder);
		if (raw === undefined) return { ok: false, value: null };
		const parsed = Number(raw);
		// Match the flag parsers: a non-positive limit would abort or time out instantly.
		const positive = Number.isFinite(parsed) && parsed > 0;
		if (positive && (max === undefined || parsed * scale <= max)) return { ok: true, value: parsed * scale };
		notify(ctx, positive ? `Invalid value: ${raw} (the derived deadline would overrun the sandbox timer)` : `Invalid value: ${raw}`, "error");
	}
}
