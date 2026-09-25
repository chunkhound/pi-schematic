import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../state.js";
import { updateIndicators, STATUS_KEY_TOPIC, STATUS_KEY_READONLY } from "../../tui.js";
import { makeTUICtx } from "./helpers.js";

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
	assert.ok(s?.includes("\u{1F512}"), "readonly indicator should show lock emoji when enabled");
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
