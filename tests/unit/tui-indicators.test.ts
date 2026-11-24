import { expect, test } from "vitest";
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
import { assertPresent } from "../assertions.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** TEST_TUI_THEME carries only `fg`; `workflowSegments` needs the full Theme surface. */
const tuiTheme = TEST_TUI_THEME as unknown as Theme;

test("updateIndicators sets context usage status with correct color tone", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 42, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	expect(s, "42% should use accent tone").toContain("[accent:42%]");
	expect(record.widgets.get("pi-schematic-warning"), "42% is below 70 — no warning widget").toBeUndefined();
});

test("updateIndicators uses error tone at 70%+ context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 85, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	expect(s, "85% should use error tone").toContain("[error:85%]");
	const w = record.widgets.get("pi-schematic-warning");
	expect(w?.[0], "warning widget shown at 85%").toContain("85%");
});

test("updateIndicators uses warning tone at 50-69% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 55, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	expect(s, "55% should use warning tone").toContain("[warning:55%]");
});

test("updateIndicators uses accent tone at 30-49% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	expect(s, "30% should use accent tone").toContain("[accent:30%]");
});

test("updateIndicators handles missing context usage", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	expect(s, "missing usage shows --%").toContain("--%");
});

test.for([Number.NaN, Number.POSITIVE_INFINITY, -1])("updateIndicators treats malformed percentages as unavailable: %s", (percent) => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	updateIndicators(makeTUICtx({ percent, record }), state);
	expect(record.statuses.get("pi-schematic-ctx")).toContain("--%");
	expect(record.widgets.get("pi-schematic-warning")).toBeUndefined();
});

test("updateIndicators preserves overflow context percentages", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	updateIndicators(makeTUICtx({ percent: 125, record }), state);
	expect(record.statuses.get("pi-schematic-ctx")).toContain("125%");
	expect(record.widgets.get("pi-schematic-warning")?.[0]).toContain("125%");
});

test("updateIndicators skips duplicate status and widget writes", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map(), widgets: new Map() };
	const ctx = makeTUICtx({ percent: 85, record });
	let statuses = 0;
	let widgets = 0;
	const setStatus = ctx.ui.setStatus;
	const setWidget = ctx.ui.setWidget;
	ctx.ui.setStatus = (...args: [string, string | undefined]) => { statuses++; setStatus(...args); };
	ctx.ui.setWidget = (...args: [string, string[] | undefined]) => { widgets++; setWidget(...args); };
	updateIndicators(ctx, state);
	const first = [statuses, widgets];
	expect(first[0] > 0, "the first refresh writes statuses").toBeTruthy();
	expect(first[1], "the first refresh writes the warning widget").toBe(1);
	updateIndicators(ctx, state);
	expect([statuses, widgets], "a repeated refresh writes nothing").toStrictEqual(first);
});

test("updateIndicators no-ops when ctx.hasUI is false", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ hasUI: false, record });

	updateIndicators(ctx, state);
	expect(record.statuses.size, "no-op should not call any setStatus").toBe(0);
	expect(record.widgets.size, "no-op should not call any setWidget").toBe(0);
});

test("updateIndicators shows notebook page count in status", () => {
	const state = createState();
	state.notebookPages.set("entry-1", "first entry");
	state.notebookPages.set("entry-2", "second entry");
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-notebook");
	expect(s, "notebook page count should be 2").toContain("2");
});

test("updateIndicators shows active notebook topic when set", () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	expect(record.statuses.get(STATUS_KEY_TOPIC)).toBe("🧭 oauth");
});

test("updateIndicators shows readonly indicator when enabled", () => {
	const state = createState();
	state.readonlyEnabled = true;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get(STATUS_KEY_READONLY);
	expect(s, "readonly indicator should show lock emoji when enabled").toContain("\u{1F512}");
	expect(s, "readonly indicator should show 'readonly' text when enabled").toContain("readonly");
});

test("updateIndicators hides readonly indicator when disabled", () => {
	const state = createState();
	state.readonlyEnabled = false;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	expect(record.statuses.get(STATUS_KEY_READONLY), "readonly indicator should be undefined when disabled").toBeUndefined();
});

