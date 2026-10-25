// Locations and names shared by the test files. This module imports neither pi nor Vitest.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root as a directory URL (trailing slash), for `new URL(relative, REPO_ROOT_URL)`. */
export const REPO_ROOT_URL = new URL("../", import.meta.url);

/** The repository root as a filesystem path, without a trailing separator. */
export const REPO_ROOT = resolve(fileURLToPath(REPO_ROOT_URL));

/** The file URL of register-loader.mjs, as `node --import` takes it. */
export const REGISTER_LOADER_URL = new URL("register-loader.mjs", REPO_ROOT_URL).href;

/**
 * The variable pi reads its agent directory from. pi resolves it before HOME, so a test that
 * isolates HOME also clears or sets this variable.
 */
export const AGENT_DIR_ENV_KEY = "PI_CODING_AGENT_DIR";
