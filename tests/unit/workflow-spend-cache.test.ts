// WHY: the run-spend projection is cached, so a stale read could hide a cost limit. These
// tests move each spend source through its real host path (branch, child ledger, classifier,
// baseline commit) and prove the projection follows every move.
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

interface Env {
	deps: WorkflowHostDeps;
	state: SchematicState;
	branch: SessionEntry[];
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
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
		},
		getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
		modelRegistry: {
			getModelsOfType: () => [classifierModel],
			getModelOfType: () => undefined,
			classify: async () => ({ api: "system-one", provider: "typesafe", model: "jev", answers: {}, usage: usd(0.25), stopReason: "stop", timestamp: 0 }),
		},
	} as unknown as ExtensionCommandContext;
	const env: Env = { deps: null as unknown as WorkflowHostDeps, state, branch };
	env.deps = {
		pi: pi as unknown as ExtensionAPI,
		state,
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: () => ctx,
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		// Replacement clears the settled branch, mirroring a real workflow.new.
		newSession: async () => {
			branch.length = 0;
		},
	};
	return env;
}

function call(host: WorkflowHost, member: string, args: unknown): Promise<unknown> {
	const tool = host.globals().find((candidate) => candidate.name === `workflow.${member}`);
	assert.ok(tool, `missing handle workflow.${member}`);
	return tool.execute(args, { signal: host.signal }) as Promise<unknown>;
}

const cost = (host: WorkflowHost): number => host.metrics().costUsd;
const close = (actual: number, expected: number, message: string): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: got ${actual}, want ${expected}`);

test("the cached run projection follows every spend source move", async () => {
	const env = createEnv();
	const host = createWorkflowHost(env.deps);

	// (a) a new branch entry moves the leaf
	env.branch.push(assistant("a1", "anthropic", "opus", 0.5));
	close(cost(host), 0.5, "new branch entry");
	// Two reads with no source move agree on the cached rows.
	close(cost(host), 0.5, "unchanged leaf reuses the projection");

	// (b) a child-ledger row writes no branch entry, so only the revision can invalidate
	env.state.childUsageSink!("c1", "anthropic", "widget", usd(0.25));
	close(cost(host), 0.75, "child-ledger row");

	// (c) a classifier call also writes no branch entry
	await call(host, "classify", { model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} });
	close(cost(host), 1.0, "classifier call");

	// (a') a second branch entry moves the leaf again
	env.branch.push(assistant("a2", "anthropic", "opus", 0.5));
	close(cost(host), 1.5, "second branch entry");

	// (d) a baseline commit via workflow.new replaces the branch source
	await call(host, "new", undefined);
	close(cost(host), 1.5, "baseline commit carries the committed spend after the branch clears");
	assert.deepEqual(host.metrics().spend.map((row) => row.key).sort(), ["anthropic/opus", "anthropic/widget", "typesafe/jev"].sort());
});

// WHY: the child ledger is keyed per tool call; same-model children must merge into one row
// with one call each, or the overview double-counts or hides a child.
test("the child ledger merges same-model children into one row with one call each", () => {
	const env = createEnv();
	const host = createWorkflowHost(env.deps);
	env.state.childUsageSink!("c1", "anthropic", "widget", usd(0.25));
	env.state.childUsageSink!("c2", "anthropic", "widget", usd(0.2));
	close(cost(host), 0.45, "two child rows");
	const widget = host.metrics().spend.find((row) => row.key === "anthropic/widget");
	assert.equal(widget?.calls, 2, "one call per child");
});

// WHY: workflow.new replaces the branch. Pruning keeps the exclusion set proportional to
// the live branch, so an id that is gone no longer suppresses its spend.
test("pruneExclusions keeps only ids still present in the branch", () => {
	const env = createEnv();
	env.branch.push(assistant("a1", "anthropic", "opus", 0.5), assistant("a2", "anthropic", "opus", 0.25));
	const host = createWorkflowHost(env.deps);
	close(cost(host), 0, "both entries start excluded as the pre-run branch");
	host.pruneExclusions(new Set(["a2"]));
	close(cost(host), 0.5, "the pruned id becomes live spend; the retained id stays excluded");
});
