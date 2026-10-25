import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
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
// files its patterns match, and refuses one named by its path instead of matched by a glob, which
// would otherwise run in neither runner. The exclusion is temporary while the suite moves to Vitest.
const vitestFiles = new Set(VITEST_FILES.map((file) => resolve(root, file)));
for (const file of vitestFiles) {
  if (!existsSync(file)) throw new Error(`tests/vitest-files.mjs lists ${file}, which does not exist.`);
}

const files = [];
for (const pattern of patterns) {
  // node --test skips node_modules on its own; the runner matches the files itself, so it must too.
  const matches = globSync(pattern, { cwd: root, exclude: ["**/node_modules/**"] });
  if (matches.length === 0) throw new Error(`No test file matches ${pattern}.`);
  for (const match of matches) {
    const file = resolve(root, match);
    if (vitestFiles.has(file) && file === resolve(root, pattern)) {
      throw new Error(`${pattern} runs on Vitest; run it with vitest instead.`);
    }
    if (!vitestFiles.has(file) && !files.includes(file)) files.push(file);
  }
}

if (files.length === 0) {
  throw new Error(`Every file matching ${patterns.join(" ")} runs on Vitest; run it with vitest instead.`);
}

const loader = pathToFileURL(resolve(root, "register-loader.mjs")).href;
// node --test reads each argument as a glob pattern, so a path containing glob characters such as
// `[ab]` matches nothing; relative paths keep the checkout's directory names out of the pattern.
const testFiles = files.map((file) => relative(root, file).split(sep).join("/"));
const result = spawnSync(
  process.execPath,
  ["--import", loader, "--test", ...flags, ...testFiles],
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
