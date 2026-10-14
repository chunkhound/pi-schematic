import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runNpmWithRetry } from "./compat-process.mjs";

// 3 direct Pi peers for host lane; current lane sync-asserts 4 (PI_SYNC_PACKAGES adds pi-agent-core transitively).
// Keep distinct — don't unify.
export const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export function createCompatCopy(root, prefix) {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  const copy = join(temp, "source");
  cpSync(root, copy, {
    recursive: true,
    filter: (source) => ![".git", "node_modules", "openspec"].includes(basename(source)),
  });
  return { temp, copy };
}

export function prepareCompatCopy(copy) {
  rmSync(join(copy, "package-lock.json"), { force: true });
  const packagePath = join(copy, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.scripts) delete packageJson.scripts.prepare;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

// `npm view --json` prints empty stdout and exits 0 for an undeclared field, and
// npm 12 wraps a single value in a one-element array.
function parseNpmViewValue(stdout) {
  if (!stdout.trim()) return undefined;
  const value = JSON.parse(stdout);
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

/** Resolve one current Pi release and the exact TypeBox version it requires. */
export async function resolveLatestPi(copy) {
  const piVersion = parseNpmViewValue((await runNpmWithRetry(copy, [
    "view", "@earendil-works/pi-coding-agent@latest", "version", "--json",
  ], { capture: true })).stdout);
  if (typeof piVersion !== "string" || !piVersion) {
    throw new Error("Latest Pi coding-agent did not declare usable Pi and TypeBox versions");
  }
  const typeboxVersion = parseNpmViewValue((await runNpmWithRetry(copy, [
    "view", `@earendil-works/pi-coding-agent@${piVersion}`, "dependencies.typebox", "--json",
  ], { capture: true })).stdout);
  if (typeof typeboxVersion !== "string" || !typeboxVersion) {
    throw new Error("Latest Pi coding-agent did not declare usable Pi and TypeBox versions");
  }
  return { piVersion, typeboxVersion };
}

export function latestPiDependencies({ piVersion, typeboxVersion }) {
  return Object.fromEntries([
    ...PI_PACKAGES.map((name) => [name, piVersion]),
    ["typebox", typeboxVersion],
  ]);
}

function copyCompatPackageLock(artifactDir, sourceDir, required = false) {
  const packageLock = join(sourceDir, "package-lock.json");
  if (!existsSync(packageLock)) {
    if (required) throw new Error(`Expected compatibility package lock at ${packageLock}`);
    return;
  }
  copyFileSync(packageLock, join(artifactDir, "package-lock.json"));
}

/** Write successful compatibility artifacts if configured. */
export function writeCompatArtifacts(artifactDir, sourceDir, { piVersion, typeboxVersion }) {
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  copyCompatPackageLock(artifactDir, sourceDir, true);
  writeFileSync(join(artifactDir, "versions.txt"), `pi=${piVersion}\ntypebox=${typeboxVersion}\nnode=${process.version}\n`);
}

/** Write failure diagnostics to artifact directory if configured. */
export function writeCompatDiagnostics(artifactDir, sourceDir, error) {
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  copyCompatPackageLock(artifactDir, sourceDir);
  writeFileSync(join(artifactDir, "failure.txt"), String(error));
}
