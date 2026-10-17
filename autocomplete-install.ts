/**
 * Leaf helper that stacks an autocomplete provider onto a UI exactly once per key.
 *
 * WHY: session starts re-run extension registration on the same UI. Pi stacks every
 * `addAutocompleteProvider` call, so a second install would wrap the wrapper.
 */

import type { AutocompleteProviderFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One key per provider so workflow and model-groups stack instead of blocking. */
export type AutocompleteProviderKey = "workflow" | "model-groups";

/** Dedupe stays per UI via WeakSet; one slot per key removes the lazy-set bookkeeping. */
const installedProviders: Record<AutocompleteProviderKey, WeakSet<object>> = {
	"workflow": new WeakSet(),
	"model-groups": new WeakSet(),
};

/** Skips headless contexts. `buildFactory` runs only on the first install per key for a UI. */
export function installAutocompleteProviderOnce(ctx: ExtensionContext, key: AutocompleteProviderKey, buildFactory: () => AutocompleteProviderFactory): void {
	if (!ctx.hasUI) return;
	if (installedProviders[key].has(ctx.ui)) return;
	installedProviders[key].add(ctx.ui);
	ctx.ui.addAutocompleteProvider(buildFactory());
}
