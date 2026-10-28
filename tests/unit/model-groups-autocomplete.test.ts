import test from "node:test";
import assert from "node:assert/strict";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createModelGroupAutocompleteProvider, registerModelGroupAutocomplete } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import type { ResolvedModelGroup } from "../../model-groups/types.js";
import { group } from "./model-groups-helpers.js";

function suggestOptions() {
	return { signal: new AbortController().signal };
}

function completionItem(value: string): AutocompleteItem {
	return { value, label: value };
}

function delegateProvider(onGetSuggestions: () => void = () => {}): AutocompleteProvider {
	return {
		getSuggestions: async () => { onGetSuggestions(); return { prefix: "", items: [completionItem("delegated")] }; },
		applyCompletion: () => ({ lines: ["applied"], cursorLine: 0, cursorCol: 7 }),
		shouldTriggerFileCompletion: () => false,
	};
}

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
	const provider = createModelGroupAutocompleteProvider(state)(delegateProvider(() => { delegated++; }));

	const suggestions = await provider.getSuggestions(["spawn #re"], 0, "spawn #re".length, suggestOptions());
	assert.ok(suggestions);
	assert.equal(suggestions.prefix, "#re");
	assert.deepEqual(suggestions.items.map((item) => item.value), ["#research", "#review"]);
	assert.deepEqual(suggestions.items.map((item) => item.description), [
		"google/gemini-2.5-pro • xhigh",
		"openai/gpt-5 • high; anthropic/claude-sonnet-4 • inherit",
	]);
	assert.equal(delegated, 0);

	state.modelGroups.groups = [group("reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }], unavailableRefs: [{ provider: "openai", modelId: "gpt-5" }] })];
	const fresh = await provider.getSuggestions(["#rev"], 0, 4, suggestOptions());
	assert.ok(fresh);
	assert.deepEqual(fresh.items.map((item) => item.value), ["#reviewers"]);
	assert.equal(fresh.items[0]?.description, "openai/gpt-5 • inherit (unavailable)");

	const other = await provider.getSuggestions(["no hash"], 0, 7, suggestOptions());
	assert.equal(delegated, 1);
	assert.ok(other);
	assert.deepEqual(other.items.map((item) => item.value), ["delegated"]);
	assert.deepEqual(provider.applyCompletion([], 0, 0, completionItem("#review"), "#re"), { lines: ["applied"], cursorLine: 0, cursorCol: 7 });
	assert.equal(provider.shouldTriggerFileCompletion?.([], 0, 0), false);
});

test("#group autocomplete hands the delegate the caller's getSuggestions options unchanged", async () => {
	const state = createState();
	let receivedOptions: unknown;
	const current: AutocompleteProvider = {
		...delegateProvider(),
		getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => { receivedOptions = options; return null; },
	};
	const provider = createModelGroupAutocompleteProvider(state)(current);
	const options = { signal: new AbortController().signal, force: true };

	await provider.getSuggestions(["no hash"], 0, 7, options);

	assert.equal(receivedOptions, options);
});

test("#group autocomplete hands the delegate the caller's completion item unchanged", () => {
	const state = createState();
	let receivedItem: unknown;
	const current: AutocompleteProvider = {
		...delegateProvider(),
		applyCompletion: (lines, cursorLine, cursorCol, item) => { receivedItem = item; return { lines, cursorLine, cursorCol }; },
	};
	const provider = createModelGroupAutocompleteProvider(state)(current);
	const item = completionItem("src/index.ts");

	provider.applyCompletion(["@src"], 0, 4, item, "@src");

	assert.equal(receivedItem, item);
});

test("#group autocomplete triggers file completion when the delegate does not decide", () => {
	const state = createState();
	const { shouldTriggerFileCompletion: _omitted, ...current } = delegateProvider();
	const provider = createModelGroupAutocompleteProvider(state)(current);

	assert.equal(provider.shouldTriggerFileCompletion?.(["@src"], 0, 4), true);
});

test("#group autocomplete prepends colored effective modal letters when a colorizer is supplied", async () => {
	const state = createState();
	state.modelGroups.groups = [group("research", { models: [{ provider: "google", modelId: "gemini-2.5-pro", thinkingLevel: "high" }] })];
	// Unordered effective set; must canonicalize, drop reasoning, and consolidate text being implied.
	state.modelGroups.groups[0].modalities = { common: [], supported: [], effective: ["reasoning", "image", "text"] };
	let delegated = 0;
	const provide = createModelGroupAutocompleteProvider(state, (color, text) => `<${color}>${text}</${color}>`)(delegateProvider(() => { delegated++; }));
	const suggestions = await provide.getSuggestions(["#res"], 0, 4, suggestOptions());
	assert.ok(suggestions);
	const description = suggestions.items[0]?.description;
	assert.ok(description);
	// Image presence implies text -> only the image letter shows; no reasoning.
	assert.match(description, /<success>I<\/success>/);
	assert.ok(!/<syntaxKeyword>T<\/syntaxKeyword>/.test(description), "text suppressed when image present");
	assert.ok(!/R<\//.test(description), "reasoning excluded");
	// Muted wrappers around the gaps and the appended per-model route details.
	assert.match(description, /<muted>  <\/muted><muted>google\/gemini-2\.5-pro • high<\/muted>/);
	assert.equal(delegated, 0);
});

test("registerModelGroupAutocomplete installs one model-groups provider per UI", () => {
	const state = createState();
	const providers: any[] = [];
	const ui = { addAutocompleteProvider: (factory: any) => providers.push(factory) };
	registerModelGroupAutocomplete({ hasUI: true, ui } as any, state);
	registerModelGroupAutocomplete({ hasUI: true, ui } as any, state);
	assert.equal(providers.length, 1, "re-registration on the same UI does not stack");
	// A replacement UI gets its own install.
	const next: any[] = [];
	registerModelGroupAutocomplete({ hasUI: true, ui: { addAutocompleteProvider: (f: any) => next.push(f) } } as any, state);
	assert.equal(next.length, 1, "a fresh UI is not blocked by the per-key guard");
	// Headless contexts install nothing.
	registerModelGroupAutocomplete({ hasUI: false, ui } as any, state);
	assert.equal(providers.length, 1, "headless contexts install nothing");
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
	const provide = createModelGroupAutocompleteProvider(state, identity)(delegateProvider());
	const suggestions = await provide.getSuggestions(["#"], 0, 1, suggestOptions());
	assert.ok(suggestions);
	const alpha = suggestions.items[0]?.description;
	const beta = suggestions.items[1]?.description;
	assert.ok(alpha);
	assert.ok(beta);
	// Both collapse to a single colored column, so each route starts at the same offset.
	assert.equal(alpha, "I  anthropic/claude • high");
	assert.equal(beta, "T  openai/gpt-5 • inherit");
	assert.equal(alpha.indexOf("anthropic/claude"), 3);
	assert.equal(beta.indexOf("openai/gpt-5"), 3);
});
