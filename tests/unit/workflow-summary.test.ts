// Contract: the persisted overview carries the run's identity, exit reason, elapsed
// time, and the spend rows exactly as the host derived them.
import assert from "node:assert/strict";
import test from "node:test";
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

test("buildWorkflowSummary derives ISO bounds from the start and elapsed time", () => {
	const input = metrics();
	const data = buildWorkflowSummary("review", "approved", undefined, input);
	assert.equal(WORKFLOW_SUMMARY_ENTRY_TYPE, "workflow-summary");
	assert.equal(data.workflow, "review");
	assert.equal(data.reason, "approved");
	assert.equal(data.startedAt, new Date(input.startedAt).toISOString());
	assert.equal(data.endedAt, new Date(input.startedAt + input.elapsedMs).toISOString());
	assert.equal(data.elapsedMs, 65_000);
	assert.equal(data.checkpoints, 3);
	assert.equal(data.steps, 7);
	assert.equal(data.turns, 14);
	assert.equal(data.classifySteps, 2);
	assert.deepEqual(data.activity, { run: 7, checkpoint: 3, classify: 2 });
	assert.equal(data.costUsd, 1.25);
	assert.deepEqual(data.spend, input.spend);
});

test("buildWorkflowSummary carries the error only when one exists", () => {
	const input = metrics();
	assert.equal("error" in buildWorkflowSummary("wf", "error", undefined, input), false);
	assert.equal(buildWorkflowSummary("wf", "error", "boom", input).error, "boom");
});

test("buildWorkflowSummary carries the soft targets and the crossing snapshot", () => {
	const input = metrics({ limits: { costLimit: 5, timeBudgetMs: null }, crossedAt: { costUsd: 5.2, elapsedMs: 1_000 }, costUsd: 6.4 });
	const data = buildWorkflowSummary("wf", "cost-limit", undefined, input);
	assert.deepEqual(data.limits, { costLimit: 5, timeBudgetMs: null });
	assert.deepEqual(data.crossedAt, { costUsd: 5.2, elapsedMs: 1_000 });
});

test("buildWorkflowSummary carries the salvaged partial only when one exists", () => {
	const input = metrics();
	assert.equal("partial" in buildWorkflowSummary("wf", "cost-limit", undefined, input), false);
	assert.deepEqual(buildWorkflowSummary("wf", "cost-limit", undefined, input, { round: 3 }).partial, { round: 3 });
});

test("buildWorkflowSummary carries the unbounded flag through from metrics", () => {
	const bounded = buildWorkflowSummary("wf", "approved", undefined, metrics({ unbounded: false }));
	assert.equal(bounded.unbounded, false, "a checkpointed run reports bounded");
	const unbounded = buildWorkflowSummary("wf", "returned", undefined, metrics({ unbounded: true }));
	assert.equal(unbounded.unbounded, true, "a checkpoint-less run reports unbounded");
	assert.deepEqual(unbounded.limits, { costLimit: null, timeBudgetMs: null }, "an unbounded run carries null targets");
});
