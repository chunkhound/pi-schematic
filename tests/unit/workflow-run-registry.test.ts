import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, SessionEntry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { createState, type SchematicState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import { createRunRegistry, matchRun, resolveRunTarget } from "../../workflow/run-registry.js";
import type { WorkflowHostDeps } from "../../workflow/types.js";
import { createTestHost, type TestPI } from "./test-host.js";

const commands = [
	{ name: "review", source: "prompt", sourceInfo: {} },
	{ name: "skill:execute", source: "skill", sourceInfo: {} },
	{ name: "danger", source: "extension", sourceInfo: {} },
] as unknown as SlashCommandInfo[];

test("resolveRunTarget keeps prompt templates and normalizes skills to skill:<name>", () => {
	assert.deepEqual(resolveRunTarget(commands, "/review"), { text: "/review", source: "prompt" });
	assert.deepEqual(resolveRunTarget(commands, "/execute"), { text: "/skill:execute", source: "skill" });
	assert.deepEqual(resolveRunTarget(commands, "execute"), { text: "/skill:execute", source: "skill" });
	assert.deepEqual(resolveRunTarget(commands, "/skill:execute"), { text: "/skill:execute", source: "skill" });
});

test("resolveRunTarget rejects extension commands", () => {
	assert.throws(() => resolveRunTarget(commands, "/danger"), /extension command/);
});

// WHY: a slashless name followed by arguments is prose (`run("review the diff")`), not a command;
// only an explicit `/name` or a bare name selects the command/skill target.
test("resolveRunTarget treats a slashless prompt with arguments as prose", () => {
	assert.deepEqual(resolveRunTarget(commands, "review the diff"), { text: "review the diff", source: "plain" });
	assert.deepEqual(resolveRunTarget(commands, "execute the plan"), { text: "execute the plan", source: "plain" });
	assert.deepEqual(resolveRunTarget(commands, "execute"), { text: "/skill:execute", source: "skill" });
	assert.deepEqual(resolveRunTarget(commands, "/execute"), { text: "/skill:execute", source: "skill" });
});

test("resolveRunTarget preserves embedded newlines in prose", () => {
	assert.deepEqual(resolveRunTarget(commands, "execute\nthe plan"), { text: "execute\nthe plan", source: "plain" });
	assert.deepEqual(resolveRunTarget(commands, "step one\nstep two"), { text: "step one\nstep two", source: "plain" });
});

test("resolveRunTarget leaves unknown prompts as plain text and preserves inline arguments", () => {
	assert.deepEqual(resolveRunTarget(commands, "just a prompt"), { text: "just a prompt", source: "plain" });
	assert.deepEqual(resolveRunTarget(commands, "/review foo bar"), { text: "/review foo bar", source: "prompt" });
	assert.deepEqual(resolveRunTarget(commands, "/unknown x"), { text: "/unknown x", source: "plain" });
});

function message(id: string, role: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: { role, content: "", timestamp: 0 },
	} as SessionEntry;
}

test("matchRun includes the complete settled run after the marker", () => {
	const branch = [message("u0", "user"), message("a1", "assistant"), message("t1", "toolResult"), message("a2", "assistant")];
	assert.deepEqual(matchRun(branch, "u0"), { fromEntryId: "a1", toEntryId: "a2", branch: branch.slice(1) });
	assert.deepEqual(matchRun(branch, null)?.toEntryId, "a2");
	assert.equal(matchRun(branch, "missing"), null);
});

test("pending correlation resolves when the branch settles", async () => {
	let settle: (() => void) | undefined;
	const registry = createRunRegistry({
		onSettled: (listener) => {
			settle = listener;
			return () => {};
		},
		getBranch: () => [message("a1", "assistant")],
	});
	const pending = registry.correlate(null);
	settle?.();
	const match = await pending.promise;
	assert.equal(match.toEntryId, "a1");
	registry.dispose();
});

