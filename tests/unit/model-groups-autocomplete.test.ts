import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { SessionManager, type AutocompleteProviderFactory, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createModelGroupAutocompleteProvider } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import type { ModelGroupDef } from "../../model-groups/types.js";
import { resolveGroups, testProvider } from "./model-groups-helpers.js";
import { assertPresent } from "../assertions.js";
import { createModelRegistry } from "../support/model-registry.js";
import { createRunner, type RunnerOptions } from "../support/runner.js";
import { realTheme } from "../support/theme.js";

/** The registry the suggestion tests resolve groups against: one authenticated provider per vendor, and one without auth. */
function suggestionRegistry(): Promise<ModelRegistry> {
	return createModelRegistry({
		"mg-openai": testProvider([{ id: "gpt-5" }], { auth: true }),
		"mg-anthropic": testProvider([{ id: "claude", input: ["text", "image"] }, { id: "claude-sonnet-4" }], { auth: true }),
		"mg-google": testProvider([{ id: "gemini-2.5-pro", input: ["text", "image"], reasoning: true }], { auth: true }),
		"mg-noauth": testProvider([{ id: "gpt-5" }], { auth: false }),
	});
}

async function projectGroups(groups: Record<string, ModelGroupDef>) {
	return resolveGroups(await suggestionRegistry(), { project: groups });
}

function suggestOptions() {
	return { signal: new AbortController().signal };
}

function completionItem(value: string): AutocompleteItem {
	return { value, label: value };
}

function delegateProvider(
	onGetSuggestions: () => void = () => {
		/* Most tests ignore the call. */
	},
): AutocompleteProvider {
	return {
		getSuggestions: () => {
			onGetSuggestions();
			return Promise.resolve({ prefix: "", items: [completionItem("delegated")] });
		},
		applyCompletion: () => ({ lines: ["applied"], cursorLine: 0, cursorCol: 7 }),
		shouldTriggerFileCompletion: () => false,
	};
}

test("#group autocomplete suggests effective live group names and delegates elsewhere", async () => {
	const state = createState();
	state.modelGroups.groups = await projectGroups({
		review: {
			models: [
				{ provider: "mg-openai", modelId: "gpt-5", thinkingLevel: "high" },
				{ provider: "mg-anthropic", modelId: "claude-sonnet-4" },
			],
		},
		research: { models: [{ provider: "mg-google", modelId: "gemini-2.5-pro", thinkingLevel: "xhigh" }] },
	});
	let delegated = 0;
	const provider = createModelGroupAutocompleteProvider(state)(
		delegateProvider(() => {
			delegated++;
		}),
	);

	const suggestions = await provider.getSuggestions(["spawn #re"], 0, "spawn #re".length, suggestOptions());
	assertPresent(suggestions);
	expect(suggestions.prefix).toBe("#re");
	expect(suggestions.items.map((item) => item.value)).toStrictEqual(["#research", "#review"]);
	expect(suggestions.items.map((item) => item.description)).toStrictEqual([
		"mg-google/gemini-2.5-pro • xhigh",
		"mg-openai/gpt-5 • high; mg-anthropic/claude-sonnet-4 • inherit",
	]);
	expect(delegated).toBe(0);

	state.modelGroups.groups = await projectGroups({ reviewers: { models: [{ provider: "mg-noauth", modelId: "gpt-5" }] } });
	const fresh = await provider.getSuggestions(["#rev"], 0, 4, suggestOptions());
	assertPresent(fresh);
	expect(fresh.items.map((item) => item.value)).toStrictEqual(["#reviewers"]);
	expect(fresh.items[0]?.description).toBe("mg-noauth/gpt-5 • inherit (unavailable)");

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
		getSuggestions: (_lines, _cursorLine, _cursorCol, options) => {
			receivedOptions = options;
			return Promise.resolve(null);
		},
	};
	const provider = createModelGroupAutocompleteProvider(state)(current);
	const options = { signal: new AbortController().signal, force: true };

	await provider.getSuggestions(["no hash"], 0, 7, options);

	expect(receivedOptions).toBe(options);
});

test("#group autocomplete triggers file completion when the delegate does not decide", () => {
	const state = createState();
	const current = delegateProvider();
	delete current.shouldTriggerFileCompletion;
	const provider = createModelGroupAutocompleteProvider(state)(current);

	expect(provider.shouldTriggerFileCompletion?.(["@src"], 0, 4)).toBe(true);
});

