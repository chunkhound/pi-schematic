import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../state.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCost,
	formatElapsed,
	installWorkflowFooter,
	renderUnifiedBar,
	uninstallWorkflowFooter,
	updateIndicators,
	workflowLabel,
	workflowSegments,
	STATUS_KEY_TOPIC,
	STATUS_KEY_READONLY,
	type BarSegment,
	type WorkflowProgressView,
} from "../../tui.js";
import { makeTUICtx, renderFooterAt, TEST_TUI_THEME, type TUIRecord } from "./helpers.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** TEST_TUI_THEME carries only `fg`; `workflowSegments` needs the full Theme surface. */
const tuiTheme = TEST_TUI_THEME as unknown as Theme;

test("updateIndicators sets context usage status with correct color tone", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 42, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	assert.ok(s?.includes("[accent:42%]"), "42% should use accent tone");
	assert.equal(record.widgets.get("pi-schematic-warning"), undefined, "42% is below 70 — no warning widget");
});

test("updateIndicators uses error tone at 70%+ context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 85, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	assert.ok(s?.includes("[error:85%]"), "85% should use error tone");
	const w = record.widgets.get("pi-schematic-warning");
	assert.ok(w?.[0]?.includes("85%"), "warning widget shown at 85%");
});

test("updateIndicators uses warning tone at 50-69% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 55, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	assert.ok(s?.includes("[warning:55%]"), "55% should use warning tone");
});

test("updateIndicators uses accent tone at 30-49% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	assert.ok(s?.includes("[accent:30%]"), "30% should use accent tone");
});

test("updateIndicators handles null context usage", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	assert.ok(s?.includes("--%"), "null usage shows --%");
});

test("updateIndicators treats malformed percentages as unavailable", () => {
	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		const state = createState();
		const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
		updateIndicators(makeTUICtx({ percent, record }), state);
		assert.ok(record.statuses.get("pi-schematic-ctx")?.includes("--%"));
		assert.equal(record.widgets.get("pi-schematic-warning"), undefined);
	}
});

test("updateIndicators preserves overflow context percentages", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	updateIndicators(makeTUICtx({ percent: 125, record }), state);
	assert.ok(record.statuses.get("pi-schematic-ctx")?.includes("125%"));
	assert.ok(record.widgets.get("pi-schematic-warning")?.[0]?.includes("125%"));
});

test("updateIndicators no-ops when ctx.hasUI is false", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ hasUI: false, record });

	updateIndicators(ctx, state);
	assert.equal(record.statuses.size, 0, "no-op should not call any setStatus");
	assert.equal(record.widgets.size, 0, "no-op should not call any setWidget");
});

test("updateIndicators shows notebook page count in status", () => {
	const state = createState();
	state.notebookPages.set("entry-1", "first entry");
	state.notebookPages.set("entry-2", "second entry");
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-notebook");
	assert.ok(s?.includes("2"), "notebook page count should be 2");
});

test("updateIndicators shows active notebook topic when set", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	assert.equal(record.statuses.get(STATUS_KEY_TOPIC), "🧭 oauth");
});

test("updateIndicators shows readonly indicator when enabled", () => {
	const state = createState();
	state.readonlyEnabled = true;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get(STATUS_KEY_READONLY);
	assert.ok(s?.includes("🔒"), "readonly indicator should show lock emoji when enabled");
	assert.ok(s?.includes("readonly"), "readonly indicator should show 'readonly' text when enabled");
});

test("updateIndicators hides readonly indicator when disabled", () => {
	const state = createState();
	state.readonlyEnabled = false;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	assert.equal(record.statuses.get(STATUS_KEY_READONLY), undefined, "readonly indicator should be undefined when disabled");
});

