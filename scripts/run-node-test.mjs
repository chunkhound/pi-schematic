import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const updateSnapshots = args.includes("--update-snapshots");
const patterns = args.filter((arg) => arg !== "--update-snapshots");

if (patterns.length === 0) {
  throw new Error("Pass at least one test file or glob pattern.");
}

const loader = pathToFileURL(resolve(root, "register-loader.mjs")).href;
// WHY: e2e files spawn real pi CLI processes; cap concurrency so a 20-file run
// cannot start 20 hosts at once. Unit tests keep Node's default concurrency.
const e2e = patterns.some((p) => p.includes("tests/e2e/"));
const concurrency = e2e ? ["--test-concurrency=2"] : [];
const result = spawnSync(
  process.execPath,
  ["--import", loader, "--test", ...concurrency, ...patterns],
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
