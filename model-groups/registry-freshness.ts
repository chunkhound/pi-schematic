import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type FileRevision = {
	dev: number | bigint;
	ino: number | bigint;
	size: number | bigint;
	mtimeMs: number;
	ctimeMs: number;
};
type StatFile = (path: string) => Promise<FileRevision>;

export type RegistryFreshnessResult = {
	refreshed: boolean;
	error?: string;
	/** True when an unreported failure should be surfaced at an interactive boundary. */
	reportPending?: boolean;
};

export interface RegistryFreshness {
	ensureFresh(ctx: ExtensionContext): Promise<RegistryFreshnessResult>;
	/** Records that the current failure streak has been reported, so it warns at most once. */
	markFailureReported(): void;
}

export interface RegistryFreshnessOptions {
	getAgentDir?: () => string;
	statFile?: StatFile;
}

const REGISTRY_FILES = ["models.json", "models-store.json", "auth.json"] as const;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function refreshError(result: { aborted?: boolean; errors?: { size: number; values?: () => IterableIterator<unknown> } }): string | undefined {
	if (result.aborted) return "Model registry refresh aborted";
	if (!result.errors || result.errors.size === 0) return undefined;
	const first = result.errors.values?.().next().value;
	return `Model registry refresh failed${first === undefined ? "" : `: ${errorMessage(first)}`}`;
}

/**
 * Reconciles Pi's process-lifetime model registry when its on-disk inputs change.
 * Only successful refreshes advance the watermark, so failures are retried.
 */
export function createRegistryFreshness(options: RegistryFreshnessOptions = {}): RegistryFreshness {
	const agentDir = options.getAgentDir ?? getAgentDir;
	const statFile = options.statFile ?? stat;
	let successfulSignature: string | undefined;
	let failing = false;
	let reported = false;
	let inFlight: Promise<RegistryFreshnessResult> | undefined;

	async function signature(): Promise<string> {
		const directory = agentDir();
		const revisions = await Promise.all(REGISTRY_FILES.map(async (file) => {
			try {
				const revision = await statFile(join(directory, file));
				return [file, revision.dev, revision.ino, revision.size, revision.mtimeMs, revision.ctimeMs].join(":");
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${file}:missing`;
				throw error;
			}
		}));
		return revisions.join("|");
	}

	async function refresh(ctx: ExtensionContext): Promise<RegistryFreshnessResult> {
		try {
			const currentSignature = await signature();
			if (currentSignature === successfulSignature) return { refreshed: false };
			const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
			const error = refreshError(result);
			if (error) {
				failing = true;
				return { refreshed: false, error, reportPending: !reported };
			}
			successfulSignature = currentSignature;
			failing = false;
			reported = false;
			return { refreshed: true };
		} catch (error) {
			failing = true;
			return { refreshed: false, error: errorMessage(error), reportPending: !reported };
		}
	}

	return {
		ensureFresh(ctx) {
			if (!inFlight) {
				inFlight = refresh(ctx).finally(() => { inFlight = undefined; });
			}
			return inFlight;
		},
		markFailureReported() {
			if (failing) reported = true;
		},
	};
}
