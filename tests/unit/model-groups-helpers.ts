import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedModelGroup } from "../../model-groups/types.js";
import { __setModelGroupsFsForTests } from "../../model-groups/store.js";
import { setTempHome } from "./helpers.js";

export async function withTemp(
	fn: (ctx: { cwd: string; home: string }) => Promise<void> | void,
): Promise<void> {
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

export function createDeferredRefreshRegistry<T extends { provider: string; id: string }>(
	initial: T[],
	refreshed: T[],
	authenticated: (model: T) => boolean = () => true,
) {
	let visible = initial;
	let refreshing = false;
	let releaseRefresh!: () => void;
	const released = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	const refreshOptions: unknown[] = [];
	return {
		getAll: () => visible,
		getAvailable: () => visible.filter(authenticated),
		find: (provider: string, id: string) => {
			if (refreshing) throw new Error("synchronous registry read before refresh completed");
			return visible.find((model) => model.provider === provider && model.id === id);
		},
		hasConfiguredAuth: (model: T) => {
			if (refreshing) throw new Error("synchronous registry read before refresh completed");
			return authenticated(model);
		},
		refresh: async (options: unknown) => {
			refreshOptions.push(options);
			refreshing = true;
			await released;
			visible = refreshed;
			refreshing = false;
			return { aborted: false, errors: new Map() };
		},
		releaseRefresh,
		refreshOptions,
	};
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
		...(opts.constraints === undefined ? {} : { constraints: { ...opts.constraints, ...(Array.isArray(opts.constraints.modalities) ? { modalities: [...opts.constraints.modalities] } : {}) } }),
		validation: {
			unavailableRefs: opts.unavailableRefs ?? [],
			shadowedByProject: opts.shadowedByProject ?? false,
			degraded: (opts.unavailableRefs?.length ?? 0) > 0,
			emptyCommonModalities: false,
			unsupportedOverrideModalities: [],
		},
		modalities: { common: [], supported: [], effective: [] },
	};
}
