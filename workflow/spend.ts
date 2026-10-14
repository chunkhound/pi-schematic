// WHY: one spend projection feeds the cost limit and the run overview, so they cannot diverge.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { childSpendRows, mergeModelSpend, spendRowsTotal, usageByModel, type ChildSpend, type ModelSpend } from "../usage.js";
import type { ReservedReason, WorkflowHostDeps } from "./types.js";

/** Minimal spend slice of the host state; the host's state extends this. */
export interface SpendState {
	baselineSpend: Map<string, ModelSpend>;
	childSpend: Map<string, ChildSpend>;
	classifierSpend: Map<string, ModelSpend>;
	/** Branch entry identities the run scan must not count: the pre-run conversation and
	 * entries already folded into the baseline (see `branchSpend`). */
	excludedEntryIds: ReadonlySet<string>;
	/** Monotonic revision of the four spend sources. The projection cache keys on it, so a
	 * write that skips `bumpSpendRevision` can serve stale rows and miss a cost limit. */
	spendRevision: number;
	/** Last projection, keyed on session + leaf + revision; null until the first read. */
	spendCache: SpendCache | null;
	startedAt: number;
	pendingStop: ReservedReason | null;
	crossedAt: { costUsd: number; elapsedMs: number } | null;
}

/** Projection cache key. The branch is append-only, so a session or leaf move is the only
 * structural change; `revision` covers ledger/source writes that leave the branch untouched. */
interface SpendCache {
	sessionId: string | null;
	leafId: string | null;
	revision: number;
	rows: Map<string, ModelSpend>;
}

/** Advance the source revision. Call after ANY write to baselineSpend, childSpend,
 * classifierSpend, or excludedEntryIds; the revision guard in `runSpendRows` is the
 * correctness backstop, so a missed bump would let a cost limit read a stale projection. */
export function bumpSpendRevision(state: Pick<SpendState, "spendRevision">): void {
	state.spendRevision += 1;
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
	return usageByModel(liveBranch(deps), { skip: spendClaims(state) });
}

/** Identity set the run-scoped branch scan must skip: entries already committed to the
 * baseline, plus the tool-call ids the child ledger owns. */
function spendClaims(state: Pick<SpendState, "childSpend" | "excludedEntryIds">): ReadonlySet<string> {
	return new Set([...state.excludedEntryIds, ...state.childSpend.keys()]);
}

/**
 * Authoritative run spend rows: usage from run start onward. Baseline (replaced sessions)
 * plus the current branch (pre-run conversation dropped, child-owned tool results excluded)
 * plus the child ledger that owns them plus classifier calls. One projection feeds both the
 * cost limit and the run overview, so they cannot diverge.
 *
 * Cached on session + leaf + source revision: repeat cost checks skip the O(entries) branch
 * scan, and any real spend move (new entry, ledger write, classifier call, baseline commit)
 * misses the cache. `limitReason` therefore never reads a stale projection.
 */
export function runSpendRows(deps: WorkflowHostDeps, state: SpendState): Map<string, ModelSpend> {
	const ctx = deps.getCtx();
	const sessionId = ctx?.sessionManager.getSessionId() ?? null;
	const leafId = ctx?.sessionManager.getLeafId() ?? null;
	const cached = state.spendCache;
	if (cached && cached.sessionId === sessionId && cached.leafId === leafId && cached.revision === state.spendRevision)
		return cached.rows;
	const rows = projectRunSpend(deps, state);
	state.spendCache = { sessionId, leafId, revision: state.spendRevision, rows };
	return rows;
}

/** Full rescan of the four spend sources; the single reader is `runSpendRows`. */
function projectRunSpend(deps: WorkflowHostDeps, state: SpendState): Map<string, ModelSpend> {
	return mergeModelSpend(state.baselineSpend, branchSpend(deps, state), childSpendRows(state.childSpend), state.classifierSpend);
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
