/**
 * E2E: no armed cancel press carries across a workflow.new rebind. The funnel
 * is re-registered per session, so a press armed before the switch must not confirm from
 * a single post-switch press; only a fresh two-press pair inside the window cancels.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessHarness } from "./pty-harness.js";
import { CANCEL_CONFIRM_MS } from "../../workflow/command.js";
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
		// The burst arms the funnel, clears the pre-shell gate, and re-arms it so the
		// post-rebind shell parks (release-exec clears the gate; the fresh hold-exec outlives it).
		const armAt = Date.now();
		h.write("key escape\nrelease-exec\nhold-exec");
		await h.waitForText('OK:{"consume":true}'); // child acks the pre-switch arm
		const armAckAt = Date.now(); // child's observed arm-eval time: the ack is written only after confirmCancel reads Date.now()
		await h.waitForText("EXEC-HELD");
		const pressAt = Date.now();
		// Keep the parent write-clock check as a fast-fail: bail before the press if the arm is already stale here.
		assert.ok(pressAt - armAt < CANCEL_CONFIRM_MS, `parent write interval exceeds the ${CANCEL_CONFIRM_MS}ms window (gap ${pressAt - armAt}ms)`);
		h.write("key escape"); // a single fresh press after the switch
		await h.waitForText('OK:{"consume":true}'); // child acks the press (re-arm, not confirm)
		const pressAckAt = Date.now(); // child's observed press-eval time
		// Why ack-aligned: the parent write interval can pass while a slow IPC round-trip after the
		// second write lets the child's arm expire (false green). The child echoes each key only after
		// confirmCancel reads Date.now(), so the ack gap is the child's own arm->press interval. A
		// stale arm would re-arm whether or not workflow.new carried it, so assert the child-side
		// precondition and fail loud instead of passing blind.
		assert.ok(pressAckAt - armAckAt < CANCEL_CONFIRM_MS, `the child's arm expired before the press was evaluated (gap ${pressAckAt - armAckAt}ms)`);
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
