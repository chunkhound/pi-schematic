// WHY: direct unit tests for the renderer's pure helpers and truncation boundary.
// These guard the visible contract without depending on golden snapshots: tone
// mapping, the detail-label set, and the collapsed model cap.
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { UNATTRIBUTED_MODEL } from "../../usage.js";
import type { ModelSpend } from "../../usage.js";
import { renderWorkflowSummary, reasonTone, MAX_MODELS_COLLAPSED, DETAIL_LABELS } from "../../workflow/summary-renderer.js";
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

const modelLines = (lines: string[]): string[] => lines.filter((line) => line.includes(" in ") && line.includes(" out"));

test("reasonTone maps error to the error tone", () => {
	assert.equal(reasonTone("error"), "error");
});

test("reasonTone maps reserved aborts to the warning tone", () => {
	assert.equal(reasonTone("cancelled"), "warning");
	assert.equal(reasonTone("time-limit"), "warning");
	assert.equal(reasonTone("cost-limit"), "warning");
});

test("reasonTone defaults to accent for non-reserved reasons", () => {
	assert.equal(reasonTone("approved"), "accent");
	assert.equal(reasonTone("returned"), "accent");
	assert.equal(reasonTone("custom"), "accent");
});

test("reasonTone is case-sensitive: 'Error' does not match 'error'", () => {
	assert.equal(reasonTone("Error"), "accent");
});

test("MAX_MODELS_COLLAPSED is 8", () => {
	assert.equal(MAX_MODELS_COLLAPSED, 8);
});

test("DETAIL_LABELS maps only counted handles that appear in the detail ledger", () => {
	assert.equal(DETAIL_LABELS.handoff, "handoff");
	assert.equal(DETAIL_LABELS.shell, "shell");
	assert.equal(DETAIL_LABELS.entries, "entries");
	assert.equal(DETAIL_LABELS.notebookWrite, "notebook");
	assert.equal(DETAIL_LABELS.readonly, "readonly");
	assert.equal(DETAIL_LABELS.new, "new");
	// Inspectors and technical handles are absent from the detail ledger: they
	// live on the headline counts row, not the expanded detail row.
	for (const name of ["run", "checkpoint", "exit", "classify", "budget", "state", "notebookIndex", "notebookRead", "notebookTopic"] as WorkflowHandleName[]) {
		assert.equal(DETAIL_LABELS[name as keyof typeof DETAIL_LABELS], undefined, `${name} is not a detail label`);
	}
});

test("collapsed rendering truncates models to MAX_MODELS_COLLAPSED and shows a more line", () => {
	const spend = Array.from({ length: MAX_MODELS_COLLAPSED + 3 }, (_, i) => spendRow(`m${i}`, 0.01));
	const data = makeData({ spend, costUsd: spend.reduce((sum, r) => sum + r.costUsd, 0) });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	assert.equal(modelLines(lines).length, MAX_MODELS_COLLAPSED, "collapsed caps at MAX_MODELS_COLLAPSED");
	assert.ok(lines.some((line) => line.includes("more")), "collapsed shows a 'more' line past the cap");
});

test("expanded rendering shows every model with no truncation", () => {
	const spend = Array.from({ length: MAX_MODELS_COLLAPSED + 3 }, (_, i) => spendRow(`m${i}`, 0.01));
	const data = makeData({ spend, costUsd: spend.reduce((sum, r) => sum + r.costUsd, 0) });
	const lines = renderWorkflowSummary(data, true, identityTheme).render(80);
	assert.equal(modelLines(lines).length, MAX_MODELS_COLLAPSED + 3, "expanded shows every model");
	assert.ok(!lines.some((line) => line.includes("more")), "expanded has no truncation line");
});

test("collapsed rendering shows all models when spend fits within the cap", () => {
	const spend = Array.from({ length: MAX_MODELS_COLLAPSED }, (_, i) => spendRow(`m${i}`, 0.01));
	const data = makeData({ spend, costUsd: spend.reduce((sum, r) => sum + r.costUsd, 0) });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	assert.equal(modelLines(lines).length, MAX_MODELS_COLLAPSED, "at-cap spend is fully shown collapsed");
	assert.ok(!lines.some((line) => line.includes("more")), "no truncation when at the cap");
});

