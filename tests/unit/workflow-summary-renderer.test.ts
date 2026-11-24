// WHY: direct unit tests for the renderer's pure helpers and truncation boundary.
// These guard the visible contract without depending on golden snapshots: tone
// mapping, the detail-label set, and the collapsed model cap.
import { expect, test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { assertPresent } from "../assertions.js";
import { UNATTRIBUTED_MODEL } from "../../usage.js";
import type { ModelSpend } from "../../usage.js";
import { renderWorkflowSummary, reasonTone, MAX_MODELS_COLLAPSED, DETAIL_LABELS, HEADLINE_HANDLES, COUNTED_HANDLES } from "../../workflow/summary-renderer.js";
import type { WorkflowRunSummaryData } from "../../workflow/summary.js";
import type { WorkflowHandleName } from "../../workflow/types.js";

/** Identity theme so rendered text is plain, assertion-friendly strings. */
const identityTheme: Theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

/** Theme that surfaces the tone name so reasonTone's output is observable. */
const toneTheme: Theme = {
	fg: (name: string, _text: string) => `[${name}]`,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

function spendRow(model: string, costUsd: number, tokens = 1000): ModelSpend {
	return {
		key: `provider/${model}`,
		provider: model === UNATTRIBUTED_MODEL ? null : "provider",
		model,
		costUsd,
		totalTokens: tokens,
		inputTokens: Math.round(tokens * 0.6),
		outputTokens: Math.round(tokens * 0.3),
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		calls: 1,
	};
}

function makeData(overrides: Partial<WorkflowRunSummaryData> = {}): WorkflowRunSummaryData {
	return {
		v: 1,
		workflow: "test-wf",
		reason: "approved",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		elapsedMs: 60_000,
		checkpoints: 1,
		steps: 1,
		turns: 1,
		classifySteps: 0,
		activity: { run: 1 },
		costUsd: 1.0,
		spend: [spendRow("model-a", 1.0)],
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		crossedAt: null,
		...overrides,
	};
}

const modelLines = (lines: readonly string[]): string[] => lines.filter((line) => line.includes(" in ") && line.includes(" out"));

test("reasonTone maps error to the error tone", () => {
	expect(reasonTone("error")).toBe("error");
});

test("reasonTone maps reserved aborts to the warning tone", () => {
	expect(reasonTone("cancelled")).toBe("warning");
	expect(reasonTone("time-limit")).toBe("warning");
	expect(reasonTone("cost-limit")).toBe("warning");
});

test("reasonTone defaults to accent for non-reserved reasons", () => {
	expect(reasonTone("approved")).toBe("accent");
	expect(reasonTone("returned")).toBe("accent");
	expect(reasonTone("custom")).toBe("accent");
});

test("reasonTone is case-sensitive: 'Error' does not match 'error'", () => {
	expect(reasonTone("Error")).toBe("accent");
});

test("MAX_MODELS_COLLAPSED is 8", () => {
	expect(MAX_MODELS_COLLAPSED).toBe(8);
});

test("DETAIL_LABELS maps handoff, shell, and entries", () => {
	expect(DETAIL_LABELS.handoff).toBe("handoff");
	expect(DETAIL_LABELS.shell).toBe("shell");
	expect(DETAIL_LABELS.entries).toBe("entries");
});

test("DETAIL_LABELS maps notebook write, readonly, and new", () => {
	expect(DETAIL_LABELS.notebookWrite).toBe("notebook");
	expect(DETAIL_LABELS.readonly).toBe("readonly");
	expect(DETAIL_LABELS.new).toBe("new");
});

test("DETAIL_LABELS omits inspectors and technical handles", () => {
	// Inspectors and technical handles are absent from the detail ledger: they
	// live on the headline counts row, not the expanded detail row.
	for (const name of ["run", "checkpoint", "exit", "classify", "budget", "state", "notebookIndex", "notebookRead", "notebookTopic"] as WorkflowHandleName[]) {
		expect(DETAIL_LABELS[name], `${name} is not a detail label`).toBeUndefined();
	}
});

test("COUNTED_HANDLES is exactly the headline plus detail sets", () => {
	const covered = new Set<WorkflowHandleName>([...HEADLINE_HANDLES, ...(Object.keys(DETAIL_LABELS) as WorkflowHandleName[])]);
	expect([...covered].sort()).toStrictEqual([...COUNTED_HANDLES].sort());
});

test("collapsed rendering truncates models to MAX_MODELS_COLLAPSED and shows a more line", () => {
	const spend = Array.from({ length: MAX_MODELS_COLLAPSED + 3 }, (_, i) => spendRow(`m${i}`, 0.01));
	const data = makeData({ spend, costUsd: spend.reduce((sum, r) => sum + r.costUsd, 0) });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	expect(modelLines(lines).length, "collapsed caps at MAX_MODELS_COLLAPSED").toBe(MAX_MODELS_COLLAPSED);
	expect(
		lines.some((line) => line.includes("more")),
		"collapsed shows a 'more' line past the cap",
	).toBe(true);
});

test("expanded rendering shows every model with no truncation", () => {
	const spend = Array.from({ length: MAX_MODELS_COLLAPSED + 3 }, (_, i) => spendRow(`m${i}`, 0.01));
	const data = makeData({ spend, costUsd: spend.reduce((sum, r) => sum + r.costUsd, 0) });
	const lines = renderWorkflowSummary(data, true, identityTheme).render(80);
	expect(modelLines(lines).length, "expanded shows every model").toBe(MAX_MODELS_COLLAPSED + 3);
	expect(!lines.some((line) => line.includes("more")), "expanded has no truncation line").toBe(true);
});

test("collapsed rendering shows all models when spend fits within the cap", () => {
	const spend = Array.from({ length: MAX_MODELS_COLLAPSED }, (_, i) => spendRow(`m${i}`, 0.01));
	const data = makeData({ spend, costUsd: spend.reduce((sum, r) => sum + r.costUsd, 0) });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	expect(modelLines(lines).length, "at-cap spend is fully shown collapsed").toBe(MAX_MODELS_COLLAPSED);
	expect(!lines.some((line) => line.includes("more")), "no truncation when at the cap").toBe(true);
});

test("counts row labels checkpoints instead of a bare glyph", () => {
	const lines = renderWorkflowSummary(makeData({ checkpoints: 3 }), false, identityTheme).render(80);
	expect(
		lines.some((line) => line.includes("checkpoints 3")),
		"checkpoints count is labelled",
	).toBe(true);
	expect(!lines.some((line) => line.includes("\u{1F6A9}")), "no bare flag glyph").toBe(true);
});

test("an unbounded run renders the limits row and no target row", () => {
	const lines = renderWorkflowSummary(makeData({ unbounded: true }), false, identityTheme).render(80);
	const unbounded = lines.find((line) => line.includes("unbounded \u2014 no checkpoint declared")) ?? "";
	expect(unbounded, "the unbounded limits row is present").not.toBe("");
	expect(unbounded, "the row is keyed under limits").toContain("limits");
	expect(
		lines.some((line) => line.includes("target ")),
		"an unbounded run carries no soft-target row",
	).toBe(false);
	const checkpoints = lines.find((line) => line.includes("checkpoints ")) ?? "";
	expect(checkpoints, "the counts row never carries the unbounded glyph").not.toContain("\u221E");
});

test("collapsed model rows split tokens into input and output", () => {
	const lines = renderWorkflowSummary(makeData(), false, identityTheme).render(80);
	const row = modelLines(lines)[0] ?? "";
	expect(row, "input tokens are labelled and shown").toContain("600 in");
	expect(row, "output tokens are labelled and shown").toContain("300 out");
	expect(!row.includes("tok"), "no single aggregate token metric remains").toBe(true);
});

test("a salvaged checkpoint payload renders as a stopped-at-checkpoint row", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "time-limit", partial: { round: 3 } }), false, identityTheme).render(80);
	const row = lines.find((line) => line.includes("stopped")) ?? "";
	expect(row, "names the stop mechanism").toContain("at checkpoint");
	expect(row, "shows the salvaged payload").toContain('{"round":3}');
});

