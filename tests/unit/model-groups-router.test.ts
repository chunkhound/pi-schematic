import { expect, test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getEffectiveModelGroupNames, resolveSpawnModelRoute, SpawnRouteError } from "../../model-groups/router.js";
import { createConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { resolveGroups, testProvider, type TestChatModel } from "./model-groups-helpers.js";
import { testMaxBudget, testMinContext } from "./model-groups-constraints-fixture.js";
import { assertPresent } from "../assertions.js";
import { createModelRegistry } from "../support/model-registry.js";

/** The authenticated provider every router test registers its usable models under. */
const P = "mg-router";
/** A provider registered without an API key: its models exist but are not usable. */
const NO_AUTH = "mg-router-noauth";

interface RouterModel extends TestChatModel {
	/** Output cost per million tokens, the fact the synthetic budget descriptor reads. */
	outputCost?: number;
}

function provider(models: readonly RouterModel[], auth: boolean): ProviderConfig {
	const config = testProvider(
		models.map(({ outputCost: _outputCost, ...model }) => ({ reasoning: true, ...model })),
		{ auth },
	);
	return {
		...config,
		models: config.models?.map((model, index) => ({ ...model, cost: { input: 1, output: models[index]?.outputCost ?? 0, cacheRead: 1, cacheWrite: 1 } })),
	};
}

/** A real registry with `models` usable under `P` and `unauthenticated` registered without auth under `NO_AUTH`. Unset reasoning reads as true. */
function routerRegistry(models: readonly RouterModel[], unauthenticated: readonly RouterModel[] = []): Promise<ModelRegistry> {
	return createModelRegistry({ [P]: provider(models, true), [NO_AUTH]: provider(unauthenticated, false) });
}

function found(registry: ModelRegistry, id: string): Model<Api> {
	const model = registry.find(P, id);
	assertPresent(model, `the registry resolves ${P}/${id}`);
	return model;
}

function members(...ids: string[]) {
	return ids.map((modelId) => ({ provider: P, modelId }));
}

test("effective model group names use project-over-global names", async () => {
	const groups = resolveGroups(await routerRegistry([]), {
		global: { review: { models: [] }, research: { models: [] } },
		project: { review: { models: [] } },
	});
	expect(getEffectiveModelGroupNames(groups)).toStrictEqual(["research", "review"]);
});

test("omitted and unknown groups inherit parent route with fallback metadata", async () => {
	const reg = await routerRegistry([{ id: "gpt-parent" }]);
	const parent = found(reg, "gpt-parent");
	expect(resolveSpawnModelRoute({ groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg }).status).toBe("inherited");
	const route = resolveSpawnModelRoute({ requestedGroup: "typo", groups: [], parentModel: parent, parentThinking: "medium", modelRegistry: reg });
	expect(route.status).toBe("unknown-fallback");
	expect(route.requestedGroup).toBe("typo");
	expect(route.model).toBe(parent);
	expect(route.thinking).toBe("medium");
});

test("known empty and all-unusable groups fail clearly", async () => {
	const reg = await routerRegistry([{ id: "parent" }]);
	const parent = found(reg, "parent");
	const groups = resolveGroups(reg, { project: { empty: { models: [] }, bad: { models: members("missing") } } });
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "empty",
			constraints: { modalities: { required: ["image"] } },
			groups,
			parentModel: parent,
			parentThinking: "low",
			modelRegistry: reg,
		}),
	).toThrow(expect.toSatisfy((error: unknown) => error instanceof SpawnRouteError && error.reason === "empty"));
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "bad",
			constraints: { modalities: { required: ["image"] } },
			groups,
			parentModel: parent,
			parentThinking: "low",
			modelRegistry: reg,
		}),
	).toThrow(expect.toSatisfy((error: unknown) => error instanceof SpawnRouteError && error.reason === "no-usable-models"));
});

test("required modalities reject a wholly-incapable group", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "text" }]);
	const groups = resolveGroups(reg, { project: { "text-only": { models: members("text") } } });
	// A group whose effective set does not contain image rejects.
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "text-only",
			constraints: { modalities: { required: ["image"] } },
			groups,
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
		}),
	).toThrow(
		expect.toSatisfy((error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup[0] === "image"),
	);
});

