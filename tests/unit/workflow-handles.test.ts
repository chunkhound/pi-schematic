import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHandleName, WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

const EXPECTED = [
	"workflow.run",
	"workflow.handoff",
	"workflow.classify",
	"workflow.shell",
	"workflow.state",
	"workflow.entries",
	"workflow.notebookIndex",
	"workflow.notebookRead",
	"workflow.notebookWrite",
	"workflow.notebookTopic",
	"workflow.budget",
	"workflow.readonly",
	"workflow.new",
	"workflow.checkpoint",
	"workflow.exit",
];

function fakeDeps(): WorkflowHostDeps {
	const pi = {
		on: () => () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
		getSettings: () => ({}),
		appendEntry: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/workspace",
		sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [] },
		getContextUsage: () => undefined,
		modelRegistry: { getModelsOfType: () => [], classify: async () => ({}) },
	} as unknown as ExtensionCommandContext;
	return {
		pi,
		state: createState(),
		limits: { costLimit: null, timeBudgetMs: null },
		getCtx: () => ctx,
		isReadonly: () => false,
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
		shellRun: async () => ({ content: [{ type: "text", text: "ok" }], isError: false, structuredContent: { output: "ok", truncated: false, exit_code: 0, wall_time_seconds: 0 } }),
	};
}

test("globals expose exactly the two-level workflow.<member> surface", () => {
	const globals = createWorkflowHost(fakeDeps()).globals();
	assert.deepEqual(globals.map((tool) => tool.name), EXPECTED);
	assert.equal(new Set(globals.map((tool) => tool.name)).size, EXPECTED.length);
	for (const tool of globals) assert.match(tool.name, /^workflow\.[A-Za-z]+$/);
});

test("only workflow.run and workflow.shell spread their arguments", () => {
	const globals = createWorkflowHost(fakeDeps()).globals();
	for (const tool of globals) {
		const spread = tool.spread === true;
		assert.equal(spread, tool.name === "workflow.run" || tool.name === "workflow.shell", tool.name);
	}
});

test("a real CodemodeSandbox accepts the handle names", async () => {
	const sandbox = new CodemodeSandbox({ globals: createWorkflowHost(fakeDeps()).globals() });
	await sandbox.close();
});