test("no stopped row for an absent or null payload", () => {
	for (const partial of [undefined, null]) {
		const lines = renderWorkflowSummary(makeData({ reason: "time-limit", partial }), false, identityTheme).render(80);
		expect(!lines.some((line) => line.includes("stopped")), "no row without a payload").toBe(true);
	}
});

test("error reason renders with the error tone", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "error", error: "boom" }), false, toneTheme).render(80);
	expect(
		lines.some((line) => line.includes("[error]")),
		"exit row surfaces the error tone",
	).toBe(true);
});

test("a soft cost stop explains the overshoot against its target", () => {
	const data = makeData({ reason: "cost-limit", costUsd: 6.4, limits: { costLimit: 5, timeBudgetMs: null }, crossedAt: { costUsd: 5.2, elapsedMs: 1_000 } });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	const target = lines.find((line) => line.includes("$5.00"));
	assertPresent(target, "target row rendered for a crossed soft cost stop");
	expect(target).toContain("$6.40");
	expect(target.includes("+$1.40") && target.includes("+28%")).toBe(true);
});

test("a soft time stop explains the overshoot against its target", () => {
	const data = makeData({
		reason: "time-limit",
		elapsedMs: 4_320_000,
		limits: { costLimit: null, timeBudgetMs: 3_600_000 },
		crossedAt: { costUsd: 1, elapsedMs: 3_600_000 },
	});
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	const target = lines.find((line) => line.includes("1:00:00"));
	assertPresent(target, "target row rendered for a crossed soft time stop");
	expect(target).toContain("1:12:00");
});

test("a soft stop renders its human reason, never the reserved token", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "cost-limit" }), false, identityTheme).render(80);
	const text = lines.join("\n");
	expect(text).toContain("cost target reached");
	expect(text, "reserved token stays out of the transcript").not.toContain("cost-limit");
});

test("cost-limit reason renders with the warning tone", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "cost-limit" }), false, toneTheme).render(80);
	expect(
		lines.some((line) => line.includes("[warning]")),
		"exit row surfaces the warning tone",
	).toBe(true);
});
