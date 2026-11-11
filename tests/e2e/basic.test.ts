/**
 * Process-isolated E2E tests for the pi-schematic extension.
 *
 * These tests spawn a fresh Node.js process per test case. Process isolation
 * means no shared singletons and no console races between test cases.
 */

import { describe, expect, it } from "vitest";
import { ProcessHarness } from "./pty-harness.js";

/** Create a fresh host, wait for READY, and return the harness. */
async function start(): Promise<ProcessHarness> {
	const h = new ProcessHarness();
	await expect(h.waitForText("READY")).resolves.toBeUndefined();
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
		await expect(h.waitForText("ERR:Context usage unavailable")).resolves.toBeUndefined();
	}));

	it("spawn tool refuses when the host has no model", async () => withHarness(async (h) => {
		h.write('tool spawn {"prompt":"any task"}');
		await expect(h.waitForText("ERR:No model configured. Cannot spawn child agent.")).resolves.toBeUndefined();
	}));

	it("headless mode keeps readonly command a no-op", async () => withHarness(async (h) => {
		h.write("headless");
		await expect(h.waitForText("OK")).resolves.toBeUndefined();
		h.write("cmd readonly");
		await expect(h.waitForText("OK")).resolves.toBeUndefined();
		h.write('toolcall write {"path":"/tmp/x","content":"x"}');
		await expect(h.waitForText("OK:null")).resolves.toBeUndefined();
	}));

	it("handles errors gracefully", async () => withHarness(async (h) => {
		// Unknown tool
		h.write("tool nonexistent {}");
		await expect(h.waitForText("ERR:unknown tool")).resolves.toBeUndefined();

		// Invalid JSON
		h.write("tool notebook_write {bad json}");
		await expect(h.waitForText("ERR:invalid json")).resolves.toBeUndefined();

		h.write("context {bad json}");
		await expect(h.waitForText("ERR:invalid json")).resolves.toBeUndefined();

		// Unknown command
		h.write("cmd nonexistent");
		await expect(h.waitForText("ERR:unknown command")).resolves.toBeUndefined();
	}));
});