test("a guarded call past the cost limit defers the stop to the next checkpoint", async () => {
	const deps = fakeDeps();
	deps.limits = { costLimit: 0, timeBudgetMs: null };
	const host = createWorkflowHost(deps);
	const byName = new Map(host.globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	// The crossing call runs; the run is not aborted mid-effect.
	const shell = (await byName.get("workflow.shell")!.execute(["echo hi"], context)) as { ok: boolean };
	assert.equal(shell.ok, true);
	assert.equal(host.exitRecord(), null);
	// The next checkpoint stops the run and salvages its metadata.
	await byName.get("workflow.checkpoint")!.execute({ round: 1 }, context);
	assert.equal(host.exitRecord()?.reason, "cost-limit");
	assert.equal(host.exitRecord()?.checkpoint, true);
	assert.deepEqual(host.checkpointRecord()?.metadata, { round: 1 });
});

/**
 * Per-handle accounting contract (see buildGlobals in workflow/host.ts): guarded
 * handles arm the deferred cost/time stop, counted handles feed the run metrics.
 * Inspectors (state/budget/notebookRead/notebookIndex/notebookTopic/checkpoint/exit)
 * stay reachable past the limit by design; checkpoint still counts, exit counts nothing.
 */
const HANDLE_CONTRACT: Array<{ name: WorkflowHandleName; guarded: boolean; counted: boolean }> = [
	{ name: "run", guarded: true, counted: true },
	{ name: "handoff", guarded: true, counted: true },
	{ name: "classify", guarded: true, counted: true },
	{ name: "shell", guarded: true, counted: true },
	{ name: "state", guarded: false, counted: false },
	{ name: "entries", guarded: true, counted: true },
	{ name: "notebookIndex", guarded: false, counted: false },
	{ name: "notebookRead", guarded: false, counted: false },
	{ name: "notebookWrite", guarded: true, counted: true },
	{ name: "notebookTopic", guarded: false, counted: false },
	{ name: "budget", guarded: false, counted: false },
	{ name: "readonly", guarded: true, counted: true },
	{ name: "new", guarded: true, counted: true },
	{ name: "checkpoint", guarded: false, counted: true },
	{ name: "exit", guarded: false, counted: false },
];

type TableEntry = { type: string; id: string; parentId: null; message: { role: string } };

/** Fake env with a working run round-trip: every send settles with one assistant entry. */
function fakeRunDeps(): { deps: WorkflowHostDeps; branch: TableEntry[] } {
	const deps = fakeDeps();
	// notebookRead throws on a missing page, so the table probes read a real page.
	deps.state.notebookPages.set("notes", "body");
	const branch: TableEntry[] = [];
	const settled = new Set<() => void>();
	let seq = 0;
	const nextId = () => `e${++seq}`;
	(deps.pi as unknown as { on: unknown }).on = (event: string, handler: () => void) => {
		if (event === "agent_settled") settled.add(handler);
		return () => { settled.delete(handler); };
	};
	(deps.pi as unknown as { getCommands: unknown }).getCommands = () => [
		{ name: "review", source: "prompt", sourceInfo: {} },
	];
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = () => {
		branch.push({ type: "message", id: nextId(), parentId: null, message: { role: "user" } });
		branch.push({ type: "message", id: nextId(), parentId: null, message: { role: "assistant" } });
		for (const handler of [...settled]) handler();
	};
	const classifierModel = { id: "jev", provider: "typesafe" };
	const ctx = deps.getCtx() as unknown as {
		sessionManager: { getBranch: unknown };
		modelRegistry: unknown;
	};
	ctx.sessionManager.getBranch = () => branch;
	ctx.modelRegistry = {
		getModelsOfType: () => [classifierModel],
		getModelOfType: () => undefined,
		classify: async () => ({ api: "x", provider: "typesafe", model: "jev", answers: {}, stopReason: "stop", timestamp: 0 }),
	};
	return { deps, branch };
}

function tableArgs(name: WorkflowHandleName): unknown {
	switch (name) {
		case "run": return ["/review"];
		case "handoff": return "next: review";
		case "classify": return { model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} };
		case "shell": return ["echo hi"];
		case "entries": return {};
		case "notebookRead": return "notes";
		case "notebookWrite": return { name: "n", content: "c" };
		case "readonly": return false;
		case "checkpoint": return { round: 1 };
		case "exit": return { reason: "done" };
		default: return undefined;
	}
}

async function callHandle(host: WorkflowHost, name: WorkflowHandleName): Promise<unknown> {
	const tool = host.globals().find((candidate) => candidate.name === `workflow.${name}`);
	assert.ok(tool, `missing handle workflow.${name}`);
	return tool.execute(tableArgs(name), { signal: host.signal } as never);
}

test("every handle matches the guarded/counted contract", async () => {
	const globals = createWorkflowHost(fakeDeps()).globals().map((tool) => tool.name);
	assert.deepEqual(
		HANDLE_CONTRACT.map((row) => `workflow.${row.name}`),
		globals,
		"the contract table covers exactly the 15 registered handles",
	);
	for (const row of HANDLE_CONTRACT) {
		// Counted probe: one call on a fresh unlimited host feeds the activity ledger.
		const countedHost = createWorkflowHost(fakeRunDeps().deps);
		await callHandle(countedHost, row.name);
		const activity = countedHost.metrics().activity as Partial<Record<WorkflowHandleName, number>>;
		assert.equal(activity[row.name] ?? 0, row.counted ? 1 : 0, `${row.name}: counted=${row.counted}`);
		// Guarded probe: past the cost limit, guarded effects hard-abort after the
		// deferred budget while inspectors stay reachable (exit/checkpoint end the run
		// through their own terminal path, never via the guard's abort reason).
		const { deps } = fakeRunDeps();
		deps.limits = { costLimit: 0, timeBudgetMs: null };
		const guardedHost = createWorkflowHost(deps);
		for (let i = 0; i < 20; i++) {
			try { await callHandle(guardedHost, row.name); } catch { /* terminal states reject; the abort reason is the signal */ }
		}
		assert.equal(guardedHost.abortedReason(), row.guarded ? "cost-limit" : null, `${row.name}: guarded=${row.guarded}`);
	}
});

