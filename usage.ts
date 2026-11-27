// WHY: One module derives usage/cost from the run's attributed sources — the settled
// session branch, the child ledger, and classifier calls — so the workflow budget and
// the run overview read the same rows and can never drift.
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import { isSpawnResultDetails, SPAWN_TOOL_NAME, spawnSpendIdentity } from "./spawn/shared.js";

/** Bucket for usage pi records without a model: compaction and branch summaries. */
export const UNATTRIBUTED_MODEL = "unattributed";

/** One model's share of a session's spend; the run overview renders exactly these rows. */
export interface ModelSpend {
	/** `provider/model`, or {@link UNATTRIBUTED_MODEL} when no entry names a model. */
	key: string;
	provider: string | null;
	model: string;
	costUsd: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Usage-bearing entries attributed to this model. */
	calls: number;
}

function spendKey(provider: string | null, model: string): string {
	return provider !== null ? `${provider}/${model}` : model;
}

/** Additive fields of one spend row; the single accumulator both usage paths share. */
type SpendDelta = Pick<ModelSpend, "costUsd" | "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "calls">;

function accumulateSpend(existing: ModelSpend, delta: SpendDelta): void {
	existing.costUsd += delta.costUsd;
	existing.totalTokens += delta.totalTokens;
	existing.inputTokens += delta.inputTokens;
	existing.outputTokens += delta.outputTokens;
	existing.cacheReadTokens += delta.cacheReadTokens;
	existing.cacheWriteTokens += delta.cacheWriteTokens;
	existing.calls += delta.calls;
}

function usageDelta(usage: Usage): SpendDelta {
	return {
		costUsd: usage.cost.total,
		totalTokens: usage.totalTokens,
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		calls: 1,
	};
}

/** Normalize an empty provider to null so a session-less model keeps a bare-model key. */
function normalizeProvider(provider: string | null): string | null {
	return provider === "" ? null : provider;
}

/** Accumulate one usage record into a model's spend row; the only per-call accumulator. */
export function addModelSpend(map: Map<string, ModelSpend>, provider: string | null, model: string, usage: Usage): void {
	const normProvider = normalizeProvider(provider);
	const key = spendKey(normProvider, model);
	const existing = map.get(key);
	if (existing) {
		accumulateSpend(existing, usageDelta(usage));
		return;
	}
	map.set(key, { key, provider: normProvider, model, ...usageDelta(usage) });
}

/** Non-empty claim identities for one entry: the entry id pi assigned, plus a tool result's
 * tool-call id. Empty ids are never candidates, so a `skip` set containing "" can never
 * suppress a usage-bearing row. This is the single owner of the claim rule. */
function claimIds(entry: SessionEntry): string[] {
	const ids = entry.id ? [entry.id] : [];
	if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId) {
		ids.push(entry.message.toolCallId);
	}
	return ids;
}

/** Primary de-dup identity for a usage-bearing entry: the entry id, else the tool-call id. */
export function spendIdentity(entry: SessionEntry): string | null {
	return claimIds(entry)[0] ?? null;
}

/** Whether `skip` already owns this entry: any of its non-empty claim identities, including
 * a tool result's tool-call id even when a distinct entry id is present. */
function isClaimed(entry: SessionEntry, skip: ReadonlySet<string>): boolean {
	return claimIds(entry).some((id) => skip.has(id));
}

/**
 * Attribute a branch's usage to models. Which entries carry usage and how much comes from
 * {@link usageFromEntry}, the single decision rows and totals share, so a new usage-bearing
 * kind cannot fold one path and not the other. Attribution (the provider/model row) is
 * resolved only when building a row, never during amount walks. Child-owned tool results
 * are skipped so the child ledger is their single owner and a settled child is counted once.
 * An entry is omitted when `skip` owns its non-empty entry id or, for a tool result, its
 * tool-call id. The run-scoped scan drops pre-run and already-committed entries, and the
 * child ledger claims its tool results, so no entry is counted twice.
 */
export function usageByModel(entries: readonly SessionEntry[], options?: { skip?: ReadonlySet<string> }): Map<string, ModelSpend> {
	const map = new Map<string, ModelSpend>();
	const skip = options?.skip;
	for (const entry of entries) {
		if (skip && isClaimed(entry, skip)) {
			continue;
		}
		const usage = usageFromEntry(entry);
		if (!usage) {
			continue;
		}
		const { provider, model } = entryAttribution(entry);
		addModelSpend(map, provider, model, usage);
	}
	return map;
}

/** One pass over entries: total usage and assistant-turn count; the shared walk. */
export interface SessionAccounting {
	usage: Usage;
	assistantTurns: number;
}

/** Fold usage and count assistant turns in a single walk, so callers never traverse twice. */
export function collectSessionAccounting(entries: readonly SessionEntry[]): SessionAccounting {
	let usage = zeroUsage();
	let assistantTurns = 0;
	for (const entry of entries) {
		const entryUsage = usageFromEntry(entry);
		if (entryUsage) {
			usage = addUsage(usage, entryUsage);
		}
		if (entry.type === "message" && messageCarriesUsage(entry.message) && entry.message.role === "assistant") {
			assistantTurns += 1;
		}
	}
	return { usage, assistantTurns };
}

