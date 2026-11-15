import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCompatCopy, latestPiDependencies, prepareCompatCopy, resolveLatestPi, writeCompatArtifacts, writeCompatDiagnostics } from "./compat-fixture.mjs";
import { repoRootFromScript, runChecked, runNpmWithRetry } from "./compat-process.mjs";
import { assertSynchronizedPackageVersions } from "./dependency-graph-assertions.mjs";

const ROOT = repoRootFromScript(import.meta.url);
const PI_SYNC_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

async function main() {
	const artifactDir = process.env.COMPAT_ARTIFACT_DIR;
	const { temp, copy } = createCompatCopy(ROOT, "pi-schematic-current-");

	try {
		prepareCompatCopy(copy);

		const latestPi = await resolveLatestPi(copy);
		// WHY: agent-core is an exact devDependency, so it must move with the other Pi packages here, or
		// the floor pin stays top-level and the latest coding-agent nests its own exact agent-core copy.
		await runNpmWithRetry(copy, [
			"install",
			"--ignore-scripts",
			"--save-dev",
			"--save-exact",
			...Object.entries(latestPiDependencies(latestPi)).map(([name, version]) => `${name}@${version}`),
			`@earendil-works/pi-agent-core@${latestPi.piVersion}`,
		]);
		const graphResult = await runNpmWithRetry(copy, ["ls", "--all", "--json"], { capture: true });
		const graph = JSON.parse(graphResult.stdout);
		if (artifactDir) {
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(join(artifactDir, "dependency-graph.json"), JSON.stringify(graph, null, 2));
		}
		const piVersion = assertSynchronizedPackageVersions(graph, PI_SYNC_PACKAGES);
		assertSynchronizedPackageVersions(graph, ["typebox"]);

		await runNpmWithRetry(copy, ["run", "typecheck"]);
		await runNpmWithRetry(copy, ["exec", "audit-ci", "--", "--config", "audit-ci.jsonc"]);
		runChecked(process.execPath, ["./node_modules/vitest/vitest.mjs", "run"], { cwd: copy });
		writeCompatArtifacts(artifactDir, copy, { piVersion, typeboxVersion: latestPi.typeboxVersion });
		process.stdout.write(`Current synchronized Pi compatibility passed at ${piVersion}.\n`);
	} catch (error) {
		writeCompatDiagnostics(artifactDir, copy, error);
		throw error;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

if (isMain) {
	await main();
}
