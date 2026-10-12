/**
 * Leaf helper that stacks an autocomplete provider onto a UI exactly once per key.
 *
 * WHY: session starts re-run extension registration on the same UI. Pi stacks every
 * `addAutocompleteProvider` call, so a second install would wrap the wrapper.
 */

import type { AutocompleteProviderFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One key per provider so workflow and model-groups stack instead of blocking. */
export type AutocompleteProviderKey = "workflow" | "model-groups";

const installedKeys = new WeakMap<object, Set<AutocompleteProviderKey>>();

/** Skips headless contexts. `buildFactory` runs only on the first install per key for a UI. */
export function installAutocompleteProviderOnce(ctx: ExtensionContext, key: AutocompleteProviderKey, buildFactory: () => AutocompleteProviderFactory): void {
	if (!ctx.hasUI) return;
	let keys = installedKeys.get(ctx.ui);
	if (keys?.has(key)) return;
	if (!keys) installedKeys.set(ctx.ui, (keys = new Set()));
	keys.add(key);
	ctx.ui.addAutocompleteProvider(buildFactory());
}
