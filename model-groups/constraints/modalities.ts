import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MODEL_GROUP_MODALITIES, type ModelGroupModalities, type ModelGroupModality } from "../types.js";
import type { ConstraintCodec, ConstraintDescriptor, ConstraintDiagnostic, ConstraintEvaluation, ConstraintSatisfaction, ConstraintViolation } from "./types.js";

function ordered(values: Iterable<ModelGroupModality>): ModelGroupModality[] {
	const set = new Set(values);
	return MODEL_GROUP_MODALITIES.filter((value) => set.has(value));
}

function modalityCodec(): ConstraintCodec<ModelGroupModality[]> {
	return {
		decode(value, path) {
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !MODEL_GROUP_MODALITIES.includes(item as ModelGroupModality)) || new Set(value).size !== value.length) return { ok: false, message: `${path} must be a unique modality vocabulary array` };
			return { ok: true, value: ordered(value as ModelGroupModality[]) };
		},
		encode: (value) => [...value],
		equals: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]),
		schema: Type.Array(Type.Union(MODEL_GROUP_MODALITIES.map((value) => Type.Literal(value))), { uniqueItems: true, description: `one of: ${MODEL_GROUP_MODALITIES.join(", ")}` }),
	};
}

function satisfaction(missing: ModelGroupModality[]): ConstraintSatisfaction {
	return missing.length ? { satisfied: false, missing } : { satisfied: true };
}

export function getModalitiesModelFact(model: Model<Api>): ModelGroupModality[] {
	return ordered([...(Array.isArray(model.input) ? model.input as ModelGroupModality[] : []), ...(model.reasoning === true ? ["reasoning" as const] : [])]);
}

export const modalitiesConstraint: ConstraintDescriptor<"modalities", ModelGroupModality[], ModelGroupModalities, ModelGroupModality[], ModelGroupModality[], ModelGroupModality[]> = {
	key: "modalities",
	order: 0,
	modelFact: getModalitiesModelFact,
	aggregate({ members }) {
		const sets = members.map(({ fact }) => new Set(fact ?? []));
		const supported = ordered(sets.flatMap((set) => [...set]));
		const common = members.length === 0 || members.some(({ fact }) => fact === undefined)
			? []
			: ordered(MODEL_GROUP_MODALITIES.filter((modality) => sets.every((set) => set.has(modality))));
		return { common, supported, effective: common };
	},
	reconcile({ aggregate, override }) {
		// Without an explicit override the group's capability is the union of its
		// members' individual modalities (any member can satisfy the capability, and
		// D1 route pre-selection picks a capable member). An explicit override stays
		// an authoritative subtractive ceiling: only members' supported modalities
		// may be listed, so the union is never exceeded.
		// An explicit [] is an intentional text-only ceiling. A non-empty override
		// made entirely stale, however, must fall back to the derived union.
		let base: ModelGroupModality[];
		if (override === undefined) {
			base = aggregate.supported;
		} else if (override.length === 0) {
			base = [];
		} else {
			const filteredOverride = ordered(override.filter((modality) => aggregate.supported.includes(modality)));
			base = filteredOverride.length ? filteredOverride : aggregate.supported;
		}
		// Text is the always-present base capability (image/reasoning both imply it);
		// keep it in the effective set whenever the group supports it, regardless of override.
		const effective = aggregate.supported.includes("text") ? ordered(["text", ...base.filter((modality) => modality !== "text")]) : base;
		const missing = override === undefined ? [] : ordered(override.filter((modality) => !aggregate.supported.includes(modality)));
		const diagnostics: ConstraintDiagnostic[] = [
			...(aggregate.common.length === 0 ? [{ key: "modalities", code: "empty-common" }] : []),
			...(missing.length ? [{ key: "modalities", code: "unsupported-override", details: missing }] : []),
		];
		return { effective, diagnostics };
	},
	groupSatisfies({ effective, requirement }) { return satisfaction(ordered(requirement.filter((modality) => !effective.includes(modality)))); },
	modelSatisfies({ fact, requirement }) { return satisfaction(ordered(requirement.filter((modality) => !fact.includes(modality)))); },
	persistence: { override: modalityCodec() },
	assertOverrideSupported({ evaluation, override }) {
		assertModalitiesOverrideSupported(evaluation, override);
	},
	requirement: {
		decode(value, path) {
			if (!value || typeof value !== "object" || Array.isArray(value) || !("required" in value)) return { ok: false, message: `${path} must be an object with required modalities` };
			return modalityCodec().decode((value as { required: unknown }).required, `${path}.required`);
		},
		encode: (value) => ({ required: [...value] }),
		equals: (left, right) => modalityCodec().equals(left, right),
		schema: Type.Object({ required: modalityCodec().schema }, { description: `required input modalities for the delegated task — shape is an object with a single "required" array key, e.g. { "required": ["text", "reasoning"] } (not a bare array). Array entries must be exactly ${MODEL_GROUP_MODALITIES.join(", ")} (no other capability names)` }),
	},
	editor: { kind: "multi-select", label: "Modalities", choices: (evaluation) => evaluation.aggregate.supported, automatic: (evaluation) => `Automatic (${evaluation.aggregate.common.filter((modality) => modality !== "reasoning").join(", ") || "none"})` },
	present: {
		group: (evaluation) => evaluation.effective.join(", "),
		prompt: (evaluation) => evaluation.effective.join(", "),
		diagnostic: (diagnostic) => diagnostic.code === "empty-common"
			? "⚠ no common modalities"
			: `⚠ stale modality override: ${((diagnostic.details as ModelGroupModality[] | undefined) ?? []).join(", ")}`,
		violation: (violation: ConstraintViolation) => violation.key,
		ceiling: (evaluation) => evaluation.aggregate.supported.includes("image") && !evaluation.effective.includes("image")
			? "Image input is disabled for this group. If the task requires reading or inspecting an image, do not work around it with OCR, third-party tools, or an alternate route; report the capability mismatch to the parent instead."
			: undefined,
	},
};

export function deriveModalitiesEvaluation(
	members: readonly { ref: { provider: string; modelId: string }; model?: Model<Api> }[],
	override: ModelGroupModality[] | undefined,
): ConstraintEvaluation<ModelGroupModalities, ModelGroupModality[]> {
	const aggregate = modalitiesConstraint.aggregate({ members: members.map(({ ref, model }) => ({ ref, ...(model ? { fact: modalitiesConstraint.modelFact(model) } : {}) })) });
	const reconciled = modalitiesConstraint.reconcile({ aggregate, override });
	return { key: modalitiesConstraint.key, aggregate, effective: reconciled.effective, diagnostics: reconciled.diagnostics };
}

export function assertModalitiesOverrideSupported(evaluation: ConstraintEvaluation<ModelGroupModalities, ModelGroupModality[]>, override: ModelGroupModality[] | undefined): void {
	if (override === undefined) return;
	const missing = evaluation.diagnostics.find((diagnostic) => diagnostic.code === "unsupported-override")?.details as ModelGroupModality[] | undefined;
	if (missing?.length) throw new Error(`Model group modality override includes unsupported modalities: ${missing.join(", ")}.`);
}

export function getMissingModalitiesFromModel(model: Model<Api>, required: readonly ModelGroupModality[]): ModelGroupModality[] {
	return ordered(required.filter((modality) => !getModalitiesModelFact(model).includes(modality)));
}
