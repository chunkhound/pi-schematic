import { expect, test } from "vitest";
import { createState } from "../../state.js";
import { updateIndicators, STATUS_KEY_TOPIC, STATUS_KEY_READONLY } from "../../tui.js";
import { makeTUICtx } from "./helpers.js";
import { assertPresent } from "../assertions.js";

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

test("updateIndicators handles null context usage", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: null, record });

	updateIndicators(ctx, state);
	const s = record.statuses.get("pi-schematic-ctx");
	expect(s, "null usage shows --%").toContain("--%");
});

test("updateIndicators treats malformed percentages as unavailable", () => {
	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		const state = createState();
		const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
		updateIndicators(makeTUICtx({ percent, record }), state);
		expect(record.statuses.get("pi-schematic-ctx")).toContain("--%");
		expect(record.widgets.get("pi-schematic-warning")).toBeUndefined();
	}
});

test("updateIndicators preserves overflow context percentages", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	updateIndicators(makeTUICtx({ percent: 125, record }), state);
	expect(record.statuses.get("pi-schematic-ctx")).toContain("125%");
	expect(record.widgets.get("pi-schematic-warning")?.[0]).toContain("125%");
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
