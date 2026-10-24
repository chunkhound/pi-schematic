import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertInstalledMatchesDeclared } from "./dependency-graph-assertions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// Guard against a stale node_modules: tests must never run against an older Pi than the
// repo pins, which is how an old local install silently reshaped the E2E suite once.
assertInstalledMatchesDeclared(root);
const args = process.argv.slice(2);
const updateSnapshots = args.includes("--update-snapshots");
const patterns = args.filter((arg) => arg !== "--update-snapshots");

if (patterns.length === 0) {
  throw new Error("Pass at least one test file or glob pattern.");
}

const loader = pathToFileURL(resolve(root, "register-loader.mjs")).href;
const result = spawnSync(
  process.execPath,
  ["--import", loader, "--test", ...patterns],
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
