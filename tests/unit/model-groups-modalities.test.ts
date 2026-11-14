import { expect, test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assertModalityOverrideSupported, deriveModelGroupModalities, getMissingModelModalities } from "../../model-groups/modalities.js";
import { deriveModalitiesEvaluation } from "../../model-groups/constraints/modalities.js";
import { resolveConstraintMembers } from "../../model-groups/constraints/resolution.js";
import type { ModelGroupDef, ModelGroupModality, ModelGroupModel } from "../../model-groups/types.js";
import { testModel } from "./helpers.js";

function registry(models: Model<Api>[]): Pick<ModelRegistry, "find"> {
	return { find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id) };
}

test("derives ordered common, supported, and override-effective modalities from the live registry", () => {
	const models = [
		testModel({ provider: "p", id: "rich", input: ["image", "text"], reasoning: true }),
		testModel({ provider: "p", id: "text", input: ["text"], reasoning: false }),
	];
	const group = { models: [{ provider: "p", modelId: "rich" }, { provider: "p", modelId: "text" }] };
	expect(deriveModelGroupModalities(group, registry(models))).toStrictEqual({
		common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text", "image", "reasoning"],
	});
	const effectiveAfterOverride = deriveModelGroupModalities({ ...group, constraints: { modalities: ["reasoning", "image"] } }, registry(models)).effective;
	expect(effectiveAfterOverride, "text stays always-present ahead of overridden add-ons").toStrictEqual(["text", "image", "reasoning"]);
	expect(deriveModelGroupModalities({ models: [...group.models, { provider: "p", modelId: "gone" }] }, registry(models)).common).toStrictEqual([]);
	models[1].input = ["text", "image"];
	expect(deriveModelGroupModalities(group, registry(models)).common, "each call reads the live registry").toStrictEqual(["text", "image"]);
});

test("compatibility façade and descriptor remain parity-equivalent across modality fixtures", () => {
	const models = [
		testModel({ provider: "p", id: "rich", input: ["image", "text"], reasoning: true }),
		testModel({ provider: "p", id: "text", input: ["text"], reasoning: false }),
	];
	const fixtures: { models: ModelGroupModel[]; constraints?: { modalities: ModelGroupModality[] } }[] = [
		{ models: [] },
		{ models: [{ provider: "p", modelId: "gone" }] },
		{ models: [{ provider: "p", modelId: "rich" }], constraints: { modalities: [] } },
		{ models: [{ provider: "p", modelId: "text" }], constraints: { modalities: ["image"] } },
		{ models: [{ provider: "p", modelId: "rich" }, { provider: "p", modelId: "text" }] },
	];
	for (const group of fixtures) {
		const resolved = resolveConstraintMembers(group.models, registry(models));
		const evaluation = deriveModalitiesEvaluation(resolved.members, group.constraints?.modalities);
		expect(deriveModelGroupModalities(group, registry(models))).toStrictEqual({
			common: evaluation.aggregate.common,
			supported: evaluation.aggregate.supported,
			effective: evaluation.effective,
		});
	}
});

test("caps stale overrides without mutation and restores them when catalog support returns", () => {
	const def: ModelGroupDef = { models: [{ provider: "p", modelId: "m" }], constraints: { modalities: ["text", "image"] } };
	const models = [testModel({ provider: "p", id: "m", input: ["text"], reasoning: false })];
	const first = deriveModelGroupModalities(def, registry(models));
	expect(first.effective).toStrictEqual(["text"]);
	expect(def.constraints?.modalities).toStrictEqual(["text", "image"]);
	models[0].input.push("image");
	expect(deriveModelGroupModalities(def, registry(models)).effective).toStrictEqual(["text", "image"]);
	expect(() => { assertModalityOverrideSupported(def, registry([testModel({ provider: "p", id: "m", input: ["text"], reasoning: false })])); }).toThrow(/unsupported modalities: image/);
	expect(getMissingModelModalities(models[0], ["text", "reasoning"])).toStrictEqual(["reasoning"]);
});
