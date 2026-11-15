import { expect, test, vi } from "vitest";
import { SessionManager, type ContextUsage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { updateIndicators, STATUS_KEY_HANDOFF, STATUS_KEY_NOTEBOOK, STATUS_KEY_TOPIC, STATUS_KEY_READONLY, WIDGET_KEY_WARNING } from "../../tui.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";
import { realTheme } from "../support/theme.js";

const STATUS_KEY_CTX = "pi-schematic-ctx";

interface IndicatorRunner {
	fixture: RunnerFixture;
	/** A context the runner built, reading the usage the test set last. */
	ctx: ExtensionContext;
	setPercent: (percent: number | null) => void;
}

/** A runner with no extension loaded, the recording UI in TUI mode with the real Theme, and a context usage the test sets. */
async function createIndicatorRunner(): Promise<IndicatorRunner> {
	let usage: ContextUsage | undefined;
	const fixture = await createRunner({
		cwd: process.cwd(),
		mode: "tui",
		factories: [],
		ui: { theme: realTheme },
		context: { getContextUsage: () => usage },
	});
	return {
		fixture,
		ctx: fixture.runner.createContext(),
		setPercent: (percent) => {
			usage = percent === null ? undefined : { tokens: null, contextWindow: 200_000, percent };
		},
	};
}

/** Runs `updateIndicators` at `percent` on a fresh state, or on `state` when given. */
async function indicatorsAt(percent: number | null, state = createState()): Promise<RunnerFixture["ui"]> {
	const { fixture, ctx, setPercent } = await createIndicatorRunner();
	setPercent(percent);
	updateIndicators(ctx, state);
	return fixture.ui;
}

test.for([
	{ percent: 12, shown: 12, tone: "dim" },
	{ percent: 29, shown: 29, tone: "dim" },
	{ percent: 29.4, shown: 29, tone: "dim" },
	{ percent: 29.5, shown: 30, tone: "accent" },
	{ percent: 30, shown: 30, tone: "accent" },
	{ percent: 42, shown: 42, tone: "accent" },
	{ percent: 49.4, shown: 49, tone: "accent" },
	{ percent: 49.5, shown: 50, tone: "warning" },
	{ percent: 50, shown: 50, tone: "warning" },
	{ percent: 55, shown: 55, tone: "warning" },
	{ percent: 69.4, shown: 69, tone: "warning" },
	{ percent: 69.5, shown: 70, tone: "error" },
	{ percent: 70, shown: 70, tone: "error" },
	{ percent: 85, shown: 85, tone: "error" },
] as const)("updateIndicators shows $percent% context usage as $shown% in the $tone tone", async ({ percent, shown, tone }) => {
	const ui = await indicatorsAt(percent);

	expect(ui.statuses.get(STATUS_KEY_CTX)).toBe(realTheme.fg("dim", "ctx ") + realTheme.fg(tone, `${String(shown)}%`));
});

test("updateIndicators handles missing context usage", async () => {
	const ui = await indicatorsAt(null);

	expect(ui.statuses.get(STATUS_KEY_CTX), "missing usage shows --%").toBe(realTheme.fg("dim", "ctx --%"));
});

test.for([Number.NaN, Number.POSITIVE_INFINITY, -1])("updateIndicators treats malformed percentages as unavailable: %s", async (percent) => {
	const ui = await indicatorsAt(percent);

	expect(ui.statuses.get(STATUS_KEY_CTX)).toBe(realTheme.fg("dim", "ctx --%"));
	expect(ui.widgets.get(WIDGET_KEY_WARNING)).toBeUndefined();
});

test("updateIndicators preserves overflow context percentages", async () => {
	const ui = await indicatorsAt(125);

	expect(ui.statuses.get(STATUS_KEY_CTX)).toBe(realTheme.fg("dim", "ctx ") + realTheme.fg("error", "125%"));
	expect(ui.widgets.get(WIDGET_KEY_WARNING)).toStrictEqual([
		realTheme.fg("error", "⚠ ") + realTheme.fg("warning", "Context at 125% — no active topic; handoff soon unless you can assign one cleanly"),
	]);
});

test("updateIndicators no-ops when ctx.hasUI is false", async () => {
	// Headless, and without a context usage binding: reading the usage would throw.
	const fixture = await createRunner({ cwd: process.cwd(), mode: "print", factories: [] });
	const ctx = fixture.runner.createContext();
	const setStatus = vi.spyOn(ctx.ui, "setStatus");
	const setWidget = vi.spyOn(ctx.ui, "setWidget");

	updateIndicators(ctx, createState());

	expect(setStatus, "no-op should not call any setStatus").not.toHaveBeenCalled();
	expect(setWidget, "no-op should not call any setWidget").not.toHaveBeenCalled();
});

test("updateIndicators shows notebook page count in status", async () => {
	const state = createState();
	state.notebookPages.set("entry-1", "first entry");
	state.notebookPages.set("entry-2", "second entry");

	const ui = await indicatorsAt(null, state);

	expect(ui.statuses.get(STATUS_KEY_NOTEBOOK), "notebook page count should be 2").toBe("📒 2");
});

test("updateIndicators shows a dim empty notebook count", async () => {
	const ui = await indicatorsAt(null);

	expect(ui.statuses.get(STATUS_KEY_NOTEBOOK)).toBe(realTheme.fg("dim", "\u{1F4D2} 0"));
});

test("updateIndicators shows active notebook topic when set", async () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";

	const ui = await indicatorsAt(30, state);

	expect(ui.statuses.get(STATUS_KEY_TOPIC)).toBe("🧭 oauth");
});

