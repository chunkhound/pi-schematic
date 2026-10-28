/**
 * E2E: cancellation must reach a checkpoint-less run in every mode. An RPC/print abort
 * arrives as an aborted turn (the `turn_end` bridge); a TUI key still only arms first.
 */
import { describe, expect, it } from "vitest";
import { type AppendedEntry, entryRecords, readAppended, readFooter, readUiEvents, sendOk, withWorkflowChild } from "./workflow-harness.js";

const ABORT_RUN = "tests/e2e/fixtures/command-abort-run.js";
const CHECKPOINT_SHELL = "tests/e2e/fixtures/command-checkpoint-shell.js";

function exits(entries: AppendedEntry[]): Record<string, unknown>[] {
	return entryRecords(entries, "workflow-exit");
}

describe("workflow cancellation in every mode", () => {
	it("an aborted RPC turn stops a checkpoint-less run with one cancelled exit and no stray chrome", () =>
		withWorkflowChild(async (h) => {
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
			expect(list).toHaveLength(1);
			expect(list[0].reason, "the aborted turn cancels the run").toBe("cancelled");
			expect(entries.filter((entry) => entry.customType === "workflow-summary")).toHaveLength(1);
			expect(await readFooter(h)).toBeNull();
		}));

	it("a single TUI cancel press arms only; a second press confirms", () =>
		withWorkflowChild(async (h) => {
			await sendOk(h, "tui");
			await sendOk(h, "hold-exec");
			h.write(`cmd-bg workflow ${CHECKPOINT_SHELL}`);
			await h.waitForText("OK:started");
			await h.waitForText("EXEC-HELD");
			await sendOk(h, "key escape");
			expect(exits(await readAppended(h))).toHaveLength(0);
			const events = await readUiEvents(h);
			expect(events.notifications.some((entry) => entry.message.includes("Escape again"))).toBe(true);
			h.write("key escape\nkey escape");
			await h.waitForText('OK:{"consume":true}');
			await sendOk(h, "release-exec");
			await sendOk(h, "cmd-wait");
			expect(exits(await readAppended(h)).at(-1)?.reason).toBe("cancelled");
		}));
});
