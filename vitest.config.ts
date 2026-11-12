import { defineConfig } from "vitest/config";
import { PI_SHARED_PACKAGES, piManifestPath } from "./pi-packages.mjs";

// pi's packages resolve from pi's manifest; see pi-packages.mjs for the rationale. Vitest
// externalizes a path under node_modules to native import(), so the extension shares pi's copies.
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
		// Drop the assertion helpers' frames so a failure's code frame points at the test's call line.
		onStackTrace: (_error, { file }) => !/[\\/]tests[\\/]assertions\.ts$/.test(file),
		unstubEnvs: true,
		restoreMocks: true,
		// 0 disables truncation, so test names built from test.each/test.for rows stay whole.
		taskTitleValueFormatTruncate: 0,
		// Coverage is collected only when a run passes --coverage. These root options would apply to
		// the e2e project too, so `npm run test:coverage` restricts the run to the unit project.
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			include: ["*.ts", "handoff/**/*.ts", "model-groups/**/*.ts", "notebook/**/*.ts", "spawn/**/*.ts", "time/**/*.ts"],
			exclude: ["vitest.config.ts"],
		},
		projects: [
			{
				test: {
					name: "unit",
					include: ["tests/unit/**/*.test.ts"],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
			{
				test: {
					name: "e2e",
					include: ["tests/e2e/**/*.test.ts"],
					// 0 disables the timeout: an e2e test or hook bounds its own waits.
					testTimeout: 0,
					hookTimeout: 0,
				},
			},
		],
	},
});
