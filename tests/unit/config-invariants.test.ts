/**
 * Invariant tests for reviewed declarations that CI and the repository must agree
 * on: the audit-ci allowlist policy, the pinned Pi, typebox and TypeScript alias
 * versions with lockfile parity, the Renovate TypeScript group and its
 * typescript-eslint peer range (sourced from the installed manifest), the two CI
 * workflows' Type-check step contract (unconditional and blocking), the verified
 * installed native compiler and engine artifacts, the repository-wide LF rule,
 * and the documented Pi floor.
 */

import { existsSync, readFileSync } from "node:fs";
import { CANCEL_CONFIRM_MS } from "../../workflow/command.js";
import { MAX_DEFERRED_EFFECTS, MAX_EFFECTS } from "../../workflow/host.js";
import { HANDOFF_TIMEOUT_MS } from "../../workflow/rebind.js";
import { HARD_DEADLINE_FACTOR, MAX_TIMEOUT_MS } from "../../workflow/sandbox.js";
import { TIME_PRESET_MS, TIME_PRESETS } from "../../workflow/limits-dialog.js";
import { MAX_EFFECT_ROWS, MAX_MODELS_COLLAPSED } from "../../workflow/summary-renderer.js";
import { STRUCTURED_OUTPUT_TOOL } from "../../workflow/output.js";
import { RESERVED_REASONS } from "../../workflow/types.js";
import { createWorkflowAutocompleteProvider } from "../../workflow/autocomplete.js";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { assertPresent, assertString } from "../assertions.js";
import { REPO_ROOT, REPO_ROOT_URL } from "../paths.js";
import { parseJson } from "./parse-json.js";
import { runGit, spawnNode } from "./spawn-node.js";

// The schemas check only the shape the parsers need; the tests assert each field with a message
// that names the offending entry.
const JsonRecord = Type.Record(Type.String(), Type.Unknown());

const AuditConfig = Type.Object({
	$schema: Type.Unknown(),
	moderate: Type.Unknown(),
	allowlist: Type.Array(Type.Unknown()),
});
type AuditConfig = Static<typeof AuditConfig>;

const PackageJson = Type.Object({
	version: Type.String(),
	peerDependencies: JsonRecord,
	devDependencies: JsonRecord,
	overrides: Type.Optional(JsonRecord),
	scripts: Type.Optional(Type.Object({ typecheck: Type.String() })),
	engines: Type.Optional(Type.Object({ node: Type.String() })),
});
type PackageJson = Static<typeof PackageJson>;

const LockPackages = Type.Record(Type.String(), Type.Object({ version: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }));
const InstalledPackage = Type.Object({ name: Type.String(), version: Type.String() });
const PeerManifest = Type.Object({ peerDependencies: Type.Object({ typescript: Type.String() }) });
const RenovateRules = Type.Object({ packageRules: Type.Array(Type.Record(Type.String(), Type.Unknown())) });

interface LockEntry {
	version?: string;
	name?: string;
}
type LockPackagesMap = Partial<Record<string, LockEntry>>;
type RenovateRule = Record<string, unknown>;

const AUDIT_SCHEMA = "https://github.com/IBM/audit-ci/raw/main/docs/schema.json";
const AUDIT_CONFIG_PATH = new URL("audit-ci.jsonc", REPO_ROOT_URL);
const AUDIT_CI_BIN_URL = new URL("node_modules/audit-ci/dist/bin.js", REPO_ROOT_URL);
const PACKAGE_JSON_PATH = new URL("package.json", REPO_ROOT_URL);
const LOCK_PATH = new URL("package-lock.json", REPO_ROOT_URL);
const RENOVATE_CONFIG_PATH = new URL(".github/renovate.json", REPO_ROOT_URL);
const README_PATH = new URL("README.md", REPO_ROOT_URL);
const GITATTRIBUTES_PATH = new URL(".gitattributes", REPO_ROOT_URL);
const PINNED_PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;
// Pinned versions verified against package.json + lockfile.
// Update when Pi devDependencies are bumped.
const EXPECTED_PI_VERSION = "1.2.0";
const EXPECTED_TYPEBOX_VERSION = "1.3.27";
const EXPECTED_NODE_FLOOR = "22.19.0";
// Approved peer floors — must track the pinned devDependency versions above.
const EXPECTED_PI_PEER = `>=${EXPECTED_PI_VERSION}`;
const EXPECTED_TYPEBOX_PEER = `>=${EXPECTED_TYPEBOX_VERSION}`;
const TYPESCRIPT_ESLINT_PACKAGE_PATH = new URL("node_modules/typescript-eslint/package.json", REPO_ROOT_URL);
const CONTRIBUTING_PATH = new URL("CONTRIBUTING.md", REPO_ROOT_URL);
const INSTALLED_TYPESCRIPT_PATH = new URL("node_modules/typescript/package.json", REPO_ROOT_URL);
// Single source for the native compiler bin path: the probe, the typecheck script expectation, and
// the helper all derive from this so they cannot drift.
const NATIVE_TSC_BIN_PATH = "node_modules/@typescript/native/bin/tsc";
const NATIVE_TSC_BIN_URL = new URL(NATIVE_TSC_BIN_PATH, REPO_ROOT_URL);
const TYPECHECK_SCRIPT = `node ${NATIVE_TSC_BIN_PATH} --noEmit`;
// The engine hoists to node_modules root; the lock guard and installed guard share this one key.
const OLD_ENGINE_LOCK_KEY = "node_modules/@typescript/old";
const OLD_ENGINE_MANIFEST = new URL(`${OLD_ENGINE_LOCK_KEY}/package.json`, REPO_ROOT_URL);
const CI_WORKFLOW_PATH = new URL(".github/workflows/ci.yml", REPO_ROOT_URL);
const NPM_PUBLISH_WORKFLOW_PATH = new URL(".github/workflows/npm-publish.yml", REPO_ROOT_URL);
const TYPESCRIPT_ALIASES = [
	{ manifestKey: "@typescript/native", lockKey: "node_modules/@typescript/native" },
	{ manifestKey: "typescript", lockKey: "node_modules/typescript" },
] as const;
// Transitive undici and minimatch advisories in the pinned test host
// @earendil-works/pi-coding-agent@1.2.0 (devDependency), and the picomatch advisory
// in the lint, test and dead-code tooling. Remove an entry when a patched version
// is installed; the expiry forces periodic re-review.
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
	"GHSA-fc5q-39xc-vjpf",
]);

