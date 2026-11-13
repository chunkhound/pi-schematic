/** Minimum estimated context size required before a handoff compaction is useful. */
export const MIN_HANDOFF_TOKENS = 30_000;

export type HandoffContextUsage = {
	tokens?: number | null;
	percent?: number | null;
	contextWindow?: number | null;
} | null | undefined;

function isFiniteNonNegative(value: number | null | undefined): value is number {
	return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Return finite non-negative platform percentages, including overflow usage. */
export function normalizeContextPercent(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** Estimate session tokens from exact usage or percentage/context-window data. */
export function estimateHandoffContextTokens(usage: HandoffContextUsage): number | null {
	if (!usage) {return null;}
	if (usage.tokens !== null && usage.tokens !== undefined) {
		return isFiniteNonNegative(usage.tokens) ? usage.tokens : null;
	}
	const percent = normalizeContextPercent(usage.percent);
	if (percent === null || !isFiniteNonNegative(usage.contextWindow) || usage.contextWindow === 0) {
		return null;
	}
	const estimated = (usage.contextWindow * percent) / 100;
	return Number.isFinite(estimated) ? estimated : null;
}

/** Return whether usage meets the minimum handoff compaction threshold. */
export function isHandoffEligible(usage: HandoffContextUsage): boolean {
	const tokens = estimateHandoffContextTokens(usage);
	return tokens !== null && tokens >= MIN_HANDOFF_TOKENS;
}

/** Format exact or estimated usage for user-facing handoff errors. */
export function formatHandoffContextUsage(usage: HandoffContextUsage): string {
	if (isFiniteNonNegative(usage?.tokens)) {return `${usage.tokens} tokens`;}
	const estimated = estimateHandoffContextTokens(usage);
	return `~${estimated === null ? "unknown" : Math.round(estimated)} tokens estimated from context usage`;
}
