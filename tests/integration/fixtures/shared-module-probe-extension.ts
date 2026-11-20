// A pi extension that applies the shared-module probe and hands its faux model to the host through
// `globalThis`, so the host can read the probe back through its own pi-coding-agent.

import { applySharedModuleProbe, PROBE_MODEL_KEY } from "./shared-module-probe.js";

export default function (): void {
	(globalThis as Record<symbol, unknown>)[PROBE_MODEL_KEY] = applySharedModuleProbe().model;
}
