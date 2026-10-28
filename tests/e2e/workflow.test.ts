/**
 * E2E: the `/workflow` command runs a real workflow in the codemode sandbox.
 * Process isolation keeps each workflow's runtime singletons private.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessHarness } from "./pty-harness.js";
import { waitForSent } from "./workflow-harness.js";

async function start(): Promise<ProcessHarness> {
	const h = new ProcessHarness();
	await h.waitForText("READY");
	// Opt in to the workflow-suite fakes (fake shell, picker stubs); other suites get none.
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

describe("workflow E2E", () => {
	it("runs a workflow end-to-end and records the exit", async () => withHarness(async (h) => {
		h.write("cmd workflow examples/workflows/smoke.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText("workflow-exit");

		const snap = h.snapshot();
		assert.ok(snap.includes('"reason":"ok"'), "exit reason recorded");
		assert.ok(snap.includes("smoke-ok"), "shell output recorded");
	}));

	it("workflow.new rebinds the session and the workflow still exits", async () => withHarness(async (h) => {
		h.write("cmd workflow examples/workflows/new-session.js");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText("workflow-exit");

		assert.ok(h.snapshot().includes('"reason":"ok"'), "exit after session replacement");
	}));

	it("a cost-limited run records the exit and the session stays responsive", async () => withHarness(async (h) => {
		h.write("flag workflow-cost 0.05");
		await h.waitForText("OK");
		// Park the run inside workflow.shell, then inject the spend mid-run: run cost
		// is scoped from run start, so a pre-run seed would no longer count.
		h.write("hold-exec");
		await h.waitForText("OK");
		h.write("cmd-bg workflow examples/workflows/smoke.js");
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");
		h.write("spent 1");
		await h.waitForText("OK");
		h.write("release-exec");
		await h.waitForText("OK");
		h.write("cmd-wait");
		await h.waitForText("OK");

		// The crossing guard ran; the checkpoint deferred the stop: exit recorded and human notified.
		h.write("ui-events");
		await h.waitForText('"message":"cost target reached","level":"info"');
		h.write("appended");
		await h.waitForText('"reason":"cost-limit"');
		assert.ok(h.snapshot().includes("partial"), "the checkpoint partial is persisted on the exit entry");

		// Input suppression and status were released: the host still serves commands.
		h.write("cmds");
		await h.waitForText("OK");
		assert.ok(h.snapshot().includes("workflow"), "command registry answers after the stop");
	}));

	it("suppresses user input while the workflow runs and releases it after", async () => withHarness(async (h) => {
		// Park the real run inside workflow.shell: a held exec proves the run is live,
		// so the mid-run dispatch below cannot race the run's completion.
		h.write("hold-exec");
		await h.waitForText("OK");
		h.write("cmd-bg workflow examples/workflows/smoke.js");
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");

		// Mid-run: non-extension source is suppressed, extension-sourced sends pass.
		h.write("input hello");
		await h.waitForText('OK:{"action":"handled"}');
		h.write("input-ext hello");
		await h.waitForText('OK:{"action":"continue"}');

		// After cmd-wait resolves, the handler's finally released suppression.
		h.write("release-exec");
		await h.waitForText("OK");
		h.write("cmd-wait");
		await h.waitForText("OK");
		h.write("input hello");
		await h.waitForText('OK:{"action":"continue"}');
	}));

	it("workflow.handoff writes one boundary, settles the successor, and the run continues", async () => withHarness(async (h) => {
		h.write("cmd-bg workflow examples/workflows/handoff.js");
		await h.waitForText("OK:started");
		// The handoff request lands async; poll the outbox until the prep message proves it.
		await waitForSent(h, "Handoff requested.");
		h.write('usage {"tokens":50000,"percent":25,"contextWindow":200000}');
		await h.waitForText("OK");
		h.write('tool handoff {"nextInstruction":"do the resumed work","context":"remaining state"}');
		await h.waitForText("OK:Handoff staged.");
		// The turn_end boundary commits the cut and the successor in one pass and asks pi
		// to continue the run; turn_start is the confirmation point the workflow watches.
		h.write("turn-end");
		await h.waitForText('"continue":true');
		h.write("turn-start");
		await h.waitForText("OK");
		// Every settle subscriber must fire: the idle wait armed mid-run is not first.
		h.write("agent-settled-all");
		await h.waitForText("OK");
		h.write("cmd-wait");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText('"reason":"ok"');
		assert.ok(h.snapshot().includes("workflow-exit"), "the continued run records its exit");
	}));

	it("cancels a running workflow with arm-then-confirm Escape", async () => withHarness(async (h) => {
		// Park the run inside workflow.shell so the presses cannot race the run's completion.
		h.write("workflow-mocks");
		await h.waitForText("OK");
		h.write("tui");
		await h.waitForText("OK");
		h.write("hold-exec");
		await h.waitForText("OK");
		h.write("cmd-bg workflow examples/workflows/smoke.js");
		await h.waitForText("OK:started");
		await h.waitForText("EXEC-HELD");

		// First Escape arms, second confirms. WHY one write: the pair must land inside the
		// real 500ms CANCEL_CONFIRM_MS, and three separate PTY round-trips can exceed it on
		// a slow CI runner. Both lines reach the host in one stdin chunk, so the funnel
		// processes them microseconds apart. Do not raise the waits to paper over this.
		h.write("key escape\nkey escape");
		await h.waitForText('OK:{"consume":true}');
		h.write("ui-events");
		// Match the funnel's arm warning by stable prefix: production appends the live
		// confirmMs window ("…within 500ms to cancel…"), so an exact literal would re-drift.
		await h.waitForText("Press Escape again");
		assert.equal((h.snapshot().match(/OK:{"consume":true}/g) ?? []).length, 2, "both presses were consumed by the funnel");
		h.write("release-exec");
		await h.waitForText("OK");
		h.write("cmd-wait");
		await h.waitForText("OK");
		h.write("appended");
		await h.waitForText('"reason":"cancelled"');

		// A stray single keypress alone never kills a run: consumed by the arm, not a cancel.
		assert.ok(!h.snapshot().includes('"reason":"ok"'), "the armed run did not complete normally");
		assert.ok(!h.snapshot().includes('"phase":"reserve"'), "no second-run rejection noise");
	}));

	it("reports a compile error without starting the run", async () => withHarness(async (h) => {
		h.write("workflow-mocks");
		await h.waitForText("OK");
		h.write("cmd workflow tests/e2e/fixtures/broken-workflow.js");
		await h.waitForText("OK");
		h.clear();
		h.write("ui-events");
		await h.waitForText("OK:");
		// Compile runs before the budget dialog: exactly one error notice, and it carries
		// the compiler's parse location — never a silently swallowed failure.
		assert.equal((h.snapshot().match(/"level"/g) ?? []).length, 1, "exactly the compile-error notice, no budget dialog chatter");
		assert.ok(h.snapshot().includes("parse error"), "the compiler's line:column message reached the user");

		h.clear();
		h.write("appended");
		await h.waitForText("OK:");
		assert.ok(!h.snapshot().includes("workflow-exit"), "a broken workflow never records an exit");
	}));
});
