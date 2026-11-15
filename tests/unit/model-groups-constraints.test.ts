import { expect, test } from "vitest";
import fs from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { evaluateConstraints } from "../../model-groups/constraints/engine.js";
import { constraintEditorRows, presentConstraintPrompt } from "../../model-groups/constraints/presentation.js";
import { modalitiesConstraint } from "../../model-groups/constraints/modalities.js";
import { createConstraintRegistry, productionConstraintRegistry } from "../../model-groups/constraints/registry.js";
import type { AnyConstraintDescriptor, ConstraintMemberResolution } from "../../model-groups/constraints/types.js";
import { testMinContext } from "./model-groups-constraints-fixture.js";
import { testModel } from "./helpers.js";
import { createModelRegistry } from "../support/model-registry.js";
import { resolveConstraintMembers } from "../../model-groups/constraints/resolution.js";
import { testProvider, withTemp } from "./model-groups-helpers.js";
import { createGroup, loadModelGroups, modelGroupsPath } from "../../model-groups/store.js";

const rich = testModel({ provider: "p", id: "rich", input: ["text", "image"], reasoning: true, contextWindow: 100 });
const text = testModel({ provider: "p", id: "text", input: ["text"], reasoning: false, contextWindow: 10 });
const resolution = (members: readonly { provider: string; modelId: string; model?: Model<Api> }[]): ConstraintMemberResolution => ({
	members: members.map(({ provider, modelId, model: resolved }) => ({ ref: { provider, modelId }, ...(resolved !== undefined ? { model: resolved } : {}) })),
});

test("constraint registry orders descriptors and rejects duplicate keys", () => {
	const registry = createConstraintRegistry([testMinContext, modalitiesConstraint]);
	expect(registry.descriptors.map((descriptor) => descriptor.key)).toStrictEqual(["modalities", "testMinContext"]);
	expect(() => createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor, modalitiesConstraint as AnyConstraintDescriptor])).toThrow(
		/Duplicate model-group constraint key: modalities/,
	);
});

test("engine preserves unresolved members as unknown facts", () => {
	const result = evaluateConstraints(
		resolution([
			{ provider: "p", modelId: "rich", model: rich },
			{ provider: "p", modelId: "gone" },
		]),
		{},
		createConstraintRegistry([modalitiesConstraint]),
	);
	// An unresolved member leaves common empty (hence the warning), but the union
	// default still carries every capability the resolved members support: text is
	// the base invariant, so effective carries the full resolved capability set.
	expect(result[0]).toStrictEqual({
		key: "modalities",
		aggregate: { common: [], supported: ["text", "image", "reasoning"], effective: [] },
		effective: ["text", "image", "reasoning"],
		diagnostics: [{ key: "modalities", code: "empty-common" }],
	});
});

test("descriptor codecs report errors and retain vocabulary ordering", () => {
	expect(modalitiesConstraint.persistence.override.decode(["reasoning", "text"], "override")).toStrictEqual({ ok: true, value: ["text", "reasoning"] });
	expect(modalitiesConstraint.persistence.override.decode(["text", "text"], "override")).toStrictEqual({
		ok: false,
		message: "override must be a unique modality vocabulary array",
	});
});

test("generic multi-select editor enumerates automatic + one toggle per choice", () => {
	const registry = createConstraintRegistry([modalitiesConstraint]);
	const evaluated = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), {}, registry);
	expect(constraintEditorRows(modalitiesConstraint as AnyConstraintDescriptor, evaluated[0])).toStrictEqual([
		{ kind: "automatic", label: "Automatic (text, image)" },
		{ kind: "toggle", label: "text", value: "text", active: true },
		{ kind: "toggle", label: "image", value: "image", active: true },
		{ kind: "toggle", label: "reasoning", value: "reasoning", active: true },
	]);
});

test("text is always present in effective even when the override drops it", () => {
	const registry = createConstraintRegistry([modalitiesConstraint]);
	const deselected = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), { modalities: [] }, registry)[0];
	expect(deselected.effective).toStrictEqual(["text"]);
	const onlyImage = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), { modalities: ["image"] }, registry)[0];
	expect(onlyImage.effective).toStrictEqual(["text", "image"]);
});

test("fully stale non-empty modality overrides fall back to the union while explicit empty remains text-only", () => {
	const registry = createConstraintRegistry([modalitiesConstraint]);
	const visionWithoutReasoning = testModel({ provider: "p", id: "vision", input: ["text", "image"], reasoning: false });
	const resolved = resolution([{ provider: "p", modelId: "vision", model: visionWithoutReasoning }]);
	const stale = evaluateConstraints(resolved, { modalities: ["reasoning"] }, registry)[0];
	expect(stale.effective).toStrictEqual(["text", "image"]);
	expect(stale.diagnostics).toStrictEqual([{ key: "modalities", code: "unsupported-override", details: ["reasoning"] }]);
	expect(evaluateConstraints(resolved, { modalities: [] }, registry)[0].effective).toStrictEqual(["text"]);
});

test("injected scalar takes the smallest context window among the members the model registry resolves", async () => {
	const registry = await createModelRegistry({
		"mg-scalar": testProvider(
			[
				{ id: "wide", contextWindow: 100 },
				{ id: "narrow", contextWindow: 10 },
			],
			{ auth: true },
		),
	});
	const members = [
		{ provider: "mg-scalar", modelId: "wide" },
		{ provider: "mg-scalar", modelId: "narrow" },
	];

	expect(evaluateConstraints(resolveConstraintMembers(members, registry), {}, createConstraintRegistry([testMinContext]))).toStrictEqual([
		{ key: "testMinContext", aggregate: { automatic: 10, supported: 100 }, effective: 10, diagnostics: [] },
	]);
});

