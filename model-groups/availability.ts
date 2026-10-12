import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** The registry view needed to test whether a resolved model is usable. */
export type ModelUsabilityRegistry = Pick<ModelRegistry, "find" | "hasConfiguredAuth">;

/** True when a resolved model exists and has configured auth (narrows the type). */
export function isUsableModel<TApi extends Api>(registry: Pick<ModelRegistry, "hasConfiguredAuth">, model: Model<TApi> | undefined): model is Model<TApi> {
	return Boolean(model && registry.hasConfiguredAuth(model));
}

/** Find a model by ref and report whether it is usable. */
export function isModelUsable(registry: ModelUsabilityRegistry, provider: string, modelId: string): boolean {
	return isUsableModel(registry, registry.find(provider, modelId));
}
