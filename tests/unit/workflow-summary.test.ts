// Contract: the persisted overview carries the run's identity, exit reason, elapsed
// time, and the spend rows exactly as the host derived them.
import { expect, test } from "vitest";
import type { WorkflowRunMetrics } from "../../workflow/types.js";
import { WORKFLOW_SUMMARY_ENTRY_TYPE, buildWorkflowSummary } from "../../workflow/summary.js";

function metrics(overrides: Partial<WorkflowRunMetrics> = {}): WorkflowRunMetrics {
	return {
		startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
		elapsedMs: 65_000,
		checkpoints: 3,
		steps: 7,
		turns: 14,
		classifySteps: 2,
		activity: { run: 7, checkpoint: 3, classify: 2 },
		costUsd: 1.25,
		spend: [
			{
				key: "anthropic/opus",
				provider: "anthropic",
				model: "opus",
				costUsd: 1.25,
				totalTokens: 10,
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				calls: 1,
			},
		],
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		crossedAt: null,
		effects: [],
		...overrides,
	};
}

function makeSummary() {
	const input = metrics();
	return { data: buildWorkflowSummary("review", "approved", undefined, input), input };
}

test("buildWorkflowSummary identifies the run and its exit reason", () => {
	const { data } = makeSummary();
	expect(WORKFLOW_SUMMARY_ENTRY_TYPE).toBe("workflow-summary");
	expect(data.workflow).toBe("review");
	expect(data.reason).toBe("approved");
});

test("buildWorkflowSummary derives ISO bounds from the start and elapsed time", () => {
	const { data, input } = makeSummary();
	expect(data.startedAt).toBe(new Date(input.startedAt).toISOString());
	expect(data.endedAt).toBe(new Date(input.startedAt + input.elapsedMs).toISOString());
	expect(data.elapsedMs).toBe(65_000);
});

test("buildWorkflowSummary reports the run's progress counts", () => {
	const { data } = makeSummary();
	expect(data.checkpoints).toBe(3);
	expect(data.steps).toBe(7);
	expect(data.turns).toBe(14);
	expect(data.classifySteps).toBe(2);
});

test("buildWorkflowSummary reports activity, cost, and spend", () => {
	const { data, input } = makeSummary();
	expect(data.activity).toStrictEqual({ run: 7, checkpoint: 3, classify: 2 });
	expect(data.costUsd).toBe(1.25);
	expect(data.spend).toStrictEqual(input.spend);
});

test("buildWorkflowSummary carries the error only when one exists", () => {
	const input = metrics();
	expect("error" in buildWorkflowSummary("wf", "error", undefined, input)).toBe(false);
	expect(buildWorkflowSummary("wf", "error", "boom", input).error).toBe("boom");
});

test("buildWorkflowSummary carries the soft targets and the crossing snapshot", () => {
	const input = metrics({ limits: { costLimit: 5, timeBudgetMs: null }, crossedAt: { costUsd: 5.2, elapsedMs: 1_000 }, costUsd: 6.4 });
	const data = buildWorkflowSummary("wf", "cost-limit", undefined, input);
	expect(data.limits).toStrictEqual({ costLimit: 5, timeBudgetMs: null });
	expect(data.crossedAt).toStrictEqual({ costUsd: 5.2, elapsedMs: 1_000 });
});

test("buildWorkflowSummary carries the salvaged partial only when one exists", () => {
	const input = metrics();
	expect("partial" in buildWorkflowSummary("wf", "cost-limit", undefined, input)).toBe(false);
	expect(buildWorkflowSummary("wf", "cost-limit", undefined, input, { round: 3 }).partial).toStrictEqual({ round: 3 });
});

test("buildWorkflowSummary carries the unbounded flag through from metrics", () => {
	const bounded = buildWorkflowSummary("wf", "approved", undefined, metrics({ unbounded: false }));
	expect(bounded.unbounded, "a checkpointed run reports bounded").toBe(false);
	const unbounded = buildWorkflowSummary("wf", "returned", undefined, metrics({ unbounded: true }));
	expect(unbounded.unbounded, "a checkpoint-less run reports unbounded").toBe(true);
	expect(unbounded.limits, "an unbounded run carries null targets").toStrictEqual({ costLimit: null, timeBudgetMs: null });
});