test("updateIndicators shows readonly-specific warning widget at 70%+ context", () => {
	const state = createState();
	state.readonlyEnabled = true;
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 85, record });

	updateIndicators(ctx, state);
	const w = record.widgets.get("pi-schematic-warning");
	assertPresent(w, "warning widget should be present at 85%");
	expect(w[0], "widget should mention readonly").toContain("readonly");
	expect(w[0], "widget should mention spawn").toContain("spawn");
	expect(w[0], "widget should mention explicit /handoff").toContain("explicit /handoff");
	expect(w[0], "widget should not promise auto-resume wording").not.toContain("resumes readonly");
});

test("updateIndicators hides widget below 70% context", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	// Pre-set a widget to verify it gets cleared
	record.widgets.set("pi-schematic-warning", ["existing"]);
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	expect(record.widgets.get("pi-schematic-warning"), "warning widget should be cleared below 70%").toBeUndefined();
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
	expect(renderUnifiedBar(segments, 200)).toBe("RUNNAME \u00B7 CP \u00B7 EL \u00B7 $0.00 \u2502 ctx 42% \u00B7 TOPIC");

	const narrow = renderUnifiedBar(segments, 18);
	expect(narrow.includes("RUNNAME"), narrow).toBeTruthy();
	expect(narrow.includes("TOPIC"), "conversation drops before any run cell").toBe(false);
	expect(visibleWidth(narrow) <= 18, narrow).toBeTruthy();

	const tiny = renderUnifiedBar(segments, 6);
	expect(visibleWidth(tiny) <= 6, tiny).toBeTruthy();
});

test("workflowSegments label elapsed with a clock and cost with $, most important first", () => {
	const segments = workflowSegments({ name: "review", checkpoints: 3, costUsd: 0.42, elapsedMs: 529_000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null }, tuiTheme);
	expect(segments.map((segment) => [segment.text, segment.priority])).toStrictEqual([
		["\u{1F6E0}\u{FE0F} review", 0],
		["\u{1F6A9} 3", 1],
		["\u{23F1} 8:49", 2],
		["$0.42", 3],
	]);
});

test("workflowSegments appends the soft target and pins a pending stop against elision", () => {
	const view = { name: "review", checkpoints: 3, costUsd: 6.4, elapsedMs: 529_000, pendingStop: "cost-limit" as const, limits: { costLimit: 5, timeBudgetMs: 3_600_000 }, unbounded: false, currentEffect: null };
	const segments = workflowSegments(view, tuiTheme);
	const pill = segments.find((segment) => segment.key === "workflow-soft-stop")!;
	expect(pill, "pending soft stop pill present").toBeTruthy();
	expect(pill.text.includes("stopping at next checkpoint"), pill.text).toBeTruthy();
	expect(pill.priority, "pill outranks identity so elision cannot drop it").toBe(-1);
	expect(segments.find((segment) => segment.key === "workflow-cost")?.text).toBe("$6.40/$5.00");
	expect(segments.find((segment) => segment.key === "workflow-elapsed")?.text.includes("/1:00:00")).toBeTruthy();
	const narrow = renderUnifiedBar(segments, 40);
	expect(narrow.includes("target reached"), narrow).toBeTruthy();
	expect(narrow.includes("review"), "the pill outranks the run name when eliding").toBe(false);
});

test("workflowSegments renders an unbounded view with the ∞ cell and no checkpoints cell", () => {
	const view = { name: "review", checkpoints: 5, costUsd: 0.42, elapsedMs: 529_000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: true, currentEffect: null };
	const segments = workflowSegments(view, tuiTheme);
	const keys = segments.map((segment) => segment.key);
	expect(keys.includes("workflow-unbounded"), "an unbounded run carries the ∞ cell").toBe(true);
	expect(keys.includes("workflow-checkpoints"), "no checkpoint count cell on an unbounded run").toBe(false);
	const unbounded = segments.find((segment) => segment.key === "workflow-unbounded")!;
	expect(unbounded.text.includes("\u221E unbounded"), "the cell text is the unbounded marker").toBeTruthy();
});

