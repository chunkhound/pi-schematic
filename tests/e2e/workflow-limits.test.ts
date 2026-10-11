/**
 * E2E: the run's first user decision — budget limits.
 * Flags bypass the dialog, a present-but-unparsable flag visibly cancels, headless records
 * the explicit no-target decision, and the dialog maps every label to its exact target.
 * Graded only from the transcript: workflow-summary.limits + emitted notifications.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withWorkflowChild, sendOk, runWorkflow, readUiEvents, latestSummary } from "./workflow-harness.js";
import type { ProcessHarness } from "./pty-harness.js";

const WORKFLOW = "tests/e2e/fixtures/exit-workflow.js";

function summaryOf(entries: Awaited<ReturnType<typeof runWorkflow>>): Record<string, any> {
	const summary = latestSummary(entries);
	assert.ok(summary, "the run must persist its overview");
	return summary;
}

function hasExit(entries: Awaited<ReturnType<typeof runWorkflow>>): boolean {
	return entries.some((entry) => entry.customType === "workflow-exit");
}

async function limitNotices(h: ProcessHarness): Promise<string[]> {
	const events = await readUiEvents(h);
	return events.notifications
		.map((notification) => notification.message)
		.filter((message) => /Invalid --workflow-(cost|time)/.test(message));
}

describe("workflow limits E2E", () => {
	it("valid cost+time flags bypass the dialog and reach the run unchanged", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 5");
		await sendOk(h, "flag workflow-time 900000");
		const summary = summaryOf(await runWorkflow(h, WORKFLOW));
		assert.deepEqual(summary.limits, { costLimit: 5, timeBudgetMs: 900000 });
		const events = await readUiEvents(h);
		assert.ok(!events.notifications.some((n) => n.message.includes("Soft targets")), "flags skip the dialog");
	}));

	it("a cost-only flag leaves the time target unset", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost 5");
		const summary = summaryOf(await runWorkflow(h, WORKFLOW));
		assert.deepEqual(summary.limits, { costLimit: 5, timeBudgetMs: null });
	}));

	it("a time-only flag leaves the cost target unset", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-time 900000");
		const summary = summaryOf(await runWorkflow(h, WORKFLOW));
		assert.deepEqual(summary.limits, { costLimit: null, timeBudgetMs: 900000 });
	}));

	it("an invalid flag visibly cancels the run", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost bogus");
		const entries = await runWorkflow(h, WORKFLOW);
		assert.equal(hasExit(entries), false, "a cancelled run records no exit");
		const notices = await limitNotices(h);
		assert.equal(notices.length, 1, "exactly one invalid-flag notice");
		assert.match(notices[0], /Invalid --workflow-cost/);
	}));

	it("both invalid flags are named in one notice", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "flag workflow-cost bogus");
		await sendOk(h, "flag workflow-time -5");
		await runWorkflow(h, WORKFLOW);
		const notices = await limitNotices(h);
		assert.equal(notices.length, 1, "a bad cost flag must not hide a bad time flag");
		assert.match(notices[0], /Invalid --workflow-cost/);
		assert.match(notices[0], /Invalid --workflow-time/);
	}));

	it("a headless run records the explicit no-target decision", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "headless");
		const entries = await runWorkflow(h, WORKFLOW);
		const limitsEntry = entries.find((entry) => entry.customType === "workflow-limits");
		assert.ok(limitsEntry, "the no-target decision is persisted, never silently unbounded");
		assert.equal((limitsEntry.data as { costLimit: unknown }).costLimit, null);
		assert.deepEqual(summaryOf(entries).limits, { costLimit: null, timeBudgetMs: null });
	}));

	it("maps every time preset and the custom minutes to its exact budget", async () => withWorkflowChild(async (h) => {
		// Literal expectations: reading TIME_PRESET_MS would test the map against itself.
		const expected: Record<string, number | null> = {
			"15 minutes": 900_000,
			"30 minutes": 1_800_000,
			"1 hour": 3_600_000,
			"2 hours": 7_200_000,
			"4 hours": 14_400_000,
			"8 hours": 28_800_000,
			"Custom…": 2 * 60_000,
			"No target": null,
		};
		for (const [label, ms] of Object.entries(expected)) {
			await sendOk(h, "mock-select No target"); // cost picker
			await sendOk(h, `mock-select ${label}`); // time picker
			if (label === "Custom…") await sendOk(h, "mock-input 2");
			const summary = summaryOf(await runWorkflow(h, WORKFLOW));
			assert.equal(summary.limits.timeBudgetMs, ms, label);
			assert.equal(summary.limits.costLimit, null, label);
		}
	}));

	it("maps a preset cost and a custom USD input exactly", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "mock-select $0.25");
		await sendOk(h, "mock-select No target");
		assert.equal(summaryOf(await runWorkflow(h, WORKFLOW)).limits.costLimit, 0.25);

		await sendOk(h, "mock-select Custom…");
		await sendOk(h, "mock-input 3");
		await sendOk(h, "mock-select No target");
		assert.equal(summaryOf(await runWorkflow(h, WORKFLOW)).limits.costLimit, 3, "custom cost is taken as USD directly");
	}));

	it("a dismissed cost picker cancels before the time picker", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "mock-select"); // undefined answer = dismissed
		const entries = await runWorkflow(h, WORKFLOW);
		assert.equal(hasExit(entries), false);
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message.includes("Soft targets")), "the soft-semantics disclosure precedes the pickers");
	}));

	it("a dismissed time picker cancels after a chosen cost target", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "mock-select $5");
		await sendOk(h, "mock-select");
		assert.equal(hasExit(await runWorkflow(h, WORKFLOW)), false);
	}));

	it("a dismissed custom-number input cancels the run", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "mock-select $5");
		await sendOk(h, "mock-select Custom…");
		await sendOk(h, "mock-input");
		assert.equal(hasExit(await runWorkflow(h, WORKFLOW)), false);
	}));

	it("a non-positive custom value shows its error, re-prompts, and accepts the fix", async () => withWorkflowChild(async (h) => {
		await sendOk(h, "mock-select Custom…");
		await sendOk(h, "mock-input 0");
		await sendOk(h, "mock-input 120");
		const summary = summaryOf(await runWorkflow(h, WORKFLOW));
		assert.equal(summary.limits.costLimit, 120, "the corrected value wins");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((n) => n.message.includes("Invalid value: 0")));
	}));

	it("a huge custom time target keeps its budget (the deadline clamp is a unit concern)", async () => withWorkflowChild(async (h) => {
		// 40000 minutes = 2.4e9 ms, above MAX_TIMEOUT_MS; the dialog hands it through unclamped.
		await sendOk(h, "mock-select No target");
		await sendOk(h, "mock-select Custom…");
		await sendOk(h, "mock-input 40000");
		assert.equal(summaryOf(await runWorkflow(h, WORKFLOW)).limits.timeBudgetMs, 2_400_000_000);
	}));
});
