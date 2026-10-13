// WHY: `notify` no-ops headless, so a present-but-unparsable flag must still leave a
// transcript record; the `notified: true` contract is unchanged (the notice fired).
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveLimits } from "../../workflow/limits-dialog.js";
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

test("an unbounded workflow names the target flags it ignores in one warning notice", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	// Flag values are irrelevant here — unboundedLimits ignores them and records them when present.
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "5", "workflow-time": "bogus" }, entries), fakeCtx(true, notices), false);
	assert.deepEqual(outcome, { kind: "ok", limits: { costLimit: null, timeBudgetMs: null } }, "no targets apply to an unbounded run");
	assert.equal(notices.length, 1, "ignored flags are the one path that notifies");
	assert.match(notices[0]!, /Ignoring --workflow-cost and --workflow-time/);
	const data = entries[0]!.data as { ignoredFlags?: string[]; notice: string };
	assert.deepEqual(data.ignoredFlags, ["--workflow-cost", "--workflow-time"], "ignored flags are recorded");
	assert.match(data.notice, /Ignoring --workflow-cost and --workflow-time/);
});
