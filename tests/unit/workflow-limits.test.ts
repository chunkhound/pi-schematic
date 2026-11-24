// WHY: `notify` no-ops headless, so a present-but-unparsable flag must still leave a
// transcript record; the `notified: true` contract is unchanged (the notice fired).
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveLimits } from "../../workflow/limits-dialog.js";
import { MAX_TIMEOUT_MS } from "../../workflow/sandbox.js";
import { WORKFLOW_ERROR_ENTRY_TYPE } from "../../workflow/types.js";

function fakePi(flags: Record<string, string>, entries: { type: string; data?: unknown }[]): ExtensionAPI {
	return {
		getFlag: (name: string) => flags[name],
		appendEntry: (type: string, data?: unknown) => {
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
}

interface PickerRecorder {
	titles: string[];
	answers: (string | undefined)[];
}

function fakeCtx(hasUI: boolean, notices: string[], picker?: PickerRecorder): ExtensionCommandContext {
	return {
		hasUI,
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
			select: (title: string) => {
				picker?.titles.push(title);
				return Promise.resolve(picker ? picker.answers.shift() : undefined);
			},
			input: () => Promise.resolve(""),
		},
	} as unknown as ExtensionCommandContext;
}

test("an invalid flag headless records a workflow-error start entry", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "bogus" }, entries), fakeCtx(false, notices), true);
	expect(outcome).toStrictEqual({ kind: "cancelled", notified: true });
	expect(entries.length).toBe(1);
	expect(entries[0].type).toBe(WORKFLOW_ERROR_ENTRY_TYPE);
	expect((entries[0].data as { phase: string }).phase).toBe("start");
	expect((entries[0].data as { error: string }).error).toMatch(/Invalid --workflow-cost/);
});

test("an invalid flag with a UI notifies without a transcript entry", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "bogus" }, entries), fakeCtx(true, notices), true);
	expect(outcome).toStrictEqual({ kind: "cancelled", notified: true });
	expect(notices.length).toBe(1);
	expect(entries.length).toBe(0);
});

test("a checkpoint-less workflow short-circuits limits: null targets and a recorded unbounded decision", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({}, entries), fakeCtx(true, notices), false);
	expect(outcome).toStrictEqual({ kind: "ok", limits: { costLimit: null, timeBudgetMs: null } });
	expect(notices.length).toBe(0);
	expect(entries.length).toBe(1);
	expect(entries[0].type).toBe("workflow-limits");
	const data = entries[0].data as { costLimit: unknown; timeBudgetMs: unknown; unbounded: boolean; ignoredFlags?: string[]; notice: string };
	expect(data.unbounded).toBe(true);
	expect(data.costLimit).toBeNull();
	expect(data.timeBudgetMs).toBeNull();
	expect(data.ignoredFlags).toBeUndefined();
});

test("an unbounded workflow names the cost flag it ignores in one warning notice", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	// Only cost targets are ignored: --workflow-time becomes the hard deadline (see below).
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "5" }, entries), fakeCtx(true, notices), false);
	expect(outcome).toStrictEqual({ kind: "ok", limits: { costLimit: null, timeBudgetMs: null } });
	expect(notices.length).toBe(1);
	expect(notices[0]).toMatch(/Ignoring --workflow-cost/);
	const data = entries[0].data as { ignoredFlags?: string[]; notice: string };
	expect(data.ignoredFlags).toStrictEqual(["--workflow-cost"]);
	expect(data.notice).toMatch(/Ignoring --workflow-cost/);
});

test("a checkpoint-less workflow honors --workflow-time as a hard sandbox deadline", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": "600000" }, entries), fakeCtx(true, notices), false);
	expect(outcome).toStrictEqual({ kind: "ok", limits: { costLimit: null, timeBudgetMs: null, hardDeadlineMs: 600_000 } });
	const data = entries[0].data as { costLimit: unknown; timeBudgetMs: unknown; hardDeadlineMs: number; notice: string };
	expect(data.hardDeadlineMs).toBe(600_000);
	expect(data.costLimit).toBeNull();
	expect(data.timeBudgetMs).toBeNull();
	expect(data.notice).toMatch(/hard deadline/i);
});

test("a checkpoint-less workflow without --workflow-time records no hard deadline", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({}, entries), fakeCtx(true, notices), false);
	expect(outcome).toStrictEqual({ kind: "ok", limits: { costLimit: null, timeBudgetMs: null } });
	expect((entries[0].data as { hardDeadlineMs?: unknown }).hardDeadlineMs).toBeUndefined();
});

test("a checkpoint-less workflow rejects an over-max --workflow-time", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": String(MAX_TIMEOUT_MS + 1) }, entries), fakeCtx(false, notices), false);
	expect(outcome).toStrictEqual({ kind: "cancelled", notified: true });
	expect(entries[0].type).toBe(WORKFLOW_ERROR_ENTRY_TYPE);
	expect((entries[0].data as { error: string }).error).toMatch(/Invalid --workflow-time/);
});

test("a checkpointed run rejects a time budget whose doubled hard deadline overflows the timer", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": String(MAX_TIMEOUT_MS) }, entries), fakeCtx(false, notices), true);
	expect(outcome).toStrictEqual({ kind: "cancelled", notified: true });
	expect(entries[0].type).toBe(WORKFLOW_ERROR_ENTRY_TYPE);
	expect((entries[0].data as { error: string }).error).toMatch(/Invalid --workflow-time/);
});

test("a checkpoint-less unparsable --workflow-time visibly cancels the run", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": "bogus" }, entries), fakeCtx(true, notices), false);
	expect(outcome).toStrictEqual({ kind: "cancelled", notified: true });
	expect(notices[0]).toMatch(/Invalid --workflow-time/);
});

test("the pickers carry the soft-target disclosure at the point of choice", async () => {
	const entries: { type: string; data?: unknown }[] = [];
	const notices: string[] = [];
	const picker: PickerRecorder = { titles: [], answers: ["No target", "No target"] };
	const outcome = await resolveLimits(fakePi({}, entries), fakeCtx(true, notices, picker), true);
	expect(outcome).toStrictEqual({ kind: "ok", limits: { costLimit: null, timeBudgetMs: null } });
	expect(picker.titles.length).toBe(2);
	for (const title of picker.titles) {
		expect(title).toMatch(/stops at next checkpoint/);
	}
	expect(notices.length).toBe(0);
});
