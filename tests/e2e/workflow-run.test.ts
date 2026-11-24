/**
 * E2E: proves the process-isolated child settles `workflow.run` through the scripted-turn
 * seam and exposes the harness faults (sandbox, append, readonly, pickers, footer).
 * The grader reads only protocol output (appended / ui-events / footer), never harness state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessHarness } from "./pty-harness.js";

async function start(): Promise<ProcessHarness> {
	const h = new ProcessHarness();
	await h.waitForText("READY");
	h.write("workflow-mocks");
	await h.waitForText("OK");
	return h;
}

async function withHarness(run: (h: ProcessHarness) => Promise<void>): Promise<void> {
	const h = await start();
	try {
		await run(h);
	} finally {
		try {
			h.write("exit");
		} catch {
			// already dead
		}
		h.close();
	}
}

describe("workflow.run harness", () => {
	it("settles a scripted turn and records its text and cost", async () => withHarness(async (h) => {
		h.write('turn {"text":"final answer","cost":0.5}');
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/run-workflow.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText('"reason":"ok"');
		assert.ok(h.snapshot().includes('"text":"final answer"'), "settled text reaches the exit entry");
		assert.ok(h.snapshot().includes('"cost":0.5'), "settled usage reaches the exit entry");
	}));

	it("captures a structured output submission through the armed tool", async () => withHarness(async (h) => {
		h.write('turn {"output":{"command":"npm test"}}');
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/run-output-workflow.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText('"reason":"ok"');
		assert.ok(h.snapshot().includes('"command":"npm test"'), "structured output captured");
	}));

	// The exit-append-failure and sandbox-timeout outcomes also run in workflow-command.test.ts:
	// this raw harness exercises the host paths directly, that suite the full /workflow funnel.
	it("a throwing exit append still records exactly one exit", async () => withHarness(async (h) => {
		h.write("fault append-throws");
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/run-workflow.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText("workflow-exit");
		const exits = (h.snapshot().match(/"customType":"workflow-exit"/g) ?? []).length;
		assert.equal(exits, 1, "the infra path records the single exit");
	}));

	it("readonly blocks a write command and records the blocked result", async () => withHarness(async (h) => {
		h.write("readonly on");
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/shell-workflow.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText('"reason":"ok"');
		assert.ok(h.snapshot().includes('"ok":false'), "the readonly guard blocked the shell");
	}));

	it("a sandbox timeout records a time-limit exit", async () => withHarness(async (h) => {
		h.write("sandbox timeout");
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/run-workflow.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText('"reason":"time-limit"');
	}));

	it("a cancelling picker stops the dialog run before any sandbox", async () => withHarness(async (h) => {
		h.write("mock-select");
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/run-workflow.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText("OK:");
		assert.ok(!h.snapshot().includes("workflow-exit"), "a cancelled dialog never records an exit");
		assert.ok(!h.snapshot().includes("workflow-shell"), "no sandbox ran");
	}));
});