test("automatic mixed groups default effective to the union so a capability routes to a capable member", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "text" }, { id: "image", input: ["text", "image"] }]);
	const parent = found(reg, "parent");
	// No explicit override: the router reconciles fresh, and the group gate now sees
	// the union default, so the image requirement passes and D1 lands on the image
	// member even when rng targets the text-only member (index 0).
	const route = resolveSpawnModelRoute({
		requestedGroup: "mixed-auto",
		constraints: { modalities: { required: ["image"] } },
		groups: resolveGroups(reg, { project: { "mixed-auto": { models: members("text", "image") } } }),
		parentModel: parent,
		parentThinking: "low",
		modelRegistry: reg,
		rng: () => 0,
	});
	expect(route.status).toBe("routed");
	expect(route.modelId).toBe("image");
	// Automatic groups carry no ceiling.
	expect(route.groupCapabilityCeilings).toBeUndefined();
	// The union never invents capabilities no member has: a reasoning requirement on
	// members that all lack reasoning still rejects with the group miss.
	const reg2 = await routerRegistry([{ id: "parent" }, { id: "text-nr", reasoning: false }, { id: "image-nr", input: ["text", "image"], reasoning: false }]);
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "mixed-auto-noreasoning",
			constraints: { modalities: { required: ["reasoning"] } },
			groups: resolveGroups(reg2, { project: { "mixed-auto-noreasoning": { models: members("text-nr", "image-nr") } } }),
			parentModel: found(reg2, "parent"),
			parentThinking: "low",
			modelRegistry: reg2,
		}),
	).toThrow(
		expect.toSatisfy((error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup[0] === "reasoning"),
	);
});

test("capability pre-selection excludes unauthenticated capable models and picks randomly from the capable set", async () => {
	// cap-unavailable is not auth-configured, so it must be excluded from the capable pool.
	const reg = await routerRegistry(
		[{ id: "parent" }, { id: "cap-a", input: ["text", "image"] }, { id: "cap-b", input: ["text", "image"] }, { id: "text" }],
		[{ id: "cap-unavailable", input: ["text", "image"] }],
	);
	const groups = resolveGroups(reg, {
		project: {
			mixed: {
				models: [...members("text", "cap-a"), { provider: NO_AUTH, modelId: "cap-unavailable" }, ...members("cap-b")],
				constraints: { modalities: ["text", "image"] },
			},
		},
	});
	let draws = 0;
	// Cycling draws reach every index of a three-member pool, so an unfiltered pool would yield cap-unavailable.
	const pick = () =>
		resolveSpawnModelRoute({
			requestedGroup: "mixed",
			constraints: { modalities: { required: ["image"] } },
			groups,
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
			rng: () => [0.05, 0.5, 0.95][draws++ % 3],
		}).modelId;
	const seen = new Set<string>();
	for (let i = 0; i < 6; i++) {
		const id = pick();
		expect(id !== "text", "must never pick the non-capable member").toBe(true);
		expect(id !== "cap-unavailable", "must never pick the unauthenticated member").toBe(true);
		seen.add(id);
	}
	expect(draws, "every selection must consult the RNG — no cursor short-circuit").toBe(6);
	expect(seen.has("cap-a") && seen.has("cap-b"), `expected random selection to reach both capable members, got ${[...seen].join(",")}`).toBe(true);
});

test("unknown group with a modality requirement rejects on the inherited model", async () => {
	const reg = await routerRegistry([{ id: "parent" }]);
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "unknown",
			constraints: { modalities: { required: ["image"] } },
			groups: [],
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
		}),
	).toThrow(
		expect.objectContaining({
			name: "SpawnRouteError",
			group: "unknown",
			message: "Spawn model 'mg-router/parent' cannot satisfy required modalities: image.",
		}),
	);
});

test("injected scalar requirements use generic violations, not modality arrays", async () => {
	const reg = await routerRegistry([
		{ id: "parent", contextWindow: 100 },
		{ id: "small", contextWindow: 10 },
	]);
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "small",
			constraints: { testMinContext: 20 },
			groups: resolveGroups(reg, { project: { small: { models: members("small") } } }),
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
			constraintRegistry: createConstraintRegistry([testMinContext]),
		}),
	).toThrow(
		expect.toSatisfy(
			(error: unknown) =>
				error instanceof SpawnRouteError &&
				error.reason === "constraint-unsatisfied" &&
				error.constraintUnsatisfied?.length === 2 &&
				error.missingModalities.length === 0 &&
				error.missingFromGroup.length === 0 &&
				error.missingFromModel.length === 0,
		),
	);
});

