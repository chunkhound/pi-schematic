// WHY: one spend projection feeds the cost limit and the run overview, so these
// tests pin the merge, the exact-threshold crossing, and the overshoot snapshot.
import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChildSpend, ModelSpend } from "../../usage.js";
import { armPendingStop, computeCurrentCost, limitReason, type SpendState } from "../../workflow/spend.js";
import type { WorkflowHostDeps } from "../../workflow/types.js";

function usage(total: number): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}

function row(model: string, costUsd: number): ModelSpend {
	return { key: model, provider: null, model, costUsd, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 };
}

function branchEntry(model: string, costUsd: number, id = model): SessionEntry {
	return { type: "usage", id, provider: null, model, usage: usage(costUsd) } as unknown as SessionEntry;
}

function stubDeps(branch: readonly SessionEntry[], costLimit: number | null = null, timeBudgetMs: number | null = null): WorkflowHostDeps {
	return {
		getCtx: () => ({ sessionManager: { getBranch: () => branch } }),
		limits: { costLimit, timeBudgetMs },
	} as unknown as WorkflowHostDeps;
}

function stateWith(
	branch: readonly SessionEntry[],
	costLimit: number | null = null,
	timeBudgetMs: number | null = null,
	excludedEntryIds: ReadonlySet<string> = new Set(),
): { deps: WorkflowHostDeps; state: SpendState } {
	const deps = stubDeps(branch, costLimit, timeBudgetMs);
	const state: SpendState = {
		baselineSpend: new Map([["base", row("base", 1)]]),
		childSpend: new Map<string, ChildSpend>([["c1", { provider: null, model: "child", usage: usage(3) }]]),
		classifierSpend: new Map([["clf", row("clf", 4)]]),
		excludedEntryIds,
		startedAt: Date.now(),
		pendingStop: null,
		crossedAt: null,
	};
	return { deps, state };
}

test("runSpendRows merges baseline+branch+child+classifier to one total", () => {
	const { deps, state } = stateWith([branchEntry("live", 2)]);
	assert.equal(computeCurrentCost(deps, state), 10);
});

test("limitReason fires exactly at the cost threshold, not below", () => {
	const below = stateWith([branchEntry("live", 1.99)], 10);
	assert.equal(limitReason(below.deps, below.state), null);
	const exact = stateWith([branchEntry("live", 2)], 10);
	assert.equal(limitReason(exact.deps, exact.state), "cost-limit");
});

test("runSpendRows drops pre-run branch entries by id", () => {
	const branch = [branchEntry("pre", 50, "pre-1"), branchEntry("run", 2, "run-1")];
	const { deps, state } = stateWith(branch, null, null, new Set(["pre-1"]));
	assert.equal(computeCurrentCost(deps, state), 10, "prior conversation spend is excluded");

	const { deps: unfilteredDeps, state: unfiltered } = stateWith(branch);
	assert.equal(computeCurrentCost(unfilteredDeps, unfiltered), 60, "without exclusion the prior spend counts");
});

test("a pre-run spend does not trip the run cost limit", () => {
	const branch = [branchEntry("pre", 50, "pre-1"), branchEntry("run", 1, "run-1")];
	const { deps, state } = stateWith(branch, 10, null, new Set(["pre-1"]));
	assert.equal(limitReason(deps, state), null, "prior conversation spend stays outside the run limit");

	const { deps: unfilteredDeps, state: unfiltered } = stateWith(branch, 10);
	assert.equal(limitReason(unfilteredDeps, unfiltered), "cost-limit", "without exclusion the limit trips");
});

test("limitReason fires exactly at the time threshold, not below", () => {
	const now = Date.now();
	const at: SpendState = { baselineSpend: new Map(), childSpend: new Map(), classifierSpend: new Map(), excludedEntryIds: new Set(), startedAt: now - 1_000, pendingStop: null, crossedAt: null };
	assert.equal(limitReason(stubDeps([], null, 1_000), at), "time-limit");
	const fresh: SpendState = { ...at, startedAt: now };
	assert.equal(limitReason(stubDeps([], null, 60_000), fresh), null);
});

test("armPendingStop snapshots crossing values", () => {
	const { deps, state } = stateWith([branchEntry("live", 2)], 10);
	state.startedAt = Date.now() - 500;
	armPendingStop(deps, state, "cost-limit");
	assert.equal(state.pendingStop, "cost-limit");
	assert.equal(state.crossedAt?.costUsd, 10);
	assert.ok((state.crossedAt?.elapsedMs ?? -1) >= 0);
});