test("updateIndicators shows readonly-specific warning widget at 70%+ context", () => {
	const state = createState();
	state.readonlyEnabled = true;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 85, record });

	updateIndicators(ctx, state);
	const w = record.widgets.get("pi-schematic-warning");
	assert.ok(w, "warning widget should be present at 85%");
	assert.ok(w[0].includes("readonly"), "widget should mention readonly");
	assert.ok(w[0].includes("spawn"), "widget should mention spawn");
	assert.ok(w[0].includes("explicit /handoff"), "widget should mention explicit /handoff");
	assert.equal(w[0].includes("resumes readonly"), false, "widget should not promise auto-resume wording");
});

test("updateIndicators hides widget below 70% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	// Pre-set a widget to verify it gets cleared
	record.widgets.set("pi-schematic-warning", ["existing"]);
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	assert.equal(record.widgets.get("pi-schematic-warning"), undefined, "warning widget should be cleared below 70%");
});

test("renderUnifiedBar keeps the run on the left and drops conversation cells first", () => {
	const segments: BarSegment[] = [
		{ key: "wf-name", text: "RUNNAME", priority: 0, zone: "workflow" },
		{ key: "wf-cp", text: "CP", priority: 1, zone: "workflow" },
		{ key: "wf-el", text: "EL", priority: 2, zone: "workflow" },
		{ key: "wf-cost", text: "$0.00", priority: 3, zone: "workflow" },
		{ key: "ctx", text: "ctx 42%", priority: 4, zone: "conversation" },
		{ key: "topic", text: "TOPIC", priority: 5, zone: "conversation" },
	];
	assert.equal(renderUnifiedBar(segments, 200), "RUNNAME \u00B7 CP \u00B7 EL \u00B7 $0.00 \u2502 ctx 42% \u00B7 TOPIC");

	const narrow = renderUnifiedBar(segments, 18);
	assert.ok(narrow.includes("RUNNAME"), narrow);
	assert.equal(narrow.includes("TOPIC"), false, "conversation drops before any run cell");
	assert.ok(visibleWidth(narrow) <= 18, narrow);

	const tiny = renderUnifiedBar(segments, 6);
	assert.ok(visibleWidth(tiny) <= 6, tiny);
});

test("workflowSegments label elapsed with a clock and cost with $, most important first", () => {
	const segments = workflowSegments({ name: "review", checkpoints: 3, costUsd: 0.42, elapsedMs: 529_000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null }, tuiTheme);
	assert.deepEqual(segments.map((segment) => [segment.text, segment.priority]), [
		["\u{1F6E0}\u{FE0F} review", 0],
		["\u{1F6A9} 3", 1],
		["\u{23F1} 8:49", 2],
		["$0.42", 3],
	]);
});

test("workflowSegments appends the soft target and pins a pending stop against elision", () => {
	const view = { name: "review", checkpoints: 3, costUsd: 6.4, elapsedMs: 529_000, pendingStop: "cost-limit" as const, limits: { costLimit: 5, timeBudgetMs: 3_600_000 }, unbounded: false, currentEffect: null };
	const segments = workflowSegments(view, tuiTheme);
	const pill = segments.find((segment) => segment.key === "workflow-soft-stop");
	assert.ok(pill, "pending soft stop pill present");
	assert.ok(pill.text.includes("stopping at next checkpoint"), pill.text);
	assert.equal(pill.priority, -1, "pill outranks identity so elision cannot drop it");
	assert.equal(segments.find((segment) => segment.key === "workflow-cost")?.text, "$6.40/$5.00");
	assert.ok(segments.find((segment) => segment.key === "workflow-elapsed")?.text.includes("/1:00:00"));
	const narrow = renderUnifiedBar(segments, 40);
	assert.ok(narrow.includes("target reached"), narrow);
	assert.equal(narrow.includes("review"), false, "the pill outranks the run name when eliding");
});

