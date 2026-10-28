// WHY: the only probe that fakes nothing where the run actually executes. The command builds
// the real CodemodeSandbox (no `sandboxFactory` seam) and the workflow's `workflow.run` turn
// runs in a real AgentSession against the offline deterministic provider. Together they pin the
// shipped chain: file -> compile -> driver -> run dispatch -> settle correlation -> exit record,
// with the child's own usage attributed into the run ledger.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { registerWorkflowCommand, type WorkflowCommandDeps } from "../../workflow/command.js";
import { releaseWorkflow, reserveWorkflow } from "../../workflow/coordinator.js";
import { runRealChildInvocation, tmpDir } from "../unit/helpers.js";
import { createTestHost } from "../unit/test-host.js";

const CHILD_COST_USD = 0.25;

// The author's file: one template step, a checkpoint as the safe exit point, then its own exit.
const WORKFLOW = `return defineWorkflow((workflow) => {
  const review = workflow.run("review the diff");
  workflow.checkpoint({ text: review.text });
  return workflow.exit({ reason: "done", text: review.text });
});
`;

function entry(id: string, message: Record<string, unknown>): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-07T00:00:00.000Z", message } as SessionEntry;
}

// The parent branch carries no usage, so every cent in the run's ledger is child-attributed.
function assistantEntry(id: string, text: string, model: string): SessionEntry {
	return entry(id, { role: "assistant", content: [{ type: "text", text }], api: "agentic-e2e-api", provider: "agentic-e2e", model, stopReason: "stop", timestamp: 0 });
}

/** Headless context: the run records everything and paints nothing. */
function headlessCtx(cwd: string, branch: SessionEntry[]): ExtensionCommandContext {
	const noop = () => {};
	return {
		hasUI: false,
		mode: "rpc",
		cwd,
		ui: { notify: noop, setStatus: noop, setWidget: noop, setFooter: noop, setWorkingMessage: noop, theme: { fg: (_name: string, text: string) => text } },
		sessionManager: {
			getSessionId: () => "e2e-workflow",
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionName: () => undefined,
		},
		modelRegistry: { getModelsOfType: () => [], getModelOfType: () => undefined },
		getContextUsage: () => null,
		isIdle: () => true,
		abort: noop,
		newSession: async () => ({ cancelled: false }),
	} as unknown as ExtensionCommandContext;
}

