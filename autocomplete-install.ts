/**
 * Leaf helper that stacks an autocomplete provider onto a UI exactly once.
 *
 * WHY: session starts re-run extension registration on the same UI. Pi stacks every
 * `addAutocompleteProvider` call, so a second install would wrap the wrapper.
 */

import type { AutocompleteProviderFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";

const installedUis = new WeakSet<object>();

/** Skips headless contexts. `buildFactory` runs only on the first install for a UI. */
export function installAutocompleteProviderOnce(ctx: ExtensionContext, buildFactory: () => AutocompleteProviderFactory): void {
	if (!ctx.hasUI || installedUis.has(ctx.ui)) return;
	installedUis.add(ctx.ui);
	ctx.ui.addAutocompleteProvider(buildFactory());
}
