import { expect, test } from "vitest";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import { createModelGroupAutocompleteProvider, registerModelGroupAutocomplete } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import { group } from "./model-groups-helpers.js";
import { assertPresent } from "../assertions.js";
import { createExtensionContext, createUIContext } from "./helpers.js";

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
	assertPresent(suggestions);
	expect(suggestions.prefix).toBe("#re");
	expect(suggestions.items.map((item) => item.value)).toStrictEqual(["#research", "#review"]);
	expect(suggestions.items.map((item) => item.description)).toStrictEqual([
		"google/gemini-2.5-pro • xhigh",
		"openai/gpt-5 • high; anthropic/claude-sonnet-4 • inherit",
	]);
	expect(delegated).toBe(0);

	state.modelGroups.groups = [group("reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }], unavailableRefs: [{ provider: "openai", modelId: "gpt-5" }] })];
	const fresh = await provider.getSuggestions(["#rev"], 0, 4, suggestOptions());
	assertPresent(fresh);
	expect(fresh.items.map((item) => item.value)).toStrictEqual(["#reviewers"]);
	expect(fresh.items[0]?.description).toBe("openai/gpt-5 • inherit (unavailable)");

	const other = await provider.getSuggestions(["no hash"], 0, 7, suggestOptions());
	expect(delegated).toBe(1);
	assertPresent(other);
	expect(other.items.map((item) => item.value)).toStrictEqual(["delegated"]);
	expect(provider.applyCompletion([], 0, 0, completionItem("#review"), "#re")).toStrictEqual({ lines: ["applied"], cursorLine: 0, cursorCol: 7 });
	expect(provider.shouldTriggerFileCompletion?.([], 0, 0)).toBe(false);
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

	expect(receivedOptions).toBe(options);
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

	expect(receivedItem).toBe(item);
});

test("#group autocomplete triggers file completion when the delegate does not decide", () => {
	const state = createState();
	const { shouldTriggerFileCompletion: _omitted, ...current } = delegateProvider();
	const provider = createModelGroupAutocompleteProvider(state)(current);

	expect(provider.shouldTriggerFileCompletion?.(["@src"], 0, 4)).toBe(true);
});

test("#group autocomplete prepends colored effective modal letters when a colorizer is supplied", async () => {
	const state = createState();
	state.modelGroups.groups = [group("research", { models: [{ provider: "google", modelId: "gemini-2.5-pro", thinkingLevel: "high" }] })];
	// Unordered effective set; must canonicalize, drop reasoning, and consolidate text being implied.
	state.modelGroups.groups[0].modalities = { common: [], supported: [], effective: ["reasoning", "image", "text"] };
	let delegated = 0;
	const provide = createModelGroupAutocompleteProvider(state, (color, text) => `<${color}>${text}</${color}>`)(delegateProvider(() => { delegated++; }));
	const suggestions = await provide.getSuggestions(["#res"], 0, 4, suggestOptions());
	assertPresent(suggestions);
	const description = suggestions.items[0]?.description;
	assertPresent(description);
	// Image presence implies text -> only the image letter shows; no reasoning.
	expect(description).toMatch(/<success>I<\/success>/);
	expect(description, "text suppressed when image present").not.toMatch(/<syntaxKeyword>T<\/syntaxKeyword>/);
	expect(description, "reasoning excluded").not.toMatch(/R<\//);
	// Muted wrappers around the gaps and the appended per-model route details.
	expect(description).toMatch(/<muted> {2}<\/muted><muted>google\/gemini-2\.5-pro • high<\/muted>/);
	expect(delegated).toBe(0);
});

test("registerModelGroupAutocomplete uses ctx.ui.addAutocompleteProvider once", () => {
	const state = createState();
	const providers: AutocompleteProviderFactory[] = [];
	const ctx = createExtensionContext({ hasUI: true, mode: "tui", ui: createUIContext({ addAutocompleteProvider: (factory) => { providers.push(factory); } }) });
	registerModelGroupAutocomplete(ctx, state);
	registerModelGroupAutocomplete(ctx, state);
	expect(providers.length).toBe(1);
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
	assertPresent(suggestions);
	const alpha = suggestions.items[0]?.description;
	const beta = suggestions.items[1]?.description;
	assertPresent(alpha);
	assertPresent(beta);
	// Both collapse to a single colored column, so each route starts at the same offset.
	expect(alpha).toBe("I  anthropic/claude • high");
	expect(beta).toBe("T  openai/gpt-5 • inherit");
	expect(alpha.indexOf("anthropic/claude")).toBe(3);
	expect(beta.indexOf("openai/gpt-5")).toBe(3);
});
