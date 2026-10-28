/**
 * Shared TUI indicator updates for the pi-schematic extension.
 *
 * Extracted from index.ts so that tool execute handlers can push live
 * updates to the TUI during tool execution — not just at turn boundaries.
 *
 * While a workflow run is active the extension replaces pi's built-in footer with
 * one unified bar (workflow run on the left, current conversation on the right).
 * pi's built-in footer joins every status text into a single line and hard-truncates
 * it, so it can neither express that hierarchy nor degrade by priority. A custom
 * footer gets `render(width)`, which is the only extension surface that can.
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { normalizeContextPercent } from "./handoff/eligibility.js";
import { READONLY_HANDOFF_TRIGGER } from "./notifications.js";
import type { SchematicState } from "./state.js";
import { collectUsage } from "./usage.js";
import type { WorkflowProgress } from "./workflow/types.js";

// ── TUI status / widget keys ─────────────────────────────────────────

/** Status bar key for the handoff-in-progress indicator (owned by index.ts). */
export const STATUS_KEY_HANDOFF = "pi-schematic-handoff";

/** Widget key for the high-context warning banner above the editor. */
export const WIDGET_KEY_WARNING = "pi-schematic-warning";

/** Status bar key for context usage percentage. */
export const STATUS_KEY_CTX = "pi-schematic-ctx";

/** Status bar key for notebook page count. */
export const STATUS_KEY_NOTEBOOK = "pi-schematic-notebook";

/** Status bar key for the active notebook topic. */
export const STATUS_KEY_TOPIC = "pi-schematic-topic";

/** Status bar key for the readonly mode indicator. */
export const STATUS_KEY_READONLY = "pi-schematic-readonly";

// ── Formatting (single source for every surface) ─────────────────────

/** Canonical USD formatting for every cost surface; the footer passes 3 digits for sub-cent spend. */
export function formatCost(usd: number, fractionDigits = 2): string {
	return `$${usd.toFixed(fractionDigits)}`;
}

/** Canonical workflow label — the single source for how every surface names a running workflow. */
export function workflowLabel(name: string): string {
	return `\u{1F6E0}\u{FE0F} ${name}`;
}

