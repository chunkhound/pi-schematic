import { expect, test } from "vitest";
import fc from "fast-check";
import {
	estimateHandoffContextTokens,
	formatHandoffContextUsage,
	isHandoffEligible,
	MIN_HANDOFF_TOKENS,
	normalizeContextPercent,
} from "../../handoff/eligibility.js";

test("handoff eligibility prefers explicit tokens", () => {
	expect(estimateHandoffContextTokens({ tokens: MIN_HANDOFF_TOKENS, percent: 1, contextWindow: 1 })).toBe(MIN_HANDOFF_TOKENS);
	expect(isHandoffEligible({ tokens: MIN_HANDOFF_TOKENS })).toBe(true);
	expect(isHandoffEligible({ tokens: MIN_HANDOFF_TOKENS - 1 })).toBe(false);
});

test("handoff eligibility estimates tokens from percent and context window", () => {
	expect(estimateHandoffContextTokens({ tokens: null, percent: 15, contextWindow: 200_000 })).toBe(30_000);
	expect(isHandoffEligible({ tokens: null, percent: 15.001, contextWindow: 200_000 })).toBe(true);
	expect(isHandoffEligible({ tokens: null, percent: 125, contextWindow: 200_000 })).toBe(true);
	expect(isHandoffEligible({ tokens: null, percent: 14.9, contextWindow: 200_000 })).toBe(false);
	expect(estimateHandoffContextTokens({ tokens: null, percent: 14.9999, contextWindow: 200_000 })).toBe(29_999.8);
	expect(isHandoffEligible({ tokens: null, percent: 14.9999, contextWindow: 200_000 })).toBe(false);
});

test("context percentage normalization accepts finite non-negative usage, including overflow", () => {
	expect(normalizeContextPercent(0)).toBe(0);
	expect(normalizeContextPercent(100)).toBe(100);
	expect(normalizeContextPercent(125)).toBe(125);
	for (const percent of [-1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
		expect(normalizeContextPercent(percent)).toBe(null);
	}
});

test("handoff eligibility rejects malformed or unestimable usage", () => {
	for (const usage of [
		null,
		{ tokens: Number.NaN },
		{ tokens: -1 },
		{ tokens: null, percent: Number.NaN, contextWindow: 200_000 },
		{ tokens: null, percent: Number.POSITIVE_INFINITY, contextWindow: 200_000 },
		{ tokens: null, percent: -1, contextWindow: 200_000 },
		{ tokens: null, percent: 20, contextWindow: 0 },
	]) {
		expect(estimateHandoffContextTokens(usage)).toBe(null);
		expect(isHandoffEligible(usage)).toBe(false);
	}
});

test("handoff eligibility rejects arithmetic overflow", () => {
	const usage = { tokens: null, percent: 100, contextWindow: Number.MAX_VALUE };
	expect(estimateHandoffContextTokens(usage)).toBe(null);
	expect(isHandoffEligible(usage)).toBe(false);
	expect(formatHandoffContextUsage(usage)).toBe("~unknown tokens estimated from context usage");
});

test("handoff eligibility is monotonic as explicit context tokens grow", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (base, additional) => {
			const initial = isHandoffEligible({ tokens: base });
			const larger = isHandoffEligible({ tokens: base + additional });
			expect(!initial || larger, `${base} eligible but ${base + additional} was not`).toBe(true);
		}),
	);
});

test("handoff usage formatting distinguishes explicit and estimated values", () => {
	expect(formatHandoffContextUsage({ tokens: 12_345 })).toBe("12345 tokens");
	expect(formatHandoffContextUsage({ tokens: null, percent: 10, contextWindow: 200_000 })).toBe("~20000 tokens estimated from context usage");
	expect(formatHandoffContextUsage(null)).toBe("~unknown tokens estimated from context usage");
});
