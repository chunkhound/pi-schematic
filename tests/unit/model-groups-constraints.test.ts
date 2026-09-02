import assert from "node:assert/strict";
import test from "node:test";
import { evaluateConstraints } from "../../model-groups/constraints/engine.js";
import { constraintEditorRows, presentConstraintPrompt } from "../../model-groups/constraints/presentation.js";
import { modalitiesConstraint } from "../../model-groups/constraints/modalities.js";
import { createConstraintRegistry, productionConstraintRegistry } from "../../model-groups/constraints/registry.js";
import type { AnyConstraintDescriptor } from "../../model-groups/constraints/types.js";
import { testMaxBudget, testMinContext } from "./model-groups-constraints-fixture.js";

const rich = { provider: "p", id: "rich", input: ["text", "image"], reasoning: true, contextWindow: 100 } as any;
const text = { provider: "p", id: "text", input: ["text"], reasoning: false, contextWindow: 10 } as any;
const resolution = (members: readonly any[]) => ({ members: members.map(({ provider, modelId, model }) => ({ ref: { provider, modelId }, ...(model ? { model } : {}) })) });

test("constraint registry orders descriptors and rejects duplicate keys", () => {
	const registry = createConstraintRegistry([testMinContext as AnyConstraintDescriptor, modalitiesConstraint as AnyConstraintDescriptor]);
	assert.deepEqual(registry.descriptors.map((descriptor) => descriptor.key), ["modalities", "testMinContext"]);
	assert.throws(() => createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor, modalitiesConstraint as AnyConstraintDescriptor]), /Duplicate model-group constraint key: modalities/);
});

	test("engine preserves unresolved members as unknown facts", () => {
	const result = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }, { provider: "p", modelId: "gone" }]), {}, createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor]));
	// An unresolved member leaves common empty (hence the warning), but the union
	// default still carries every capability the resolved members support: text is
	// the base invariant, so effective carries the full resolved capability set.
	assert.deepEqual(result[0], { key: "modalities", aggregate: { common: [], supported: ["text", "image", "reasoning"], effective: [] }, effective: ["text", "image", "reasoning"], diagnostics: [{ key: "modalities", code: "empty-common" }] });
});

test("descriptor codecs report errors and retain vocabulary ordering", () => {
	assert.deepEqual(modalitiesConstraint.persistence.override.decode(["reasoning", "text"], "override"), { ok: true, value: ["text", "reasoning"] });
	assert.deepEqual(modalitiesConstraint.persistence.override.decode(["text", "text"], "override"), { ok: false, message: "override must be a unique modality vocabulary array" });
});

test("generic multi-select editor enumerates automatic + one toggle per choice", () => {
	const registry = createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor]);
	const evaluated = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), {}, registry);
	assert.deepEqual(constraintEditorRows(modalitiesConstraint as AnyConstraintDescriptor, evaluated[0]), [
		{ kind: "automatic", label: "Automatic (text, image)" },
		{ kind: "toggle", label: "text", value: "text", active: true },
		{ kind: "toggle", label: "image", value: "image", active: true },
		{ kind: "toggle", label: "reasoning", value: "reasoning", active: true },
	]);
});

test("text is always present in effective even when the override drops it", () => {
	const registry = createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor]);
	const deselected = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), { modalities: [] }, registry)[0];
	assert.deepEqual(deselected.effective, ["text"]);
	const onlyImage = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), { modalities: ["image"] }, registry)[0];
	assert.deepEqual(onlyImage.effective, ["text", "image"]);
});

test("fully stale non-empty modality overrides fall back to the union while explicit empty remains text-only", () => {
	const registry = createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor]);
	const visionWithoutReasoning = { provider: "p", id: "vision", input: ["text", "image"], reasoning: false } as any;
	const resolved = resolution([{ provider: "p", modelId: "vision", model: visionWithoutReasoning }]);
	const stale = evaluateConstraints(resolved, { modalities: ["reasoning"] }, registry)[0];
	assert.deepEqual(stale.effective, ["text", "image"]);
	assert.deepEqual(stale.diagnostics, [{ key: "modalities", code: "unsupported-override", details: ["reasoning"] }]);
	assert.deepEqual(evaluateConstraints(resolved, { modalities: [] }, registry)[0].effective, ["text"]);
});

