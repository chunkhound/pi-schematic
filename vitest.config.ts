import { defineConfig } from "vitest/config";
import { PI_SHARED_PACKAGES, piManifestPath } from "./pi-packages.mjs";
import { VITEST_FILES } from "./tests/vitest-files.mjs";

// pi-coding-agent ships its own copies of the pi packages and of typebox, and its nested pi
// packages import those copies. Resolving them with pi's manifest as the parent gives the
// extension the copies pi loads, so they share module-level state (registries, keybindings) and
// typebox's runtime identity. Vitest externalizes a path under node_modules to native import().
export default defineConfig({
	plugins: [
		{
			name: "pi-shared-packages",
			enforce: "pre",
			async resolveId(source, _importer, options) {
				if (!PI_SHARED_PACKAGES.test(source)) return null;
				const resolved = await this.resolve(source, piManifestPath, { ...options, skipSelf: true });
				if (resolved === null) {
					throw new Error(
						`pi-shared-packages: cannot resolve ${JSON.stringify(source)} from pi's manifest ${piManifestPath}`,
					);
				}
				return resolved;
			},
		},
	],
	test: {
		env: { PI_OFFLINE: "1" },
		expect: { requireAssertions: true },
		unstubEnvs: true,
		restoreMocks: true,
		// 0 disables truncation, so test names built from test.each/test.for rows stay whole.
		taskTitleValueFormatTruncate: 0,
		projects: [
			{
				test: {
					name: "unit",
					// Only the files listed in tests/vitest-files.mjs run here; the rest of the suite still
					// runs on node:test. The list is temporary while the suite moves to Vitest.
					include: [...VITEST_FILES],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
	},
});
