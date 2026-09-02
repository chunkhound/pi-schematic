import { Type } from "typebox";
import type { ConstraintDescriptor } from "../../model-groups/constraints/types.js";

type TestMinContextAggregate = { automatic: number | null; supported: number | null };
type TestMaxBudgetAggregate = { automatic: number | null; supported: number | null };

const positiveIntegerCodec = {
	decode: (value: unknown, path: string) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? { ok: true as const, value } : { ok: false as const, message: `${path} must be a positive safe integer` },
	encode: (value: number) => value,
	equals: (left: number, right: number) => left === right,
	schema: Type.Integer({ minimum: 1 }),
};

// Tests-only scalar proofs: production must never register or recognize these keys.
export const testMinContext: ConstraintDescriptor<"testMinContext", number, TestMinContextAggregate, number, number, number | null> = {
	key: "testMinContext", order: 10,
	modelFact: (model) => model.contextWindow,
	aggregate: ({ members }) => {
		const facts = members.flatMap((member) => member.fact === undefined ? [] : [member.fact]);
		return { automatic: members.length && facts.length === members.length ? Math.min(...facts) : null, supported: facts.length ? Math.max(...facts) : null };
	},
	reconcile: ({ aggregate, override }) => {
		if (override === undefined) return { effective: aggregate.automatic, diagnostics: aggregate.automatic === null ? [{ key: "testMinContext", code: "unknown-automatic" }] : [] };
		return override <= (aggregate.supported ?? 0)
			? { effective: override, diagnostics: [] }
			: { effective: null, diagnostics: [{ key: "testMinContext", code: "unsupported-override", details: override }] };
	},
	groupSatisfies: ({ effective, requirement }) => effective !== null && effective >= requirement ? { satisfied: true } : { satisfied: false, unsatisfied: requirement },
	modelSatisfies: ({ fact, requirement }) => fact >= requirement ? { satisfied: true } : { satisfied: false, unsatisfied: requirement },
	persistence: { override: positiveIntegerCodec },
	assertOverrideSupported({ evaluation, override }) {
		if (override === undefined) return;
		if (evaluation.diagnostics.some((diagnostic) => diagnostic.code === "unsupported-override")) {
			throw new Error(`Model group testMinContext override ${override} exceeds the supported context for this group.`);
		}
	},
	requirement: positiveIntegerCodec,
	editor: { kind: "number", label: "Test minimum context", unit: "tokens", min: 1, step: 1, automatic: () => "Automatic", value: (evaluation) => evaluation.effective },
	present: {
		group: (evaluation) => `minimum ${evaluation.effective ?? "unknown"} tokens`,
		prompt: (evaluation) => `minimum ${evaluation.effective ?? "unknown"} tokens`,
		diagnostic: (diagnostic) => diagnostic.code === "unsupported-override" ? `unsupported minimum ${diagnostic.details} tokens` : "minimum context unknown",
		violation: () => "minimum context unsatisfied",
		ceiling: (evaluation) => evaluation.effective !== null && (evaluation.aggregate.automatic === null || evaluation.effective > evaluation.aggregate.automatic)
			? `Minimum context is capped at ${evaluation.effective} tokens for this group.`
			: undefined,
	},
};

// Tests-only lower-is-better proof. The automatic value is the group's worst
// output cost; an explicit cap may not exceed the cheapest supported member.
export const testMaxBudget: ConstraintDescriptor<"testMaxBudget", number, TestMaxBudgetAggregate, number, number, number | null> = {
	key: "testMaxBudget", order: 11,
	modelFact: (model) => model.cost.output,
	aggregate: ({ members }) => {
		const facts = members.flatMap((member) => member.fact === undefined ? [] : [member.fact]);
		return { automatic: members.length && facts.length === members.length ? Math.max(...facts) : null, supported: facts.length ? Math.min(...facts) : null };
	},
	reconcile: ({ aggregate, override }) => {
		if (override === undefined) return { effective: aggregate.automatic, diagnostics: aggregate.automatic === null ? [{ key: "testMaxBudget", code: "unknown-automatic" }] : [] };
		return override <= (aggregate.supported ?? 0)
			? { effective: override, diagnostics: [] }
			: { effective: null, diagnostics: [{ key: "testMaxBudget", code: "unsupported-override", details: override }] };
	},
	groupSatisfies: ({ effective, requirement }) => effective !== null && effective <= requirement ? { satisfied: true } : { satisfied: false, unsatisfied: requirement },
	modelSatisfies: ({ fact, requirement }) => fact <= requirement ? { satisfied: true } : { satisfied: false, unsatisfied: requirement },
	persistence: { override: positiveIntegerCodec },
	assertOverrideSupported({ evaluation, override }) {
		if (override === undefined) return;
		if (evaluation.diagnostics.some((diagnostic) => diagnostic.code === "unsupported-override")) {
			throw new Error(`Model group testMaxBudget override ${override} exceeds the supported budget for this group.`);
		}
	},
	requirement: positiveIntegerCodec,
	editor: { kind: "number", label: "Test maximum budget", unit: "credits", min: 1, step: 1, automatic: () => "Automatic", value: (evaluation) => evaluation.effective },
	present: {
		group: (evaluation) => `maximum ${evaluation.effective ?? "unknown"} credits`,
		prompt: (evaluation) => `maximum ${evaluation.effective ?? "unknown"} credits`,
		diagnostic: (diagnostic) => diagnostic.code === "unsupported-override" ? `unsupported maximum ${diagnostic.details} credits` : "maximum budget unknown",
		violation: () => "maximum budget unsatisfied",
		ceiling: (evaluation) => evaluation.effective !== null && (evaluation.aggregate.automatic === null || evaluation.effective < evaluation.aggregate.automatic)
			? `Maximum output budget is capped at ${evaluation.effective} credits for this group.`
			: undefined,
	},
};
