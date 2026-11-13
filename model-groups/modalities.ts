import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { assertModalitiesOverrideSupported, deriveModalitiesEvaluation, getMissingModalitiesFromModel } from "./constraints/modalities.js";
import { resolveConstraintMembers } from "./constraints/resolution.js";
import type { ModelGroupDef, ModelGroupModalities, ModelGroupModality } from "./types.js";

export function deriveModelGroupModalities(
	group: Pick<ModelGroupDef, "models" | "constraints">,
	modelRegistry: Pick<ModelRegistry, "find">,
): ModelGroupModalities {
	const override = group.constraints?.modalities as ModelGroupModality[] | undefined;
	const evaluation = deriveModalitiesEvaluation(resolveConstraintMembers(group.models, modelRegistry).members, override);
	return { common: evaluation.aggregate.common, supported: evaluation.aggregate.supported, effective: evaluation.effective };
}

export function assertModalityOverrideSupported(
	group: Pick<ModelGroupDef, "models" | "constraints">,
	modelRegistry: Pick<ModelRegistry, "find">,
): void {
	const override = group.constraints?.modalities as ModelGroupModality[] | undefined;
	const evaluation = deriveModalitiesEvaluation(resolveConstraintMembers(group.models, modelRegistry).members, override);
	assertModalitiesOverrideSupported(evaluation, override);
}

export function getMissingModelModalities(model: Model<Api>, required: readonly ModelGroupModality[]): ModelGroupModality[] {
	return getMissingModalitiesFromModel(model, required);
}
