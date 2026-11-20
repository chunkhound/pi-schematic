/** The one version every occurrence of the named packages has in an `npm ls --all --json` graph; throws otherwise. */
export declare function assertSynchronizedPackageVersions(graph: unknown, packageNames: readonly string[]): string;