test("counts row labels checkpoints instead of a bare glyph", () => {
	const lines = renderWorkflowSummary(makeData({ checkpoints: 3 }), false, identityTheme).render(80);
	assert.ok(lines.some((line) => line.includes("checkpoints 3")), "checkpoints count is labelled");
	assert.ok(!lines.some((line) => line.includes("\u{1F6A9}")), "no bare flag glyph");
});

test("an unbounded run renders the limits row and no target row", () => {
	const lines = renderWorkflowSummary(makeData({ unbounded: true }), false, identityTheme).render(80);
	const unbounded = lines.find((line) => line.includes("unbounded \u2014 no checkpoint declared")) ?? "";
	assert.ok(unbounded, "the unbounded limits row is present");
	assert.ok(unbounded.includes("limits"), "the row is keyed under limits");
	assert.equal(lines.some((line) => line.includes("target ")), false, "an unbounded run carries no soft-target row");
	const checkpoints = lines.find((line) => line.includes("checkpoints ")) ?? "";
	assert.equal(checkpoints.includes("\u221E"), false, "the counts row never carries the unbounded glyph");
});

test("collapsed model rows split tokens into input and output", () => {
	const lines = renderWorkflowSummary(makeData(), false, identityTheme).render(80);
	const row = modelLines(lines)[0] ?? "";
	assert.ok(row.includes("600 in"), "input tokens are labelled and shown");
	assert.ok(row.includes("300 out"), "output tokens are labelled and shown");
	assert.ok(!row.includes("tok"), "no single aggregate token metric remains");
});

test("a salvaged checkpoint payload renders as a stopped-at-checkpoint row", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "time-limit", partial: { round: 3 } }), false, identityTheme).render(80);
	const row = lines.find((line) => line.includes("stopped")) ?? "";
	assert.ok(row.includes("at checkpoint"), "names the stop mechanism");
	assert.ok(row.includes('{"round":3}'), "shows the salvaged payload");
});

test("no stopped row for an absent or null payload", () => {
	for (const partial of [undefined, null]) {
		const lines = renderWorkflowSummary(makeData({ reason: "time-limit", partial }), false, identityTheme).render(80);
		assert.ok(!lines.some((line) => line.includes("stopped")), "no row without a payload");
	}
});

test("error reason renders with the error tone", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "error", error: "boom" }), false, toneTheme).render(80);
	assert.ok(lines.some((line) => line.includes("[error]")), "exit row surfaces the error tone");
});

test("a soft cost stop explains the overshoot against its target", () => {
	const data = makeData({ reason: "cost-limit", costUsd: 6.4, limits: { costLimit: 5, timeBudgetMs: null }, crossedAt: { costUsd: 5.2, elapsedMs: 1_000 } });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	const target = lines.find((line) => line.includes("$5.00"));
	assert.ok(target, "target row rendered for a crossed soft cost stop");
	assert.ok(target.includes("$6.40"), target);
	assert.ok(target.includes("+$1.40") && target.includes("+28%"), target);
});

test("a soft time stop explains the overshoot against its target", () => {
	const data = makeData({ reason: "time-limit", elapsedMs: 4_320_000, limits: { costLimit: null, timeBudgetMs: 3_600_000 }, crossedAt: { costUsd: 1, elapsedMs: 3_600_000 } });
	const lines = renderWorkflowSummary(data, false, identityTheme).render(80);
	const target = lines.find((line) => line.includes("1:00:00"));
	assert.ok(target, "target row rendered for a crossed soft time stop");
	assert.ok(target.includes("1:12:00"), target);
});

test("a soft stop renders its human reason, never the reserved token", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "cost-limit" }), false, identityTheme).render(80);
	const text = lines.join("\n");
	assert.ok(text.includes("cost target reached"), text);
	assert.equal(text.includes("cost-limit"), false, "reserved token stays out of the transcript");
});

test("cost-limit reason renders with the warning tone", () => {
	const lines = renderWorkflowSummary(makeData({ reason: "cost-limit" }), false, toneTheme).render(80);
	assert.ok(lines.some((line) => line.includes("[warning]")), "exit row surfaces the warning tone");
});
