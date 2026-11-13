/**
 * Invariant tests for reviewed declarations that CI and the repository must agree
 * on: the audit-ci allowlist policy, the pinned Pi and typebox versions with
 * lockfile parity, the repository-wide LF rule, the documented Pi floor, and the
 * CI step order.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { REPO_ROOT, REPO_ROOT_URL } from "../paths.js";
import { CHILD_TIMEOUT_MS, spawnNode } from "./spawn-node.js";

interface AuditRecord {
	active: boolean;
	expiry: string;
	notes: string;
}

interface AuditConfig {
	$schema: string;
	moderate: boolean;
	allowlist: Record<string, AuditRecord>[];
}

interface PackageJson {
	version: string;
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
}

const AUDIT_SCHEMA = "https://github.com/IBM/audit-ci/raw/main/docs/schema.json";
const AUDIT_CONFIG_PATH = new URL("audit-ci.jsonc", REPO_ROOT_URL);
const AUDIT_CI_BIN_URL = new URL("node_modules/audit-ci/dist/bin.js", REPO_ROOT_URL);
const PACKAGE_JSON_PATH = new URL("package.json", REPO_ROOT_URL);
const LOCK_PATH = new URL("package-lock.json", REPO_ROOT_URL);
const README_PATH = new URL("README.md", REPO_ROOT_URL);
const GITATTRIBUTES_PATH = new URL(".gitattributes", REPO_ROOT_URL);
const PINNED_PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;
// Pinned versions verified against package.json + lockfile.
// Update when Pi devDependencies are bumped.
const EXPECTED_PI_VERSION = "1.2.0";
const EXPECTED_TYPEBOX_VERSION = "1.3.27";
// Approved peer floors — must track the pinned devDependency versions above.
const EXPECTED_PI_PEER = `>=${EXPECTED_PI_VERSION}`;
const EXPECTED_TYPEBOX_PEER = `>=${EXPECTED_TYPEBOX_VERSION}`;
// Transitive undici and minimatch advisories in the pinned test host
// @earendil-works/pi-coding-agent@1.2.0 (devDependency). Remove an entry when a
// pinned host ships a patched version; the expiry forces periodic re-review.
const EXPECTED_ALLOWLIST_KEYS = new Set<string>([
	"GHSA-xjj6-f33q-929c",
	"GHSA-4qv8-2p9j-2685",
	"GHSA-f72v-6w45-q472",
	"GHSA-2m5v-pch6-74hx",
	"GHSA-4w7w-5xrc-9h26",
	"GHSA-qrxm-fqhp-jwvm",
	"GHSA-9fm3-97px-rjf6",
	"GHSA-55wc-3pg8-jfw6",
	"GHSA-g3hv-75wg-m249",
]);

function readText(url: URL): string {
	return readFileSync(url, "utf8");
}

function parseAuditConfig(): AuditConfig {
	const lines = readText(AUDIT_CONFIG_PATH)
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"));
	return JSON.parse(lines.join("\n")) as AuditConfig;
}

function parsePackageJson(): PackageJson {
	return JSON.parse(readText(PACKAGE_JSON_PATH)) as PackageJson;
}

function allowlistEntries(config: AuditConfig): [string, AuditRecord][] {
	return config.allowlist.map((entry) => {
		const [key, value] = Object.entries(entry)[0] ?? [];
		expect(key, "allowlist entry must define exactly one scoped advisory path").toBeTruthy();
		expect(value, `missing metadata for allowlist entry: ${key}`).toBeTruthy();
		return [key, value];
	});
}

function parseIsoDate(value: string): number {
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	expect(Number.isNaN(timestamp), `invalid ISO date: ${value}`).not.toBe(true);
	return timestamp;
}

// Runs the installed audit-ci bin, the one `npx audit-ci` resolves to in CI, as a Node child so it
// gets spawnNode's deadline and cleared NODE_OPTIONS.
function runAuditCi(): void {
	const args = [fileURLToPath(AUDIT_CI_BIN_URL), "--config", "audit-ci.jsonc"];
	const result = spawnNode(args, { cwd: REPO_ROOT });
	const diagnostics = [
		`command: node ${args.join(" ")}`,
		`status: ${String(result.status)}`,
		`stdout:\n${result.stdout}`,
		`stderr:\n${result.stderr}`,
	].join("\n");
	expect(result.status, diagnostics).toBe(0);
}

test("pinned Pi compatibility metadata stays exact", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as { packages: Record<string, { version?: string }> };
	for (const name of PINNED_PI_PACKAGES) {
		expect(packageJson.peerDependencies[name], `${name} peer must require ${EXPECTED_PI_PEER}`).toBe(EXPECTED_PI_PEER);
	}
	expect(packageJson.peerDependencies.typebox, `typebox peer must require ${EXPECTED_TYPEBOX_PEER}`).toBe(EXPECTED_TYPEBOX_PEER);
	for (const name of PINNED_PI_PACKAGES) {
		expect(packageJson.devDependencies[name]).toBe(EXPECTED_PI_VERSION);
		expect(lock.packages[`node_modules/${name}`]?.version).toBe(EXPECTED_PI_VERSION);
	}
	expect(packageJson.devDependencies.typebox).toBe(EXPECTED_TYPEBOX_VERSION);
	expect(lock.packages["node_modules/typebox"]?.version).toBe(EXPECTED_TYPEBOX_VERSION);
	expect(packageJson.devDependencies["@earendil-works/pi-agent-core"], "pi-agent-core must be an exact devDependency on the pinned Pi version").toBe(EXPECTED_PI_VERSION);
	expect(packageJson.peerDependencies, "pi-agent-core must not be a peer").not.toHaveProperty(["@earendil-works/pi-agent-core"]);
	expect(lock.packages["node_modules/@earendil-works/pi-agent-core"]?.version, "pi-agent-core must stay on the pinned Pi version; its exact devDependency keeps it there").toBe(EXPECTED_PI_VERSION);
});

test("package and lockfile versions agree", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as { version?: string; packages: Record<string, { version?: string }> };
	expect(lock.version, "package-lock.json version must match package.json").toBe(packageJson.version);
	expect(lock.packages[""]?.version, "package-lock.json root package version must match package.json").toBe(packageJson.version);
});

// WHY: one global `* text=auto eol=lf` rule plus the EOL report keep every tracked
// text file LF, whatever core.autocrlf says.
const EOL_MARKERS = new Set(["i/crlf", "i/mixed", "w/crlf", "w/mixed"]);
function eolViolations(report: string): string[] {
	return report.split("\n").filter((line) => line.split(/\s+/).some((field) => EOL_MARKERS.has(field)));
}
const eolReportLine = (index: string, worktree: string): string => `i/${index}    w/${worktree}    attr/text=auto eol=lf \tREADME.md`;

test.for([
	{ index: "crlf", worktree: "lf" },
	{ index: "mixed", worktree: "lf" },
	{ index: "lf", worktree: "crlf" },
	{ index: "lf", worktree: "mixed" },
])("the EOL report check rejects i/$index w/$worktree", ({ index, worktree }) => {
	expect(eolViolations(eolReportLine(index, worktree))).toHaveLength(1);
});

test("the EOL report check accepts LF text and non-text files", () => {
	expect(eolViolations(eolReportLine("lf", "lf")), "clean LF report must pass").toStrictEqual([]);
	expect(eolViolations("i/none    w/none    -text\tlogo.gif"), "non-text files must not be flagged").toStrictEqual([]);
});

test("repository text has one LF line-ending contract", () => {
	const rules = readText(GITATTRIBUTES_PATH).split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
	expect(rules, "all text must check out with LF; see .gitattributes").toStrictEqual(["* text=auto eol=lf"]);
	// spawnNode runs only node; the same deadline keeps a stalled git child from hanging the worker.
	const result = spawnSync("git", ["ls-files", "--eol"], { cwd: REPO_ROOT, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
	expect(result.error, `git ls-files --eol did not run: ${result.error?.message}`).toBeUndefined();
	expect(result.status, `git ls-files --eol failed: ${result.stderr}`).toBe(0);
	expect(result.stdout, "git ls-files --eol must report i/lf and w/lf").toMatch(/i\/lf\s+w\/lf/);
	expect(eolViolations(result.stdout), "tracked text must be LF; stale Windows checkout recovery (discards uncommitted changes, so commit or stash first): git rm --cached -r . && git reset --hard").toStrictEqual([]);
});

test("README names the current Pi floor", () => {
	const readme = readText(README_PATH);
	// The optional group matches the linked form, `[Pi](https://pi.dev) 1.2.0`.
	const versions = new Set(Array.from(readme.matchAll(/Pi(?:\]\([^)]*\))? (\d+\.\d+\.\d+)/g), (match) => match[1]));
	expect([...versions], "every Pi version mention in README must name the Pi floor").toStrictEqual([EXPECTED_PI_VERSION]);
	expect(readme, "README still names the retired Pi floor").not.toMatch(/0\.99\.2/);
});

test("audit-ci config enforces the reviewed allowlist policy", () => {
	const config = parseAuditConfig();
	expect(config.$schema).toBe(AUDIT_SCHEMA);
	expect(config.moderate).toBe(true);

	const entries = allowlistEntries(config);
	expect(new Set(entries.map(([key]) => key))).toStrictEqual(EXPECTED_ALLOWLIST_KEYS);
	const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
	for (const [key, value] of entries) {
		expect(key).toMatch(/^GHSA-[a-z0-9-]+(?:\|[^|>]+(?:>[^|>]+)*)?$/);
		expect(value.active).toBe(true);
		expect(value.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(parseIsoDate(value.expiry), `expired allowlist entry: ${key}`).toBeGreaterThanOrEqual(today);
		expect(value.notes.trim()).not.toBe("");
	}
});

test("audit-ci config matches the CI audit command", () => {
	runAuditCi();
});