/** Human label for a reserved soft-stop reason; every other reason passes through unchanged. */
export function reasonLabel(reason: string): string {
	if (reason === "cost-limit") return "cost target reached";
	if (reason === "time-limit") return "time target reached";
	return reason;
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// ── Unified workflow bar ─────────────────────────────────────────────

/** Workflow run progress surfaced in the unified bar: host progress plus the run identity. */
export interface WorkflowProgressView extends WorkflowProgress {
	name: string;
}

/** Live view the unified footer renders from; read every frame so replacement stays fresh. */
export interface WorkflowBarView {
	state: SchematicState;
	progress: WorkflowProgressView;
}

/**
 * One bar cell. `priority` orders elision only: the highest number drops first.
 * `zone` selects the divider-separated region — workflow stats always outrank
 * conversation stats, so every workflow cell carries a lower priority number.
 */
export interface BarSegment {
	key: string;
	text: string;
	priority: number;
	zone: "workflow" | "conversation";
}

/** Context tone thresholds — the single source for the 30/50/70 ctx coloring. */
function contextTone(pct: number): "error" | "warning" | "accent" | "dim" {
	return pct >= 70 ? "error" : pct >= 50 ? "warning" : pct >= 30 ? "accent" : "dim";
}

/** `⏱ elapsed` with the soft time target appended when one is set, keeping current-vs-target visible. */
function elapsedCell(view: WorkflowProgressView): string {
	const elapsed = `\u{23F1} ${formatElapsed(view.elapsedMs)}`;
	return view.limits.timeBudgetMs === null ? elapsed : `${elapsed}/${formatElapsed(view.limits.timeBudgetMs)}`;
}

/** `$current` with the soft cost target appended when one is set. */
function costCell(view: WorkflowProgressView): string {
	return view.limits.costLimit === null ? formatCost(view.costUsd) : `${formatCost(view.costUsd)}/${formatCost(view.limits.costLimit)}`;
}

/**
 * Run cells, most important first. A pending soft stop outranks identity (priority -1) so it
 * survives every elision: the human must always see that the run ends at its next checkpoint.
 */
export function workflowSegments(view: WorkflowProgressView, theme: Theme): BarSegment[] {
	const cells: BarSegment[] = [];
	if (view.pendingStop) {
		cells.push({
			key: "workflow-soft-stop",
			text: theme.fg("warning", `\u{23F8} ${reasonLabel(view.pendingStop)} \u2014 stopping at next checkpoint`),
			priority: -1,
			zone: "workflow",
		});
	}
	// A checkpoint count is meaningless without checkpoints: the same slot carries the
	// unbounded marker, in an informative tone (not a warning) since unbounded is expected.
	const progressCell: BarSegment = view.unbounded
		? { key: "workflow-unbounded", text: theme.fg("accent", "\u221E unbounded"), priority: 1, zone: "workflow" }
		: { key: "workflow-checkpoints", text: `\u{1F6A9} ${view.checkpoints}`, priority: 1, zone: "workflow" };
	cells.push(
		{ key: "workflow-name", text: workflowLabel(view.name), priority: 0, zone: "workflow" },
		progressCell,
		{ key: "workflow-elapsed", text: elapsedCell(view), priority: 2, zone: "workflow" },
		{ key: "workflow-cost", text: costCell(view), priority: 3, zone: "workflow" },
	);
	// The command currently running, elided before every run stat (the widget shows the full form).
	// Collapse whitespace first: the footer is one physical row, so a multi-line effect must not inject breaks.
	if (view.currentEffect) {
		const flat = view.currentEffect.replace(/\s+/g, " ");
		const command = flat.length > 40 ? `${flat.slice(0, 37)}\u2026` : flat;
		cells.push({ key: "workflow-effect", text: theme.fg("muted", `$ ${command}`), priority: 3.5, zone: "workflow" });
	}
	return cells;
}

/** Conversation cells, all below every run cell: ctx › topic › readonly › notebook. */
function conversationSegments(ctx: ExtensionContext, state: SchematicState, theme: Theme): BarSegment[] {
	const percent = normalizeContextPercent(ctx.getContextUsage()?.percent);
	const ctxText = percent === null
		? theme.fg("dim", "ctx --%")
		: theme.fg("dim", "ctx ") + theme.fg(contextTone(Math.round(percent)), `${Math.round(percent)}%`);
	const count = state.notebookPages.size;
	return [
		{ key: STATUS_KEY_CTX, text: ctxText, priority: 4, zone: "conversation" },
		{ key: STATUS_KEY_TOPIC, text: state.activeNotebookTopic ? `\u{1F9ED} ${state.activeNotebookTopic}` : theme.fg("dim", "\u{1F9ED} -"), priority: 5, zone: "conversation" },
		...(state.readonlyEnabled ? [{ key: STATUS_KEY_READONLY, text: theme.fg("warning", "\u{1F512} readonly"), priority: 6, zone: "conversation" as const }] : []),
		{ key: STATUS_KEY_NOTEBOOK, text: count > 0 ? `\u{1F4D2} ${count}` : theme.fg("dim", "\u{1F4D2} 0"), priority: 7, zone: "conversation" },
	];
}

/**
 * Lay out one bar line, never wider than `width`; the elide ladder lives in {@link fitBarLine}.
 */
export function renderUnifiedBar(segments: readonly BarSegment[], width: number): string {
	const workflow = segments.filter(s => s.zone === "workflow").sort((a, b) => a.priority - b.priority).map(s => ({ ...s }));
	const conversation = segments.filter(s => s.zone === "conversation").sort((a, b) => a.priority - b.priority).map(s => ({ ...s }));
	const build = () => {
		const run = workflow.map(s => s.text).join(" \u00B7 ");
		const chat = conversation.map(s => s.text).join(" \u00B7 ");
		return [run, chat].filter(Boolean).join(" \u2502 ");
	};
	return fitBarLine(build, conversation, workflow, width);
}

/** Elide ladder: drop the lowest-priority cells first (highest number), so every
 * conversation cell goes before any run cell, and the run identity truncates last
 * instead of clipping mid-line into an ellipsis. Mutates the passed copies. */
function sanitizeFooterCell(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ");
}

function fitBarLine(build: () => string, conversation: Array<{ text: string }>, workflow: Array<{ text: string }>, width: number): string {
	let line = build();
	while (visibleWidth(line) > width && conversation.length > 0) {
		conversation.pop();
		line = build();
	}
	while (visibleWidth(line) > width && workflow.length > 1) {
		workflow.pop();
		line = build();
	}
	if (visibleWidth(line) > width && workflow.length === 1) {
		workflow[0].text = truncateToWidth(workflow[0].text, width, "\u2026");
		line = build();
	}
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

// ── Dim ambient stats line ───────────────────────────────────────────

/** Footer tiers mirror pi's own compaction. Only pi's decimal-k and whole-M tiers live here; the rest defer to {@link formatCompactTokens}. */
function formatTokens(count: number): string {
	if (count >= 10_000_000) return `${Math.round(count / 1_000_000)}M`;
	if (count >= 1000 && count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return formatCompactTokens(count);
}

/** Compact token count for summary cards: `1.2M` / `2k` / `150`. The caller supplies the
 * unit so `in`/`out`/`cache` read at a glance. Single source shared by every summary surface. */
export function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`;
	return `${tokens}`;
}

/** Home-relative cwd, mirroring pi's footer so the dim line matches the built-in one. */
function formatCwdForFooter(cwd: string): string {
	const home = homedir();
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	if (resolvedCwd === resolvedHome) return "~";
	return resolvedCwd.startsWith(resolvedHome + sep) ? `~${resolvedCwd.slice(resolvedHome.length)}` : cwd;
}

interface UsageCache { sessionId: string; leafId: string | null; usage: ReturnType<typeof collectUsage> }
const usageCaches = new WeakMap<ExtensionContext, UsageCache>();

/**
 * Whole-session usage for the ambient line. Cached per context+leaf: entries are
 * append-only and every append moves the leaf, so a leaf change is the only way
 * the totals can move. Avoids an O(entries) scan on every repaint.
 */
function sessionUsage(ctx: ExtensionContext): UsageCache["usage"] {
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	const leafId = manager.getLeafId();
	const cached = usageCaches.get(ctx);
	if (cached && cached.sessionId === sessionId && cached.leafId === leafId) return cached.usage;
	const usage = collectUsage(manager.getEntries());
	usageCaches.set(ctx, { sessionId, leafId, usage });
	return usage;
}

/**
 * Ambient whole-session detail below the bar, dim so the bar stays the focal point.
 * It restores the built-in footer's cwd/branch, token totals and model/context that
 * a custom footer would otherwise hide. Drops cwd first, then totals, keeping model/ctx.
 */
function renderDimStatsLine(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider, width: number): string {
	const dim = (text: string) => theme.fg("dim", text);
	const usage = ctx.getContextUsage();
	const session = sessionUsage(ctx);
	const cwd = formatCwdForFooter(ctx.cwd);
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();
	const left = dim(`${cwd}${branch ? ` (${branch})` : ""}${sessionName ? ` \u2022 ${sessionName}` : ""}`);
	const middle = dim(`\u2191${formatTokens(session.input)} \u2193${formatTokens(session.output)} ${formatCost(session.cost.total, 3)}`);
	const model = ctx.model?.id ?? "no-model";
	const thinking = ctx.model?.reasoning ? ` \u2022 ${ctx.thinkingLevel ?? "off"}` : "";
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = normalizeContextPercent(usage?.percent);
	const pct = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const right = dim(`${model}${thinking}  ${pct}/${formatTokens(contextWindow)}`);
	let slots = [left, middle, right];
	while (slots.length > 1 && visibleWidth(slots.join("  ")) > width) {
		slots = slots.length === 3 ? [slots[1], slots[2]] : [slots[1]];
	}
	const line = slots.join("  ");
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

// ── Footer install / restore ─────────────────────────────────────────

const installedFooters = new WeakSet<ExtensionContext>();
const schematicStatusKeys = new Set([STATUS_KEY_HANDOFF, STATUS_KEY_CTX, STATUS_KEY_NOTEBOOK, STATUS_KEY_TOPIC, STATUS_KEY_READONLY]);

/**
 * Replace pi's built-in footer with the unified workflow bar for one run.
 * Idempotent per context: repeated progress ticks reuse the installed footer, and
 * a session replacement (pi clears the footer on invalidate) installs on the fresh
 * context because `applyWorkflowProgress` runs again on rebind.
 */
export function installWorkflowFooter(ctx: ExtensionContext, read: () => WorkflowBarView): void {
	if (!ctx.hasUI || ctx.mode !== "tui" || installedFooters.has(ctx)) return;
	installedFooters.add(ctx);
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render: (width: number) => {
				const { state, progress } = read();
				const segments = [...workflowSegments(progress, theme), ...conversationSegments(ctx, state, theme)];
				for (const [key, value] of footerData.getExtensionStatuses()) {
					if (value === undefined || schematicStatusKeys.has(key)) continue;
					segments.push({ key, text: sanitizeFooterCell(value), priority: 8, zone: "conversation" });
				}
				const handoff = footerData.getExtensionStatuses().get(STATUS_KEY_HANDOFF);
				if (handoff) segments.push({ key: STATUS_KEY_HANDOFF, text: sanitizeFooterCell(handoff), priority: 6, zone: "conversation" });
				return [renderUnifiedBar(segments, width), renderDimStatsLine(ctx, theme, footerData, width)];
			},
		};
	});
}

/** Restore pi's built-in footer when the run ends. Membership in `installedFooters`
 * implies `hasUI` and tui mode (install only adds under both), so no re-check here. */
export function uninstallWorkflowFooter(ctx: ExtensionContext): void {
	if (!installedFooters.delete(ctx)) return;
	ctx.ui.setFooter(undefined);
}

// ── Persistent indicators (non-workflow footer path) ─────────────────

/** Last value sent per ctx, so a repeated refresh is silent: the 1s ticker calls
 * `updateIndicators` throughout a model turn, and over RPC every call is an event.
 * Scoped to `ctx`: a session reset clears the warning widget outside this module. */
const sentIndicators = new WeakMap<ExtensionContext, Map<string, string | undefined>>();

/** Send one surface only when its value changed since the last call for this `ctx`. */
function sendOnce(sent: Map<string, string | undefined>, key: string, value: string | undefined, send: () => void): void {
	if (sent.has(key) && sent.get(key) === value) return;
	send();
	sent.set(key, value);
}

/** Update indicators: context usage, notebook count, topic, warning widget. Any UI surface
 * (TUI and RPC alike) receives statuses/widgets; only footer chrome is TUI-exclusive. */
export function updateIndicators(ctx: ExtensionContext, state: SchematicState): void {
	if (!ctx.hasUI) return;
	const sent = sentIndicators.get(ctx) ?? new Map<string, string | undefined>();
	sentIndicators.set(ctx, sent);

	const theme = ctx.ui.theme;

	// One producer for the conversation cells; the built-in footer shows each by key.
	const byKey = new Map(conversationSegments(ctx, state, theme).map(segment => [segment.key, segment.text]));
	for (const key of [STATUS_KEY_CTX, STATUS_KEY_NOTEBOOK, STATUS_KEY_TOPIC, STATUS_KEY_READONLY]) {
		const value = byKey.get(key);
		sendOnce(sent, key, value, () => ctx.ui.setStatus(key, value));
	}

	// High-context warning widget (above editor)
	const percent = normalizeContextPercent(ctx.getContextUsage()?.percent);
	const warning = percent !== null && percent >= 70 ? warningLine(theme, state, Math.round(percent)) : undefined;
	sendOnce(sent, WIDGET_KEY_WARNING, warning, () =>
		ctx.ui.setWidget(WIDGET_KEY_WARNING, warning === undefined ? undefined : [warning]));
}

/** The single-line warning shown above the editor past the context threshold. */
function warningLine(theme: Theme, state: SchematicState, pct: number): string {
	const message = state.readonlyEnabled
		? `Context at ${pct}% — readonly: same topic → spawn; different topic → ${READONLY_HANDOFF_TRIGGER}`
		: state.activeNotebookTopic
			? `Context at ${pct}% — use topic fit: same topic → spawn, different topic → handoff`
			: `Context at ${pct}% — no active topic; handoff soon unless you can assign one cleanly`;
	return theme.fg("error", "\u26A0 ") + theme.fg("warning", message);
}
