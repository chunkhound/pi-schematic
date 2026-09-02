import test from "node:test";
import assert from "node:assert/strict";
import { getEffectiveModelGroupNames, resolveSpawnModelRoute, SpawnRouteError } from "../../model-groups/router.js";
import { createConstraintRegistry } from "../../model-groups/constraints/registry.js";
import type { ResolvedModelGroup } from "../../model-groups/types.js";
import { group } from "./model-groups-helpers.js";
import { testMaxBudget, testMinContext } from "./model-groups-constraints-fixture.js";

function model(provider: string, id: string, overrides: Record<string, unknown> = {}): any {
	return { provider, id, reasoning: true, input: ["text"], ...overrides };
}

function registry(models: any[], authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`))): any {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: any) => authenticated.has(`${m.provider}:${m.id}`),
	};
}

test("effective model group names use project-over-global names", () => {
	const groups = [group("review", { scope: "global", shadowedByProject: true }), group("review", { scope: "project" }), group("research", { scope: "global" })];
	assert.deepEqual(getEffectiveModelGroupNames(groups), ["research", "review"]);
});

test("omitted and unknown groups inherit parent route with fallback metadata", () => {
	const parent = model("openai", "gpt-parent");
	const reg = registry([parent]);
	assert.deepEqual(resolveSpawnModelRoute({ groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg }).status, "inherited");
	const route = resolveSpawnModelRoute({ requestedGroup: "typo", groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg });
	assert.equal(route.status, "unknown-fallback"); assert.equal(route.requestedGroup, "typo"); assert.equal(route.model, parent); assert.equal(route.thinking, "medium");
});

test("known empty and all-unusable groups fail clearly", () => {
	const parent = model("openai", "parent");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "empty", constraints: { modalities: { required: ["image"] } }, groups: [group("empty", { scope: "project" })], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "empty");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "bad", constraints: { modalities: { required: ["image"] } }, groups: [group("bad", { scope: "project", models: [{ provider: "openai", modelId: "missing" }] })], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "no-usable-models");
});

test("required modalities prefer a capable member and still reject a wholly-incapable group", () => {
	const parent = model("p", "parent");
	const text = model("p", "text");
	const image = model("p", "image", { input: ["text", "image"] });
	const routed = group("mixed", { models: [{ provider: "p", modelId: "text" }, { provider: "p", modelId: "image" }], constraints: { modalities: ["text", "image"] } });
	routed.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	const reg = registry([parent, text, image]);
	// Capability pre-selection: even when rng would land on the text-only member (index 0),
	// the router narrows to members whose individual modality fact satisfies image.
	const route = resolveSpawnModelRoute({ requestedGroup: "mixed", constraints: { modalities: { required: ["image"] } }, groups: [routed], parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => 0 });
	assert.equal(route.status, "routed");
	assert.equal(route.modelId, "image");
	// A group whose effective set does not contain image still rejects.
	const textOnly = group("text-only", { models: [{ provider: "p", modelId: "text" }] });
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "text-only", constraints: { modalities: { required: ["image"] } }, groups: [textOnly], parentModel: parent, parentThinking: "low", modelRegistry: reg }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup[0] === "image");
});

test("automatic mixed groups default effective to the union so a capability routes to a capable member", () => {
	const parent = model("p", "parent");
	const text = model("p", "text");
	const image = model("p", "image", { input: ["text", "image"] });
	const routed = group("mixed-auto", { models: [{ provider: "p", modelId: "text" }, { provider: "p", modelId: "image" }] });
	// No explicit override: the router reconciles fresh, and the group gate now sees
	// the union default, so the image requirement passes and D1 lands on the image
	// member even when rng targets the text-only member (index 0).
	const reg = registry([parent, text, image]);
	const route = resolveSpawnModelRoute({ requestedGroup: "mixed-auto", constraints: { modalities: { required: ["image"] } }, groups: [routed], parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => 0 });
	assert.equal(route.status, "routed");
	assert.equal(route.modelId, "image");
	// Automatic groups carry no ceiling.
	assert.equal(route.groupCapabilityCeilings, undefined);
	// The union never invents capabilities no member has: a reasoning requirement on
	// members that all lack reasoning still rejects with the group miss.
	const textNr = model("p", "text-nr", { reasoning: false });
	const imageNr = model("p", "image-nr", { input: ["text", "image"], reasoning: false });
	const reg2 = registry([parent, textNr, imageNr]);
	const routed2 = group("mixed-auto-noreasoning", { models: [{ provider: "p", modelId: "text-nr" }, { provider: "p", modelId: "image-nr" }] });
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "mixed-auto-noreasoning", constraints: { modalities: { required: ["reasoning"] } }, groups: [routed2], parentModel: parent, parentThinking: "low", modelRegistry: reg2 }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup[0] === "reasoning");
});

test("capability pre-selection excludes unauthenticated capable models and picks randomly from the capable set", () => {
	const parent = model("p", "parent");
	const capA = model("p", "cap-a", { input: ["text", "image"] });
	const capB = model("p", "cap-b", { input: ["text", "image"] });
	const unavailable = model("p", "cap-unavailable", { input: ["text", "image"] });
	const text = model("p", "text");
	const routed = group("mixed", { models: [
		{ provider: "p", modelId: "text" },
		{ provider: "p", modelId: "cap-a" },
		{ provider: "p", modelId: "cap-unavailable" },
		{ provider: "p", modelId: "cap-b" },
	], constraints: { modalities: ["text", "image"] } });
	routed.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	// cap-unavailable is not auth-configured, so it must be excluded from the capable pool.
	const reg = registry([parent, capA, capB, text], new Set(["p:cap-a", "p:cap-b", "p:text"]));
	let draws = 0;
	// Random selection over the filtered pool: alternating draws land on each capable member.
	const pick = () => resolveSpawnModelRoute({ requestedGroup: "mixed", constraints: { modalities: { required: ["image"] } }, groups: [routed], parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => (draws++ % 2 === 0 ? 0.05 : 0.95) }).modelId;
	const seen = new Set<string>();
	for (let i = 0; i < 6; i++) {
		const id = pick();
		assert.ok(id !== "text", "must never pick the non-capable member");
		assert.ok(id !== "cap-unavailable", "must never pick the unauthenticated member");
		seen.add(id);
	}
	assert.equal(draws, 6, "every selection must consult the RNG — no cursor short-circuit");
	assert.ok(seen.has("cap-a") && seen.has("cap-b"), `expected random selection to reach both capable members, got ${[...seen]}`);
});

test("known group missing effective modality and inherited fallback reject requirements", () => {
	const parent = model("p", "parent"); const text = model("p", "text"); const g = group("text", { models: [{ provider: "p", modelId: "text" }] });
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "text", constraints: { modalities: { required: ["image"] } }, groups: [g], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent, text]) }), (error: unknown) => error instanceof SpawnRouteError && error.missingFromGroup[0] === "image");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "unknown", constraints: { modalities: { required: ["image"] } }, groups: [], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent]) }), (error: unknown) => error instanceof SpawnRouteError && error.group === "unknown" && /Spawn model/.test(error.message));
});

test("injected scalar requirements use generic violations, not modality arrays", () => {
	const parent = model("p", "parent", { contextWindow: 100 }); const small = model("p", "small", { contextWindow: 10 });
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "small", constraints: { testMinContext: 20 }, groups: [group("small", { models: [{ provider: "p", modelId: "small" }] })], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent, small]), constraintRegistry: createConstraintRegistry([testMinContext]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "constraint-unsatisfied" && error.constraintUnsatisfied?.length === 2 && error.missingModalities.length === 0 && error.missingFromGroup.length === 0 && error.missingFromModel.length === 0);
});

test("generic scalar requirements narrow mixed groups in both comparison directions", () => {
	const parent = model("p", "parent", { contextWindow: 100, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
	const smallCheap = model("p", "small-cheap", { contextWindow: 10, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
	const largeCostly = model("p", "large-costly", { contextWindow: 100, cost: { input: 1, output: 5, cacheRead: 1, cacheWrite: 1 } });
	const reg = registry([parent, smallCheap, largeCostly]);
	const injected = createConstraintRegistry([testMinContext, testMaxBudget]);
	const minGroup = group("min", { models: [{ provider: "p", modelId: "small-cheap" }, { provider: "p", modelId: "large-costly" }], constraints: { testMinContext: 50 } });
	const minRoute = resolveSpawnModelRoute({ requestedGroup: "min", constraints: { testMinContext: 50 }, groups: [minGroup], parentModel: parent, parentThinking: "low", modelRegistry: reg, constraintRegistry: injected, rng: () => 0 });
	assert.equal(minRoute.modelId, "large-costly", "higher-is-better requirements select the >= capable member");
	assert.deepEqual(minRoute.groupCapabilityCeilings, ["Minimum context is capped at 50 tokens for this group."]);

	const budgetGroup = group("budget", { models: [{ provider: "p", modelId: "large-costly" }, { provider: "p", modelId: "small-cheap" }], constraints: { testMaxBudget: 1 } });
	const budgetRoute = resolveSpawnModelRoute({ requestedGroup: "budget", constraints: { testMaxBudget: 2 }, groups: [budgetGroup], parentModel: parent, parentThinking: "low", modelRegistry: reg, constraintRegistry: injected, rng: () => 0 });
	assert.equal(budgetRoute.modelId, "small-cheap", "lower-is-better requirements select the <= capable member");
	assert.deepEqual(budgetRoute.groupCapabilityCeilings, ["Maximum output budget is capped at 1 credits for this group."]);
});

test("bare-array constraint requirements are rejected by the descriptor codec", () => {
	const parent = model("p", "parent");
	const text = model("p", "text");
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "g", constraints: { modalities: ["image"] } as any, groups: [group("g", { models: [{ provider: "p", modelId: "text" }] })], parentModel: parent, parentThinking: "low", modelRegistry: registry([parent, text]) }), /must be an object with required modalities/);
});

test("routed empty modality requirements select by RNG across usable members", () => {
	const parent = model("p", "parent");
	const first = model("p", "first");
	const second = model("p", "second");
	let rngCalls = 0;
	const route = resolveSpawnModelRoute({
		requestedGroup: "routed",
		constraints: { modalities: { required: [] } },
		groups: [group("routed", { models: [{ provider: "p", modelId: "first" }, { provider: "p", modelId: "second" }] })],
		parentModel: parent,
		parentThinking: "medium",
		modelRegistry: registry([parent, first, second]),
		rng: () => { rngCalls++; return 0.75; },
	});
	assert.equal(route.modelId, "second", "the RNG-selected member wins when no members are narrowed out");
	assert.equal(rngCalls, 1, "exactly one RNG draw for the member selection");
});

test("plain inherited route honors requiredModalities with empty-array no-op", () => {
	const rich = model("p", "rich-parent", { input: ["text", "image"] });
	const text = model("p", "text-parent", { input: ["text"] });
	// Empty array is a no-op: route returns unchanged, no requirement check.
	assert.deepEqual(resolveSpawnModelRoute({ constraints: { modalities: { required: [] } }, groups: [], parentModel: text, parentThinking: "medium", modelRegistry: registry([text]) }).status, "inherited");
	// Parent satisfies all requirements → inherited route succeeds.
	assert.deepEqual(resolveSpawnModelRoute({ constraints: { modalities: { required: ["text", "image"] } }, groups: [], parentModel: rich, parentThinking: "medium", modelRegistry: registry([rich]) }).status, "inherited");
	// Parent lacks a required modality → missing-modality with the parent model details.
	assert.throws(() => resolveSpawnModelRoute({ constraints: { modalities: { required: ["image"] } }, groups: [], parentModel: text, parentThinking: "medium", modelRegistry: registry([text]) }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.group === "<inherited>" && error.missingFromModel[0] === "image" && error.missingFromGroup.length === 0 && /Spawn model/.test(error.message));
});

test("explicit group override carries a modality ceiling even when caller declares no requirement", () => {
	const parent = model("openai", "gpt-parent");
	const vision = model("openai", "gpt-vision", { input: ["text", "image"], reasoning: true });
	const g = group("posed", {
		models: [{ provider: "openai", modelId: "gpt-vision" }],
		constraints: { modalities: ["text", "reasoning"] },
	});
	g.modalities.effective = ["text", "reasoning"];
	const route = resolveSpawnModelRoute({ requestedGroup: "posed", groups: [g], parentModel: parent, parentThinking: "medium", modelRegistry: registry([parent, vision]) });
	assert.equal(route.status, "routed");
	assert.deepEqual(route.groupCapabilityCeilings, ["Image input is disabled for this group. If the task requires reading or inspecting an image, do not work around it with OCR, third-party tools, or an alternate route; report the capability mismatch to the parent instead."]);
});

test("groups without an explicit override get no modality ceiling", () => {
	const parent = model("openai", "gpt-parent");
	const vision = model("openai", "gpt-vision", { input: ["text", "image"], reasoning: true });
	const g = group("openbox", { models: [{ provider: "openai", modelId: "gpt-vision" }] });
	g.modalities.effective = ["text", "image", "reasoning"];
	const route = resolveSpawnModelRoute({ requestedGroup: "openbox", groups: [g], parentModel: parent, parentThinking: "medium", modelRegistry: registry([parent, vision]) });
	assert.equal(route.status, "routed");
	assert.equal(route.groupCapabilityCeilings, undefined);
});

test("explicit override stays a subtractive ceiling even when a capable member exists", () => {
	const parent = model("p", "parent");
	const vision = model("p", "gpt-vision", { input: ["text", "image"], reasoning: true });
	const text = model("p", "text");
	const g = group("posed", { models: [{ provider: "p", modelId: "gpt-vision" }, { provider: "p", modelId: "text" }], constraints: { modalities: ["text", "reasoning"] } });
	g.modalities.effective = ["text", "reasoning"];
	// The group gate must still reject image even though the routed member itself
	// supports it: the override is the declared ceiling (rng lands on the vision member).
	const reg = registry([parent, vision, text]);
	assert.throws(() => resolveSpawnModelRoute({ requestedGroup: "posed", constraints: { modalities: { required: ["image"] } }, groups: [g], parentModel: parent, parentThinking: "low", modelRegistry: reg, rng: () => 0 }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup[0] === "image" && error.missingFromModel.length === 0);
});
