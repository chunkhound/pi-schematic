// WHY: One module derives usage/cost from the run's attributed sources — the settled
// session branch, the child ledger, and classifier calls — behind one accumulator, so
// settled rows and the spend ledger read the same entries and cannot drift.
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import { isSpawnResultDetails, SPAWN_TOOL_NAME, spawnSpendIdentity } from "./spawn/shared.js";
import { stripUnsafeDisplayChars } from "./model-groups/display.js";

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

/** Normalize a provider to null when empty or made only of unsafe display bytes, so a session-less
 * model keeps a bare-model key and control/bidi bytes never reach a rendered row. */
function normalizeProvider(provider: string | null): string | null {
	if (provider === null || provider === "") {
		return null;
	}
	const stripped = stripUnsafeDisplayChars(provider);
	return stripped === "" ? null : stripped;
}

/** Normalize a model name for a spend row: drop control/bidi bytes so a byte-bearing name never
 * splits one model across two rows. */
function normalizeSpendModel(model: string): string {
	return stripUnsafeDisplayChars(model);
}

/** Accumulate one usage record into a model's spend row; the only per-call accumulator. */
export function addModelSpend(map: Map<string, ModelSpend>, provider: string | null, model: string, usage: Usage): void {
	const normProvider = normalizeProvider(provider);
	const normModel = normalizeSpendModel(model);
	const key = spendKey(normProvider, normModel);
	const existing = map.get(key);
	if (existing) {
		accumulateSpend(existing, usageDelta(usage));
		return;
	}
	map.set(key, { key, provider: normProvider, model: normModel, ...usageDelta(usage) });
}

/** Non-empty claim identities for one entry: the entry id if assigned, plus a tool result's
 * tool-call id. Empty ids are never candidates, so a `skip` set containing "" can never
 * suppress a usage-bearing row. This is the single owner of the de-dup rule. */
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

/** Skip exclusion sets for {@link usageByModel}; the two ID domains never cross-suppress. */
export interface UsageByModelOptions {
	/** Entry ids whose usage-bearing entries must be excluded (session-entry domain). */
	skipEntryIds?: ReadonlySet<string>;
	/** Spawn tool-call ids whose child-owned results must be excluded (child-ledger claims). */
	skipSpawnCallIds?: ReadonlySet<string>;
}

/** Whether the exclusion sets own this entry. Entry ids claim any entry; spawn tool-call ids claim
 * only spawn tool results, so a foreign skip key can never suppress an unrelated tool result. */
function isClaimed(entry: SessionEntry, options: UsageByModelOptions | undefined): boolean {
	if (entry.id && options?.skipEntryIds?.has(entry.id) === true) {
		return true;
	}
	if (entry.type === "message" && entry.message.role === "toolResult") {
		const callId = entry.message.toolCallId;
		if (callId && entry.message.toolName === SPAWN_TOOL_NAME && options?.skipSpawnCallIds?.has(callId) === true) {
			return true;
		}
	}
	return false;
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
 *
 * NOTE: skipSpawnCallIds must be derived from rows the sink actually wrote. When a child wrote
 * no row (unreadable settle, a throwing sink, or no subscription), skipping its tool result here
 * drops real spend from the surface, so claim ids only from ledger rows.
 */
export function usageByModel(entries: readonly SessionEntry[], options?: UsageByModelOptions): Map<string, ModelSpend> {
	const map = new Map<string, ModelSpend>();
	for (const entry of entries) {
		if (isClaimed(entry, options)) {
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
	/** Count of usage-bearing entries folded into `usage`; the child ledger's per-child call count. */
	usageEntries: number;
}

/** Fold usage and count assistant turns in a single walk, so callers never traverse twice. */
export function collectSessionAccounting(entries: readonly SessionEntry[]): SessionAccounting {
	let usage = zeroUsage();
	let assistantTurns = 0;
	let usageEntries = 0;
	for (const entry of entries) {
		const entryUsage = usageFromEntry(entry);
		if (entryUsage) {
			usage = addUsage(usage, entryUsage);
			usageEntries += 1;
		}
		if (entry.type === "message" && messageCarriesUsage(entry.message) && entry.message.role === "assistant") {
			assistantTurns += 1;
		}
	}
	return { usage, assistantTurns, usageEntries };
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

/** Settled accounting for one child call, as the sink would receive it. */
export interface SettledChildSpend {
	provider: string | null;
	model: string;
	usage: Usage;
	calls: number;
}

/**
 * Reconcile a child's live spend row against its settled accounting: the readable settled read is
 * authoritative (a stale live snapshot would undercount a run that spent more), and the live row is
 * retained only when settled accounting is unavailable, so a failed settle write never zeroes a real row.
 */
export function reconcileChildSpend(live: ModelSpend | undefined, settled: SettledChildSpend | undefined): ModelSpend | undefined {
	if (!settled) {
		return live;
	}
	const provider = normalizeProvider(settled.provider);
	const model = normalizeSpendModel(settled.model);
	return {
		key: spendKey(provider, model),
		provider,
		model,
		costUsd: settled.usage.cost.total,
		totalTokens: settled.usage.totalTokens,
		inputTokens: settled.usage.input,
		outputTokens: settled.usage.output,
		cacheReadTokens: settled.usage.cacheRead,
		cacheWriteTokens: settled.usage.cacheWrite,
		calls: settled.calls,
	};
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
