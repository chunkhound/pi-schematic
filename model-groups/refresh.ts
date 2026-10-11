import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import type { RegistryFreshness } from "./registry-freshness.js";
import { loadModelGroups, validateModelGroups } from "./store.js";
import type { ModelGroupsAccess } from "./types.js";

export function modelGroupsAccess(ctx: ExtensionContext): ModelGroupsAccess {
	return { cwd: ctx.cwd, policy: ctx.isProjectTrusted() ? "global-project" : "global-only" };
}

/** Recompute the synchronous group snapshot from the registry's current state. */
export function refreshModelGroupsState(state: SchematicState, ctx: ExtensionContext) {
	state.modelGroups.groups = [];
	state.modelGroups.validation = null;
	if (!ctx.cwd || !ctx.modelRegistry) return null;
	const loadedModelGroups = loadModelGroups(modelGroupsAccess(ctx));
	const resolvedModelGroups = validateModelGroups(loadedModelGroups, ctx.modelRegistry);
	state.modelGroups.groups = resolvedModelGroups;
	state.modelGroups.validation = { groups: resolvedModelGroups, loadIssues: loadedModelGroups.issues };
	return state.modelGroups.validation;
}

/** Await registry reconciliation before publishing the dependent group snapshot. */
export async function refreshModelGroupsStateFresh(
	state: SchematicState,
	ctx: ExtensionContext,
	freshness: RegistryFreshness = state.registryFreshness,
) {
	if (!ctx.modelRegistry) return refreshModelGroupsState(state, ctx);
	const result = await freshness.ensureFresh(ctx);
	if (result.reportPending && ctx.hasUI) {
		ctx.ui.notify("Model registry refresh failed; using last known models", "warning");
		freshness.markFailureReported();
	}
	return refreshModelGroupsState(state, ctx);
}
