// State/entry digests exercised through the public `workflow.state` and `workflow.entries`
// globals (createWorkflowHost seam); no workflow-internal imports. The pure usage math
// (addUsage/collectUsage) lives with its own module's suite in usage.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

const usd = (total: number): Usage => ({
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function message(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role, content, timestamp: 0, ...extra },
	} as SessionEntry;
}

function digestHost(branch: SessionEntry[], state = createState()): { host: WorkflowHost; state: ReturnType<typeof createState> } {
	const ctx = {
		cwd: "/workspace",
		sessionManager: {
			getSessionId: () => "s1",
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
		},
		// 42% of the window; the digest reports the percent, never the raw tokens.
		getContextUsage: () => ({ percent: 42 }),
		modelRegistry: {},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
	const deps: WorkflowHostDeps = {
		pi: { appendEntry: () => {}, getActiveTools: () => ["bash", "read"] } as unknown as WorkflowHostDeps["pi"],
		state,
		limits: { costLimit: null, timeBudgetMs: null },
		getCtx: () => ctx,
		isReadonly: () => true,
		setReadonly: (enabled: boolean) => enabled,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
	return { host: createWorkflowHost(deps), state };
}

function handle(host: WorkflowHost, name: string): { execute: (args?: unknown, context?: unknown) => Promise<unknown> } {
	const tool = host.globals().find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing handle: ${name}`);
	const execute = tool.execute.bind(tool) as (args: unknown, context: unknown) => Promise<unknown>;
	// Default context: inspectors need no signal; the sandbox always supplies one.
	return { execute: (args, context = {}) => execute(args, context) };
}

test("workflow.entries filters after an id, caps the newest, and names tool calls", async () => {
	const entries: SessionEntry[] = [
		message("u0", "user", "start"),
		message("a1", "assistant", [{ type: "toolCall", name: "bash" }, { type: "text", text: "done" }]),
		message("t1", "toolResult", [{ type: "text", text: "ok" }], { toolName: "bash" }),
	];
	const { host } = digestHost(entries);
	const all = (await handle(host, "workflow.entries").execute({ after: "u0" })) as Array<Record<string, unknown>>;
	assert.equal(all.length, 2);
	assert.deepEqual(all[0].toolNames, ["bash"]);
	assert.equal(all[0].text, "done");
	assert.deepEqual(all[1].toolNames, ["bash"]);
	const limited = (await handle(host, "workflow.entries").execute({ after: "u0", limit: 1 })) as Array<Record<string, unknown>>;
	assert.equal(limited.length, 1);
	assert.equal(limited[0].id, "t1");
	assert.deepEqual(await handle(host, "workflow.entries").execute({ after: "u0", limit: 0 }), []);
});

// An absent `after` id reports the whole branch; an unknown one fails loudly.
test("workflow.entries returns the whole branch when the after id is absent", async () => {
	const entries = [message("u0", "user", "start"), message("a1", "assistant", [{ type: "text", text: "hi" }])];
	const { host } = digestHost(entries);
	assert.equal(((await handle(host, "workflow.entries").execute({})) as unknown[]).length, 2);
});

test("workflow.entries rejects an unknown after id by name", async () => {
	const entries = [message("u0", "user", "start"), message("a1", "assistant", [{ type: "text", text: "hi" }])];
	const { host } = digestHost(entries);
	await assert.rejects(handle(host, "workflow.entries").execute({ after: "missing" }), /unknown after id "missing"/);
});

test("workflow.entries rejects a limit that is not a finite non-negative integer", async () => {
	const entries = [message("u0", "user", "start"), message("a1", "assistant", [{ type: "text", text: "hi" }])];
	const { host } = digestHost(entries);
	for (const limit of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, null, "2"]) {
		await assert.rejects(handle(host, "workflow.entries").execute({ limit }), /limit must be a non-negative integer/, `limit ${String(limit)}`);
	}
});

test("workflow.state reports the newest assistant text across content blocks", async () => {
	const entries: SessionEntry[] = [
		message("a1", "assistant", [{ type: "text", text: "first" }]),
		message("u1", "user", "note"),
		message("a2", "assistant", [{ type: "thinking", thinking: "x" }, { type: "text", text: "second" }]),
	];
	const { host } = digestHost(entries);
	const digest = (await handle(host, "workflow.state").execute()) as Record<string, unknown>;
	assert.equal(digest.lastResponse, "second");
});

test("workflow.state reports the host-composed view of the session", async () => {
	// `cost` is the host's run-scoped spend projection (workflow/spend.ts composes the
	// live-branch scan with baseline, child-ledger, and classifier rows). The host freezes
	// the pre-run branch by id, so usage appended after host creation is the run's.
	const entries: SessionEntry[] = [message("u0", "user", "hello")];
	const state = createState();
	state.activeNotebookTopic = "runtime";
	state.activeNotebookTopicSource = "agent";
	const { host } = digestHost(entries, state);
	entries.push(message("a1", "assistant", [{ type: "text", text: "answer" }], { usage: usd(0.4) }));
	const digest = (await handle(host, "workflow.state").execute()) as Record<string, unknown>;
	assert.equal(digest.sessionId, "s1");
	assert.equal(digest.leafId, "a1");
	assert.equal(digest.messageCount, 2);
	assert.equal(digest.contextPercent, 42);
	assert.equal(digest.cost, 0.4);
	assert.equal(digest.lastResponse, "answer");
	assert.equal(digest.readonly, true);
	assert.deepEqual(digest.activeTools, ["bash", "read"]);
	assert.equal(digest.notebookTopic, "runtime");
	assert.equal(digest.settledRuns, 0, "the digest reports settled runs; none have settled in a fresh host");
});

// WHY: the digest crosses into the sandbox as JSON, so the sandbox
// must never see the raw transcript. lastResponse is the one allowed message
// field — every OTHER message text stays out of the serialized digest.
test("the serialized digest never carries the conversation's message text", async () => {
	const MARKER = "TRANSCRIPT-MARKER-a7f3";
	const entries: SessionEntry[] = [
		message("u0", "user", `secret request: ${MARKER}`),
		message("a1", "assistant", [{ type: "text", text: `interim note ${MARKER}` }]),
		message("u1", "user", "continue"),
		message("a2", "assistant", [{ type: "text", text: "final answer" }]),
	];
	const { host } = digestHost(entries);
	const digest = (await handle(host, "workflow.state").execute()) as Record<string, unknown>;
	assert.equal(digest.lastResponse, "final answer", "the final assistant text is the digest's only message text");
	const json = JSON.stringify(digest);
	assert.equal(json.includes(MARKER), false, "no other conversation text crosses into the sandbox");
});