test("generic scalar requirements narrow mixed groups in both comparison directions", async () => {
	const reg = await routerRegistry([
		{ id: "parent", contextWindow: 100, outputCost: 1 },
		{ id: "small-cheap", contextWindow: 10, outputCost: 1 },
		{ id: "large-costly", contextWindow: 100, outputCost: 5 },
	]);
	const injected = createConstraintRegistry([testMinContext, testMaxBudget]);
	const groups = resolveGroups(reg, {
		project: {
			min: { models: members("small-cheap", "large-costly"), constraints: { testMinContext: 50 } },
			budget: { models: members("large-costly", "small-cheap"), constraints: { testMaxBudget: 1 } },
		},
	});
	const minRoute = resolveSpawnModelRoute({
		requestedGroup: "min",
		constraints: { testMinContext: 50 },
		groups,
		parentModel: found(reg, "parent"),
		parentThinking: "low",
		modelRegistry: reg,
		constraintRegistry: injected,
		rng: () => 0,
	});
	expect(minRoute.modelId, "higher-is-better requirements select the >= capable member").toBe("large-costly");
	expect(minRoute.groupCapabilityCeilings).toStrictEqual(["Minimum context is capped at 50 tokens for this group."]);

	const budgetRoute = resolveSpawnModelRoute({
		requestedGroup: "budget",
		constraints: { testMaxBudget: 2 },
		groups,
		parentModel: found(reg, "parent"),
		parentThinking: "low",
		modelRegistry: reg,
		constraintRegistry: injected,
		rng: () => 0,
	});
	expect(budgetRoute.modelId, "lower-is-better requirements select the <= capable member").toBe("small-cheap");
	expect(budgetRoute.groupCapabilityCeilings).toStrictEqual(["Maximum output budget is capped at 1 credits for this group."]);
});

test("bare-array constraint requirements are rejected by the descriptor codec", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "text" }]);
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "g",
			constraints: { modalities: ["image"] },
			groups: resolveGroups(reg, { project: { g: { models: members("text") } } }),
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
		}),
	).toThrow(/must be an object with required modalities/);
});

test("routed empty modality requirements select by RNG across usable members", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "first" }, { id: "second" }]);
	const route = resolveSpawnModelRoute({
		requestedGroup: "routed",
		constraints: { modalities: { required: [] } },
		groups: resolveGroups(reg, { project: { routed: { models: members("first", "second") } } }),
		parentModel: found(reg, "parent"),
		parentThinking: "medium",
		modelRegistry: reg,
		rng: () => 0.75,
	});
	expect(route.modelId, "the RNG-selected member wins when no members are narrowed out").toBe("second");
});

test("plain inherited route treats empty requiredModalities as satisfied", async () => {
	const reg = await routerRegistry([{ id: "text-parent", input: ["text"] }]);
	// The requirement check runs and an empty requirement passes, so the route stays inherited.
	expect(
		resolveSpawnModelRoute({
			constraints: { modalities: { required: [] } },
			groups: [],
			parentModel: found(reg, "text-parent"),
			parentThinking: "medium",
			modelRegistry: reg,
		}).status,
	).toBe("inherited");
});

test("plain inherited route stays inherited when the parent model has every required modality", async () => {
	const reg = await routerRegistry([{ id: "rich-parent", input: ["text", "image"] }]);
	expect(
		resolveSpawnModelRoute({
			constraints: { modalities: { required: ["text", "image"] } },
			groups: [],
			parentModel: found(reg, "rich-parent"),
			parentThinking: "medium",
			modelRegistry: reg,
		}).status,
	).toBe("inherited");
});

test("plain inherited route rejects a modality the parent model lacks", async () => {
	const reg = await routerRegistry([{ id: "text-parent", input: ["text"] }]);
	expect(() =>
		resolveSpawnModelRoute({
			constraints: { modalities: { required: ["image"] } },
			groups: [],
			parentModel: found(reg, "text-parent"),
			parentThinking: "medium",
			modelRegistry: reg,
		}),
	).toThrow(
		expect.objectContaining({
			name: "SpawnRouteError",
			group: "<inherited>",
			message: "Spawn model 'mg-router/text-parent' cannot satisfy required modalities: image.",
		}),
	);
});

