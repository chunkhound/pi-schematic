import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCompatCopy, latestPiDependencies, prepareCompatCopy, resolveLatestPi, writeCompatArtifacts, writeCompatDiagnostics } from "./compat-fixture.mjs";
import { repoRootFromScript, runChecked, runNpmWithRetry } from "./compat-process.mjs";
import { assertSynchronizedPackageVersions } from "./dependency-graph-assertions.mjs";

const ROOT = repoRootFromScript(import.meta.url);
const PI_SYNC_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

// The unit tests the compat lane runs in the Vitest unit project.
export const COMPAT_UNIT_FILES = [
  "tests/unit/spawn-runtime-compatibility.test.ts",
  "tests/unit/spawn-lifecycle.test.ts",
  "tests/unit/spawn-event.test.ts",
  "tests/unit/spawn-render.test.ts",
  "tests/unit/frontmatter-cache.test.ts",
  "tests/unit/spawn.test.ts",
  "tests/unit/readonly-spawn.test.ts",
  "tests/unit/model-group-frontmatter.test.ts",
  "tests/unit/model-groups-crud.test.ts",
  "tests/unit/model-groups-integration.test.ts",
  "tests/unit/handoff.test.ts",
  "tests/unit/handoff-boundary-session.test.ts",
  "tests/unit/notebook.test.ts",
  "tests/unit/prompt-sections.test.ts",
  "tests/unit/readonly-frontmatter.test.ts",
  "tests/unit/readonly-mode.test.ts",
  "tests/unit/system-prompt.test.ts",
  "tests/unit/compat-process.test.ts",
  "tests/unit/dependency-graph-assertions.test.ts",
  "tests/unit/module-evaluation-order.test.ts",
  "tests/unit/pi-module-identity.test.ts",
  "tests/unit/test-host.test.ts",
];

// Vitest ignores a file filter that matches no file when another filter matches, so a listed file
// that does not exist, or that the unit project does not include, would silently not run while the
// lane passes. The unit project runs `tests/unit/**/*.test.ts`. Paths are relative to the repository
// root, whatever the working directory.
export function assertCompatTestFiles(files) {
  const missing = files.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) {
    throw new Error(`The compat lane lists test files that do not exist: ${missing.join(", ")}`);
  }
  const outside = files.filter((file) => !(file.startsWith("tests/unit/") && file.endsWith(".test.ts")));
  if (outside.length > 0) {
    throw new Error(`The compat lane lists test files outside the unit project: ${outside.join(", ")}`);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

async function main() {
  assertCompatTestFiles(COMPAT_UNIT_FILES);
  const artifactDir = process.env.COMPAT_ARTIFACT_DIR;
  const { temp, copy } = createCompatCopy(ROOT, "pi-schematic-current-");

  try {
    prepareCompatCopy(copy);

    const latestPi = await resolveLatestPi(copy);
    await runNpmWithRetry(copy, ["install", "--ignore-scripts", "--save-dev", "--save-exact",
      ...Object.entries(latestPiDependencies(latestPi)).map(([name, version]) => `${name}@${version}`),
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
    runChecked(process.execPath, ["./node_modules/vitest/vitest.mjs", "run", "--project", "unit", ...COMPAT_UNIT_FILES], { cwd: copy });
    runChecked(process.execPath, ["./node_modules/vitest/vitest.mjs", "run", "--project", "e2e"], { cwd: copy });
    writeCompatArtifacts(artifactDir, copy, { piVersion, typeboxVersion: latestPi.typeboxVersion });
    process.stdout.write(`Current synchronized Pi compatibility passed at ${piVersion}.\n`);
  } catch (error) {
    writeCompatDiagnostics(artifactDir, copy, error);
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMain) await main();