test("registry disposal rejects pending correlations and removes the settled listener", async () => {
	let removed = 0;
	const registry = createRunRegistry({
		onSettled: () => () => { removed += 1; },
		getBranch: () => [],
	});
	const pending = registry.correlate(null);
	registry.dispose();
	await assert.rejects(pending.promise, /disposed/);
	registry.dispose();
	assert.equal(removed, 1);
});

test("matchRun returns null until an assistant entry appears after the marker", () => {
	const branch = [message("u0", "user"), message("t1", "toolResult")];
	assert.equal(matchRun(branch, "u0"), null);
	assert.equal(matchRun(branch, "missing"), null);
});

// ── Host lifecycle: the registry is disposed with its host ──────────────
// WHY: `disposeHost` (workflow/host.ts) clears the child-usage sink and disposes the registry
// as two independent steps, so a null sink is not evidence about the registry. These tests pin
// the registry step through the real host lifecycle on pi's real event bus.

/** Host deps over a shared state and branch; only the registry seams matter here. */
function lifecycleDeps(pi: TestPI, state: SchematicState, branch: SessionEntry[]): WorkflowHostDeps {
	const ctx = { sessionManager: { getSessionId: () => "lifecycle", getLeafId: () => null, getBranch: () => branch } } as unknown as ExtensionCommandContext;
	return {
		pi,
		state,
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: () => ctx,
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
}

/** Live `agent_settled` subscribers on pi's real bus, and the way to drive one. */
function settleListeners(pi: TestPI): Array<() => void> {
	return pi.handlers.get("agent_settled") ?? [];
}

function settle(pi: TestPI): void {
	for (const handler of [...settleListeners(pi)]) handler();
}

// WHY: a missing `state.registry.dispose()` leaves the pending correlation promise
// unrejected, so the assertion below would hang forever without a timeout. 5 s is
// far above the normal ~1 ms dispose path and short enough to fail fast in CI.
function rejectsWithin(promise: Promise<unknown>, pattern: RegExp, message?: string): Promise<void> {
	return assert.rejects(Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for rejection")), 5000)),
	]), pattern, message);
}

test("host disposal disposes its registry and the next host correlates on a fresh one", async () => {
	const pi = await createTestHost(() => {});
	const branch: SessionEntry[] = [];
	const first = createWorkflowHost(lifecycleDeps(pi, createState(), branch));
	const pending = first.registry.correlate(null);
	assert.equal(settleListeners(pi).length, 1, "the first correlate subscribes on pi's real event bus");

	first.dispose();
	await rejectsWithin(pending.promise, /disposed/, "host disposal must release the pending correlation");
	assert.equal(settleListeners(pi).length, 0, "host disposal must unsubscribe the registry's settle listener");

	const second = createWorkflowHost(lifecycleDeps(pi, createState(), branch));
	assert.notEqual(second.registry, first.registry, "a new run owns a fresh registry, never the disposed one");
	branch.push(message("a1", "assistant"));
	const resolved = second.registry.correlate(null);
	settle(pi);
	assert.equal((await resolved.promise).toEntryId, "a1", "the fresh registry resolves like any other");
	second.dispose();
});

// WHY: the sink identity guard lets a newer host keep its sink while an older host is disposed,
// yet the older host's registry disposal is unconditional. A bug that cleared the sink and
// skipped `registry.dispose()` would pass every sink-based check and fail this one.
test("host disposal releases the registry even when a newer host owns the sink", async () => {
	const pi = await createTestHost(() => {});
	const state = createState();
	const branch: SessionEntry[] = [];
	const first = createWorkflowHost(lifecycleDeps(pi, state, branch));
	const pending = first.registry.correlate(null);
	const second = createWorkflowHost(lifecycleDeps(pi, state, branch));

	first.dispose();
	assert.notEqual(state.childUsageSink, null, "the newer host keeps its sink: a cleared sink is not the disposal signal");
	await rejectsWithin(pending.promise, /disposed/, "the older host still disposes its own registry");
	second.dispose();
});
