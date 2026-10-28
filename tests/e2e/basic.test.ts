/**
 * Process-isolated E2E tests for the pi-schematic extension.
 *
 * These tests spawn a fresh Node.js process per test case. Process isolation
 * means no shared singletons and no console races between test cases.
 */

import { describe, it } from "node:test";
import { ProcessHarness } from "./pty-harness.js";

/** Create a fresh host, wait for READY, and return the harness. */
async function start(): Promise<ProcessHarness> {
	const h = new ProcessHarness();
	await h.waitForText("READY");
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

describe("pi-schematic E2E", () => {
	it("handoff tool rejects when context usage is unavailable", async () => withHarness(async (h) => {
		h.write('tool handoff {"nextInstruction":"test handoff task"}');
		await h.waitForText("ERR:Context usage unavailable");
	}));

	it("spawn tool refuses when the host has no model", async () => withHarness(async (h) => {
		h.write('tool spawn {"prompt":"any task"}');
		await h.waitForText("ERR:No model configured. Cannot spawn child agent.");
	}));

	it("headless mode keeps readonly command a no-op", async () => withHarness(async (h) => {
		h.write("headless");
		await h.waitForText("OK");
		h.write("cmd readonly");
		await h.waitForText("OK");
		h.write('toolcall write {"path":"/tmp/x","content":"x"}');
		await h.waitForText("OK:null");
	}));

	it("handles errors gracefully", async () => withHarness(async (h) => {
		// Unknown tool
		h.write("tool nonexistent {}");
		await h.waitForText("ERR:unknown tool");

		// Invalid JSON
		h.write("tool notebook_write {bad json}");
		await h.waitForText("ERR:invalid json");

		h.write("context {bad json}");
		await h.waitForText("ERR:invalid json");

		// Unknown command
		h.write("cmd nonexistent");
		await h.waitForText("ERR:unknown command");
	}));
});
