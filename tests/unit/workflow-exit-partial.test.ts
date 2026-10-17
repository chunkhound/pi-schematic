// WHY: a command-recorded sandbox abort once folded the checkpoint salvage into
// `ExitRecord.metadata`, so the summary (which reads `partial`) lost it. The exit
// record now carries `partial` as its own field; this pins both directions.
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import { buildWorkflowSummary } from "../../workflow/summary.js";
import type { WorkflowHostDeps } from "../../workflow/types.js";

function fakeDeps(): WorkflowHostDeps {
	const pi = {
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/workspace",
		sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [] },
	} as unknown as ExtensionCommandContext;
	return {
		pi,
		state: createState(),
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: () => ctx,
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
}

test("checkpoint then sandbox abort: the command-recorded exit keeps the salvage in `partial` and the summary carries it", async () => {
	const host = createWorkflowHost(fakeDeps());
	const byName = new Map(host.globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	// The workflow reaches a safe exit point before the sandbox dies.
	await byName.get("workflow.checkpoint")!.execute({ round: 3 }, context);
	assert.equal(host.exitRecord(), null, "a checkpoint alone records no exit");
	// Mirror workflow/command.ts reportResult: abort on the sandbox failure, then the
	// run's single write salvages the last checkpoint.
	host.abort("cancelled", "sandbox aborted");
	host.recordExit(
		{ reason: "cancelled", error: "sandbox aborted", partial: host.checkpointRecord()?.metadata },
		"error",
	);
	const exit = host.exitRecord();
	assert.deepEqual(exit?.partial, { round: 3 }, "the salvage survives on its own field");
	// Mirror workflow/command.ts finalizeRun: the summary reads `partial` directly.
	const summary = buildWorkflowSummary("review", exit?.reason ?? "returned", exit?.error, host.metrics(), exit?.partial);
	assert.deepEqual(summary.partial, { round: 3 }, "the summary card carries the salvaged checkpoint");
});

test("workflow.exit keeps user metadata in `metadata` with no `partial`", async () => {
	const host = createWorkflowHost(fakeDeps());
	const byName = new Map(host.globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	await byName.get("workflow.exit")!.execute({ reason: "done" }, context);
	const exit = host.exitRecord();
	assert.deepEqual(exit?.metadata, { reason: "done" });
	assert.equal(exit?.partial, undefined, "a plain exit salvages nothing");
});
