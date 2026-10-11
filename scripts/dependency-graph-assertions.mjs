import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Pi peers and TypeBox whose installed version must equal the exact version package.json pins. */
export const GUARDED_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

function readInstalledVersion(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * Fail when an installed Pi/TypeBox package differs from the exact version package.json
 * pins. This catches a stale node_modules (for example Pi 0.84.1 installed while the repo
 * targets 0.99.2), which would otherwise make tests and typecheck silently run against an
 * older host API. `npm ci` restores the pinned versions.
 */
export function assertInstalledMatchesDeclared(root, packageNames = GUARDED_PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = manifest.devDependencies ?? {};
  const mismatches = [];
  for (const name of packageNames) {
    const expected = declared[name];
    if (typeof expected !== "string") continue;
    const installed = readInstalledVersion(root, name);
    if (installed !== expected) {
      mismatches.push(`${name}: installed ${installed ?? "missing"}, package.json declares ${expected}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      "Installed dependencies do not match package.json; run `npm ci` before testing. " +
        mismatches.join("; "),
    );
  }
}

function collectPackageOccurrences(graph, packageNames) {
  const targets = new Set(packageNames);
  const occurrences = new Map(packageNames.map((name) => [name, []]));

  function visit(node, path) {
    if (!node || typeof node !== "object" || !node.dependencies || typeof node.dependencies !== "object") return;
    for (const [name, dependency] of Object.entries(node.dependencies)) {
      const dependencyPath = `${path} > ${name}`;
      if (targets.has(name)) {
        occurrences.get(name).push({
          path: dependencyPath,
          version: typeof dependency?.version === "string" ? dependency.version : undefined,
        });
      }
      visit(dependency, dependencyPath);
    }
  }

  visit(graph, graph?.name ?? "root");
  return occurrences;
}

function formatVersion(version) {
  return version ?? "missing version";
}

export function assertSynchronizedPackageVersions(graph, packageNames) {
  if (packageNames.length === 0) throw new Error("Pass at least one package name to synchronize");
  const occurrences = collectPackageOccurrences(graph, packageNames);
  const packages = [];

  for (const name of packageNames) {
    const namedPackages = occurrences.get(name);
    if (namedPackages.length === 0) throw new Error(`Expected ${name} in the dependency graph, found no occurrences`);
    packages.push(...namedPackages.map((occurrence) => ({ name, ...occurrence })));
  }

  const versions = [...new Set(packages.map(({ version }) => formatVersion(version)))].sort();
  if (versions.length !== 1) {
    const found = packages.map(({ name, path, version }) => `${name}@${formatVersion(version)} at ${path}`).join(", ");
    throw new Error(`Expected synchronized package versions; found ${versions.join(", ")}: ${found}`);
  }
  if (packages[0].version === undefined) throw new Error(`Expected synchronized package versions; found missing version`);
  return packages[0].version;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assertInstalledMatchesDeclared(root);
}
