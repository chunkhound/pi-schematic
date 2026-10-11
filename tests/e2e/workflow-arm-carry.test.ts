/**
 * E2E: no armed cancel press carries across a workflow.new rebind. The funnel
 * is re-registered per session, so a press armed before the switch must not confirm from
 * a single post-switch press; only a fresh two-press pair inside the window cancels.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessHarness } from "./pty-harness.js";
import {
	type AppendedEntry,
	readAppended,
	readUiEvents,
	sendOk,
	withWorkflowChild,
} from "./workflow-harness.js";

const ARM_CARRY = "tests/e2e/fixtures/command-arm-carry.js";

function exits(entries: AppendedEntry[]): Array<Record<string, any>> {
	return entries.filter((entry) => entry.customType === "workflow-exit").map((entry) => entry.data as Record<string, any>);
}

/** Park the fixture inside its first shell call; the run is provably mid-flight. */
async function startHeldRun(h: ProcessHarness): Promise<void> {
	await sendOk(h, "tui");
	await sendOk(h, "hold-exec");
	h.write(`cmd-bg workflow ${ARM_CARRY}`);
	await h.waitForText("OK:started");
	await h.waitForText("EXEC-HELD");
}

async function finishHeldRun(h: ProcessHarness): Promise<void> {
	await sendOk(h, "release-exec");
	await sendOk(h, "cmd-wait");
}

describe("workflow.new cancellation carry", () => {
	it("an armed press never confirms across workflow.new; a fresh pair still cancels", () => withWorkflowChild(async (h) => {
		await startHeldRun(h);
		await sendOk(h, "key escape"); // arm mid-run, before the switch
		// Re-arm the gate in the same burst as the release so the post-rebind shell parks
		// (release-exec clears the current gate; the fresh hold-exec outlives it).
		h.write("release-exec\nhold-exec");
		await h.waitForText("OK");
		await h.waitForText("EXEC-HELD");
		await sendOk(h, "key escape"); // a single fresh press after the switch
		const events = await readUiEvents(h);
		// Two "Escape again" warnings: the pre-switch arm plus the fresh post-switch press.
		// A carried arm would confirm silently on the fresh press (only one warning).
		const rearmWarnings = events.notifications.filter((entry) => entry.level === "warning" && entry.message.includes("Escape again"));
		assert.ok(rearmWarnings.length >= 2, "the fresh press must re-arm, not confirm the stale arm");
		assert.equal(exits(await readAppended(h)).length, 0, "the stale armed press must not cancel after workflow.new");
		// A fresh pair confirms whether or not the single press above still sits inside
		// its window, so a slow harness only strengthens this half of the assertion.
		h.write("key escape\nkey escape");
		await h.waitForText('OK:{"consume":true}');
		await finishHeldRun(h);
		assert.equal(exits(await readAppended(h)).at(-1)?.reason, "cancelled", "a fresh pair within the window still cancels");
	}));
});
