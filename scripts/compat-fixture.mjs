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
export function parseNpmViewValue(stdout) {
  if (!stdout.trim()) return undefined;
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`Unexpected npm view --json output: ${JSON.stringify(stdout)}`, { cause });
  }
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

// npm before 12 returns `npm pack --json` as an array; npm 12 as an object keyed by package name.
export function packEntry(packJson) {
  let entry;
  if (Array.isArray(packJson) && packJson.length === 1) entry = packJson[0];
  else if (packJson && typeof packJson === "object" && Object.keys(packJson).length === 1) entry = Object.values(packJson)[0];
  if (typeof entry?.filename !== "string" || !entry.filename) {
    throw new Error(`Unexpected npm pack --json output: ${JSON.stringify(packJson)}`);
  }
  return entry;
}

/** Resolve one current Pi release and the exact TypeBox version it requires. */
export async function resolveLatestPi(copy) {
  const piStdout = (await runNpmWithRetry(copy, [
    "view", "@earendil-works/pi-coding-agent@latest", "version", "--json",
  ], { capture: true })).stdout;
  const piVersion = parseNpmViewValue(piStdout);
  if (typeof piVersion !== "string" || !piVersion) {
    throw new Error(`Latest Pi coding-agent did not declare a usable version: ${JSON.stringify(piStdout)}`);
  }
  const typeboxStdout = (await runNpmWithRetry(copy, [
    "view", `@earendil-works/pi-coding-agent@${piVersion}`, "dependencies.typebox", "--json",
  ], { capture: true })).stdout;
  const typeboxVersion = parseNpmViewValue(typeboxStdout);
  if (typeof typeboxVersion !== "string" || !typeboxVersion) {
    throw new Error(`Pi coding-agent ${piVersion} did not declare a usable TypeBox version: ${JSON.stringify(typeboxStdout)}`);
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
