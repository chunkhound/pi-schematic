// SSOT contract: baseline (replaced sessions) + the current branch (with child-owned
// tool results skipped) + the child ledger + classifier spend sum exactly once in the
// run metrics, and a cancelled workflow.new never double-counts.
import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createState, type SchematicState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

const usd = (total: number): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function assistant(id: string, provider: string, model: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "assistant", provider, model, content: [{ type: "text", text: "x" }], timestamp: 0, usage: usd(total) },
	} as SessionEntry;
}

// A settled child's tool result: same model as the ledger, identified by toolCallId.
function childToolResult(id: string, toolCallId: string, provider: string, model: string, total: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		message: { role: "toolResult", toolName: "spawn", toolCallId, content: "child done", timestamp: 0, usage: usd(total), details: { model, route: { provider } } },
	} as unknown as SessionEntry;
}

interface Env {
	deps: WorkflowHostDeps;
	state: SchematicState;
	branch: SessionEntry[];
	ctx: ExtensionCommandContext;
	failNew: boolean;
}

function createEnv(): Env {
	const state = createState();
	const branch: SessionEntry[] = [];
	const classifierModel = { id: "jev", provider: "typesafe" };
	const pi = {
		on: () => () => {},
		getCommands: () => [],
		sendUserMessage: () => {},
		appendEntry: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	const ctx = {
		abort: () => {},
		cwd: "/workspace",
		model: undefined,
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => (branch.length ? branch[branch.length - 1].id : null),
			getBranch: () => branch,
		},
		getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
		modelRegistry: {
			getModelsOfType: () => [classifierModel],
			getModelOfType: () => undefined,
			classify: async () => ({
				api: "system-one",
				provider: "typesafe",
				model: "jev",
				answers: {},
				usage: usd(0.25),
				stopReason: "stop",
				timestamp: 0,
			}),
		},
	} as unknown as ExtensionCommandContext;
	const env: Env = { deps: null as unknown as WorkflowHostDeps, state, branch, ctx, failNew: false };
	env.deps = {
		pi: pi as unknown as ExtensionAPI,
		state,
		limits: { costLimit: null, timeBudgetMs: null },
		getCtx: () => ctx,
		isReadonly: () => false,
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		// Replacement clears the settled branch; a cancelled replacement throws instead.
		newSession: async () => {
			if (env.failNew) throw new Error("new session was cancelled");
			branch.length = 0;
		},
	};
	return env;
}

async function call(host: WorkflowHost, member: string, args: unknown): Promise<unknown> {
	const tool = host.globals().find((candidate) => candidate.name === `workflow.${member}`);
	assert.ok(tool, `missing handle workflow.${member}`);
	return tool.execute(args, { signal: host.signal });
}

function spendSum(host: WorkflowHost): number {
	return host.metrics().spend.reduce((total, row) => total + row.costUsd, 0);
}

test("baseline + branch + child ledger + classifier spend sums exactly once", async () => {
	const env = createEnv();
	env.branch.push(assistant("a0", "anthropic", "opus", 0.5));
	const host = createWorkflowHost(env.deps);
	// A child reports cumulative stats through the run sink; the same spend later lands
	// on the branch as its tool result and must be skipped, not counted twice.
	env.state.childUsageSink!("c1", "anthropic", "widget", usd(0.3));
	env.branch.push(childToolResult("tr1", "c1", "anthropic", "widget", 0.3));
	await call(host, "classify", { model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} });
	await call(host, "new", undefined);
	const metrics = host.metrics();
	assert.ok(Math.abs(metrics.costUsd - 1.05) < 1e-9, "baseline 0.5 + child 0.3 + classifier 0.25");
	assert.ok(Math.abs(spendSum(host) - metrics.costUsd) < 1e-9, "spend rows sum to the total once");
	assert.equal(metrics.costUsd, metrics.spend.reduce((total, row) => total + row.costUsd, 0));
	const byKey = Object.fromEntries(metrics.spend.map((row) => [row.key, row.costUsd]));
	assert.equal(byKey["anthropic/opus"], 0.5);
	assert.equal(byKey["anthropic/widget"], 0.3, "child ledger owns the child's spend");
	assert.equal(byKey["typesafe/jev"], 0.25);
});

test("a cancelled workflow.new counts the unchanged branch and child once", async () => {
	const env = createEnv();
	env.branch.push(assistant("a0", "anthropic", "opus", 0.5));
	const host = createWorkflowHost(env.deps);
	env.state.childUsageSink!("c1", "anthropic", "widget", usd(0.3));
	env.branch.push(childToolResult("tr1", "c1", "anthropic", "widget", 0.3));
	await call(host, "classify", { model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} });
	env.failNew = true;
	await assert.rejects(() => call(host, "new", undefined), /cancelled/);
	const metrics = host.metrics();
	assert.ok(Math.abs(metrics.costUsd - 1.05) < 1e-9, "no baseline committed on top of the unchanged branch");
	assert.ok(Math.abs(spendSum(host) - metrics.costUsd) < 1e-9, "spend rows sum to the total once");
	assert.equal(metrics.costUsd, metrics.spend.reduce((total, row) => total + row.costUsd, 0));
	assert.deepEqual(metrics.spend.map((row) => row.key).sort(), ["anthropic/opus", "anthropic/widget", "typesafe/jev"].sort());
});
