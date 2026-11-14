/** The unit test files the current compat lane runs, relative to the repository root. */
export declare const COMPAT_UNIT_FILES: string[];

/** Throws when a listed file does not exist or lies outside the unit project. */
export declare function assertCompatTestFiles(files: readonly string[]): void;
