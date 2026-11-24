/**
 * E2E: the run's first user decision — budget limits.
 * Flags bypass the dialog, a present-but-unparsable flag visibly cancels, headless records
 * the explicit no-target decision, and the dialog maps every label to its exact target.
 * Graded only from the transcript: workflow-summary.limits + emitted notifications.
 */
import { describe, expect, it } from "vitest";
import { withWorkflowChild, sendOk, runWorkflow, readUiEvents, readFooter, readAppended, latestSummary } from "./workflow-harness.js";
import { TIME_PRESETS, TIME_PRESET_MS } from "../../workflow/limits-dialog.js";
import type { WorkflowLimits } from "../../workflow/types.js";
import { assertPresent, isRecord } from "../assertions.js";
import type { ProcessHarness } from "./pty-harness.js";

const WORKFLOW = "tests/e2e/fixtures/exit-workflow.js";
const NO_CHECKPOINT = "tests/e2e/fixtures/command-no-checkpoint.js";

interface WorkflowSummary {
	limits: WorkflowLimits;
	unbounded: boolean;
}

/** Narrow an entry's `limits` payload (unknown) to the typed limits record. */
function limitsOf(value: unknown): WorkflowLimits {
	if (!isRecord(value)) {
		throw new Error("the run must persist its limits overview");
	}
	const costLimit = value.costLimit;
	const timeBudgetMs = value.timeBudgetMs;
	return {
		costLimit: typeof costLimit === "number" || costLimit === null ? costLimit : null,
		timeBudgetMs: typeof timeBudgetMs === "number" || timeBudgetMs === null ? timeBudgetMs : null,
	};
}

/** Whether an entry's `data` payload records an explicit unbounded decision. */
function unboundedOf(value: unknown): boolean {
	return isRecord(value) && value.unbounded === true;
}

/** Read a string field from an entry's `data` payload, or "" when absent/non-string. */
function reasonOf(value: unknown): string {
	return isRecord(value) && typeof value.reason === "string" ? value.reason : "";
}

function summaryOf(entries: Awaited<ReturnType<typeof runWorkflow>>): WorkflowSummary {
	const summary = latestSummary(entries);
	assertPresent(summary, "the run must persist its overview");
	return {
		limits: limitsOf(summary.limits),
		unbounded: summary.unbounded === true,
	};
}

function hasExit(entries: Awaited<ReturnType<typeof runWorkflow>>): boolean {
	return entries.some((entry) => entry.customType === "workflow-exit");
}

async function limitNotices(h: ProcessHarness): Promise<string[]> {
	const events = await readUiEvents(h);
	return events.notifications.map((notification) => notification.message).filter((message) => /Invalid --workflow-(cost|time)/.test(message));
}

