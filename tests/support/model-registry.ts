// An in-memory pi ModelRegistry for tests: no models.json, no auth file and no network. The
// factory clears the environment variables pi reads provider credentials from, so getAvailable()
// holds only the providers the test configured, on every machine.

import { ModelRegistry, ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { vi } from "vitest";

// The variables pi-ai reads to configure a built-in provider: API keys and tokens, the ambient AWS
// and Google Cloud settings it treats as configured credentials, and the three Anthropic workload
// identity federation settings that authenticate together. pi-ai's main entry exports no table of
// them, so the list is written out.
const PROVIDER_CREDENTIAL_ENV = [
	"AI_GATEWAY_API_KEY",
	"ANT_LING_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_ORGANIZATION_ID",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_PROFILE",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"BASETEN_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GCLOUD_PROJECT",
	"GEMINI_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"META_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"NVIDIA_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"RADIUS_API_KEY",
	"TOGETHER_API_KEY",
	"TYPESAFE_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
];

/**
 * A `ModelRegistry` with the built-in catalog and the `providers` registered under their ids, each
 * with its own auth: a provider config with an `apiKey` is configured, one without is not. Each id
 * must be one no built-in provider uses. Throws when an id is taken, or when `getAvailable()` holds
 * a model of a provider the test did not pass.
 */
export async function createModelRegistry(providers: Record<string, ProviderConfig>): Promise<ModelRegistry> {
	for (const name of PROVIDER_CREDENTIAL_ENV) {
		vi.stubEnv(name, undefined);
	}
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, credentials: new InMemoryCredentialStore() });
	const registry = new ModelRegistry(runtime);
	for (const [id, config] of Object.entries(providers)) {
		if (registry.getProvider(id) !== undefined) {
			throw new Error(`The test registry's provider id "${id}" is taken by a built-in provider; pick an id no built-in provider uses.`);
		}
		registry.registerProvider(id, config);
	}
	// Registration starts availability checks without awaiting them; this refresh settles them.
	await registry.refresh({ allowNetwork: false });
	const leaked = registry.getAvailable().filter((model) => !Object.hasOwn(providers, model.provider));
	if (leaked.length > 0) {
		throw new Error(
			`The test registry lists models of providers the test did not pass: ${leaked.map((model) => `${model.provider}/${model.id}`).join(", ")}. Clear the variable that configures them in the registry factory.`,
		);
	}
	return registry;
}
