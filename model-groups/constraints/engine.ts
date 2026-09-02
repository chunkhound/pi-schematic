import type { ConstraintRegistry } from "./registry.js";
import type { AnyConstraintDescriptor, ConstraintEvaluation, ConstraintMemberResolution, ConstraintViolation, ErasedConstraintEvaluation } from "./types.js";

function evaluateDescriptor(descriptor: AnyConstraintDescriptor, resolution: ConstraintMemberResolution, override: unknown): ErasedConstraintEvaluation {
	const members = resolution.members.map(({ ref, model }) => ({ ref, ...(model ? { fact: descriptor.modelFact(model) } : {}) }));
	const aggregate = descriptor.aggregate({ members });
	const reconciled = descriptor.reconcile({ aggregate, override });
	return { key: descriptor.key, aggregate, effective: reconciled.effective, diagnostics: reconciled.diagnostics };
}

/** Pure evaluator: resolution is supplied by the host and no registry APIs are reachable here. */
export function evaluateConstraints(
	resolution: ConstraintMemberResolution,
	overrides: Readonly<Record<string, unknown>>,
	registry: ConstraintRegistry,
): readonly ErasedConstraintEvaluation[] {
	return registry.descriptors.map((descriptor) => evaluateDescriptor(descriptor, resolution, overrides[descriptor.key]));
}

export function evaluateConstraint<Aggregate, Effective>(
	descriptor: AnyConstraintDescriptor,
	resolution: ConstraintMemberResolution,
	override: unknown,
): ConstraintEvaluation<Aggregate, Effective> {
	return evaluateDescriptor(descriptor, resolution, override) as ConstraintEvaluation<Aggregate, Effective>;
}

export function evaluateGroupRequirement(
	descriptor: AnyConstraintDescriptor,
	evaluation: ErasedConstraintEvaluation,
	requirement: unknown,
): ConstraintViolation | undefined {
	const satisfaction = descriptor.groupSatisfies({ aggregate: evaluation.aggregate, effective: evaluation.effective, requirement });
	return satisfaction.satisfied ? undefined : { key: descriptor.key, scope: "group", satisfaction };
}

export function evaluateModelRequirement(
	descriptor: AnyConstraintDescriptor,
	model: ConstraintMemberResolution["members"][number]["model"],
	requirement: unknown,
): ConstraintViolation | undefined {
	if (!model) return { key: descriptor.key, scope: "model", satisfaction: { satisfied: false, missing: "unresolved" } };
	const satisfaction = descriptor.modelSatisfies({ fact: descriptor.modelFact(model), requirement });
	return satisfaction.satisfied ? undefined : { key: descriptor.key, scope: "model", satisfaction };
}
