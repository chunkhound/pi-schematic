import type { Api, Model } from "@earendil-works/pi-ai";

/** A model with `fields` over placeholder metadata: the id as name, a test api and base URL, zero cost and limits. */
export function testModel(fields: Pick<Model<Api>, "provider" | "id" | "input" | "reasoning"> & Partial<Model<Api>>): Model<Api> {
	return {
		name: fields.id,
		api: "test-api",
		baseUrl: "http://localhost.invalid",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
		...fields,
	};
}