test("updateIndicators shows readonly indicator when enabled", async () => {
	const state = createState();
	state.readonlyEnabled = true;

	const ui = await indicatorsAt(null, state);

	expect(ui.statuses.get(STATUS_KEY_READONLY), "readonly indicator shows the lock and 'readonly' when enabled").toBe(
		realTheme.fg("warning", "\u{1F512} readonly"),
	);
});

test("updateIndicators hides readonly indicator when disabled", async () => {
	const state = createState();
	state.readonlyEnabled = false;

	const ui = await indicatorsAt(null, state);

	expect(ui.statuses.get(STATUS_KEY_READONLY), "readonly indicator should be undefined when disabled").toBeUndefined();
});

test("updateIndicators shows readonly-specific warning widget at 70%+ context", async () => {
	const state = createState();
	state.readonlyEnabled = true;

	const ui = await indicatorsAt(85, state);

	expect(ui.widgets.get(WIDGET_KEY_WARNING), "the widget names readonly, spawn and explicit /handoff, and promises no auto-resume").toStrictEqual([
		realTheme.fg("error", "⚠ ") +
			realTheme.fg("warning", "Context at 85% — readonly: same topic → spawn; different topic → explicit /handoff or an eligible human topic boundary"),
	]);
});

test("updateIndicators shows the topic-fit warning widget at 85% with an active topic", async () => {
	const state = createState();
	state.activeNotebookTopic = "oauth";

	const ui = await indicatorsAt(85, state);

	expect(ui.widgets.get(WIDGET_KEY_WARNING)).toStrictEqual([
		realTheme.fg("error", "⚠ ") + realTheme.fg("warning", "Context at 85% — use topic fit: same topic → spawn, different topic → handoff"),
	]);
});

test("updateIndicators shows the no-topic warning widget at 85% without an active topic", async () => {
	const ui = await indicatorsAt(85);

	expect(ui.widgets.get(WIDGET_KEY_WARNING)).toStrictEqual([
		realTheme.fg("error", "⚠ ") + realTheme.fg("warning", "Context at 85% — no active topic; handoff soon unless you can assign one cleanly"),
	]);
});

test("updateIndicators shows the warning widget at 69.5% context", async () => {
	const ui = await indicatorsAt(69.5);

	expect(ui.widgets.get(WIDGET_KEY_WARNING)).toStrictEqual([
		realTheme.fg("error", "⚠ ") + realTheme.fg("warning", "Context at 70% — no active topic; handoff soon unless you can assign one cleanly"),
	]);
});

test("updateIndicators hides widget below 70% context", async () => {
	const { fixture, ctx, setPercent } = await createIndicatorRunner();
	const state = createState();
	// Show the widget first, to verify it gets cleared.
	setPercent(85);
	updateIndicators(ctx, state);
	setPercent(69.4);

	updateIndicators(ctx, state);

	expect(fixture.ui.widgets.get(WIDGET_KEY_WARNING), "warning widget should be cleared below 70%").toBeUndefined();
});

test("session_start new clears stale handoff status and warning widget", async () => {
	let usage: ContextUsage | undefined = { tokens: 170_000, contextWindow: 200_000, percent: 85 };
	const fixture = await createRunner({
		cwd: process.cwd(),
		mode: "tui",
		sessionManager: SessionManager.inMemory(process.cwd()),
		ui: { theme: realTheme, addAutocompleteProvider: () => undefined },
		context: { getContextUsage: () => usage, isIdle: () => true, isProjectTrusted: () => false },
		activeTools: [],
	});
	const { runner, ui } = fixture;
	await fixture.command("handoff").handler("implement auth", runner.createCommandContext());
	// The toggle refreshes the indicators, which shows the warning widget at 85%.
	await fixture.command("readonly").handler("", runner.createCommandContext());
	expect(ui.statuses.get(STATUS_KEY_HANDOFF), "the handoff status is set before the reset").toBeDefined();
	expect(ui.widgets.get(WIDGET_KEY_WARNING), "the warning widget is set before the reset").toBeDefined();
	usage = undefined;

	await runner.emit({ type: "session_start", reason: "new" });

	expect(ui.statuses.get(STATUS_KEY_HANDOFF)).toBeUndefined();
	expect(ui.widgets.get(WIDGET_KEY_WARNING)).toBeUndefined();
});
