// WHY: budget dialog is the run's first user decision (flags bypass, headless skips).
// Isolated so command.ts keeps orchestration only; notify lives here as the shared
// UI-notice helper (leaf module, no cycle back into command).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { safeAppendEntry } from "./errors.js";
import { WORKFLOW_ERROR_ENTRY_TYPE, type WorkflowLimits } from "./types.js";

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
const COST_PRESETS = ["$1", "$5", "$10", "$0.25", NO_TARGET, CUSTOM];
const TIME_PRESETS_BASE = ["15 minutes", "30 minutes", "1 hour", "2 hours", "4 hours", "8 hours", NO_TARGET, CUSTOM] as const;
export const TIME_PRESET_MS: Record<Exclude<(typeof TIME_PRESETS_BASE)[number], typeof NO_TARGET | typeof CUSTOM>, number> = {
	"15 minutes": 900_000,
	"30 minutes": 1_800_000,
	"1 hour": 3_600_000,
	"2 hours": 7_200_000,
	"4 hours": 14_400_000,
	"8 hours": 28_800_000,
};
export const TIME_PRESETS: string[] = [...TIME_PRESETS_BASE];

/** One resolved-targets outcome. `cancelled.notified` tells the caller whether the reason is already shown. */
export type LimitsOutcome = { kind: "ok"; limits: WorkflowLimits } | { kind: "cancelled"; notified: boolean };

/** Flags bypass the dialog when they parse to a finite positive number; a present but
 * unparsable flag visibly cancels the run instead of silently falling back to unlimited. */
export async function resolveLimits(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<LimitsOutcome> {
	const rawCost = pi.getFlag("workflow-cost");
	const rawTime = pi.getFlag("workflow-time");
	const cost = parseLimitFlag(rawCost);
	const time = parseLimitFlag(rawTime);
	const invalid = invalidFlagsNotice(rawCost, cost, rawTime, time);
	if (invalid) {
		notify(ctx, invalid, "error");
		// WHY: `notify` no-ops headless, so the transcript carries the failure instead.
		if (!ctx.hasUI) pi.appendEntry(WORKFLOW_ERROR_ENTRY_TYPE, { phase: "start", error: invalid });
		return { kind: "cancelled", notified: true };
	}
	if (cost !== undefined || time !== undefined) return { kind: "ok", limits: { costLimit: cost ?? null, timeBudgetMs: time ?? null } };
	if (!ctx.hasUI) return headlessNoTarget(pi);
	const limits = await promptLimits(ctx);
	return limits ? { kind: "ok", limits } : { kind: "cancelled", notified: false };
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
	].filter((message): message is string => message !== null);
	return messages.length > 0 ? messages.join("\n") : null;
}

interface LimitChoice {
	/** False cancels the whole run. */
	ok: boolean;
	value: number | null;
}

async function promptLimits(ctx: ExtensionCommandContext): Promise<WorkflowLimits | null> {
	// Disclose the soft semantics before the pickers; the titles restate them at the point of choice.
	ctx.ui.notify(
		"Soft targets: after a target is crossed the run stops at its next checkpoint, so the final cost/time can run over.",
		"info",
	);
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
	if (choice === CUSTOM) return customNumber(ctx, "Time target (minutes)", "minutes", 60_000);
	// Fail loud: an unknown label here is a preset-list/map drift bug, not a user choice.
	const ms = TIME_PRESET_MS[choice as keyof typeof TIME_PRESET_MS];
	if (ms === undefined) throw new Error(`Unknown time preset: ${choice}`);
	return { ok: true, value: ms };
}

// A bad custom value re-prompts the input; only an explicit escape (undefined) cancels the run.
async function customNumber(ctx: ExtensionCommandContext, title: string, placeholder: string, scale: number): Promise<LimitChoice> {
	for (;;) {
		const raw = await ctx.ui.input(title, placeholder);
		if (raw === undefined) return { ok: false, value: null };
		const parsed = Number(raw);
		// Match the flag parsers: a non-positive limit would abort or time out instantly.
		if (Number.isFinite(parsed) && parsed > 0) return { ok: true, value: parsed * scale };
		notify(ctx, `Invalid value: ${raw}`, "error");
	}
}
