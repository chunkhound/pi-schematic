// Sets state through the extension's pi-ai and pi-tui and reads it back through pi-coding-agent, so
// a test sees whether both sides share one instance of each package. This module imports no test
// runner and only bare package specifiers, so plain Node, the test loaders and pi's extension loader
// can all load it.

import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { generateSummary, keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

/** The summary the faux provider answers with. */
export const PROBE_SUMMARY = "pi-module-identity probe summary";

/** The key bound to `tui.editor.cursorUp` while the probe is applied. */
export const PROBE_KEY = "ctrl+q";

/** The `globalThis` key under which the fixture extension hands its faux model to the host. */
export const PROBE_MODEL_KEY = Symbol.for("pi-schematic.shared-module-probe.model");

export interface AppliedSharedModuleProbe {
	model: Model<string>;
	/** Unregisters the faux provider and puts back the keybindings that were active before. */
	restore(): void;
}

/**
 * The extension side: registers a faux provider that answers with PROBE_SUMMARY and binds
 * `tui.editor.cursorUp` to PROBE_KEY, through the pi-ai and pi-tui this module resolves.
 */
export function applySharedModuleProbe(): AppliedSharedModuleProbe {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage(PROBE_SUMMARY)]);
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.cursorUp": PROBE_KEY }));
	return {
		model: faux.getModel(),
		restore() {
			faux.unregister();
			setKeybindings(previous);
		},
	};
}

/** The pi side: what pi-coding-agent sees of the provider behind `model` and of the keybindings. */
export async function readSharedModuleProbe(model: Model<string>): Promise<{ summary: string; key: string }> {
	return {
		summary: await generateSummary([], model, 2_000, undefined),
		key: keyText("tui.editor.cursorUp"),
	};
}
