// WHY: one spend projection feeds the cost limit and the run overview, so they cannot diverge.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { childSpendRows, mergeModelSpend, spendRowsTotal, usageByModel, type ChildSpend, type ModelSpend } from "../usage.js";
import type { ReservedReason, WorkflowHostDeps } from "./types.js";

/** Minimal spend slice of the host state; the host's state extends this. */
export interface SpendState {
	baselineSpend: Map<string, ModelSpend>;
	childSpend: Map<string, ChildSpend>;
	classifierSpend: Map<string, ModelSpend>;
	/** Branch entry ids that predate the run; the run-scoped scan drops them. */
	excludedEntryIds: ReadonlySet<string>;
	startedAt: number;
	pendingStop: ReservedReason | null;
	crossedAt: { costUsd: number; elapsedMs: number } | null;
}

// WHY: getCtx() is null only during a session replacement gap. The gap is expected and
// transient, and this path runs on every cost check, so logging here would flood the
// transcript. Spend rows exclude the live branch's uncommitted usage; the partial sum
// (baseline + child ledger + classifier) still stands.
export function liveBranch(deps: WorkflowHostDeps): readonly SessionEntry[] {
	const ctx = deps.getCtx();
	if (ctx) return ctx.sessionManager.getBranch();
	return [];
}

/** Live-branch spend via a direct usageByModel scan per call; no cache. */
export function branchSpend(deps: WorkflowHostDeps, state: Pick<SpendState, "childSpend" | "excludedEntryIds">): Map<string, ModelSpend> {
	return usageByModel(liveBranch(deps), {
		skipToolCalls: new Set(state.childSpend.keys()),
		skipEntries: state.excludedEntryIds,
	});
}

/**
 * Authoritative run spend rows: usage from run start onward. Baseline (replaced sessions)
 * plus the current branch (pre-run conversation dropped, child-owned tool results excluded)
 * plus the child ledger that owns them plus classifier calls. One projection feeds both the
 * cost limit and the run overview, so they cannot diverge.
 */
export function runSpendRows(deps: WorkflowHostDeps, state: SpendState): Map<string, ModelSpend> {
	return mergeModelSpend(
		state.baselineSpend,
		branchSpend(deps, state),
		childSpendRows(state.childSpend),
		state.classifierSpend,
	);
}

export function computeCurrentCost(deps: WorkflowHostDeps, state: SpendState): number {
	return spendRowsTotal(runSpendRows(deps, state));
}

/** The target the run has crossed, or null. Both targets cross against their exact threshold — no early grace.
 * No finite guard on either side: every producer (limits-dialog flags, presets, custom input) emits a finite positive. */
export function limitReason(deps: WorkflowHostDeps, state: SpendState): ReservedReason | null {
	const costLimit = deps.limits.costLimit;
	if (costLimit !== null && computeCurrentCost(deps, state) >= costLimit) return "cost-limit";
	const budget = deps.limits.timeBudgetMs;
	if (budget !== null && Date.now() - state.startedAt >= budget) return "time-limit";
	return null;
}

/** Arm a soft stop and snapshot the crossing values for the overview's overshoot forensics. */
export function armPendingStop(deps: WorkflowHostDeps, state: SpendState, reason: ReservedReason): void {
	state.pendingStop = reason;
	state.crossedAt = { costUsd: computeCurrentCost(deps, state), elapsedMs: Date.now() - state.startedAt };
}