/** Count assistant messages in a branch: each is one model round-trip (a "turn"). */
export function assistantCount(entries: readonly SessionEntry[]): number {
	return collectSessionAccounting(entries).assistantTurns;
}

/** Fold spend rows from several sources into one new map; never mutates its inputs. */
export function mergeModelSpend(...maps: ReadonlyMap<string, ModelSpend>[]): Map<string, ModelSpend> {
	const merged = new Map<string, ModelSpend>();
	for (const map of maps) {
		for (const spend of map.values()) {
			const existing = merged.get(spend.key);
			if (!existing) {
				merged.set(spend.key, { ...spend });
				continue;
			}
			accumulateSpend(existing, spend);
		}
	}
	return merged;
}

/** Total USD of a spend map. The run's cost is always this sum, never a parallel snapshot. */
export function spendRowsTotal(rows: ReadonlyMap<string, ModelSpend>): number {
	let total = 0;
	for (const row of rows.values()) {
		total += row.costUsd;
	}
	return total;
}

/** Fresh zero Usage; the sole zero producer. */
export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Frozen compat stand-in for the removed singleton; consumers must treat it as read-only.
// Prefer zeroUsage() for a fresh copy so an accidental mutation never corrupts a shared zero.
export const ZERO_USAGE: Usage = Object.freeze(zeroUsage());

/**
 * Mirrors pi-coding-agent's unexported combineUsage: the optional token splits appear only
 * once some usage reports them. A Pi upgrade that changes the usage fields must update this;
 * one that changes the entry kinds carrying usage updates usageFromEntry — the single decision
 * every usage surface shares. The parity test "real child usage matches the session stats across
 * assistant, tool result, usage, compaction and branch-summary entries" checks both against Pi.
 */
export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) } : {}),
		...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/** Whether a message carries usage: assistant turns and tool results do, so user/system/custom ends fold nothing. */
export function messageCarriesUsage(message: { role: string }): message is { role: "assistant" | "toolResult"; usage?: Usage } {
	return message.role === "assistant" || message.role === "toolResult";
}

/** Usage carried by one entry; never reads attribution metadata (provider/model/route), so totals
 * cannot depend on spawn details.route accessors. */
function usageFromEntry(entry: SessionEntry): Usage | null {
	if (entry.type === "usage") {
		return entry.usage;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return entry.usage ?? null;
	}
	if (entry.type === "message" && messageCarriesUsage(entry.message)) {
		return entry.message.usage ?? null;
	}
	return null;
}

/** Effective provider/model of an assistant message: responseModel is what actually ran, model the
 * fallback, so spend follows the resolved model the parent would attribute to the same row. */
export function assistantSpendIdentity(message: { provider?: string; model: string; responseModel?: string }): { provider: string | null; model: string } {
	return { provider: message.provider ?? null, model: message.responseModel ?? message.model };
}

/** Where a usage-bearing entry's spend row keys: provider/model, resolved only when building a row.
 * A hostile details getter (e.g. a throwing route accessor) degrades to unattributed. */
function entryAttribution(entry: SessionEntry): { provider: string | null; model: string } {
	if (entry.type === "usage") {
		return { provider: entry.provider, model: entry.model };
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { provider: null, model: UNATTRIBUTED_MODEL };
	}
	if (entry.type !== "message") {
		return { provider: null, model: UNATTRIBUTED_MODEL };
	}
	const message = entry.message;
	if (message.role === "assistant") {
		// The provider may answer under a model other than requested; responseModel is the
		// effective model and model the fallback, so spend follows what actually ran.
		return assistantSpendIdentity(message);
	}
	// Only a spawned child's result carries a model identity; an unrelated tool's free-form
	// details must not claim a provider/model spend row. The effective model (details.model)
	// is authoritative, so group aliases that resolve to one model share that row.
	if (message.role === "toolResult") {
		if (message.toolName === SPAWN_TOOL_NAME) {
			try {
				if (isSpawnResultDetails(message.details)) {
					const spend = spawnSpendIdentity(message.details);
					if (spend) {
						return { provider: spend.provider, model: spend.model };
					}
				}
			} catch {
				// Degrade to unattributed; the amount walk never reads these accessors.
			}
		}
	}
	return { provider: null, model: UNATTRIBUTED_MODEL };
}

export function collectUsage(entries: readonly SessionEntry[]): Usage {
	return collectSessionAccounting(entries).usage;
}

/**
 * @deprecated Tightened alias of pi's {@link SessionStats}: every field is required, so a
 * partial stats object no longer compiles. Use SessionStats directly; there are no fallbacks.
 */
export type SessionStatsLike = SessionStats;

// Pi exposes whole-session cost as one number, so only cost.total is authoritative; the
// per-component costs stay zero by design and addUsage preserves them as-is.
export function sessionStatsToUsage(stats: SessionStats): Usage {
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
	};
}