test("unguarded budget/state/notebookRead/exit stay reachable past the cost limit", async () => {
	const deps = fakeDeps();
	deps.limits = { costLimit: 0, timeBudgetMs: null };
	const byName = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	deps.state.notebookPages.set("notes", "body");
	await byName.get("workflow.budget")!.execute(null, context);
	await byName.get("workflow.state")!.execute(null, context);
	// A missing page throws (documented contract); a real page still reads past the limit.
	assert.equal(await byName.get("workflow.notebookRead")!.execute("notes", context), "body");
	await byName.get("workflow.exit")!.execute(null, context);
});

// WHY: the exit reason is a shared contract (deriveExitReason): reserved tokens reject
// before anything is recorded, an object reason survives, and a missing reason is "returned".
test("workflow.exit rejects reserved reasons and derives the record reason", async () => {
	const context = { signal: new AbortController().signal } as never;
	const exitOf = (host: WorkflowHost) => new Map(host.globals().map((tool) => [tool.name, tool])).get("workflow.exit")!;
	const rejecting = createWorkflowHost(fakeDeps());
	await assert.rejects(async () => { await exitOf(rejecting).execute("cost-limit", context); }, /reserved abort reason/);
	assert.equal(rejecting.exitRecord(), null, "a rejected exit records nothing");
	const approved = createWorkflowHost(fakeDeps());
	await exitOf(approved).execute({ reason: "approved" }, context);
	assert.equal(approved.exitRecord()?.reason, "approved");
	const bare = createWorkflowHost(fakeDeps());
	await exitOf(bare).execute(undefined, context);
	assert.equal(bare.exitRecord()?.reason, "returned");
});

// WHY: previews buffer until the send happens; a dispatch failure must restore them for
// the next run instead of dropping them, while the sent boundary is the real dispatch.
test("a dispatch failure keeps buffered previews for the next run", async () => {
	const { deps, branch } = fakeRunDeps();
	const sent: string[] = [];
	const settled = new Set<() => void>();
	(deps.pi as unknown as { on: unknown }).on = (event: string, handler: () => void) => {
		if (event === "agent_settled") settled.add(handler);
		return () => { settled.delete(handler); };
	};
	let failDispatch = true;
	let seq = 0;
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (text: string) => {
		sent.push(text);
		if (failDispatch) throw new Error("dispatch down");
		branch.push({ type: "message", id: `u${++seq}`, parentId: null, message: { role: "user" } });
		branch.push({ type: "message", id: `a${seq}`, parentId: null, message: { role: "assistant" } });
		for (const handler of [...settled]) handler();
	};
	const host = createWorkflowHost(deps);
	const byName = new Map(host.globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	await byName.get("workflow.notebookWrite")!.execute({ name: "perf", content: "body" }, context);
	await assert.rejects(async () => { await byName.get("workflow.run")!.execute(["/review"], context); }, /dispatch down/);
	failDispatch = false;
	await byName.get("workflow.run")!.execute(["/review"], context);
	assert.equal(sent.length, 2);
	assert.match(sent[1], /Notebook page "perf" written/);
});

// WHY: docs/workflows.md's Handles table is the user-facing contract for the handle union;
// this pins it to the runtime surface so a handle added or removed forces a docs edit.
test("the docs Handles table lists exactly the runtime handle surface", () => {
	const doc = readFileSync(new URL("../../docs/workflows.md", import.meta.url), "utf8");
	const docHandles = [...doc.matchAll(/^\| `workflow\.([A-Za-z]+)` \|/gm)].map((m) => m[1]);
	const runtimeHandles = createWorkflowHost(fakeDeps()).globals().map((tool) => tool.name.replace(/^workflow\./, ""));
	assert.deepEqual([...docHandles].sort(), [...runtimeHandles].sort());
	assert.equal(docHandles.length, EXPECTED.length, "a 16th handle must also edit the docs table");
});

// WHY: readonly is a posture switch, so a coerced argument ("false" → true) would flip it
// silently. Only a real boolean may change the posture; anything else fails by name.
test("workflow.readonly accepts only a boolean and leaves the posture unchanged otherwise", async () => {
	const deps = fakeDeps();
	let posture = false;
	deps.setReadonly = (enabled) => { posture = enabled; return posture; };
	deps.isReadonly = () => posture;
	const readonly = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool])).get("workflow.readonly")!;
	const context = { signal: new AbortController().signal } as never;
	for (const bad of [undefined, "false", 1]) {
		await assert.rejects(async () => readonly.execute(bad, context), /workflow\.readonly takes a boolean/, `argument ${String(bad)}`);
		assert.equal(posture, false, `posture after ${String(bad)}`);
	}
	assert.deepEqual(await readonly.execute(true, context), { readonly: true });
	assert.equal(posture, true);
});