test("explicit group override carries a modality ceiling even when caller declares no requirement", async () => {
	const reg = await routerRegistry([{ id: "gpt-parent" }, { id: "gpt-vision", input: ["text", "image"], reasoning: true }]);
	const route = resolveSpawnModelRoute({
		requestedGroup: "posed",
		groups: resolveGroups(reg, { project: { posed: { models: members("gpt-vision"), constraints: { modalities: ["text", "reasoning"] } } } }),
		parentModel: found(reg, "gpt-parent"),
		parentThinking: "medium",
		modelRegistry: reg,
	});
	expect(route.status).toBe("routed");
	expect(route.groupCapabilityCeilings).toStrictEqual([
		"Image input is disabled for this group. If the task requires reading or inspecting an image, do not work around it with OCR, third-party tools, or an alternate route; report the capability mismatch to the parent instead.",
	]);
});

test("groups without an explicit override get no modality ceiling", async () => {
	const reg = await routerRegistry([{ id: "gpt-parent" }, { id: "gpt-vision", input: ["text", "image"], reasoning: true }]);
	const route = resolveSpawnModelRoute({
		requestedGroup: "openbox",
		groups: resolveGroups(reg, { project: { openbox: { models: members("gpt-vision") } } }),
		parentModel: found(reg, "gpt-parent"),
		parentThinking: "medium",
		modelRegistry: reg,
	});
	expect(route.status).toBe("routed");
	expect(route.groupCapabilityCeilings).toBeUndefined();
});

test("explicit override stays a subtractive ceiling even when a capable member exists", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "gpt-vision", input: ["text", "image"], reasoning: true }, { id: "text" }]);
	// The group gate must still reject image even though the routed member itself
	// supports it: the override is the declared ceiling (rng lands on the vision member).
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "posed",
			constraints: { modalities: { required: ["image"] } },
			groups: resolveGroups(reg, { project: { posed: { models: members("gpt-vision", "text"), constraints: { modalities: ["text", "reasoning"] } } } }),
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
			rng: () => 0,
		}),
	).toThrow(
		expect.toSatisfy(
			(error: unknown) =>
				error instanceof SpawnRouteError && error.reason === "missing-modality" && error.missingFromGroup[0] === "image" && error.missingFromModel.length === 0,
		),
	);
});

test("routed member without a thinking level inherits the parent thinking level", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "member" }]);
	const route = resolveSpawnModelRoute({
		requestedGroup: "inherit",
		groups: resolveGroups(reg, { project: { inherit: { models: members("member") } } }),
		parentModel: found(reg, "parent"),
		parentThinking: "high",
		modelRegistry: reg,
	});
	expect(route.thinking).toBe("high");
});

test("known group missing a required modality rejects with the full message", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "text" }]);
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "text",
			constraints: { modalities: { required: ["image"] } },
			groups: resolveGroups(reg, { project: { text: { models: members("text") } } }),
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
		}),
	).toThrow(
		expect.objectContaining({
			name: "SpawnRouteError",
			message:
				"Model Group 'text' cannot satisfy required modalities: image. Effective group modalities missing: image. Routed model 'mg-router/text' missing: image.",
		}),
	);
});

test("unsatisfied constraint requirement rejects with the full message", async () => {
	const reg = await routerRegistry([
		{ id: "parent", contextWindow: 100 },
		{ id: "small", contextWindow: 10 },
	]);
	expect(() =>
		resolveSpawnModelRoute({
			requestedGroup: "small",
			constraints: { testMinContext: 20 },
			groups: resolveGroups(reg, { project: { small: { models: members("small") } } }),
			parentModel: found(reg, "parent"),
			parentThinking: "low",
			modelRegistry: reg,
			constraintRegistry: createConstraintRegistry([testMinContext]),
		}),
	).toThrow(expect.objectContaining({ name: "SpawnRouteError", message: "Spawn route 'small' cannot satisfy constraint requirements." }));
});

test("requested group name is trimmed and an empty name inherits", async () => {
	const reg = await routerRegistry([{ id: "parent" }, { id: "member" }]);
	const groups = resolveGroups(reg, { project: { review: { models: members("member") } } });
	const route = (requestedGroup: string) =>
		resolveSpawnModelRoute({ requestedGroup, groups, parentModel: found(reg, "parent"), parentThinking: "low", modelRegistry: reg });

	expect(route(" review ").groupName).toBe("review");
	expect(route("").status).toBe("inherited");
});
