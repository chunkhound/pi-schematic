import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelGroupDef, ModelGroupsLoadedGroup, ModelGroupScope, ResolvedModelGroup } from "../../model-groups/types.js";
import { __setModelGroupsFsForTests, validateModelGroups } from "../../model-groups/store.js";
import { evaluateConstraints } from "../../model-groups/constraints/engine.js";
import { productionConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { setTempHome } from "../support/temp.js";

export async function withTemp(fn: (ctx: { cwd: string; home: string }) => Promise<void> | void): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-groups-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const restoreHome = setTempHome(home);
	try {
		await fn({ cwd, home });
	} finally {
		restoreHome();
		__setModelGroupsFsForTests(null);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

export function group(
	name: string,
	opts: {
		scope?: "project" | "global";
		models?: ResolvedModelGroup["models"];
		constraints?: { modalities: import("../../model-groups/types.js").ModelGroupModality[] } | Record<string, unknown>;
		shadowedByProject?: boolean;
		unavailableRefs?: ResolvedModelGroup["validation"]["unavailableRefs"];
	} = {},
): ResolvedModelGroup {
	const scope = opts.scope ?? "project";
	return {
		name,
		scope,
		sourcePath: `<${scope}>`,
		models: opts.models ?? [],
		...(opts.constraints === undefined
			? {}
			: { constraints: { ...opts.constraints, ...(isArray(opts.constraints.modalities) ? { modalities: [...opts.constraints.modalities] } : {}) } }),
		validation: {
			unavailableRefs: opts.unavailableRefs ?? [],
			shadowedByProject: opts.shadowedByProject ?? false,
			degraded: (opts.unavailableRefs?.length ?? 0) > 0,
		},
		modalities: { common: [], supported: [], effective: [] },
		evaluations: evaluateConstraints(
			{ members: (opts.models ?? []).map((ref) => ({ ref, model: undefined })) },
			opts.constraints ?? {},
			productionConstraintRegistry,
		),
	};
}

// ── Real registry providers and resolved groups ──

/** A chat model a test registers; unset fields read as a text-only model without reasoning. */
export interface TestChatModel {
	id: string;
	name?: string;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	contextWindow?: number;
}

/** A provider config for the in-memory registry; `auth: true` registers it with an API key, so its models are available. */
export function testProvider(models: readonly TestChatModel[], { auth }: { auth: boolean }): ProviderConfig {
	return {
		baseUrl: "http://127.0.0.1:9",
		api: "openai-completions",
		...(auth ? { apiKey: "test-key" } : {}),
		models: models.map((model) => ({
			id: model.id,
			name: model.name ?? "",
			input: model.input ?? ["text"],
			reasoning: model.reasoning ?? false,
			...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow ?? 0,
			maxTokens: 0,
		})),
	};
}

/** Groups per scope, as a test writes them into a config file. */
export type ScopedGroupDefs = Partial<Record<ModelGroupScope, Record<string, ModelGroupDef>>>;

function loadedGroups(scope: ModelGroupScope, groups: Record<string, ModelGroupDef>, name: string): ModelGroupsLoadedGroup[] {
	return Object.hasOwn(groups, name) ? [{ name, scope, sourcePath: `<${scope}>`, ...structuredClone(groups[name]) }] : [];
}

/** The groups `validateModelGroups` resolves from `defs` against `registry`, merged by name with global before project, as the store loads them. */
export function resolveGroups(registry: ModelRegistry, defs: ScopedGroupDefs): ResolvedModelGroup[] {
	const global = defs.global ?? {};
	const project = defs.project ?? {};
	const names = [...new Set([...Object.keys(global), ...Object.keys(project)])].sort();
	return validateModelGroups(
		{
			configs: { global: { version: 2, groups: global }, project: { version: 2, groups: project } },
			merged: names.flatMap((name) => [...loadedGroups("global", global, name), ...loadedGroups("project", project, name)]),
			issues: [],
		},
		registry,
	);
}
