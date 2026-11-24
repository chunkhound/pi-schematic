// WHY: One module derives usage/cost from the run's attributed sources — the settled
// session branch, the child ledger, and classifier calls — so the workflow budget and
// the run overview read the same rows and can never drift.
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Narrow `value` to an object record so optional spawn-tool fields can be read safely. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** Accumulate one usage record into a model's spend row; the only per-call accumulator. */
export function addModelSpend(map: Map<string, ModelSpend>, provider: string | null, model: string, usage: Usage): void {
	const key = spendKey(provider, model);
	const existing = map.get(key);
	if (existing) {
		accumulateSpend(existing, usageDelta(usage));
		return;
	}
	map.set(key, { key, provider, model, ...usageDelta(usage) });
}

/** Whether `skip` already owns this entry. Checks the entry id and the tool-call id: the
 * child ledger is keyed by the latter, and a tool result may carry a distinct pi id. An
 * empty entry id is never matched, preserving the fallback to the tool-call id. */
function isClaimed(entry: SessionEntry, skip: ReadonlySet<string>): boolean {
	if (entry.id && skip.has(entry.id)) {
		return true;
	}
	if (entry.type !== "message") {
		return false;
	}
	const toolCallId = entry.message.role === "toolResult" ? entry.message.toolCallId : undefined;
	return toolCallId !== undefined && skip.has(toolCallId);
}

/**
 * Attribute a branch's usage to models. The run's spend rows are this map plus the child
 * ledger and classifier calls. Assistant turns carry provider/model, `usage` entries carry
 * provider/model, and model-less usage (compaction and branch summaries) falls into
 * {@link UNATTRIBUTED_MODEL} with its tokens. Child-owned tool results are skipped so the
 * child ledger is their single owner and a settled child is counted once.
 * Entries whose spend identity (the entry id when pi assigned one, else the tool-call id) is
 * in `skip` are omitted entirely. The run-scoped scan drops pre-run and already-committed
 * entries, and the child ledger claims its tool results, so no entry is counted twice.
 */
export function usageByModel(entries: readonly SessionEntry[], options?: { skip?: ReadonlySet<string> }): Map<string, ModelSpend> {
	const map = new Map<string, ModelSpend>();
	const skip = options?.skip;
	for (const entry of entries) {
		if (skip && isClaimed(entry, skip)) {
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				// pi's assistant message type always carries provider/model, so no fallback is needed.
				addModelSpend(map, message.provider, message.model, message.usage);
			} else if (message.role === "toolResult") {
				const usage = message.usage;
				if (usage) {
					const details = isRecord(message.details) ? message.details : undefined;
					const child = typeof details?.model === "string" ? details.model : undefined;
					const route = isRecord(details?.route) ? details.route : undefined;
					const provider = typeof route?.provider === "string" ? route.provider : undefined;
					addModelSpend(map, provider ?? null, child ?? UNATTRIBUTED_MODEL, usage);
				}
			}
			continue;
		}
		if (entry.type === "usage") {
			addModelSpend(map, entry.provider, entry.model, entry.usage);
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.usage) {
				addModelSpend(map, null, UNATTRIBUTED_MODEL, entry.usage);
			}
		}
	}
	return map;
}

/** Count assistant messages in a branch: each is one model round-trip (a "turn").
 * Excludes tool results and child sessions, which are not parent-conversation model turns. */
export function assistantCount(entries: readonly SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			count += 1;
		}
	}
	return count;
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

/** Shape of pi's whole-session `getSessionStats()` totals; only these fields are read. */
export interface SessionStatsLike {
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	cost?: number;
}

// Frozen: a shared mutable zero would corrupt every future aggregate on accidental mutation.
export const ZERO_USAGE: Usage = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
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

/** Usage carried by one entry: usage entries, summaries, and assistant/tool messages. */
function usageFromEntry(entry: SessionEntry): Usage | null {
	if (entry.type === "usage") {
		return entry.usage;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return entry.usage ?? null;
	}
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant") {
			return message.usage;
		}
		if (message.role === "toolResult") {
			return message.usage ?? null;
		}
	}
	return null;
}

export function collectUsage(entries: readonly SessionEntry[]): Usage {
	return entries.reduce<Usage>((acc, entry) => {
		const usage = usageFromEntry(entry);
		return usage ? addUsage(acc, usage) : acc;
	}, ZERO_USAGE);
}

// Pi exposes whole-session cost as one number; every consumer reads cost.total,
// so the per-component costs stay zero and the total is authoritative.
export function sessionStatsToUsage(stats: SessionStatsLike): Usage {
	return {
		input: stats.tokens?.input ?? 0,
		output: stats.tokens?.output ?? 0,
		cacheRead: stats.tokens?.cacheRead ?? 0,
		cacheWrite: stats.tokens?.cacheWrite ?? 0,
		totalTokens: stats.tokens?.total ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost ?? 0 },
	};
}
