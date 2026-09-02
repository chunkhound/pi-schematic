import test from "node:test";
import assert from "node:assert/strict";
import { assertModalityOverrideSupported, deriveModelGroupModalities, getMissingModelModalities } from "../../model-groups/modalities.js";
import { deriveModalitiesEvaluation } from "../../model-groups/constraints/modalities.js";
import { resolveConstraintMembers } from "../../model-groups/constraints/resolution.js";
import type { ModelGroupDef } from "../../model-groups/types.js";

function registry(models: any[]): { find(provider: string, id: string): any } {
	return { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) };
}

test("derives ordered common, supported, and override-effective modalities from the live registry", () => {
	const models = [
		{ provider: "p", id: "rich", input: ["image", "text"], reasoning: true },
		{ provider: "p", id: "text", input: ["text"], reasoning: false },
	];
	const group = { models: [{ provider: "p", modelId: "rich" }, { provider: "p", modelId: "text" }] };
	assert.deepEqual(deriveModelGroupModalities(group, registry(models)), {
		common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text", "image", "reasoning"],
	});
	const effectiveAfterOverride = deriveModelGroupModalities({ ...group, constraints: { modalities: ["reasoning", "image"] } }, registry(models)).effective;
	assert.deepEqual(effectiveAfterOverride, ["text", "image", "reasoning"], "text stays always-present ahead of overridden add-ons");
	assert.deepEqual(deriveModelGroupModalities({ models: [...group.models, { provider: "p", modelId: "gone" }] }, registry(models)).common, []);
	models[1].input = ["text", "image"];
	assert.deepEqual(deriveModelGroupModalities(group, registry(models)).common, ["text", "image"], "each call reads the live registry");
});

test("compatibility façade and descriptor remain parity-equivalent across modality fixtures", () => {
	const models: any[] = [
		{ provider: "p", id: "rich", input: ["image", "text"], reasoning: true },
		{ provider: "p", id: "text", input: ["text"], reasoning: false },
	];
	const fixtures: ModelGroupDef[] = [
		{ models: [] },
		{ models: [{ provider: "p", modelId: "gone" }] },
		{ models: [{ provider: "p", modelId: "rich" }], constraints: { modalities: [] } },
		{ models: [{ provider: "p", modelId: "text" }], constraints: { modalities: ["image"] } },
		{ models: [{ provider: "p", modelId: "rich" }, { provider: "p", modelId: "text" }] },
	];
	for (const group of fixtures) {
		const resolved = resolveConstraintMembers(group.models, registry(models));
		const evaluation = deriveModalitiesEvaluation(resolved.members, group.constraints?.modalities as any);
		assert.deepEqual(deriveModelGroupModalities(group, registry(models)), {
			common: evaluation.aggregate.common,
			supported: evaluation.aggregate.supported,
			effective: evaluation.effective,
		});
	}
});

test("caps stale overrides without mutation and restores them when catalog support returns", () => {
	const def: ModelGroupDef = { models: [{ provider: "p", modelId: "m" }], constraints: { modalities: ["text", "image"] } };
	const models: any[] = [{ provider: "p", id: "m", input: ["text"], reasoning: false }];
	const first = deriveModelGroupModalities(def, registry(models));
	assert.deepEqual(first.effective, ["text"]);
	assert.deepEqual(def.constraints?.modalities, ["text", "image"]);
	models[0].input.push("image");
	assert.deepEqual(deriveModelGroupModalities(def, registry(models)).effective, ["text", "image"]);
	assert.throws(() => assertModalityOverrideSupported(def, registry([{ provider: "p", id: "m", input: ["text"], reasoning: false }])), /unsupported modalities: image/);
	assert.deepEqual(getMissingModelModalities(models[0], ["text", "reasoning"]), ["reasoning"]);
});