// WHY: run options arrive untyped from workflow JS. A malformed field must fail by name
// before dispatch, and the previews buffered for the next run must survive the rejection.
test("workflow.run rejects a malformed options object before dispatch and keeps buffered previews", async () => {
	const { deps } = fakeRunDeps();
	const sent: string[] = [];
	const dispatch = (deps.pi as unknown as { sendUserMessage: (...args: unknown[]) => void }).sendUserMessage;
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (...args: unknown[]) => {
		sent.push(args[0] as string);
		return dispatch(...args);
	};
	const tools = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	await tools.get("workflow.notebookWrite")!.execute({ name: "perf", content: "body" }, context);
	const rejected: Array<[unknown, RegExp]> = [
		[{ model: "p/m" }, /options\.model must be \{ provider: string, id: string \}/],
		[{ model: { provider: "p" } }, /options\.model must be/],
		[{ thinking: "turbo" }, /options\.thinking must be one of minimal, low, medium, high, xhigh, max/],
		[["high"], /options must be an object/],
	];
	for (const [options, pattern] of rejected) {
		await assert.rejects(async () => tools.get("workflow.run")!.execute(["/review", options], context), pattern, JSON.stringify(options));
	}
	assert.equal(sent.length, 0, "a rejected options object never dispatches");
	await tools.get("workflow.run")!.execute(["/review"], context);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /Notebook page "perf" written/, "the buffered preview reaches the next run");
});

// WHY: a failed advisory record must not vanish silently: the UI notice names the missing
// transcript record, and a recorded failure reads as a plain notice.
test("a host error notice names a transcript record that could not be persisted", async () => {
	const deps = fakeDeps();
	const notices: string[] = [];
	deps.notify = (message) => { notices.push(message); };
	deps.onProgress = () => { throw new Error("ui down"); };
	const shell = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool])).get("workflow.shell")!;
	const context = { signal: new AbortController().signal } as never;
	deps.pi.appendEntry = () => { throw new Error("append down"); };
	await shell.execute(["echo hi"], context);
	assert.equal(notices[0], "workflow progress failed: ui down (transcript record not persisted)");
	deps.pi.appendEntry = () => {};
	notices.length = 0;
	await shell.execute(["echo hi"], context);
	assert.equal(notices[0], "workflow progress failed: ui down");
});

// WHY: docs/workflows.md states the handle count in prose; the contract table must stay in
// lockstep so a new handle cannot silently stale the docs number.
test("the handle count stated in docs/workflows.md stays in sync", () => {
	assert.equal(HANDLE_CONTRACT.length, 15, "docs/workflows.md states 15 handles; update both together");
});

