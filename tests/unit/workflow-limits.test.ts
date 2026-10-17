// WHY: `notify` no-ops headless, so a present-but-unparsable flag must still leave a
// transcript record; the `notified: true` contract is unchanged (the notice fired).
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveLimits } from "../../workflow/limits-dialog.js";
import { MAX_TIMEOUT_MS } from "../../workflow/sandbox.js";
import { WORKFLOW_ERROR_ENTRY_TYPE } from "../../workflow/types.js";

function fakePi(flags: Record<string, string>, entries: Array<{ type: string; data?: unknown }>): ExtensionAPI {
	return {
		getFlag: (name: string) => flags[name],
		appendEntry: (type: string, data?: unknown) => { entries.push({ type, data }); },
	} as unknown as ExtensionAPI;
}

interface PickerRecorder {
	titles: string[];
	answers: Array<string | undefined>;
}

function fakeCtx(hasUI: boolean, notices: string[], picker?: PickerRecorder): ExtensionCommandContext {
	return {
		hasUI,
		ui: {
			notify: (message: string) => { notices.push(message); },
			select: (title: string) => {
				picker?.titles.push(title);
				return Promise.resolve(picker ? picker.answers.shift() : undefined);
			},
			input: () => Promise.resolve(""),
		},
	} as unknown as ExtensionCommandContext;
}

test("an invalid flag headless records a workflow-error start entry", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "bogus" }, entries), fakeCtx(false, notices), true);
	assert.deepEqual(outcome, { kind: "cancelled", notified: true });
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, WORKFLOW_ERROR_ENTRY_TYPE);
	assert.equal((entries[0].data as { phase: string }).phase, "start");
	assert.match((entries[0].data as { error: string }).error, /Invalid --workflow-cost/);
});

test("an invalid flag with a UI notifies without a transcript entry", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "bogus" }, entries), fakeCtx(true, notices), true);
	assert.deepEqual(outcome, { kind: "cancelled", notified: true });
	assert.equal(notices.length, 1);
	assert.equal(entries.length, 0);
});

test("a checkpoint-less workflow short-circuits limits: null targets and a recorded unbounded decision", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({}, entries), fakeCtx(true, notices), false);
	assert.deepEqual(outcome, { kind: "ok", limits: { costLimit: null, timeBudgetMs: null } }, "no targets apply to an unbounded run");
	assert.equal(notices.length, 0, "the normal path stays silent: the live footer carries the unbounded indicator");
	assert.equal(entries.length, 1, "a UI/transcript-only workflow-limits entry is appended");
	assert.equal(entries[0]!.type, "workflow-limits");
	const data = entries[0]!.data as { costLimit: unknown; timeBudgetMs: unknown; unbounded: boolean; ignoredFlags?: string[]; notice: string };
	assert.equal(data.unbounded, true);
	assert.equal(data.costLimit, null);
	assert.equal(data.timeBudgetMs, null);
	assert.equal(data.ignoredFlags, undefined, "no flags to ignore, so none are recorded");
});

test("an unbounded workflow names the cost flag it ignores in one warning notice", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	// Only cost targets are ignored: --workflow-time becomes the hard deadline (see below).
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "5" }, entries), fakeCtx(true, notices), false);
	assert.deepEqual(outcome, { kind: "ok", limits: { costLimit: null, timeBudgetMs: null } }, "no soft targets apply to an unbounded run");
	assert.equal(notices.length, 1, "ignored cost flag is the one path that notifies");
	assert.match(notices[0]!, /Ignoring --workflow-cost/);
	const data = entries[0]!.data as { ignoredFlags?: string[]; notice: string };
	assert.deepEqual(data.ignoredFlags, ["--workflow-cost"], "ignored flags are recorded");
	assert.match(data.notice, /Ignoring --workflow-cost/);
});

test("a checkpoint-less workflow honors --workflow-time as a hard sandbox deadline", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": "600000" }, entries), fakeCtx(true, notices), false);
	assert.deepEqual(
		outcome,
		{ kind: "ok", limits: { costLimit: null, timeBudgetMs: null, hardDeadlineMs: 600_000 } },
		"the flag becomes the hard deadline, never a soft target",
	);
	const data = entries[0]!.data as { costLimit: unknown; timeBudgetMs: unknown; hardDeadlineMs: number; notice: string };
	assert.equal(data.hardDeadlineMs, 600_000);
	assert.equal(data.costLimit, null);
	assert.equal(data.timeBudgetMs, null);
	assert.match(data.notice, /hard deadline/i);
});

test("a checkpoint-less workflow without --workflow-time records no hard deadline", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({}, entries), fakeCtx(true, notices), false);
	assert.deepEqual(outcome, { kind: "ok", limits: { costLimit: null, timeBudgetMs: null } });
	assert.equal((entries[0]!.data as { hardDeadlineMs?: unknown }).hardDeadlineMs, undefined, "no flag means the run stays unbounded");
});

test("a checkpoint-less workflow rejects an over-max --workflow-time", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": String(MAX_TIMEOUT_MS + 1) }, entries), fakeCtx(false, notices), false);
	assert.deepEqual(outcome, { kind: "cancelled", notified: true });
	assert.equal(entries[0]!.type, WORKFLOW_ERROR_ENTRY_TYPE);
	assert.match((entries[0]!.data as { error: string }).error, /Invalid --workflow-time/);
});

test("a checkpointed run rejects a time budget whose doubled hard deadline overflows the timer", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": String(MAX_TIMEOUT_MS) }, entries), fakeCtx(false, notices), true);
	assert.deepEqual(outcome, { kind: "cancelled", notified: true }, "an over-max budget must cancel, never silently clamp");
	assert.equal(entries[0]!.type, WORKFLOW_ERROR_ENTRY_TYPE);
	assert.match((entries[0]!.data as { error: string }).error, /Invalid --workflow-time/);
});

test("a checkpoint-less unparsable --workflow-time visibly cancels the run", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-time": "bogus" }, entries), fakeCtx(true, notices), false);
	assert.deepEqual(outcome, { kind: "cancelled", notified: true });
	assert.match(notices[0]!, /Invalid --workflow-time/);
});

test("the pickers carry the soft-target disclosure at the point of choice", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const picker: PickerRecorder = { titles: [], answers: ["No target", "No target"] };
	const outcome = await resolveLimits(fakePi({}, entries), fakeCtx(true, notices, picker), true);
	assert.deepEqual(outcome, { kind: "ok", limits: { costLimit: null, timeBudgetMs: null } });
	assert.equal(picker.titles.length, 2, "cost picker then time picker");
	for (const title of picker.titles) assert.match(title, /stops at next checkpoint/, "each picker title restates the soft-stop semantics");
	assert.equal(notices.length, 0, "no pre-picker toast");
});
