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

function fakeCtx(hasUI: boolean, notices: string[]): ExtensionCommandContext {
	return {
		hasUI,
		ui: { notify: (message: string) => { notices.push(message); } },
	} as unknown as ExtensionCommandContext;
}

test("an invalid flag headless records a workflow-error start entry", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "bogus" }, entries), fakeCtx(false, notices));
	assert.deepEqual(outcome, { kind: "cancelled", notified: true });
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, WORKFLOW_ERROR_ENTRY_TYPE);
	assert.equal((entries[0].data as { phase: string }).phase, "start");
	assert.match((entries[0].data as { error: string }).error, /Invalid --workflow-cost/);
});

test("an invalid flag with a UI notifies without a transcript entry", async () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const notices: string[] = [];
	const outcome = await resolveLimits(fakePi({ "workflow-cost": "bogus" }, entries), fakeCtx(true, notices));
	assert.deepEqual(outcome, { kind: "cancelled", notified: true });
	assert.equal(notices.length, 1);
	assert.equal(entries.length, 0);
});