// WHY: notebookWrite returns null, so the clipping notice must ride the buffered preview;
// otherwise a truncated page reaches the next run silently.
test("workflow.notebookWrite surfaces truncation in the next run's buffered preview", async () => {
	const { deps } = fakeRunDeps();
	const sent: string[] = [];
	const dispatch = (deps.pi as unknown as { sendUserMessage: (...args: unknown[]) => void }).sendUserMessage;
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (...args: unknown[]) => {
		sent.push(args[0] as string);
		return dispatch(...args);
	};
	const tools = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	const long = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n");

	await tools.get("workflow.notebookWrite")!.execute({ name: "big", content: long }, context);
	await tools.get("workflow.run")!.execute(["/review"], context);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /Notebook page "big" written/);
	assert.match(sent[0], /TRUNCATED by lines/);
});

// WHY: a run-scoped override must never leak across turns, so each restored field is
// independent: a throwing setModel restore must not skip the thinking restore.
test("a throwing model restore still restores the run's thinking level", async () => {
	const { deps } = fakeRunDeps();
	const previousModel = { provider: "prev", id: "m" };
	const requestedModel = { provider: "next", id: "m" };
	const thinking: Array<string | undefined> = [];
	let setModelCalls = 0;
	(deps.pi as unknown as { setModel: unknown }).setModel = async () => {
		setModelCalls += 1;
		if (setModelCalls === 2) throw new Error("restore down");
		return true;
	};
	(deps.pi as unknown as { setThinkingLevel: unknown }).setThinkingLevel = (level: string | undefined) => { thinking.push(level); };
	(deps.pi as unknown as { getThinkingLevel: unknown }).getThinkingLevel = () => "medium";
	const ctx = deps.getCtx() as unknown as { model: unknown; modelRegistry: { getModelOfType: unknown } };
	ctx.model = previousModel;
	ctx.modelRegistry.getModelOfType = () => requestedModel;
	const tools = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;

	await assert.rejects(
		async () => { await tools.get("workflow.run")!.execute(["/review", { model: requestedModel, thinking: "high" }], context); },
		/override restore failed/,
	);
	assert.deepEqual(thinking, ["high", "medium"], "the thinking restore runs even though setModel threw");
});

// WHY: arming the output tool mutates run-scoped state, so a registration failure must still
// run the override restore or the run's model/thinking leak into the next turn.
test("a throwing output-tool arming still restores the run's model and thinking", async () => {
	const { deps } = fakeRunDeps();
	const previousModel = { provider: "prev", id: "m" };
	const requestedModel = { provider: "next", id: "m" };
	const models: unknown[] = [];
	const thinking: Array<string | undefined> = [];
	(deps.pi as unknown as { setModel: unknown }).setModel = async (model: unknown) => { models.push(model); return true; };
	(deps.pi as unknown as { setThinkingLevel: unknown }).setThinkingLevel = (level: string | undefined) => { thinking.push(level); };
	(deps.pi as unknown as { getThinkingLevel: unknown }).getThinkingLevel = () => "medium";
	(deps.pi as unknown as { getActiveTools: unknown }).getActiveTools = () => ["bash"];
	(deps.pi as unknown as { registerTool: unknown }).registerTool = () => { throw new Error("bad schema"); };
	const ctx = deps.getCtx() as unknown as { model: unknown; modelRegistry: { getModelOfType: unknown } };
	ctx.model = previousModel;
	ctx.modelRegistry.getModelOfType = () => requestedModel;
	const tools = new Map(createWorkflowHost(deps).globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;

	await assert.rejects(
		async () => { await tools.get("workflow.run")!.execute(["/review", { model: requestedModel, thinking: "high", output: {} }], context); },
		/bad schema/,
	);
	assert.deepEqual(models, [requestedModel, previousModel], "the override restore runs after the arming failure");
	assert.deepEqual(thinking, ["high", "medium"]);
});