/** Poll `cond` until true or the deadline passes; the sandbox and child session are async. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// WHY timeout: the run parks in the real sandbox until this test settles its turn, so a
// broken settle must fail the test instead of hanging the runner.
test("/workflow runs the real sandbox against a real model turn and attributes its cost", { timeout: 120_000 }, async () => {
	const dir = await tmpDir();
	const state = createState();
	const frontmatterPrepared: string[] = [];
	const deps: WorkflowCommandDeps = {
		setReadonly: () => false,
		requestHandoff: async () => {},
		watchHandoffSettlement: () => ({ done: new Promise<never>(() => {}), dispose: () => {} }),
		prepareRunFrontmatter: async (text) => { frontmatterPrepared.push(text); },
	};
	const pi = await createTestHost((api) => registerWorkflowCommand(api, state, deps));
	// A project prompt template named `review` exists, but a slashless prompt with arguments is
	// prose (never a command), so the run must send it verbatim.
	pi.setCommands([{ name: "review", source: "prompt", sourceInfo: { path: join(dir, ".pi", "prompts", "review.md"), source: "prompt", scope: "project", origin: "top-level" } }]);
	const branch: SessionEntry[] = [];
	const ctx = headlessCtx(dir, branch);
	let failure: unknown;
	try {
		await mkdir(join(dir, ".pi", "workflows"), { recursive: true });
		await writeFile(join(dir, ".pi", "workflows", "review-step.js"), WORKFLOW);

		const running = pi.commands.get("workflow").handler("review-step", ctx).catch((error: unknown) => { failure = error; });
		await waitFor(() => pi.sentUserMessages.length > 0, "the workflow's run turn to dispatch");
		const dispatched = String(pi.sentUserMessages[0].content);
		assert.equal(dispatched, "review the diff", "a slashless prose prompt dispatches verbatim, not as a command");
		assert.deepEqual(frontmatterPrepared, [dispatched], "the turn's frontmatter resolved before the send");

		// A real child session answers the turn. It shares this `state`, so its usage flushes into
		// the sink the live run installed - the same path the spawn tool uses in production.
		assert.ok(state.childUsageSink, "the live run owns the child-usage sink the spawn tool writes to");
		const child = await runRealChildInvocation({ prompt: dispatched, state, childCostUsd: CHILD_COST_USD });
		assert.equal(child.probeCalls, 1, "the workflow turn completed its tool loop");
		assert.ok(child.observedMessages.some((text) => text.includes(dispatched)), "the real session carried the workflow's own turn");

		branch.push(entry("e-user", { role: "user", content: dispatched, timestamp: 0 }), assistantEntry("e-turn", child.expectedText, child.modelId));
		for (const handler of pi.handlers.get("agent_settled") ?? []) await handler({}, ctx);
		await running;
		assert.equal(failure, undefined, `the run must settle without rejecting: ${String(failure)}`);

		const exits = pi.appendedEntries.filter((record) => record.customType === "workflow-exit");
		assert.deepEqual(exits.map((record) => record.data), [{ v: 1, reason: "done", metadata: { reason: "done", text: child.expectedText } }], "exactly one exit record, carrying the workflow's own reason and the model's reply");
		assert.ok(pi.appendedEntries.some((record) => record.customType === "workflow-limits"), "the headless no-target start is recorded, never silently unbounded");

		const summaries = pi.appendedEntries.filter((record) => record.customType === "workflow-summary");
		assert.equal(summaries.length, 1, "one overview per run");
		const summary = summaries[0].data;
		assert.equal(summary.workflow, "review-step");
		assert.equal(summary.reason, "done");
		assert.deepEqual([summary.steps, summary.turns, summary.checkpoints], [1, 1, 1], "one step, one round-trip, one checkpoint");
		const childRow = summary.spend.find((row: { model: string }) => row.model === child.modelId);
		assert.ok(childRow, `the child's spend must appear in the run ledger: ${JSON.stringify(summary.spend)}`);
		assert.ok(childRow.costUsd >= CHILD_COST_USD, `the child turn must cost at least ${CHILD_COST_USD}, got ${childRow.costUsd}`);
		assert.equal(summary.costUsd, childRow.costUsd, "all of the run's cost is child-attributed spend");

		assert.equal(state.childUsageSink, null, "the disposed run uninstalls its sink");
		assert.equal(reserveWorkflow(), true, "the run released the process-wide reservation");
		releaseWorkflow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// A checkpoint-only workflow: no model turns, so the run is fast and fully deterministic.
const BACKSTOP_WORKFLOW = `return defineWorkflow((workflow) => {
  workflow.checkpoint({});
  workflow.exit({ reason: "done", text: "ok" });
});
`;

// WHY: a run that dies before its cleanup (a bypassed finally) must never poison the next
// run. This poisons the two run-state slots the way a crashed run would leave them and
// runs a checkpoint-only workflow through the real command and sandbox; the openRun
// backstop must clear them so the fresh run completes with clean state. The run registry is
// no longer a shared slot: the host owns and disposes it, so it cannot leak across runs.
test("a poisoned prior run never blocks the next run", { timeout: 60_000 }, async () => {
	const dir = await tmpDir();
	const state = createState();
	const deps: WorkflowCommandDeps = {
		setReadonly: () => false,
		requestHandoff: async () => {},
		watchHandoffSettlement: () => ({ done: new Promise<never>(() => {}), dispose: () => {} }),
		prepareRunFrontmatter: async () => {},
	};
	state.inputSuppressed = true;
	state.childUsageSink = () => {};
	const pi = await createTestHost((api) => registerWorkflowCommand(api, state, deps));
	try {
		await mkdir(join(dir, ".pi", "workflows"), { recursive: true });
		await writeFile(join(dir, ".pi", "workflows", "backstop-step.js"), BACKSTOP_WORKFLOW);
		await pi.commands.get("workflow")!.handler("backstop-step", headlessCtx(dir, []));

		assert.equal(state.inputSuppressed, false, "input ends usable");
		assert.equal(state.childUsageSink, null, "no sink survives the run");
		const exits = pi.appendedEntries.filter((record) => record.customType === "workflow-exit");
		assert.deepEqual(exits.map((record) => record.data), [{ v: 1, reason: "done", metadata: { reason: "done", text: "ok" } }], "the run completes despite the poisoned state");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