describe("workflow limits E2E", () => {
	it("valid cost+time flags bypass the dialog and reach the run unchanged", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost 5");
			await sendOk(h, "flag workflow-time 900000");
			const summary = summaryOf(await runWorkflow(h, WORKFLOW));
			expect(summary.limits).toEqual({ costLimit: 5, timeBudgetMs: 900000 });
			expect(
				(await readUiEvents(h)).notifications.some((n) => /Soft targets|unbounded/i.test(n.message)),
				"valid flags bypass the dialog with no banner notice",
			).toBe(false);
		}));

	it("a cost-only flag leaves the time target unset", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost 5");
			const summary = summaryOf(await runWorkflow(h, WORKFLOW));
			expect(summary.limits).toEqual({ costLimit: 5, timeBudgetMs: null });
		}));

	it("a time-only flag leaves the cost target unset", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-time 900000");
			const summary = summaryOf(await runWorkflow(h, WORKFLOW));
			expect(summary.limits).toEqual({ costLimit: null, timeBudgetMs: 900000 });
		}));

	it("an invalid flag visibly cancels the run", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost bogus");
			const entries = await runWorkflow(h, WORKFLOW);
			expect(hasExit(entries), "a cancelled run records no exit").toBe(false);
			const notices = await limitNotices(h);
			expect(notices, "exactly one invalid-flag notice").toHaveLength(1);
			expect(notices[0]).toMatch(/Invalid --workflow-cost/);
		}));

	it("both invalid flags are named in one notice", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-cost bogus");
			await sendOk(h, "flag workflow-time -5");
			await runWorkflow(h, WORKFLOW);
			const notices = await limitNotices(h);
			expect(notices, "a bad cost flag must not hide a bad time flag").toHaveLength(1);
			expect(notices[0]).toMatch(/Invalid --workflow-cost/);
			expect(notices[0]).toMatch(/Invalid --workflow-time/);
		}));

	it("a headless run records the explicit no-target decision", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "headless");
			const entries = await runWorkflow(h, WORKFLOW);
			const limitsEntry = entries.find((entry) => entry.customType === "workflow-limits");
			assertPresent(limitsEntry, "the no-target decision is persisted, never silently unbounded");
			expect(limitsOf(limitsEntry.data).costLimit).toBeNull();
			expect(summaryOf(entries).limits).toEqual({ costLimit: null, timeBudgetMs: null });
		}));

	it("maps every time preset and the custom hours to its exact budget", async () =>
		withWorkflowChild(async (h) => {
			// Literal expectations: reading TIME_PRESET_MS would test the map against itself.
			const expected: Record<string, number | null> = {
				"1 hour": 3_600_000,
				"4 hours": 14_400_000,
				"8 hours": 28_800_000,
				"Custom…": 2 * 3_600_000,
				"No target": null,
			};
			// Pin the shipped preset vocabulary so a new preset cannot ship without a literal above.
			expect([...TIME_PRESETS].sort(), "a new or removed time preset must be added to this pinned list").toEqual(Object.keys(expected).sort());
			expect(
				TIME_PRESETS.filter((preset) => preset !== "No target" && preset !== "Custom…").sort(),
				"every value-bearing preset must map to an ms budget",
			).toEqual(Object.keys(TIME_PRESET_MS).sort());
			for (const [label, ms] of Object.entries(expected)) {
				await sendOk(h, "mock-select No target"); // cost picker
				await sendOk(h, `mock-select ${label}`); // time picker
				if (label === "Custom…") {
					await sendOk(h, "mock-input 2");
				}
				const summary = summaryOf(await runWorkflow(h, WORKFLOW));
				expect(summary.limits.timeBudgetMs, label).toBe(ms);
				expect(summary.limits.costLimit, label).toBeNull();
			}
		}));

	it("maps a preset cost and a custom USD input exactly", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "mock-select $1");
			await sendOk(h, "mock-select No target");
			expect(summaryOf(await runWorkflow(h, WORKFLOW)).limits.costLimit).toBe(1);

			await sendOk(h, "mock-select Custom…");
			await sendOk(h, "mock-input 3");
			await sendOk(h, "mock-select No target");
			expect(summaryOf(await runWorkflow(h, WORKFLOW)).limits.costLimit, "custom cost is taken as USD directly").toBe(3);
		}));

	it("a dismissed cost picker cancels before the time picker", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "mock-select"); // undefined answer = dismissed
			expect(hasExit(await runWorkflow(h, WORKFLOW))).toBe(false);
		}));

	it("a dismissed time picker cancels after a chosen cost target", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "mock-select $5");
			await sendOk(h, "mock-select");
			expect(hasExit(await runWorkflow(h, WORKFLOW))).toBe(false);
		}));

	it("a dismissed custom-number input cancels the run", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "mock-select $5");
			await sendOk(h, "mock-select Custom…");
			await sendOk(h, "mock-input");
			expect(hasExit(await runWorkflow(h, WORKFLOW))).toBe(false);
		}));

	it("a non-positive custom value shows its error, re-prompts, and accepts the fix", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "mock-select Custom…");
			await sendOk(h, "mock-input 0");
			await sendOk(h, "mock-input 120");
			const summary = summaryOf(await runWorkflow(h, WORKFLOW));
			expect(summary.limits.costLimit, "the corrected value wins").toBe(120);
			const events = await readUiEvents(h);
			expect(events.notifications.some((n) => n.message.includes("Invalid value: 0"))).toBe(true);
		}));

	it("a custom time target above the sandbox timer max is rejected and re-prompts", async () =>
		withWorkflowChild(async (h) => {
			// 40000 hours = 1.44e11 ms, whose doubled hard deadline overruns the sandbox timer.
			await sendOk(h, "mock-select No target");
			await sendOk(h, "mock-select Custom…");
			await sendOk(h, "mock-input 40000");
			await sendOk(h, "mock-input 1");
			const summary = summaryOf(await runWorkflow(h, WORKFLOW));
			expect(summary.limits.timeBudgetMs, "the corrected value wins").toBe(3_600_000);
			const events = await readUiEvents(h);
			expect(
				events.notifications.some((n) => n.message.includes("Invalid value: 40000")),
				"the over-max value shows a visible error",
			).toBe(true);
		}));

	it("a checkpoint-less workflow runs unbounded: no dialog, no notice, unbounded footer", async () =>
		withWorkflowChild(async (h) => {
			// Hold the run inside its fake shell so the live footer (uninstalled at run end) is observable.
			await sendOk(h, "tui");
			await sendOk(h, "hold-exec");
			h.write(`cmd-bg workflow ${NO_CHECKPOINT}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			// hasCheckpoint is false => resolveLimits short-circuits: no pickers are invoked.
			const events = await readUiEvents(h);
			expect(events.notifications, "no start-up notice: the live footer carries the unbounded indicator").toHaveLength(0);
			// The footer renders live from the progress view: the ∞ cell, not the checkpoint count.
			const footer = await readFooter(h);
			assertPresent(footer, "the footer shows the unbounded cell, not the checkpoint count");
			expect(footer).toContain("\u221E unbounded");
			expect(footer).not.toContain("\u{1F6A9}");
			await sendOk(h, "release-exec");
			await sendOk(h, "cmd-wait");
		}));

	it("a checkpoint-less workflow records the unbounded decision", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "hold-exec");
			h.write(`cmd-bg workflow ${NO_CHECKPOINT}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			await sendOk(h, "release-exec");
			await sendOk(h, "cmd-wait");
			const entries = await readAppended(h);
			const summary = summaryOf(entries);
			expect(summary).toEqual({ limits: { costLimit: null, timeBudgetMs: null }, unbounded: true });
			const limitsEntry = entries.find((entry) => entry.customType === "workflow-limits");
			assertPresent(limitsEntry, "the unbounded decision is persisted as a workflow-limits entry");
			expect({ unbounded: unboundedOf(limitsEntry.data), limits: limitsOf(limitsEntry.data) }).toEqual({
				unbounded: true,
				limits: { costLimit: null, timeBudgetMs: null },
			});
			// The unbounded decision is UI/transcript-only: no model-facing workflow-log entry is added.
			expect(
				entries.some((entry) => entry.customType === "workflow-log"),
				"unbounded decision never reaches the LLM",
			).toBe(false);
		}));

	it("--workflow-time kills a checkpoint-less shell loop with exactly one time-limit exit", async () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "flag workflow-time 1000");
			await sendOk(h, "hold-exec");
			// Park the run inside its shell: only the sandbox hard deadline can end it.
			h.write(`cmd-bg workflow ${NO_CHECKPOINT}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			await sendOk(h, "cmd-wait");
			const entries = await readAppended(h);
			const exits = entries.filter((entry) => entry.customType === "workflow-exit");
			expect(exits, "a killed run records exactly one exit").toHaveLength(1);
			expect(reasonOf(exits[0].data)).toBe("time-limit");
		}));
});
