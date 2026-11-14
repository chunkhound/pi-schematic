interface PiVersions {
	piVersion: string;
	typeboxVersion: string;
}

/** The direct Pi peer packages the host lane installs. */
export declare const PI_PACKAGES: string[];

/** Copies the repository into a new temp directory, without .git, caches, coverage and node_modules. */
export declare function createCompatCopy(root: string, prefix: string): { temp: string; copy: string };

/** Drops the copy's package lock and its prepare script. */
export declare function prepareCompatCopy(copy: string): void;

/** Parsed `npm view --json` output: undefined for empty output, a one-element array unwrapped. */
export declare function parseNpmViewValue(stdout: string): unknown;

/** The single entry of `npm pack --json` output, in the array or the object form. */
export declare function packEntry(stdout: string): { filename: string; [key: string]: unknown };

/** The current Pi release and the exact TypeBox version it requires, looked up through npm. */
export declare function resolveLatestPi(copy: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; execPath?: string }): Promise<PiVersions>;

/** Dependency versions for the Pi packages and TypeBox, keyed by package name. */
export declare function latestPiDependencies(versions: PiVersions): Record<string, string>;

/** Writes the package lock and versions.txt into artifactDir; does nothing without an artifactDir. */
export declare function writeCompatArtifacts(artifactDir: string | undefined, sourceDir: string, versions: PiVersions): void;

/** Writes the package lock, when present, and failure.txt into artifactDir; does nothing without an artifactDir. */
export declare function writeCompatDiagnostics(artifactDir: string | undefined, sourceDir: string, error: unknown): void;

export {};