test("injected scalar traverses resolution, aggregation, persistence, reconciliation, and production isolation", () => {
	const injected = createConstraintRegistry([testMinContext as AnyConstraintDescriptor]);
	const resolved = resolution([{ provider: "p", modelId: "rich", model: rich }, { provider: "p", modelId: "text", model: text }]);
	const automatic = evaluateConstraints(resolved, {}, injected)[0];
	assert.deepEqual(automatic.aggregate, { automatic: 10, supported: 100 });
	assert.equal(automatic.effective, 10);
	assert.deepEqual(evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }, { provider: "p", modelId: "gone" }]), {}, injected)[0], { key: "testMinContext", aggregate: { automatic: null, supported: 100 }, effective: null, diagnostics: [{ key: "testMinContext", code: "unknown-automatic" }] });
	assert.deepEqual(evaluateConstraints(resolution([]), {}, injected)[0].aggregate, { automatic: null, supported: null });
	const envelope: Record<string, unknown> = { testMinContext: testMinContext.persistence.override.encode(12) };
	const decoded = testMinContext.persistence.override.decode(envelope.testMinContext, "constraints.testMinContext");
	assert.deepEqual(decoded, { ok: true, value: 12 });
	assert.deepEqual({ testMinContext: testMinContext.persistence.override.encode(decoded.ok ? decoded.value : 0) }, envelope);
	assert.equal(evaluateConstraints(resolved, envelope, injected)[0].effective, 12);
	const unsupported = evaluateConstraints(resolved, { testMinContext: 101 }, injected)[0];
	assert.equal(unsupported.effective, null);
	assert.deepEqual(unsupported.diagnostics, [{ key: "testMinContext", code: "unsupported-override", details: 101 }]);
	assert.deepEqual(productionConstraintRegistry.descriptors.map((descriptor) => descriptor.key), ["modalities"]);
	assert.equal(productionConstraintRegistry.get("testMinContext"), undefined);
	assert.equal(productionConstraintRegistry.get("testMaxBudget"), undefined);
});

test("injected lower-is-better budget rejects an override above the supported cap", () => {
	const injected = createConstraintRegistry([testMaxBudget as AnyConstraintDescriptor]);
	const resolved = resolution([
		{ provider: "p", modelId: "cheap", model: { ...text, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } },
		{ provider: "p", modelId: "costly", model: { ...rich, cost: { input: 1, output: 5, cacheRead: 1, cacheWrite: 1 } } },
	]);
	const automatic = evaluateConstraints(resolved, {}, injected)[0];
	assert.deepEqual(automatic.aggregate, { automatic: 5, supported: 1 });
	assert.equal(automatic.effective, 5);
	const capped = evaluateConstraints(resolved, { testMaxBudget: 1 }, injected)[0];
	assert.equal(capped.effective, 1);
	const unsupported = evaluateConstraints(resolved, { testMaxBudget: 2 }, injected)[0];
	assert.equal(unsupported.effective, null);
	assert.deepEqual(unsupported.diagnostics, [{ key: "testMaxBudget", code: "unsupported-override", details: 2 }]);
});

test("generic modality prompt presentation preserves effective and empty labels", () => {
	const registry = createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor]);
	const effective = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), {}, registry);
	const empty = evaluateConstraints(resolution([]), {}, registry);
	assert.equal(presentConstraintPrompt(effective, registry).filter(Boolean).join(", ") || "no common modalities", "text, image, reasoning");
	assert.equal(presentConstraintPrompt(empty, registry).filter(Boolean).join(", ") || "no common modalities", "no common modalities");
});

test("generic presentation and number form rows use injected descriptor metadata", () => {
	const injected = createConstraintRegistry([testMinContext as AnyConstraintDescriptor]);
	const evaluations = evaluateConstraints(resolution([{ provider: "p", modelId: "rich", model: rich }]), { testMinContext: 12 }, injected);
	assert.deepEqual(presentConstraintPrompt(evaluations, injected), ["minimum 12 tokens"]);
	assert.deepEqual(constraintEditorRows(testMinContext as AnyConstraintDescriptor, evaluations[0]), [
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
	const result = evaluateConstraints(spyResolution, {}, createConstraintRegistry([modalitiesConstraint as AnyConstraintDescriptor]));
	assert.deepEqual(result[0].effective, ["text", "image", "reasoning"]);
});