function readText(url: URL): string {
	return readFileSync(url, "utf8");
}

function parseAuditConfig(): AuditConfig {
	const lines = readText(AUDIT_CONFIG_PATH)
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"));
	return parseJson(AuditConfig, lines.join("\n"), "audit-ci.jsonc");
}

function parsePackageJson(): PackageJson {
	return parseJson(PackageJson, readText(PACKAGE_JSON_PATH), "package.json");
}

function allowlistEntries(config: AuditConfig): [string, Record<string, unknown>][] {
	return config.allowlist.map((entry) => {
		const [key, value] = Value.Check(JsonRecord, entry) ? (Object.entries(entry)[0] ?? []) : [];
		if (key === undefined || key === "") {
			throw new Error("allowlist entry must define exactly one scoped advisory path");
		}
		if (!Value.Check(JsonRecord, value)) {
			throw new Error(`missing metadata for allowlist entry: ${key}`);
		}
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
function runAuditCi(): { status: number | null; diagnostics: string } {
	const args = [fileURLToPath(AUDIT_CI_BIN_URL), "--config", "audit-ci.jsonc"];
	const result = spawnNode(args, { cwd: REPO_ROOT });
	const diagnostics = [`command: node ${args.join(" ")}`, `status: ${String(result.status)}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join(
		"\n",
	);
	return { status: result.status, diagnostics };
}

const assertPinnedPeer = (packageJson: PackageJson, name: string): void => {
	expect(packageJson.peerDependencies[name], `${name} peer must require ${EXPECTED_PI_PEER}`).toBe(EXPECTED_PI_PEER);
};

const assertPinnedDevDep = (packageJson: PackageJson, lock: { packages: LockPackagesMap }, name: string): void => {
	expect(packageJson.devDependencies[name], `${name} devDependency must be pinned`).toBe(EXPECTED_PI_VERSION);
	expect(lock.packages[`node_modules/${name}`]?.version, `${name} lock entry must match the pin`).toBe(EXPECTED_PI_VERSION);
};

const assertAgentCorePin = (packageJson: PackageJson, lock: { packages: LockPackagesMap }): void => {
	expect(packageJson.devDependencies["@earendil-works/pi-agent-core"], "pi-agent-core must be an exact devDependency on the pinned Pi version").toBe(
		EXPECTED_PI_VERSION,
	);
	expect(packageJson.peerDependencies, "pi-agent-core must not be a peer").not.toHaveProperty(["@earendil-works/pi-agent-core"]);
	expect(
		lock.packages["node_modules/@earendil-works/pi-agent-core"]?.version,
		"pi-agent-core must stay on the pinned Pi version; its exact devDependency keeps it there",
	).toBe(EXPECTED_PI_VERSION);
};

test("pinned Pi compatibility metadata stays exact", () => {
	const packageJson = parsePackageJson();
	const lock = readLock();
	for (const name of PINNED_PI_PACKAGES) {
		assertPinnedPeer(packageJson, name);
	}
	expect(packageJson.peerDependencies.typebox, `typebox peer must require ${EXPECTED_TYPEBOX_PEER}`).toBe(EXPECTED_TYPEBOX_PEER);
	for (const name of PINNED_PI_PACKAGES) {
		assertPinnedDevDep(packageJson, lock, name);
	}
	expect(packageJson.devDependencies.typebox).toBe(EXPECTED_TYPEBOX_VERSION);
	expect(lock.packages["node_modules/typebox"]?.version).toBe(EXPECTED_TYPEBOX_VERSION);
	assertAgentCorePin(packageJson, lock);
});

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const depNames = (rule: RenovateRule): string[] => asStringArray(rule.matchDepNames);

// Plain x.y.z tuple compare (prerelease-free versions); avoids padded-string mis-ordering.
function parseSemverTuple(version: string): [number, number, number] {
	const parts = version.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
		throw new Error(`expected a plain semver, got: ${version}`);
	}
	return [parts[0], parts[1], parts[2]];
}

function ltSemver(left: string, right: string): boolean {
	const [lMajor, lMinor, lPatch] = parseSemverTuple(left);
	const [rMajor, rMinor, rPatch] = parseSemverTuple(right);
	return lMajor !== rMajor ? lMajor < rMajor : lMinor !== rMinor ? lMinor < rMinor : lPatch < rPatch;
}

function aliasPin(spec: unknown): { name: string; version: string } {
	const match = typeof spec === "string" ? /^npm:(@?[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec) : null;
	if (match === null) {
		throw new Error(`exact alias pin expected (npm:<name>@<semver>), got: ${String(spec)}`);
	}
	return { name: match[1], version: match[2] };
}

interface PeerRange {
	floor: string;
	ceiling: string;
}

// The typescript-eslint peer range is two-sided (`>=4.8.4 <6.1.0`); parse both bounds so a
// future floor raise fails loudly instead of passing every gate.
function typescriptEslintPeerRange(): PeerRange {
	const manifest = parseJson(PeerManifest, readText(TYPESCRIPT_ESLINT_PACKAGE_PATH), "typescript-eslint package.json");
	const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(manifest.peerDependencies.typescript);
	if (match === null) {
		throw new Error(`typescript-eslint peer range must be exactly ">=<floor> <<ceiling>": ${manifest.peerDependencies.typescript}`);
	}
	return { floor: match[1], ceiling: match[2] };
}

const withinPeerRange = (version: string, peer: PeerRange): boolean => !ltSemver(version, peer.floor) && ltSemver(version, peer.ceiling);

function readLock(): { version?: string; packages: LockPackagesMap } {
	return parseJson(Type.Object({ version: Type.Optional(Type.String()), packages: LockPackages }), readText(LOCK_PATH), "package-lock.json");
}

function requireRule(rules: RenovateRule[], predicate: (rule: RenovateRule) => boolean, what: string): RenovateRule {
	const rule = rules.find(predicate);
	if (rule === undefined) {
		throw new Error(`${what} rule not found in .github/renovate.json`);
	}
	return rule;
}

function engineEntry(packages: LockPackagesMap): LockEntry | undefined {
	return packages[OLD_ENGINE_LOCK_KEY];
}

const assertAliasMaterialized = (packageJson: PackageJson, lock: { packages: LockPackagesMap }, manifestKey: string, lockKey: string): void => {
	const pin = aliasPin(packageJson.devDependencies[manifestKey]);
	const entry = lock.packages[lockKey];
	expect(entry, `lock must materialize ${lockKey}`).toBeDefined();
	expect(entry?.name).toBe(pin.name);
	expect(entry?.version).toBe(pin.version);
};

function nativeEntries(packages: LockPackagesMap): { path: string; entry: LockEntry | undefined }[] {
	return Object.entries(packages)
		.filter(([path]) => path.startsWith("node_modules/") && path.endsWith("/@typescript/native"))
		.map(([path, entry]) => ({ path, entry }));
}

// Spawn a child, assert a clean exit, and return trimmed stdout: the shared version-probe that every
// compiler-version assertion reuses so probes stay uniform and bodies stay short.
function probeVersionOutput(args: readonly string[]): string {
	const result = spawnNode(args, { cwd: REPO_ROOT });
	expect(result.status, "the probed process must exit cleanly").toBe(0);
	return result.stdout.trim();
}

// Runs the same bin the typecheck script invokes; the version it reports must equal the manifest pin,
// so a swapped artifact (e.g. @typescript/old) cannot pass while the manifest pins another compiler.
function assertNativeProbe(nativePin: { version: string }): void {
	expect(probeVersionOutput([fileURLToPath(NATIVE_TSC_BIN_URL), "--version"]), "the native tsc bin must report the pinned version").toBe(
		`Version ${nativePin.version}`,
	);
}

// The engine override, its lock materialization and the peer-range placement are one contract;
// grouped so the alias test stays readable and the pieces cannot drift apart.
function assertEngineOverride(packageJson: PackageJson, lock: { packages: LockPackagesMap }, peer: PeerRange): void {
	const overrideSpec = packageJson.overrides?.["@typescript/old"];
	expect(overrideSpec, "package.json must override @typescript/old to an exact engine pin").toMatch(/^npm:typescript@\d+\.\d+\.\d+$/);
	const enginePin = aliasPin(overrideSpec);
	const engine = engineEntry(lock.packages);
	expect(engine, "lock must materialize the pinned engine @typescript/old").toMatchObject({ name: enginePin.name, version: enginePin.version });
	const alias = aliasPin(packageJson.devDependencies.typescript);
	expect(
		[withinPeerRange(enginePin.version, peer), withinPeerRange(alias.version, peer)],
		"engine and typescript alias must sit inside the typescript-eslint peer range",
	).toStrictEqual([true, true]);
}

test("pinned TypeScript aliases stay exact and materialize in the lock", () => {
	const packageJson = parsePackageJson();
	const lock = readLock();
	for (const { manifestKey, lockKey } of TYPESCRIPT_ALIASES) {
		assertAliasMaterialized(packageJson, lock, manifestKey, lockKey);
	}
	assertEngineOverride(packageJson, lock, typescriptEslintPeerRange());
	expect(readText(CONTRIBUTING_PATH), "CONTRIBUTING.md must document the engine override pattern").toMatch(/npm:typescript@/);
	expect(packageJson.overrides?.["@typescript/native"], "package.json must self-reference @typescript/native").toBe("$@typescript/native");
});

test("installed native compiler matches the pinned alias", () => {
	const packageJson = parsePackageJson();
	const lock = readLock();
	// Every @typescript/native copy (root or nested under the eslint plugins) must share the manifest
	// pin; a regenerated lock silently drifting to a nightly build fails here.
	const nativePin = aliasPin(packageJson.devDependencies["@typescript/native"]);
	const natives = nativeEntries(lock.packages);
	expect(natives, "the @typescript/native pin must materialize in the lock").not.toHaveLength(0);
	for (const { path, entry } of natives) {
		expect(entry, `${path} must be the pinned native compiler`).toMatchObject({ name: "typescript", version: nativePin.version });
	}
	// Probe the bin the typecheck script actually runs: lock labels and the TS6 shim can agree while a
	// swapped artifact (e.g. @typescript/old) is installed. Report the version the compiler really is.
	assertNativeProbe(nativePin);
});

test("installed shim and engine match their pins", () => {
	const packageJson = parsePackageJson();
	// Lock labels can name the right shim while npm ci installs the wrong artifact (a swapped
	// resolved/integrity pair); verify what is installed and what the forwarder reports.
	const enginePin = aliasPin(packageJson.overrides?.["@typescript/old"]);
	const shimPin = aliasPin(packageJson.devDependencies.typescript);
	const shim = parseJson(InstalledPackage, readText(INSTALLED_TYPESCRIPT_PATH), "installed node_modules/typescript/package.json");
	expect(shim, "installed typescript must be the aliased shim").toMatchObject({ name: shimPin.name, version: shimPin.version });
	const installedEngine = parseJson(InstalledPackage, readText(OLD_ENGINE_MANIFEST), "installed engine manifest");
	expect(installedEngine, "installed engine must match the override pin").toMatchObject({ name: enginePin.name, version: enginePin.version });
	expect(
		probeVersionOutput(["-e", "process.stdout.write(require('typescript').version)"]),
		"the installed typescript forwarder must report the pinned engine version",
	).toBe(enginePin.version);
});

// Parse the workflow YAML structurally (yaml is a direct devDependency, so knip stays quiet): a
// raw-text regex accepts a commented-out step or a `run: "true"` placeholder, while YAML semantics
// make the contract explicit — `run` must be the exact string, not a boolean or empty.
interface WorkflowStep {
	name?: string;
	run?: unknown;
	if?: unknown;
	"continue-on-error"?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function workflowSteps(workflow: string, jobName: string): WorkflowStep[] {
	const doc: unknown = parse(workflow);
	if (!isRecord(doc) || !("jobs" in doc)) {
		return [];
	}
	const jobs: unknown = doc.jobs;
	if (!isRecord(jobs) || !(jobName in jobs)) {
		return [];
	}
	const job: unknown = jobs[jobName];
	if (!isRecord(job) || !("steps" in job)) {
		return [];
	}
	const steps: unknown = job.steps;
	return Array.isArray(steps) ? steps.filter((step): step is WorkflowStep => isRecord(step)) : [];
}

function requireExecutableTypecheckStep(workflow: string, fileName: string, jobName: string): void {
	const step = workflowSteps(workflow, jobName).find((candidate) => candidate.name === "Type check");
	expect(step, `${fileName} ${jobName} job must have a "Type check" step`).toBeDefined();
	expect(step?.run, `${fileName} ${jobName} job "Type check" step must run "npm run typecheck"`).toBe("npm run typecheck");
	// The gate must be unconditional and blocking: a skipped or tolerated Type check would silently
	// regress the repo, so the step must not carry an `if` or `continue-on-error`.
	expect(step?.if, `${fileName} ${jobName} job "Type check" step must be unconditional (no if)`).toBeUndefined();
	expect(step?.["continue-on-error"], `${fileName} ${jobName} job "Type check" step must be blocking (no continue-on-error)`).toBeUndefined();
}

// Matches any direct compiler invocation in a run value: bare tsc or the tsc6 shim bin as whole
// words anywhere (start, middle, trailing), which also covers path-prefixed bins; safe tokens like
// `npm run typecheck` or `tsconfig` stay unmatched.
const DIRECT_TSC_RUN_REGEX = /\btsc6?\b/;

// Asserts no step in the job runs the compiler directly (bare tsc / a path-prefixed tsc or tsc6
// bin), bypassing the typecheck script. Scoped to run values, never whole-file text, so comments
// naming tsc cannot false-positive.
function assertNoDirectTscRuns(workflow: string, fileName: string, jobName: string): void {
	for (const step of workflowSteps(workflow, jobName)) {
		if (typeof step.run === "string") {
			expect(step.run, `${fileName} ${jobName} step ${step.name ?? "<unnamed>"} must never invoke tsc directly`).not.toMatch(DIRECT_TSC_RUN_REGEX);
		}
	}
}

test("typecheck always invokes the native TypeScript 7 compiler", () => {
	const packageJson = parsePackageJson();
	expect(packageJson.scripts?.typecheck, "typecheck must invoke the pinned native compiler bin").toBe(TYPECHECK_SCRIPT);
	for (const [name, jobName, workflow] of [
		["ci.yml", "test", readText(CI_WORKFLOW_PATH)],
		["npm-publish.yml", "publish", readText(NPM_PUBLISH_WORKFLOW_PATH)],
	] as const) {
		requireExecutableTypecheckStep(workflow, name, jobName);
		assertNoDirectTscRuns(workflow, name, jobName);
	}
});

// Every way a workflow could call the compiler directly, bypassing the typecheck script:
// path-prefixed bins, bare tsc in trailing/mid-string positions, and the tsc6 shim bin.
const DIRECT_TSC_RUN_BYPASSES = [
	{ run: "./node_modules/.bin/tsc --noEmit" },
	{ run: "npm run build && tsc" },
	{ run: "npx -p typescript tsc --noEmit" },
	{ run: "npx tsc6" },
] as const;

const SAFE_TSC_RUNS = [
	{ run: "npm run typecheck" },
	{ run: "npm run typecheck && npm run lint" },
	{ run: "npm ci" },
	{ run: "node scripts/build.mjs" },
	{ run: "ls tsconfig.json" },
] as const;

test.each(DIRECT_TSC_RUN_BYPASSES)("direct-tsc guard rejects bypass run $run", ({ run }) => {
	expect(run, "the guard must flag every direct compiler invocation").toMatch(DIRECT_TSC_RUN_REGEX);
});

test.each(SAFE_TSC_RUNS)("direct-tsc guard keeps safe run $run", ({ run }) => {
	expect(run, "safe runs must stay unflagged").not.toMatch(DIRECT_TSC_RUN_REGEX);
});

const assertCeilingRule = (ceiling: string, renovate: { packageRules: RenovateRule[] }): void => {
	const ceilingRule = requireRule(
		renovate.packageRules,
		(rule) => typeof rule.allowedVersions === "string" && depNames(rule).includes("typescript"),
		"typescript ceiling",
	);
	expect(ceilingRule.allowedVersions, "typescript alias ceiling must equal the typescript-eslint peer bound").toBe(`<${ceiling}`);
	expect(new Set(depNames(ceilingRule)), "ceiling must cap exactly typescript and @typescript/old").toEqual(new Set(["typescript", "@typescript/old"]));
	expect(readText(CONTRIBUTING_PATH), "CONTRIBUTING.md must document the typescript-eslint peer ceiling").toContain(`<${ceiling}`);
};

test("Renovate TypeScript group pins all three names and caps the engine", () => {
	const renovate = parseJson(RenovateRules, readText(RENOVATE_CONFIG_PATH), ".github/renovate.json");
	const tsGroup = requireRule(renovate.packageRules, (rule) => rule.groupName === "TypeScript", "TypeScript group");
	expect(tsGroup.rangeStrategy, "TypeScript group must pin updates").toBe("pin");
	expect(new Set(depNames(tsGroup)), "TypeScript group must cover exactly the three pinned names").toEqual(
		new Set(["typescript", "@typescript/native", "@typescript/old"]),
	);
	assertCeilingRule(typescriptEslintPeerRange().ceiling, renovate);
});

test("package and lockfile versions agree", () => {
	const packageJson = parsePackageJson();
	const lock = readLock();
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
	const rules = readText(GITATTRIBUTES_PATH)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	expect(rules, "all text must check out with LF; see .gitattributes").toStrictEqual(["* text=auto eol=lf"]);
	const eolReport = runGit(["ls-files", "--eol"], { cwd: REPO_ROOT });
	expect(eolReport, "git ls-files --eol must report i/lf and w/lf").toMatch(/i\/lf\s+w\/lf/);
	expect(
		eolViolations(eolReport),
		"tracked text must be LF; stale Windows checkout recovery (discards uncommitted changes, so commit or stash first): git rm --cached -r . && git reset --hard",
	).toStrictEqual([]);
});

test("README names the current Pi floor", () => {
	const readme = readText(README_PATH);
	// The optional group matches the linked form, `[Pi](https://pi.dev) 1.2.0`.
	const versions = new Set(Array.from(readme.matchAll(/Pi(?:\]\([^)]*\))? (\d+\.\d+\.\d+)/g), (match) => match[1]));
	expect([...versions], "every Pi version mention in README must name the Pi floor").toStrictEqual([EXPECTED_PI_VERSION]);
	expect(readme, "README still names the retired Pi floor").not.toMatch(/0\.99\.2/);
});

function assertAllowlistEntry(key: string, value: Record<string, unknown>, today: number): void {
	expect(key).toMatch(/^GHSA-[a-z0-9-]+(?:\|[^|>]+(?:>[^|>]+)*)?$/);
	expect(value.active, `allowlist entry must be active: ${key}`).toBe(true);
	assertString(value.expiry, `allowlist entry needs an expiry date: ${key}`);
	expect(value.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	expect(parseIsoDate(value.expiry), `expired allowlist entry: ${key}`).toBeGreaterThanOrEqual(today);
	assertString(value.notes, `allowlist entry needs notes: ${key}`);
	expect(value.notes.trim(), `allowlist entry needs notes: ${key}`).not.toBe("");
}

test("audit-ci config enforces the reviewed allowlist policy", () => {
	const config = parseAuditConfig();
	expect(config.$schema).toBe(AUDIT_SCHEMA);
	expect(config.moderate).toBe(true);

	const entries = allowlistEntries(config);
	expect(new Set(entries.map(([key]) => key))).toStrictEqual(EXPECTED_ALLOWLIST_KEYS);
	const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
	for (const [key, value] of entries) {
		assertAllowlistEntry(key, value, today);
	}
});

test("audit-ci config matches the CI audit command", () => {
	const { status, diagnostics } = runAuditCi();
	expect(status, diagnostics).toBe(0);
});

// ── Workflow invariants (from the /workflow chain) ────────────────

const WORKFLOW_PATH = new URL(".github/workflows/ci.yml", REPO_ROOT_URL);
const WORKFLOWS_DOC_PATH = new URL("docs/workflows.md", REPO_ROOT_URL);
const WORKFLOW_ENGINE_DOC_PATH = new URL("docs/workflow-engine.md", REPO_ROOT_URL);
const ARCHITECTURE_DOC_PATH = new URL("docs/architecture.md", REPO_ROOT_URL);

const EXPECTED_MATRIX = new Set([
	"ubuntu-latest@22.19.0",
	"ubuntu-latest@26.13.1",
	"macos-latest@22.19.0",
	"macos-latest@26.13.1",
	"windows-latest@22.19.0",
	"windows-latest@26.13.1",
]);

function parseMatrixEntries(workflow: string): Set<string> {
	const osMatch = /\bos: \[([^\]]+)\]/.exec(workflow);
	const includeMatches = workflow.matchAll(/- track: ([^\n]+)\n\s+node-version: "([^"]+)"/g);
	const oses = osMatch ? osMatch[1].split(",").map((s) => s.trim()) : [];
	const nodes = Array.from(includeMatches, ([, _track, node]) => node.trim());
	const result = new Set<string>();
	for (const os of oses) {
		for (const node of nodes) {
			result.add(`${os}@${node}`);
		}
	}
	return result;
}

function stepIndex(workflow: string, step: string): number {
	const index = workflow.indexOf(`- name: ${step}`);
	expect(index, `missing workflow step: ${step}`).not.toBe(-1);
	return index;
}

function stepBlock(workflow: string, step: string): string {
	const start = stepIndex(workflow, step);
	const afterName = workflow.indexOf("\n", start) + 1;
	const nextStep = workflow.indexOf("\n      - name:", afterName);
	const end = nextStep === -1 ? workflow.length : nextStep;
	return workflow.slice(afterName, end);
}

function minimumNodeVersion(value: string): string {
	const match = /^>=(?<version>\d+\.\d+\.\d+)$/.exec(value);
	const version = match?.groups?.version;
	assertPresent(version, `unsupported engines.node format: ${value}`);
	return version;
}

test("workflow keeps the expected CI matrix and fail-fast policy", () => {
	const workflow = readText(WORKFLOW_PATH);
	expect(workflow).toMatch(/fail-fast:\s+false/);
	expect(parseMatrixEntries(workflow)).toStrictEqual(EXPECTED_MATRIX);
	expect(workflow).toMatch(/run: npx audit-ci --config audit-ci\.jsonc/);
});

test("workflow ordering: security audit precedes unit tests, which precede E2E tests", () => {
	const workflow = readText(WORKFLOW_PATH);
	expect(stepIndex(workflow, "Type check")).toBeLessThan(stepIndex(workflow, "Security audit"));
	expect(stepIndex(workflow, "Security audit")).toBeLessThan(stepIndex(workflow, "Unit tests"));
	expect(stepIndex(workflow, "Unit tests")).toBeLessThan(stepIndex(workflow, "E2E tests"));
});

test("workflow matrix includes the minimum Node floor on ubuntu-latest", () => {
	const packageJson = parsePackageJson();
	const nodeFloor = packageJson.engines?.node;
	assertPresent(nodeFloor, "package.json engines.node missing");
	expect(EXPECTED_MATRIX.has(`ubuntu-latest@${minimumNodeVersion(nodeFloor)}`)).toBe(true);
});

// Constants: code owns every value. The engine doc names each constant and its owner file.
// Author-visible rule values are stated once in docs/workflows.md; pinned below to the code.
const CONTRACT_CONSTANT_ROWS: [name: string, owner: string][] = [
	["CANCEL_CONFIRM_MS", "workflow/command.ts"],
	["HANDOFF_TIMEOUT_MS", "workflow/rebind.ts"],
	["MAX_DEFERRED_EFFECTS", "workflow/host.ts"],
	["HARD_DEADLINE_FACTOR", "workflow/sandbox.ts"],
];
const INTERNAL_CONSTANT_ROWS: [name: string, owner: string][] = [
	["MEMORY_LIMIT_BYTES", "workflow/command.ts"],
	["WORKFLOW_PROGRESS_TICK_MS", "workflow/command.ts"],
	["MAX_EFFECTS", "workflow/host.ts"],
	["MAX_TIMEOUT_MS", "workflow/sandbox.ts"],
	["STRUCTURED_OUTPUT_TOOL", "workflow/output.ts"],
	["MAX_EFFECT_ROWS", "workflow/summary-renderer.ts"],
	["MAX_MODELS_COLLAPSED", "workflow/summary-renderer.ts"],
	["MAX_ENTRY_OUTPUT_LINES", "workflow/activity.ts"],
	["MAX_ENTRY_OUTPUT_CHARS", "workflow/activity.ts"],
	["MAX_SUGGESTIONS", "workflow/autocomplete.ts"],
];

test("workflow engine constants stay pinned to the code", () => {
	const exported: [name: string, actual: unknown, expected: unknown][] = [
		["CANCEL_CONFIRM_MS", CANCEL_CONFIRM_MS, 500],
		["HANDOFF_TIMEOUT_MS", HANDOFF_TIMEOUT_MS, 15 * 60 * 1000],
		["MAX_DEFERRED_EFFECTS", MAX_DEFERRED_EFFECTS, 16],
		["MAX_EFFECTS", MAX_EFFECTS, 100],
		["MAX_TIMEOUT_MS", MAX_TIMEOUT_MS, 2147483647],
		["HARD_DEADLINE_FACTOR", HARD_DEADLINE_FACTOR, 2],
		["STRUCTURED_OUTPUT_TOOL", STRUCTURED_OUTPUT_TOOL, "workflow_output"],
		["MAX_EFFECT_ROWS", MAX_EFFECT_ROWS, 10],
		["MAX_MODELS_COLLAPSED", MAX_MODELS_COLLAPSED, 8],
	];
	for (const [name, actual, expected] of exported) {
		expect(actual, `${name} changed — update docs/workflows.md (rule owner) if the author-visible value moved`).toBe(expected);
	}
});

test("workflow reserved reasons stay exact and the engine doc rows name their owner files", () => {
	expect([...RESERVED_REASONS]).toStrictEqual(["cost-limit", "time-limit", "cancelled", "error"]);
	const engineDoc = readText(WORKFLOW_ENGINE_DOC_PATH);
	for (const [name, owner] of [...CONTRACT_CONSTANT_ROWS, ...INTERNAL_CONSTANT_ROWS]) {
		expect(engineDoc).toMatch(new RegExp(`| *\`${name}\` *| *\`${owner}\` *|`));
		expect(existsSync(new URL(owner, REPO_ROOT_URL)), `${name} owner ${owner} is missing`).toBe(true);
	}
});

test("workflow engine doc splits contract-visible from internal knobs", () => {
	const engineDoc = readText(WORKFLOW_ENGINE_DOC_PATH);
	expect(engineDoc).not.toMatch(/^\| `[A-Z_]+` \|.*\d/m);
	const contractHeading = engineDoc.indexOf("Contract-visible knobs");
	const internalHeading = engineDoc.indexOf("Internal knobs");
	expect(contractHeading >= 0 && internalHeading > contractHeading).toBe(true);
	for (const [name] of CONTRACT_CONSTANT_ROWS) {
		expect(engineDoc.indexOf(`\`${name}\``, contractHeading) < internalHeading, `${name} must sit in the contract-visible table`).toBe(true);
	}
});

test("workflow author-visible rule prose stays pinned in docs/workflows.md", () => {
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	expect(workflowsDoc).toMatch(/MAX_DEFERRED_EFFECTS = 16/);
	expect(workflowsDoc).toMatch(/within 500 ms \(`CANCEL_CONFIRM_MS`\) confirms/);
	expect(workflowsDoc).toMatch(/\*\*twice\*\* the soft time target/);
	expect(workflowsDoc).toMatch(/each handoff wait carries its own full 15-minute deadline/i);
	expect(workflowsDoc).not.toMatch(/one absolute 15-minute deadline/i);
});

test("workflow documented time presets match the dialog labels", () => {
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	const timePresetSentence = /the time presets are ([^;]+);/i.exec(workflowsDoc);
	const sentence = timePresetSentence?.[1];
	assertPresent(sentence, "docs/workflows.md lost the time-preset sentence");
	const documentedPresets = [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	expect(documentedPresets).toStrictEqual(Object.keys(TIME_PRESET_MS));
	expect(documentedPresets.every((label) => TIME_PRESETS.includes(label))).toBe(true);
});

test("the /workflow completion list is capped at the engine suggestion limit", async () => {
	const entries = Array.from({ length: 25 }, (_, index) => ({
		name: `flow-${index}`,
		path: `/w/flow-${index}.js`,
		source: "global" as const,
		label: "global",
	}));
	const current: Parameters<ReturnType<typeof createWorkflowAutocompleteProvider>>[0] = {
		getSuggestions: () => Promise.resolve(null),
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		shouldTriggerFileCompletion: () => false,
	};
	const provide = createWorkflowAutocompleteProvider(() => Promise.resolve(entries))(current);
	const suggestions = await provide.getSuggestions(["/workflow flow"], 0, "/workflow flow".length, { signal: new AbortController().signal });
	assertPresent(suggestions, "expected workflow suggestions");
	expect(suggestions.items.length).toBe(20);
});

test("workflow docs keep one owner per shared rule", () => {
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	const engineDoc = readText(WORKFLOW_ENGINE_DOC_PATH);
	expect(workflowsDoc).toMatch(/Full rejection list \(compiler contract\)/);
	expect(engineDoc).toMatch(/The rules live in \[workflows\.md\]/);
	expect(engineDoc).not.toMatch(/\| Rejection \| Rule \|/);
	expect(workflowsDoc).toMatch(/Checkpoints are optional\. Without `workflow\.checkpoint\(\.\.\.\)`, the workflow is unbounded/);
	expect(workflowsDoc).toMatch(/`workflow\.exit` is terminal and is not a checkpoint/);
});

test("workflow docs pin the example and do not restate values", () => {
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	expect(workflowsDoc).toMatch(/examples\/workflows\/review\.js/);
	expect(workflowsDoc).not.toMatch(/jev-latest|"typesafe"/);
	expect(workflowsDoc).not.toMatch(/MAX_EFFECTS = |MAX_EFFECT_ROWS = /);
});

test("workflow docs point effect-limit owners at the engine doc", () => {
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	const engineDoc = readText(WORKFLOW_ENGINE_DOC_PATH);
	expect(workflowsDoc).toMatch(/`MAX_EFFECTS`[^\n]*workflow-engine\.md/);
	expect(workflowsDoc).toMatch(/`MAX_EFFECT_ROWS`[^\n]*workflow-engine\.md/);
	expect(engineDoc).toMatch(/\| *`workflow-limits` entry *\| *`workflow\/limits-dialog\.ts` *\|/);
});

test("the handoff cut lives at the turn_end boundary, not the deleted compaction modules", () => {
	const deleted = ["handoff/compact.ts", "handoff/recovery.ts", "follow-up.ts"];
	for (const file of deleted) {
		expect(existsSync(new URL(file, REPO_ROOT_URL)), `${file} must stay deleted`).toBe(false);
	}
	expect(readText(new URL("handoff/boundary.ts", REPO_ROOT_URL))).toMatch(/export function watchHandoffSettlement\(/);
	for (const doc of [ARCHITECTURE_DOC_PATH, WORKFLOWS_DOC_PATH, WORKFLOW_ENGINE_DOC_PATH]) {
		const text = readText(doc);
		for (const stale of [...deleted, "HandoffPayload", "HANDOFF_COMPACTION_TIMEOUT_MS"]) {
			expect(text, `${doc.pathname} still names ${stale}`).not.toContain(stale);
		}
	}
});

test("the Node floor has one source across CI and package metadata", () => {
	const pkg = parsePackageJson();
	const workflow = readText(WORKFLOW_PATH);
	const nodeFloor = pkg.engines?.node;
	assertPresent(nodeFloor, "package.json engines.node missing");
	expect(nodeFloor).toBe(`>=${EXPECTED_NODE_FLOOR}`);
	expect(workflow).toMatch(new RegExp(`node-version: "${EXPECTED_NODE_FLOOR.replaceAll(".", ".")}"`));
	expect(workflow).not.toMatch(/matrix\.node-version == '22\.19\.0'/);
	expect(readText(README_PATH)).toMatch(/Node\.js version/);
	expect(readText(WORKFLOWS_DOC_PATH)).toMatch(/Node\.js >= 22\.19\.0/);
});

test("Windows current-Pi step runs after packed-host failure but not on cancellation", () => {
	const workflow = readText(WORKFLOW_PATH);
	const block = stepBlock(workflow, "Synchronized current Pi compatibility on Windows");
	expect(block).toMatch(/if: matrix\.os == 'windows-latest' && !cancelled\(\)/);
});
