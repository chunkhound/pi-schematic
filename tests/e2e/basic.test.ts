/**
 * Process-isolated E2E tests for the agenticoding extension.
 *
 * These tests spawn a fresh Node.js process per test case. Process isolation
 * means no shared singletons and no console races between test cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

describe("agenticoding E2E", () => {
	it("host starts and extension registers", async () => withHarness(async (h) => {
		h.write("tools");
		await h.waitForText("OK:");

		const snap = h.snapshot();
		assert.ok(snap.includes("notebook_write"), "notebook_write tool registered");
		assert.ok(snap.includes("notebook_read"), "notebook_read tool registered");
		assert.ok(snap.includes("notebook_index"), "notebook_index tool registered");
		assert.ok(snap.includes("notebook_topic_set"), "notebook_topic_set tool registered");
		assert.ok(snap.includes("handoff"), "handoff tool registered");
		assert.ok(snap.includes("spawn"), "spawn tool registered");
	}));

	it("notebook write/read round-trip", async () => withHarness(async (h) => {
		h.write('tool notebook_write {"name":"my-page","content":"Hello World"}');
		await h.waitForText("OK:Saved notebook page");

		h.write('tool notebook_read {"name":"my-page"}');
		await h.waitForText("OK:--- my-page ---");

		const snap = h.snapshot();
		assert.ok(snap.includes("Hello World"), "content persisted");
	}));

	it("notebook index reflects written pages", async () => withHarness(async (h) => {
		h.write('tool notebook_write {"name":"page-a","content":"Page A"}');
		await h.waitForText("OK:");

		h.write("tool notebook_index {}");
		await h.waitForText("page-a");

		// Second write should appear in index
		h.write('tool notebook_write {"name":"page-b","content":"Page B"}');
		await h.waitForText("OK:");

		h.write("tool notebook_index {}");
		await h.waitForText("page-b");

		const snap = h.snapshot();
		assert.ok(snap.includes("page-a"), "page-a in index");
		assert.ok(snap.includes("page-b"), "page-b in index");
	}));

	it("notebook_write overwrites existing page", async () => withHarness(async (h) => {
		h.write('tool notebook_write {"name":"page","content":"v1"}');
		await h.waitForText("OK:");

		// Clear accumulated output so we only check the second write/read
		h.clear();
		h.write('tool notebook_write {"name":"page","content":"v2"}');
		await h.waitForText("OK:");

		h.clear();
		h.write('tool notebook_read {"name":"page"}');
		await h.waitForText("OK:--- page ---");

		const snap = h.snapshot();
		assert.ok(snap.includes("v2"), "overwritten content present");
		assert.ok(!snap.includes("v1"), "old content absent from fresh output");
	}));

	it("notebook topic lifecycle: set via command, agent-set blocked", async () => withHarness(async (h) => {
		// Set topic via /notebook command (human-set)
		h.write("cmd notebook my-e2e-topic");
		await h.waitForText("OK");

		// Agent-set should be blocked (human is authoritative)
		h.write('tool notebook_topic_set {"topic":"agent-topic"}');
		await h.waitForText("ERR:");
		const snap = h.snapshot();
		assert.ok(
			snap.includes("authoritative"),
			"human-set topic blocks agent override",
		);
	}));

	it("agent-set topic works when unset", async () => withHarness(async (h) => {
		// No topic set yet -- agent can set
		h.write('tool notebook_topic_set {"topic":"fresh-agent-topic"}');
		await h.waitForText("OK:Active notebook topic:");
		const snap = h.snapshot();
		assert.ok(snap.includes("fresh-agent-topic"));
	}));

	it("handoff tool requires an instruction and eligible context usage", async () => withHarness(async (h) => {
		// An instruction is mandatory even before usage checks run
		h.write('tool handoff {"context":"situational only"}');
		await h.waitForText("Empty handoff nextInstruction rejected");

		// With an instruction but no usage data, handoff is still rejected
		h.write('tool handoff {"nextInstruction":"test handoff task"}');
		await h.waitForText("ERR:Context usage unavailable");
	}));

	it("handoff queues the successor instruction and re-announces readonly in its turn", async () => withHarness(async (h) => {
		h.write("cmd readonly");
		await h.waitForText("OK");
		// Drain the toggle nudge so the successor nudge proves post-handoff live state.
		h.write("context");
		await h.waitForText("agenticoding-readonly-nudge");
		h.write("cmd handoff continue readonly work");
		await h.waitForText("OK");
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"context":"mid-task state"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		h.write("successor-turn");
		await h.waitForText("## Next instruction");
		await h.waitForText("continue readonly work");
		await h.waitForText("mid-task state");
		await h.waitForText("[readonly] enabled");
		h.write("successor-turn");
		await h.waitForText("ERR:no queued successor turn");
	}));

	it("persisted successor is not re-delivered by settle or tree navigation", async () => withHarness(async (h) => {
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		// Draining the follow-up persists it as real text content parts.
		h.write("successor-turn");
		await h.waitForText("## Next instruction");

		h.write("agent-settled");
		await h.waitForText("OK");
		h.write("session-tree");
		await h.waitForText("OK");
		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		assert.equal(h.snapshot().trim(), "OK:1", "a persisted successor must be delivered exactly once");
	}));

	it("editing a persisted successor never re-delivers its original instruction", async () => withHarness(async (h) => {
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		h.write("successor-turn");
		await h.waitForText("## Next instruction");
		// The original follow-up has settled, so the dedupe latch cannot mask a retry.
		h.write("agent-settled");
		await h.waitForText("OK");
		h.write("tree-edit-last-user");
		await h.waitForText("OK");
		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		assert.equal(h.snapshot().trim(), "OK:1", "editing a successor must not requeue its original instruction");
	}));

	it("recovery resends a lost successor and stops once it lands", async () => withHarness(async (h) => {
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");

		// Simulate a lost fire-and-forget delivery: the follow-up never reaches the branch.
		h.write("drop-follow-up");
		await h.waitForText("OK");
		h.write("agent-settled");
		await h.waitForText("OK");
		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		assert.equal(h.snapshot().trim(), "OK:2", "recovery must resend the absent successor");

		// The resent delivery lands and persists; a later settle must not send again.
		h.write("successor-turn");
		await h.waitForText("## Next instruction");
		h.write("agent-settled");
		await h.waitForText("OK");
		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		assert.equal(h.snapshot().trim(), "OK:2", "a delivered successor must not be re-sent");
	}));

	it("identical successors across cuts are attributed by lineage, not re-sent", async () => withHarness(async (h) => {
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		// Two cuts carry identical payloads. Queued successors attach to the current
		// leaf (cut2), so lineage attributes the surviving successor to cut2.
		h.write('tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		h.write('tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");

		// Drain cut1's queued successor (it persists under cut2, the current leaf),
		// then discard cut2's. Text alone cannot tell the deliveries apart.
		h.write("successor-turn");
		await h.waitForText("## Next instruction");
		h.write("drop-follow-up");
		await h.waitForText("OK");

		// The successor sits after cut2, so recovery finds no candidate. Settle clears
		// the direct-delivery latch for the later trigger.
		h.write("agent-settled");
		await h.waitForText("OK");
		h.write("tree-edit-last-user");
		await h.waitForText("OK");
		h.write("session-tree");
		await h.waitForText("OK");

		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		// 2 direct sends (one per compact-success), no resend: lineage proves cut2's
		// successor was retained outside the branch, so the identical payload is not
		// re-delivered.
		assert.equal(h.snapshot().trim(), "OK:2", "an identical successor owned by another cut must not be re-sent");
	}));

	it("recovery never appends a lost handoff after newer user work", async () => withHarness(async (h) => {
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"old handoff work"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		h.write("drop-follow-up");
		await h.waitForText("OK");

		// The user moved on before a recovery trigger. That newer intent owns the branch.
		h.write("user-turn newer user work");
		await h.waitForText("OK");
		h.write("agent-settled");
		await h.waitForText("OK");
		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		assert.equal(h.snapshot().trim(), "OK:1", "recovery must not enqueue superseded work");
	}));

	it("tree navigation never appends a lost handoff after newer user work", async () => withHarness(async (h) => {
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"old handoff work"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		h.write("drop-follow-up");
		await h.waitForText("OK");

		// The user moved on before a recovery trigger. Tree navigation must not
		// resurrect the superseded instruction either.
		h.write("user-turn newer user work");
		await h.waitForText("OK");
		// Settle clears the direct-delivery dedupe latch so session-tree recovery
		// is exercised, not latch-masked: pre-supersession code would resend here.
		h.write("agent-settled");
		await h.waitForText("OK");
		h.write("session-tree");
		await h.waitForText("OK");
		h.clear();
		h.write("successor-count");
		await h.waitForText("OK:");
		await h.waitForText("\n");
		assert.equal(h.snapshot().trim(), "OK:1", "tree recovery must not enqueue superseded work");
	}));

	it("failed handoff compaction preserves retryability", async () => withHarness(async (h) => {
		h.write("cmd handoff retry after failure");
		await h.waitForText("OK");
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"retry after failure"}');
		await h.waitForText("OK:Handoff started.");
		h.write("compact-fail simulated failure");
		await h.waitForText("OK:compaction failed");
		await h.waitForText("Handoff failed");
		h.clear();
		h.write("ui-events");
		await h.waitForText('"agenticoding-handoff":"🤝 Handoff required — ready to compact"');
		await h.waitForText("Handoff compaction failed");
		h.write('tool handoff {"nextInstruction":"retry after failure"}');
		await h.waitForText("OK:Handoff started.");
	}));

	it("stale handoff compaction is ignored after session-tree navigation", async () => withHarness(async (h) => {
		h.write("cmd handoff stale branch");
		await h.waitForText("OK");
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"stale branch work"}');
		await h.waitForText("OK:Handoff started.");
		h.write("session-tree");
		await h.waitForText("OK");
		h.write("compact-success");
		await h.waitForText("OK:null");
		h.clear();
		h.write("ui-events");
		await h.waitForText("OK:");
		assert.doesNotMatch(h.snapshot(), /agenticoding-handoff/);
	}));

	it("readonly lifecycle: handoff bypass clears after compaction while readonly persists", async () => withHarness(async (h) => {
		h.write("cmd readonly");
		await h.waitForText("OK");
		// Drain the readonly toggle nudge
		h.write("context");
		await h.waitForText("agenticoding-readonly-nudge");
		// Issue /handoff command — creates the bypass
		h.write("cmd handoff continue readonly work");
		await h.waitForText("OK");
		// Set eligible context usage and call the handoff tool
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"continue readonly work"}');
		await h.waitForText("OK:Handoff started.");
		// Simulate successful compaction
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		// After compaction: bypass cleared, readonly persists and is re-announced live.
		h.write("context");
		await h.waitForText("agenticoding-readonly-nudge");
		await h.waitForText("[readonly] enabled");
		// handoff tool should now be blocked again
		h.write('toolcall handoff {"nextInstruction":"direct call"}');
		await h.waitForText('"block":true');
		// write tool should stay blocked
		h.write('toolcall write {"path":"/tmp/x","content":"x"}');
		await h.waitForText('"block":true');
	}));

	it("readonly topic boundary enables the handoff bypass on the next context hook", async () => withHarness(async (h) => {
		h.write("cmd readonly");
		await h.waitForText("OK");
		h.write("context");
		await h.waitForText("agenticoding-readonly-nudge");
		h.write("cmd notebook oauth");
		await h.waitForText("OK");
		h.write("cmd notebook billing");
		await h.waitForText("OK");
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write("context");
		await h.waitForText("temporary handoff exception active");
		h.clear();
		h.write("ui-events");
		await h.waitForText('"agenticoding-handoff":"🤝 Handoff required — ready to compact"');
		await h.waitForText("Readonly topic boundary detected");
		h.write('toolcall handoff {"nextInstruction":"continue billing work"}');
		await h.waitForText('OK:null');
		h.write('tool handoff {"nextInstruction":"continue billing work"}');
		await h.waitForText('OK:Handoff started.');
		h.clear();
		h.write("ui-events");
		await h.waitForText('"agenticoding-handoff":"🤝 Handoff in progress"');
		h.write("compact-success");
		await h.waitForText("queuedFollowUp");
		// Readonly persists after the handoff and is re-announced live
		h.write("context");
		await h.waitForText("agenticoding-readonly-nudge");
		h.clear();
		h.write("ui-events");
		await h.waitForText("OK:");
		assert.doesNotMatch(h.snapshot(), /agenticoding-handoff/);
		h.write('toolcall handoff {"nextInstruction":"direct call"}');
		await h.waitForText('"block":true');
	}));

	it("commands are registered", async () => withHarness(async (h) => {
		h.write("cmds");
		await h.waitForText("OK:");

		const snap = h.snapshot();
		assert.ok(snap.includes("notebook"), "/notebook command registered");
		assert.ok(snap.includes("handoff"), "/handoff command registered");
	}));

	it("spawn tool errors gracefully without model infrastructure", async () => withHarness(async (h) => {
		// Without a real model/session manager, spawn should throw immediately.
		h.write('tool spawn {"prompt":"any task"}');
		await h.waitForText("ERR:");

		const snap = h.snapshot();
		assert.ok(snap.includes("No model") || snap.includes("ERR"), "spawn errors gracefully");
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
