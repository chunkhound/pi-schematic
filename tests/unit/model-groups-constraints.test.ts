import { expect, test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { evaluateConstraints } from "../../model-groups/constraints/engine.js";
import { constraintEditorRows, presentConstraintPrompt } from "../../model-groups/constraints/presentation.js";
import { modalitiesConstraint } from "../../model-groups/constraints/modalities.js";
import { createConstraintRegistry, productionConstraintRegistry } from "../../model-groups/constraints/registry.js";
import type { AnyConstraintDescriptor, ConstraintMemberResolution } from "../../model-groups/constraints/types.js";
import { testMaxBudget, testMinContext } from "./model-groups-constraints-fixture.js";

function model(fields: Pick<Model<Api>, "provider" | "id" | "input" | "reasoning"> & Partial<Model<Api>>): Model<Api> {
	return {
		name: fields.id, api: "test-api", baseUrl: "http://localhost.invalid",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0, ...fields,
	};
}

const rich = model({ provider: "p", id: "rich", input: ["text", "image"], reasoning: true, contextWindow: 100 });
const text = model({ provider: "p", id: "text", input: ["text"], reasoning: false, contextWindow: 10 });
const resolution = (members: readonly { provider: string; modelId: string; model?: Model<Api> }[]): ConstraintMemberResolution => ({ members: members.map(({ provider, modelId, model: resolved }) => ({ ref: { provider, modelId }, ...(resolved !== undefined ? { model: resolved } : {}) })) });

test("constraint registry orders descriptors and rejects duplicate keys", () => {
	const registry = createConstraintRegistry([testMinContext, modalitiesConstraint]);
	expect(registry.descriptors.map((descriptor) => descriptor.key)).toStrictEqual(["modalities", "testMinContext"]);
	expect(() => createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor, modalitiesConstraint as AnyConstraintDescriptor])).toThrow(/Duplicate model-group constraint key: modalities/);
});

	test("engine preserves unresolved members as unknown facts", () => {
	const result = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }, { provider: "p", modelId: "gone" }]), {}, createConstraintRegistry([modalitiesConstraint]));
	// An unresolved member leaves common empty (hence the warning), but the union
	// default still carries every capability the resolved members support: text is
	// the base invariant, so effective carries the full resolved capability set.
	expect(result[0]).toStrictEqual({ key: "modalities", aggregate: { common: [], supported: ["text", "image", "reasoning"], effective: [] }, effective: ["text", "image", "reasoning"], diagnostics: [{ key: "modalities", code: "empty-common" }] });
});

test("descriptor codecs report errors and retain vocabulary ordering", () => {
	expect(modalitiesConstraint.persistence.override.decode(["reasoning", "text"], "override")).toStrictEqual({ ok: true, value: ["text", "reasoning"] });
	expect(modalitiesConstraint.persistence.override.decode(["text", "text"], "override")).toStrictEqual({ ok: false, message: "override must be a unique modality vocabulary array" });
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
	const visionWithoutReasoning = model({ provider: "p", id: "vision", input: ["text", "image"], reasoning: false });
	const resolved = resolution([{ provider: "p", modelId: "vision", model: visionWithoutReasoning }]);
	const stale = evaluateConstraints(resolved, { modalities: ["reasoning"] }, registry)[0];
	expect(stale.effective).toStrictEqual(["text", "image"]);
	expect(stale.diagnostics).toStrictEqual([{ key: "modalities", code: "unsupported-override", details: ["reasoning"] }]);
	expect(evaluateConstraints(resolved, { modalities: [] }, registry)[0].effective).toStrictEqual(["text"]);
});

