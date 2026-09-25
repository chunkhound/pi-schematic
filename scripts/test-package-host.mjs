import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCompatCopy, latestPiDependencies, prepareCompatCopy, resolveLatestPi, writeCompatArtifacts, writeCompatDiagnostics } from "./compat-fixture.mjs";
import { repoRootFromScript, runChecked, runNpmWithRetry } from "./compat-process.mjs";

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

async function main() {
  const root = repoRootFromScript(import.meta.url);
  const artifactDir = process.env.COMPAT_ARTIFACT_DIR;
  const { temp, copy } = createCompatCopy(root, "pi-schematic-host-");
  const host = join(temp, "host");
  let tarball;

  try {
    prepareCompatCopy(copy);

    const packJson = JSON.parse((await runNpmWithRetry(copy, ["pack", "--json", "--ignore-scripts"], { capture: true })).stdout);
    tarball = join(copy, packJson[0].filename);
    const latestPi = await resolveLatestPi(copy);
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, "package.json"), `${JSON.stringify({
      name: "pi-schematic-package-host",
      private: true,
      type: "module",
      dependencies: {
        ...latestPiDependencies(latestPi),
        "pi-schematic": `file:${tarball}`,
      },
    }, null, 2)}\n`);
    await runNpmWithRetry(host, ["install", "--ignore-scripts"]);
    const graph = JSON.parse((await runNpmWithRetry(host, ["ls", "--json", "pi-schematic",
      "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"], { capture: true })).stdout);
    const extension = graph.dependencies?.["pi-schematic"];
    if (!extension) throw new Error("Packed extension is missing from host graph");
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      const nested = join(host, "node_modules", "pi-schematic", "node_modules", ...name.split("/"), "package.json");
      if (existsSync(nested)) throw new Error(`Packed extension owns nested peer ${name}`);
    }

    writeFileSync(join(host, "smoke.mjs"), `
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
const extensionPath = join(process.cwd(), "node_modules", "pi-schematic", "index.ts");
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: join(process.cwd(), "agent"),
  additionalExtensionPaths: [extensionPath],
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
if (loaded.extensions.length !== 1) throw new Error("packed extension did not load");
`);
    runChecked(process.execPath, ["smoke.mjs"], { cwd: host });
    writeCompatArtifacts(artifactDir, host, {
      piVersion: latestPi.piVersion,
      typeboxVersion: latestPi.typeboxVersion,
    });
    process.stdout.write(`Packed latest Pi ${latestPi.piVersion} host smoke passed with host-provided peers.\n`);
  } catch (error) {
    writeCompatDiagnostics(artifactDir, host, error);
    throw error;
  } finally {
    if (tarball) rmSync(tarball, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMain) await main();
