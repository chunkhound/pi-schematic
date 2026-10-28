// State/entry digests exercised through the public `workflow.state` and `workflow.entries`
// globals (createWorkflowHost seam); no workflow-internal imports. The pure usage math
// (addUsage/collectUsage) lives with its own module's suite in usage.test.ts.
import { expect, test } from "vitest";
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
		unbounded: false,
		getCtx: () => ctx,
		setReadonly: (enabled: boolean) => enabled,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
	return { host: createWorkflowHost(deps), state };
}

function handle(host: WorkflowHost, name: string): { execute: (args?: unknown, context?: unknown) => Promise<unknown> } {
	const tool = host.globals().find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`missing handle: ${name}`);
	}
	const execute = tool.execute.bind(tool) as (args: unknown, context: unknown) => Promise<unknown>;
	// Default context: inspectors need no signal; the sandbox always supplies one.
	return { execute: (args, context = {}) => execute(args, context) };
}

test("workflow.entries filters after an id and names tool calls", async () => {
	const entries: SessionEntry[] = [
		message("u0", "user", "start"),
		message("a1", "assistant", [
			{ type: "toolCall", name: "bash" },
			{ type: "text", text: "done" },
		]),
		message("t1", "toolResult", [{ type: "text", text: "ok" }], { toolName: "bash" }),
	];
	const { host } = digestHost(entries);
	const all = (await handle(host, "workflow.entries").execute({ after: "u0" })) as Record<string, unknown>[];
	expect(all.length).toBe(2);
	expect(all[0].toolNames).toStrictEqual(["bash"]);
	expect(all[0].text).toBe("done");
	expect(all[1].toolNames).toStrictEqual(["bash"]);
});

test("workflow.entries caps the returned window", async () => {
	const entries: SessionEntry[] = [
		message("u0", "user", "start"),
		message("a1", "assistant", [
			{ type: "toolCall", name: "bash" },
			{ type: "text", text: "done" },
		]),
		message("t1", "toolResult", [{ type: "text", text: "ok" }], { toolName: "bash" }),
	];
	const { host } = digestHost(entries);
	const limited = (await handle(host, "workflow.entries").execute({ after: "u0", limit: 1 })) as Record<string, unknown>[];
	expect(limited.length).toBe(1);
	expect(limited[0].id).toBe("t1");
	expect(await handle(host, "workflow.entries").execute({ after: "u0", limit: 0 })).toStrictEqual([]);
});

// An absent `after` id reports the whole branch; an unknown one fails loudly.
test("workflow.entries returns the whole branch when the after id is absent", async () => {
	const entries = [message("u0", "user", "start"), message("a1", "assistant", [{ type: "text", text: "hi" }])];
	const { host } = digestHost(entries);
	expect(((await handle(host, "workflow.entries").execute({})) as unknown[]).length).toBe(2);
});

test("workflow.entries rejects an unknown after id by name", async () => {
	const entries = [message("u0", "user", "start"), message("a1", "assistant", [{ type: "text", text: "hi" }])];
	const { host } = digestHost(entries);
	await expect(handle(host, "workflow.entries").execute({ after: "missing" })).rejects.toThrow(/unknown after id "missing"/);
});

test("workflow.entries rejects a limit that is not a finite non-negative integer", async () => {
	const entries = [message("u0", "user", "start"), message("a1", "assistant", [{ type: "text", text: "hi" }])];
	const { host } = digestHost(entries);
	for (const limit of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, null, "2"]) {
		await expect(handle(host, "workflow.entries").execute({ limit })).rejects.toThrow(/limit must be a non-negative integer/);
	}
});

test("workflow.state reports the newest assistant text across content blocks", async () => {
	const entries: SessionEntry[] = [
		message("a1", "assistant", [{ type: "text", text: "first" }]),
		message("u1", "user", "note"),
		message("a2", "assistant", [
			{ type: "thinking", thinking: "x" },
			{ type: "text", text: "second" },
		]),
	];
	const { host } = digestHost(entries);
	const digest = (await handle(host, "workflow.state").execute()) as Record<string, unknown>;
	expect(digest.lastResponse).toBe("second");
});

async function makeSessionDigest(): Promise<Record<string, unknown>> {
	// `cost` is the host's run-scoped spend projection (workflow/spend.ts composes the
	// live-branch scan with baseline, child-ledger, and classifier rows). The host freezes
	// the pre-run branch by id, so usage appended after host creation is the run's.
	const entries: SessionEntry[] = [message("u0", "user", "hello")];
	const state = createState();
	state.activeNotebookTopic = "runtime";
	state.activeNotebookTopicSource = "agent";
	state.readonlyEnabled = true;
	const { host } = digestHost(entries, state);
	entries.push(message("a1", "assistant", [{ type: "text", text: "answer" }], { usage: usd(0.4) }));
	return (await handle(host, "workflow.state").execute()) as Record<string, unknown>;
}

test("workflow.state reports the session identity and message count", async () => {
	const digest = await makeSessionDigest();
	expect(digest.sessionId).toBe("s1");
	expect(digest.leafId).toBe("a1");
	expect(digest.messageCount).toBe(2);
	expect(digest.contextPercent).toBe(42);
});

test("workflow.state reports the run's committed usage", async () => {
	const digest = await makeSessionDigest();
	expect(digest.cost).toBe(0.4);
	expect(digest.lastResponse).toBe("answer");
});

test("workflow.state reports posture and settled-run accounting", async () => {
	const digest = await makeSessionDigest();
	expect(digest.readonly).toBe(true);
	expect(digest.activeTools).toStrictEqual(["bash", "read"]);
	expect(digest.notebookTopic).toBe("runtime");
	expect(digest.settledRuns, "the digest reports settled runs; none have settled in a fresh host").toBe(0);
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
	expect(digest.lastResponse, "the final assistant text is the digest's only message text").toBe("final answer");
	const json = JSON.stringify(digest);
	expect(json, "no other conversation text crosses into the sandbox").not.toContain(MARKER);
});