test("injected scalar traverses resolution, aggregation, persistence, reconciliation, and production isolation", () => {
	const injected = createConstraintRegistry([testMinContext]);
	const resolved = resolution([{ provider: "p", modelId: "rich", model: rich }, { provider: "p", modelId: "text", model: text }]);
	const automatic = evaluateConstraints(resolved, {}, injected)[0];
	expect(automatic.aggregate).toStrictEqual({ automatic: 10, supported: 100 });
	expect(automatic.effective).toBe(10);
	expect(evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }, { provider: "p", modelId: "gone" }]), {}, injected)[0]).toStrictEqual({ key: "testMinContext", aggregate: { automatic: null, supported: 100 }, effective: null, diagnostics: [{ key: "testMinContext", code: "unknown-automatic" }] });
	expect(evaluateConstraints(resolution([]), {}, injected)[0].aggregate).toStrictEqual({ automatic: null, supported: null });
	const envelope: Record<string, unknown> = { testMinContext: testMinContext.persistence.override.encode(12) };
	const decoded = testMinContext.persistence.override.decode(envelope.testMinContext, "constraints.testMinContext");
	expect(decoded).toStrictEqual({ ok: true, value: 12 });
	expect({ testMinContext: testMinContext.persistence.override.encode(decoded.ok ? decoded.value : 0) }).toStrictEqual(envelope);
	expect(evaluateConstraints(resolved, envelope, injected)[0].effective).toBe(12);
	const unsupported = evaluateConstraints(resolved, { testMinContext: 101 }, injected)[0];
	expect(unsupported.effective).toBeNull();
	expect(unsupported.diagnostics).toStrictEqual([{ key: "testMinContext", code: "unsupported-override", details: 101 }]);
	expect(productionConstraintRegistry.descriptors.map((descriptor) => descriptor.key)).toStrictEqual(["modalities"]);
	expect(productionConstraintRegistry.get("testMinContext")).toBeUndefined();
	expect(productionConstraintRegistry.get("testMaxBudget")).toBeUndefined();
});

test("injected lower-is-better budget rejects an override above the supported cap", () => {
	const injected = createConstraintRegistry([testMaxBudget]);
	const resolved = resolution([
		{ provider: "p", modelId: "cheap", model: { ...text, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } },
		{ provider: "p", modelId: "costly", model: { ...rich, cost: { input: 1, output: 5, cacheRead: 1, cacheWrite: 1 } } },
	]);
	const automatic = evaluateConstraints(resolved, {}, injected)[0];
	expect(automatic.aggregate).toStrictEqual({ automatic: 5, supported: 1 });
	expect(automatic.effective).toBe(5);
	const capped = evaluateConstraints(resolved, { testMaxBudget: 1 }, injected)[0];
	expect(capped.effective).toBe(1);
	const unsupported = evaluateConstraints(resolved, { testMaxBudget: 2 }, injected)[0];
	expect(unsupported.effective).toBeNull();
	expect(unsupported.diagnostics).toStrictEqual([{ key: "testMaxBudget", code: "unsupported-override", details: 2 }]);
});

test("generic modality prompt presentation preserves effective and empty labels", () => {
	const registry = createConstraintRegistry([modalitiesConstraint]);
	const effective = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), {}, registry);
	const empty = evaluateConstraints(resolution([]), {}, registry);
	expect(presentConstraintPrompt(effective, registry).filter(Boolean).join(", ") || "no common modalities").toBe("text, image, reasoning");
	expect(presentConstraintPrompt(empty, registry).filter(Boolean).join(", ") || "no common modalities").toBe("no common modalities");
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

test("engine uses only the supplied resolution and never calls host registry APIs", () => {
	const spyResolution = Object.assign(resolution([{ provider: "p", modelId: "rich", model: rich }]), {
		find: () => { throw new Error("find must not be called"); },
		hasConfiguredAuth: () => { throw new Error("auth must not be called"); },
		refresh: () => { throw new Error("refresh must not be called"); },
	});
	const result = evaluateConstraints(spyResolution, {}, createConstraintRegistry([modalitiesConstraint]));
	expect(result[0].effective).toStrictEqual(["text", "image", "reasoning"]);
});
