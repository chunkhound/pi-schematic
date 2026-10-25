import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VITEST_FILES } from "../tests/vitest-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const updateSnapshots = args.includes("--update-snapshots");
const flags = args.filter((arg) => arg.startsWith("--") && arg !== "--update-snapshots");
const patterns = args.filter((arg) => !arg.startsWith("--"));

if (patterns.length === 0) {
  throw new Error("Pass at least one test file or glob pattern.");
}

// The files listed in tests/vitest-files.mjs run on Vitest, so this runner drops them from the
// files its patterns match. The exclusion is temporary while the suite moves to Vitest.
const vitestFiles = new Set(VITEST_FILES.map((file) => resolve(root, file)));
for (const file of vitestFiles) {
  if (!existsSync(file)) throw new Error(`tests/vitest-files.mjs lists ${file}, which does not exist.`);
}

const files = [];
for (const pattern of patterns) {
  const matches = globSync(pattern, { cwd: root });
  if (matches.length === 0) throw new Error(`No test file matches ${pattern}.`);
  for (const match of matches) {
    const file = resolve(root, match);
    if (!vitestFiles.has(file) && !files.includes(file)) files.push(file);
  }
}

if (files.length === 0) {
  throw new Error(`Every file matching ${patterns.join(" ")} runs on Vitest; run it with vitest instead.`);
}

const loader = pathToFileURL(resolve(root, "register-loader.mjs")).href;
const result = spawnSync(
  process.execPath,
  ["--import", loader, "--test", ...flags, ...files],
  {
    cwd: root,
    stdio: "inherit",
    env: updateSnapshots
      ? { ...process.env, UPDATE_SNAPSHOTS: "1" }
      : process.env,
  },
);

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