test("injected scalar has no automatic value for a member that does not resolve and reports it as unknown", () => {
	const resolved = resolution([
		{ provider: "p", modelId: "rich", model: rich },
		{ provider: "p", modelId: "gone" },
	]);

	expect(evaluateConstraints(resolved, {}, createConstraintRegistry([testMinContext]))).toStrictEqual([
		{
			key: "testMinContext",
			aggregate: { automatic: null, supported: 100 },
			effective: null,
			diagnostics: [{ key: "testMinContext", code: "unknown-automatic" }],
		},
	]);
});

test("injected scalar override within the supported context becomes the effective value", () => {
	const resolved = resolution([
		{ provider: "p", modelId: "rich", model: rich },
		{ provider: "p", modelId: "text", model: text },
	]);

	expect(evaluateConstraints(resolved, { testMinContext: 12 }, createConstraintRegistry([testMinContext]))).toStrictEqual([
		{ key: "testMinContext", aggregate: { automatic: 10, supported: 100 }, effective: 12, diagnostics: [] },
	]);
});

test("model groups store writes an injected scalar override to the group file and loads it back", () =>
	withTemp(async ({ cwd }) => {
		const access = { cwd, policy: "global-project" as const };
		const injected = createConstraintRegistry([testMinContext]);
		const registry = await createModelRegistry({ "mg-scalar": testProvider([{ id: "wide", contextWindow: 100 }], { auth: true }) });

		createGroup("project", access, "deep", { models: [{ provider: "mg-scalar", modelId: "wide" }], constraints: { testMinContext: 12 } }, registry, injected);

		expect(JSON.parse(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"))).toStrictEqual({
			version: 2,
			groups: { deep: { models: [{ provider: "mg-scalar", modelId: "wide" }], constraints: { testMinContext: 12 } } },
		});
		expect(loadModelGroups(access, injected).configs.project.groups.deep).toStrictEqual({
			models: [{ provider: "mg-scalar", modelId: "wide" }],
			constraints: { testMinContext: 12 },
		});
	}));

test.for(["testMinContext", "testMaxBudget"])("production constraint registry does not know the test-only key %s", (key) => {
	expect(productionConstraintRegistry.get(key)).toBeUndefined();
});

test("generic modality prompt presentation preserves effective labels", () => {
	const registry = createConstraintRegistry([modalitiesConstraint]);
	const effective = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), {}, registry);
	expect(presentConstraintPrompt(effective, registry)).toStrictEqual(["text, image, reasoning"]);
});

test("generic presentation and number form rows use injected descriptor metadata", () => {
	const injected = createConstraintRegistry([testMinContext]);
	const evaluations = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), { testMinContext: 12 }, injected);
	expect(presentConstraintPrompt(evaluations, injected)).toStrictEqual(["minimum 12 tokens"]);
	expect(constraintEditorRows(testMinContext as AnyConstraintDescriptor, evaluations[0])).toStrictEqual([
		{ kind: "automatic", label: "Automatic" },
		{ kind: "number", label: "Test minimum context", value: 12, unit: "tokens", min: 1, step: 1 },
	]);
});

test("modalities descriptor derives ordered common, supported, and override-effective modalities", async () => {
	const registry = await createModelRegistry({
		"mg-modalities": testProvider(
			[
				{ id: "rich", input: ["image", "text"], reasoning: true },
				{ id: "text", input: ["text"], reasoning: false },
			],
			{ auth: true },
		),
	});
	const descriptors = createConstraintRegistry([modalitiesConstraint]);
	const members = [
		{ provider: "mg-modalities", modelId: "rich" },
		{ provider: "mg-modalities", modelId: "text" },
	];
	const evaluate = (models: typeof members, overrides: Record<string, unknown>) =>
		evaluateConstraints(resolveConstraintMembers(models, registry), overrides, descriptors)[0];

	expect(evaluate(members, {})).toStrictEqual({
		key: "modalities",
		aggregate: { common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text"] },
		effective: ["text", "image", "reasoning"],
		diagnostics: [],
	});
	expect(evaluate(members, { modalities: ["reasoning", "image"] }).effective, "text stays ahead of the overridden add-ons").toStrictEqual([
		"text",
		"image",
		"reasoning",
	]);
	expect(evaluate([...members, { provider: "mg-modalities", modelId: "gone" }], {}).aggregate, "an unresolved member empties common").toStrictEqual({
		common: [],
		supported: ["text", "image", "reasoning"],
		effective: [],
	});
});

test("a stale modality override is restored when the model regains the modality", async () => {
	const registry = await createModelRegistry({ "mg-restore": testProvider([{ id: "m", input: ["text"] }], { auth: true }) });
	const descriptors = createConstraintRegistry([modalitiesConstraint]);
	const overrides = { modalities: ["text", "image"] };
	const members = [{ provider: "mg-restore", modelId: "m" }];
	expect(
		evaluateConstraints(resolveConstraintMembers(members, registry), overrides, descriptors)[0].effective,
		"capped while the model lacks image",
	).toStrictEqual(["text"]);

	registry.registerProvider("mg-restore", testProvider([{ id: "m", input: ["text", "image"] }], { auth: true }));

	expect(evaluateConstraints(resolveConstraintMembers(members, registry), overrides, descriptors)[0].effective).toStrictEqual(["text", "image"]);
	expect(overrides, "the stored override is not rewritten").toStrictEqual({ modalities: ["text", "image"] });
});
