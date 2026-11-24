/**
 * E2E: cancellation must reach a checkpoint-less run in every mode. An RPC/print abort
 * arrives as an aborted turn (the `turn_end` bridge); a TUI key still only arms first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type AppendedEntry,
	readAppended,
	readFooter,
	readUiEvents,
	sendOk,
	withWorkflowChild,
} from "./workflow-harness.js";

const ABORT_RUN = "tests/e2e/fixtures/command-abort-run.js";
const CHECKPOINT_SHELL = "tests/e2e/fixtures/command-checkpoint-shell.js";

function exits(entries: AppendedEntry[]): Array<Record<string, any>> {
	return entries.filter((entry) => entry.customType === "workflow-exit").map((entry) => entry.data as Record<string, any>);
}

describe("workflow cancellation in every mode", () => {
	it("an aborted RPC turn stops a checkpoint-less run with one cancelled exit and no stray chrome", () => withWorkflowChild(async (h) => {
		await sendOk(h, "mode rpc");
		await sendOk(h, "hold-turn");
		h.write(`cmd-bg workflow ${ABORT_RUN}`);
		await h.waitForText("OK:started");
		await h.waitForText("TURN-HELD");
		await sendOk(h, "turn-end aborted");
		await sendOk(h, "release-turn");
		await sendOk(h, "cmd-wait");
		const entries = await readAppended(h);
		const list = exits(entries);
		assert.equal(list.length, 1, "exactly one exit record");
		assert.equal(list[0].reason, "cancelled", "the aborted turn cancels the run");
		assert.equal(entries.filter((entry) => entry.customType === "workflow-summary").length, 1, "the overview lands exactly once");
		assert.equal(await readFooter(h), null, "no stray footer after the run");
	}));

	it("a single TUI cancel press arms only; a second press confirms", () => withWorkflowChild(async (h) => {
		await sendOk(h, "tui");
		await sendOk(h, "hold-exec");
		h.write(`cmd-bg workflow ${CHECKPOINT_SHELL}`);
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		await sendOk(h, "key escape");
		assert.equal(exits(await readAppended(h)).length, 0, "one press never aborts");
		const events = await readUiEvents(h);
		assert.ok(events.notifications.some((entry) => entry.message.includes("Escape again")), "the press arms with a warning");
		h.write("key escape\nkey escape");
		await h.waitForText('OK:{"consume":true}');
		await sendOk(h, "release-exec");
		await sendOk(h, "cmd-wait");
		assert.equal(exits(await readAppended(h)).at(-1)?.reason, "cancelled", "a fresh pair confirms");
	}));
});