test("installWorkflowFooter replaces the footer once; uninstall restores the built-in one", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 62, record });
	const view = () => ({ state, progress: { name: "review", checkpoints: 1, costUsd: 0.1, elapsedMs: 1000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null } });

	installWorkflowFooter(ctx, view);
	installWorkflowFooter(ctx, view);
	expect(record.footerInstalls, "repeated progress ticks reuse the installed footer").toBe(1);

	const lines = renderFooterAt(record, 120) ?? [];
	expect(lines.length, "unified bar plus the dim ambient line").toBe(2);
	expect(lines[0].includes("review") && lines[0].includes("\u2502 [dim:ctx ]"), lines[0]).toBeTruthy();

	uninstallWorkflowFooter(ctx);
	expect(record.footer, "run end restores the built-in footer").toBeUndefined();
	expect(record.footerRestores).toBe(1);
});

test("workflow footer renders foreign statuses as one-line fitted cells", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map([["other-extension", "FOREIGN\nSTATUS"], [STATUS_KEY_TOPIC, "INJECTED-TOPIC"]]), widgets: new Map() };
	const ctx = makeTUICtx({ percent: 62, record });
	installWorkflowFooter(ctx, () => ({ state, progress: { name: "review", checkpoints: 1, costUsd: 0.1, elapsedMs: 1000, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null } }));
	const lines = renderFooterAt(record, 120) ?? [];
	expect(lines[0].includes("FOREIGN STATUS"), lines[0]).toBeTruthy();
	expect(lines[0].includes("\n"), lines[0]).toBe(false);
	expect(visibleWidth(lines[0]) <= 120, lines[0]).toBeTruthy();
	expect(lines[0].includes("INJECTED-TOPIC"), "schematic-owned keys are not re-rendered as foreign cells").toBe(false);
});

test("installWorkflowFooter stays silent headless", () => {
	const state = createState();
	const record: TUIRecord = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const headless = makeTUICtx({ hasUI: false, record });
	installWorkflowFooter(headless, () => ({ state, progress: { name: "review", checkpoints: 0, costUsd: 0, elapsedMs: 0, pendingStop: null, limits: { costLimit: null, timeBudgetMs: null }, unbounded: false, currentEffect: null } }));
	expect(record.footerInstalls ?? 0, "headless installs no footer").toBe(0);
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
	expect(record.statuses.get("pi-schematic-ctx")?.includes("62%"), "RPC receives indicator statuses").toBeTruthy();
	expect(record.footerInstalls ?? 0, "no workflow footer in RPC mode").toBe(0);
});

// WHY: the footer is one physical row, so a multi-line currentEffect must be flattened before it
// reaches the bar or it injects line breaks into the render.
test("workflowSegments flattens a multi-line currentEffect into one cell", () => {
	const view = {
		name: "review", checkpoints: 1, costUsd: 0.1, elapsedMs: 1000, pendingStop: null,
		limits: { costLimit: null, timeBudgetMs: null }, unbounded: false,
		currentEffect: "line one\nline two\tline three",
	} as WorkflowProgressView;
	const effect = workflowSegments(view, tuiTheme).find((cell) => cell.key === "workflow-effect")!;
	expect(effect, "the effect cell is present").toBeTruthy();
	expect(effect.text.includes("\n"), "no newline reaches the footer row").toBe(false);
	expect(effect.text.includes("\t"), "no tab reaches the footer row").toBe(false);
	expect(effect.text.includes("line one line two"), effect.text).toBeTruthy();
});

test("workflow progress helpers share one formatting source", () => {
	expect(formatCost(1.2)).toBe("$1.20");
	expect(formatElapsed(3_725_000)).toBe("1:02:05");
	expect(workflowLabel("review")).toBe("\u{1F6E0}\u{FE0F} review");
});

test("workflow footer pins zero-state and boundary formatting", () => {
	expect(formatCost(0)).toBe("$0.00");
	expect(formatElapsed(0)).toBe("0:00");
	expect(formatElapsed(59_000)).toBe("0:59");
	expect(formatElapsed(3_600_000)).toBe("1:00:00");
	expect(formatElapsed(-5_000), "negative ticks clamp instead of printing garbage").toBe("0:00");
});