test("workflowSegments renders an unbounded view with the ∞ cell and no checkpoints cell", () => {
	const view = { name: "review", checkpoints: 5, costUsd: 0.42, elapsedMs: 529_000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: true, currentEffect: null };
	const segments = workflowSegments(view, tuiTheme);
	const keys = segments.map((segment) => segment.key);
	assert.equal(keys.includes("workflow-unbounded"), true, "an unbounded run carries the ∞ cell");
	assert.equal(keys.includes("workflow-checkpoints"), false, "no checkpoint count cell on an unbounded run");
	const unbounded = segments.find((segment) => segment.key === "workflow-unbounded")!;
	assert.ok(unbounded.text.includes("\u221E unbounded"), "the cell text is the unbounded marker");
});

test("installWorkflowFooter replaces the footer once; uninstall restores the built-in one", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 62, record });
	const view = () => ({ state, progress: { name: "review", checkpoints: 1, costUsd: 0.1, elapsedMs: 1000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null } });

	installWorkflowFooter(ctx, view);
	installWorkflowFooter(ctx, view);
	assert.equal(record.footerInstalls, 1, "repeated progress ticks reuse the installed footer");

	const lines = renderFooterAt(record, 120) ?? [];
	assert.equal(lines.length, 2, "unified bar plus the dim ambient line");
	assert.ok(lines[0].includes("review") && lines[0].includes("\u2502 [dim:ctx ]"), lines[0]);

	uninstallWorkflowFooter(ctx);
	assert.equal(record.footer, undefined, "run end restores the built-in footer");
	assert.equal(record.footerRestores, 1);
});

test("installWorkflowFooter stays silent headless", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const headless = makeTUICtx({ hasUI: false, record });
	installWorkflowFooter(headless, () => ({ state, progress: { name: "review", checkpoints: 0, costUsd: 0, elapsedMs: 0, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null } }));
	assert.equal(record.footerInstalls ?? 0, 0, "headless installs no footer");
});

// WHY: RPC reports hasUI, so it must receive setStatus/setWidget updates; workflow footer chrome
// is TUI-exclusive and must not install there.
test("an RPC context receives statuses but installs no footer", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const rpc = makeTUICtx({ hasUI: true, mode: "rpc", percent: 62, record });
	updateIndicators(rpc, state);
	installWorkflowFooter(rpc, () => ({ state, progress: { name: "review", checkpoints: 0, costUsd: 0, elapsedMs: 0, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null } }));
	uninstallWorkflowFooter(rpc);
	assert.ok(record.statuses.get("pi-schematic-ctx")?.includes("62%"), "RPC receives indicator statuses");
	assert.equal(record.footerInstalls ?? 0, 0, "no workflow footer in RPC mode");
});

// WHY: the footer is one physical row, so a multi-line currentEffect must be flattened before it
// reaches the bar or it injects line breaks into the render.
test("workflowSegments flattens a multi-line currentEffect into one cell", () => {
	const view = {
		name: "review", checkpoints: 1, costUsd: 0.1, elapsedMs: 1000, pendingStop: null,
		limits: { costLimit: null, timeBudgetMs: null }, unbounded: false,
		currentEffect: "line one\nline two\tline three",
	} as WorkflowProgressView;
	const effect = workflowSegments(view, tuiTheme).find((cell) => cell.key === "workflow-effect");
	assert.ok(effect, "the effect cell is present");
	assert.equal(effect.text.includes("\n"), false, "no newline reaches the footer row");
	assert.equal(effect.text.includes("\t"), false, "no tab reaches the footer row");
	assert.ok(effect.text.includes("line one line two"), effect.text);
});

test("workflow progress helpers share one formatting source", () => {
	assert.equal(formatCost(1.2), "$1.20");
	assert.equal(formatElapsed(3_725_000), "1:02:05");
	assert.equal(workflowLabel("review"), "\u{1F6E0}\u{FE0F} review");
});

test("workflow footer pins zero-state and boundary formatting", () => {
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatElapsed(0), "0:00");
	assert.equal(formatElapsed(59_000), "0:59");
	assert.equal(formatElapsed(3_600_000), "1:00:00");
	assert.equal(formatElapsed(-5_000), "0:00", "negative ticks clamp instead of printing garbage");
});