test("#group autocomplete prepends colored effective modal letters when a colorizer is supplied", async () => {
	const state = createState();
	// The member's effective modalities are text, image and reasoning.
	state.modelGroups.groups = await projectGroups({ research: { models: [{ provider: "mg-google", modelId: "gemini-2.5-pro", thinkingLevel: "high" }] } });
	let delegated = 0;
	const provide = createModelGroupAutocompleteProvider(
		state,
		(color, text) => `<${color}>${text}</${color}>`,
	)(
		delegateProvider(() => {
			delegated++;
		}),
	);
	const suggestions = await provide.getSuggestions(["#res"], 0, 4, suggestOptions());
	assertPresent(suggestions);
	const description = suggestions.items[0]?.description;
	assertPresent(description);
	// Image presence implies text -> only the image letter shows; no reasoning.
	expect(description).toMatch(/<success>I<\/success>/);
	expect(description, "text suppressed when image present").not.toMatch(/<syntaxKeyword>T<\/syntaxKeyword>/);
	expect(description, "reasoning excluded").not.toMatch(/R<\//);
	// Muted wrappers around the gaps and the appended per-model route details.
	expect(description).toMatch(/<muted> {2}<\/muted><muted>mg-google\/gemini-2\.5-pro • high<\/muted>/);
	expect(delegated).toBe(0);
});

/** Options for a runner over the shipped extension that can run session_start in an empty, untrusted project. */
async function sessionStartOptions(ui: RunnerOptions["ui"]): Promise<RunnerOptions> {
	const cwd = mkdtempSync(join(tmpdir(), "model-groups-autocomplete-"));
	onTestFinished(() => {
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		cwd,
		mode: "tui",
		sessionManager: SessionManager.inMemory(cwd),
		modelRegistry: await createModelRegistry({}),
		context: { isProjectTrusted: () => false, getContextUsage: () => undefined },
		activeTools: [],
		...(ui === undefined ? {} : { ui }),
	};
}

test("registerModelGroupAutocomplete uses ctx.ui.addAutocompleteProvider once", async () => {
	const providers: AutocompleteProviderFactory[] = [];
	const { runner } = await createRunner(
		await sessionStartOptions({
			theme: realTheme,
			addAutocompleteProvider: (factory) => {
				providers.push(factory);
			},
		}),
	);

	await runner.emit({ type: "session_start", reason: "startup" });
	await runner.emit({ type: "session_start", reason: "startup" });

	expect(providers.length).toBe(1);
});

test("registerModelGroupAutocomplete registers nothing without a UI", async () => {
	const { runner } = await createRunner(await sessionStartOptions(undefined));
	// Without a bound UI pi hands every context its shared no-op UI.
	const register = vi.spyOn(runner.createContext().ui, "addAutocompleteProvider");

	await runner.emit({ type: "session_start", reason: "startup" });

	expect(register).not.toHaveBeenCalled();
});

test("group autocomplete consolidates to a single consistent letter column", async () => {
	const state = createState();
	// alpha has image (implies text) -> single I; beta is text-only -> single T.
	state.modelGroups.groups = await projectGroups({
		alpha: { models: [{ provider: "mg-anthropic", modelId: "claude", thinkingLevel: "high" }] },
		beta: { models: [{ provider: "mg-openai", modelId: "gpt-5" }] },
	});
	const identity = (color: string, text: string) => text;
	const provide = createModelGroupAutocompleteProvider(state, identity)(delegateProvider());
	const suggestions = await provide.getSuggestions(["#"], 0, 1, suggestOptions());
	assertPresent(suggestions);
	const alpha = suggestions.items[0]?.description;
	const beta = suggestions.items[1]?.description;
	assertPresent(alpha);
	assertPresent(beta);
	// Both collapse to a single colored column, so each route starts at the same offset.
	expect(alpha).toBe("I  mg-anthropic/claude • high");
	expect(beta).toBe("T  mg-openai/gpt-5 • inherit");
	expect(alpha.indexOf("mg-anthropic/claude")).toBe(3);
	expect(beta.indexOf("mg-openai/gpt-5")).toBe(3);
});

test("group autocomplete omits the letter column when no group has letters", async () => {
	const state = createState();
	// A group without members has no effective modalities, so it has no letters.
	state.modelGroups.groups = await projectGroups({ empty: { models: [] } });
	const identity = (_color: string, text: string) => text;
	const provide = createModelGroupAutocompleteProvider(state, identity)(delegateProvider());

	const suggestions = await provide.getSuggestions(["#"], 0, 1, suggestOptions());

	assertPresent(suggestions);
	expect(suggestions.items.map((item) => item.description)).toStrictEqual(["No models configured"]);
});

test.for([
	{ label: "a capitalised group name for a lowercase prefix", group: "Review", typed: "#re", value: "#Review" },
	{ label: "a lowercase group name for a capitalised prefix", group: "review", typed: "#RE", value: "#review" },
])("#group autocomplete matches group names case-insensitively and inserts the group's own spelling: $label", async ({ group, typed, value }) => {
	const state = createState();
	state.modelGroups.groups = await projectGroups({ [group]: { models: [{ provider: "mg-openai", modelId: "gpt-5" }] } });
	const provider = createModelGroupAutocompleteProvider(state)(delegateProvider());

	const suggestions = await provider.getSuggestions([typed], 0, typed.length, suggestOptions());

	assertPresent(suggestions);
	expect(suggestions.items.map((item) => item.value)).toStrictEqual([value]);
});
