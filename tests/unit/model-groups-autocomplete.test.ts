import test from "node:test";
import assert from "node:assert/strict";
import { createModelGroupAutocompleteProvider, registerModelGroupAutocomplete } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import type { ResolvedModelGroup } from "../../model-groups/types.js";
import { group } from "./model-groups-helpers.js";

test("#group autocomplete suggests effective live group names and delegates elsewhere", async () => {
	const state = createState();
	state.modelGroups.groups = [
		group("review", { models: [
			{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
			{ provider: "anthropic", modelId: "claude-sonnet-4" },
		]}),
		group("research", { models: [{ provider: "google", modelId: "gemini-2.5-pro", thinkingLevel: "xhigh" }] }),
	];
	let delegated = 0;
	const current = {
		getSuggestions: async () => { delegated++; return { prefix: "", items: [{ value: "delegated" }] }; },
		applyCompletion: () => "applied",
		shouldTriggerFileCompletion: () => false,
	};
	const provider = createModelGroupAutocompleteProvider(state)(current as any);

	const suggestions = await provider.getSuggestions(["spawn #re"], 0, "spawn #re".length, {});
	assert.equal(suggestions.prefix, "#re");
	assert.deepEqual(suggestions.items.map((item: any) => item.value), ["#research", "#review"]);
	assert.deepEqual(suggestions.items.map((item: any) => item.description), [
		"google/gemini-2.5-pro • xhigh",
		"openai/gpt-5 • high; anthropic/claude-sonnet-4 • inherit",
	]);
	assert.equal(delegated, 0);

	state.modelGroups.groups = [group("reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }], unavailableRefs: [{ provider: "openai", modelId: "gpt-5" }] })];
	const fresh = await provider.getSuggestions(["#rev"], 0, 4, {});
	assert.deepEqual(fresh.items.map((item: any) => item.value), ["#reviewers"]);
	assert.equal(fresh.items[0].description, "openai/gpt-5 • inherit (unavailable)");

	const other = await provider.getSuggestions(["no hash"], 0, 7, {});
	assert.equal(delegated, 1);
	assert.deepEqual(other.items.map((item: any) => item.value), ["delegated"]);
	assert.equal(provider.applyCompletion([], 0, 0, {}, "#re"), "applied");
	assert.equal(provider.shouldTriggerFileCompletion([], 0, 0), false);
});

test("#group autocomplete prepends colored effective modal letters when a colorizer is supplied", async () => {
	const state = createState();
	state.modelGroups.groups = [group("research", { models: [{ provider: "google", modelId: "gemini-2.5-pro", thinkingLevel: "high" }] })];
	// Unordered effective set; must canonicalize, drop reasoning, and consolidate text being implied.
	state.modelGroups.groups[0].modalities = { common: [], supported: [], effective: ["reasoning", "image", "text"] };
	let delegated = 0;
	const current = {
		getSuggestions: async () => { delegated++; return { prefix: "", items: [{ value: "delegated" }] }; },
		applyCompletion: () => "applied",
		shouldTriggerFileCompletion: () => false,
	};
	const provide = createModelGroupAutocompleteProvider(state, (color, text) => `<${color}>${text}</${color}>`)(current as any);
	const { items } = await provide.getSuggestions(["#res"], 0, 4, {});
	const description = items[0].description;
	// Image presence implies text -> only the image letter shows; no reasoning.
	assert.match(description, /<success>I<\/success>/);
	assert.ok(!/<syntaxKeyword>T<\/syntaxKeyword>/.test(description), "text suppressed when image present");
	assert.ok(!/R<\//.test(description), "reasoning excluded");
	// Muted wrappers around the gaps and the appended per-model route details.
	assert.match(description, /<muted>  <\/muted><muted>google\/gemini-2\.5-pro • high<\/muted>/);
	assert.equal(delegated, 0);
});

test("registerModelGroupAutocomplete uses ctx.ui.addAutocompleteProvider once", () => {
	const state = createState();
	const providers: any[] = [];
	const ctx = { hasUI: true, ui: { addAutocompleteProvider: (factory: any) => providers.push(factory) } };
	registerModelGroupAutocomplete(ctx as any, state);
	registerModelGroupAutocomplete(ctx as any, state);
	assert.equal(providers.length, 1);
});

test("group autocomplete consolidates to a single consistent letter column", async () => {
	const state = createState();
	state.modelGroups.groups = [
		group("alpha", { models: [{ provider: "anthropic", modelId: "claude", thinkingLevel: "high" }] }),
		group("beta", { models: [{ provider: "openai", modelId: "gpt-5" }] }),
	];
	// alpha has image (implies text) -> single I; beta is text-only -> single T.
	state.modelGroups.groups[0].modalities = { common: [], supported: [], effective: ["text", "image"] };
	state.modelGroups.groups[1].modalities = { common: [], supported: [], effective: ["text"] };
	const identity = (color: string, text: string) => text;
	const provide = createModelGroupAutocompleteProvider(state, identity as any)({ getSuggestions: async () => null } as any);
	const { items } = await provide.getSuggestions(["#"], 0, 1, {});
	const alpha = items[0].description;
	const beta = items[1].description;
	// Both collapse to a single colored column, so each route starts at the same offset.
	assert.equal(alpha, "I  anthropic/claude • high");
	assert.equal(beta, "T  openai/gpt-5 • inherit");
	assert.equal(alpha.indexOf("anthropic/claude"), 3);
	assert.equal(beta.indexOf("openai/gpt-5"), 3);
});
