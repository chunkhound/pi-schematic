import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { packEntry, parseNpmViewValue, resolveLatestPi, writeCompatArtifacts } from "../../scripts/compat-fixture.mjs";

// One line of the stub npm's call log: the arguments of one call, which must be strings.
function parseCallArgs(line: string): string[] {
	const args: unknown = JSON.parse(line);
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
		throw new Error(`The stub npm logged a call that is not an array of strings: ${line}`);
	}
	return args;
}

function withTempDir(prefix: string, run: (temp: string) => void): void {
	const temp = mkdtempSync(join(tmpdir(), prefix));
	try {
		run(temp);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

test("writeCompatArtifacts does nothing when artifacts are disabled", () => {
	withTempDir("compat-artifact-disabled-", (temp) => {
		const artifactDir = join(temp, "artifacts");
		writeCompatArtifacts(undefined, join(temp, "source"), { piVersion: "1.2.3", typeboxVersion: "4.5.6" });
		expect(existsSync(artifactDir)).toBe(false);
	});
});

test("writeCompatArtifacts writes reproducible successful compatibility artifacts", () => {
	withTempDir("compat-artifact-success-", (temp) => {
		const sourceDir = join(temp, "source");
		const artifactDir = join(temp, "artifacts");
		const packageLock = '{"lockfileVersion":3}\n';
		mkdirSync(sourceDir);
		writeFileSync(join(sourceDir, "package-lock.json"), packageLock);

		writeCompatArtifacts(artifactDir, sourceDir, { piVersion: "1.2.3", typeboxVersion: "4.5.6" });

		expect(readFileSync(join(artifactDir, "package-lock.json"), "utf8")).toBe(packageLock);
		expect(readFileSync(join(artifactDir, "versions.txt"), "utf8")).toBe(`pi=1.2.3\ntypebox=4.5.6\nnode=${process.version}\n`);
	});
});

test("writeCompatArtifacts rejects a successful artifact without its package lock", () => {
	withTempDir("compat-artifact-missing-lock-", (temp) => {
		const sourceDir = join(temp, "source");
		mkdirSync(sourceDir);
		expect(
			() => { writeCompatArtifacts(join(temp, "artifacts"), sourceDir, { piVersion: "1.2.3", typeboxVersion: "4.5.6" }); },
		).toThrow(/Expected compatibility package lock/);
	});
});

const parseAccepted: [string, string, unknown][] = [
	["a bare JSON string", '"1.2.0"', "1.2.0"],
	["a one-element array, unwrapped", '["1.2.0"]', "1.2.0"],
	["empty output, as undeclared", "", undefined],
	["whitespace-only output, as undeclared", "  \n", undefined],
	["an empty array, left as is", "[]", []],
];

for (const [shape, stdout, expected] of parseAccepted) {
	test(`parseNpmViewValue accepts ${shape}`, () => {
		expect(parseNpmViewValue(stdout)).toStrictEqual(expected);
	});
}

test("parseNpmViewValue rejects non-JSON output, naming the command and keeping the parse error as cause", () => {
	const stdout = "{not json";
	expect(() => parseNpmViewValue(stdout)).toThrow(expect.toSatisfy((error: Error) => {
		expect(error.message).toMatch(/npm view --json/);
		expect(error.message).toContain(JSON.stringify(stdout));
		expect(error.cause).toBeInstanceOf(SyntaxError);
		return true;
	}));
});

const packEntryFixture = { filename: "chunkhound-pi-schematic-1.0.0.tgz" };

const packEntryAccepted: [string, unknown][] = [
	["a one-element array", [packEntryFixture]],
	["an object keyed by package name", { "@chunkhound/pi-schematic": packEntryFixture }],
];

for (const [shape, packJson] of packEntryAccepted) {
	test(`packEntry accepts ${shape}`, () => {
		expect(packEntry(JSON.stringify(packJson))).toStrictEqual(packEntryFixture);
	});
}

const packEntryRejected: [string, unknown][] = [
	["a two-element array", [packEntryFixture, packEntryFixture]],
	["an object with two keys", { a: packEntryFixture, b: packEntryFixture }],
	["an entry with an empty filename", [{ filename: "" }]],
	["an entry without a filename", [{ name: "no-filename" }]],
	["a string", "x"],
];

for (const [shape, packJson] of packEntryRejected) {
	test(`packEntry rejects ${shape}`, () => {
		expect(() => packEntry(JSON.stringify(packJson))).toThrow(/Unexpected npm pack --json output/);
	});
}

test("packEntry rejects non-JSON output, quoting it and keeping the parse error as cause", () => {
	const stdout = "npm WARN not json";
	expect(() => packEntry(stdout)).toThrow(expect.toSatisfy((error: Error) => {
		expect(error.message).toMatch(/Unexpected npm pack --json output/);
		expect(error.message).toContain(JSON.stringify(stdout));
		expect(error.cause).toBeInstanceOf(SyntaxError);
		return true;
	}));
});

// resolveLatestPi reaches npm through the npm_execpath seam: a stub npm-cli.js answers each lookup.
async function withStubNpm(
	versionStdout: string,
	typeboxStdout: string,
	run: (temp: string, calls: () => string[][], options: { env: NodeJS.ProcessEnv }) => Promise<void>,
): Promise<void> {
	const temp = mkdtempSync(join(tmpdir(), "compat-resolve-latest-pi-"));
	const callLog = join(temp, "calls.jsonl");
	const stub = join(temp, "npm-cli.js");
	writeFileSync(stub, `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
if (args.includes("version")) process.stdout.write(${JSON.stringify(versionStdout)});
else if (args.includes("dependencies.typebox")) process.stdout.write(${JSON.stringify(typeboxStdout)});
else process.stdout.write("unexpected npm args: " + args.join(" "));
`);
	try {
		await run(temp, () => readFileSync(callLog, "utf8").trim().split("\n").map(parseCallArgs), {
			env: { ...process.env, npm_execpath: stub },
		});
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

test("resolveLatestPi rejects when npm prints no latest version, without a TypeBox lookup", async () => {
	await withStubNpm("", "", async (temp, calls, options) => {
		await expect(resolveLatestPi(temp, options)).rejects.toSatisfy((error: Error) => {
			expect(error.message).toMatch(/did not declare a usable version/);
			expect(error.message).toContain(JSON.stringify(""));
			return true;
		});
		expect(calls().length).toBe(1);
	});
});

test("resolveLatestPi rejects when npm resolves several latest versions, quoting its output", async () => {
	const stdout = '["1.0.0","1.1.0"]';
	await withStubNpm(stdout, "", async (temp, calls, options) => {
		await expect(resolveLatestPi(temp, options)).rejects.toSatisfy((error: Error) => {
			expect(error.message).toMatch(/did not declare a usable version/);
			expect(error.message).toContain(JSON.stringify(stdout));
			return true;
		});
		expect(calls().length).toBe(1);
	});
});

test("resolveLatestPi rejects when the resolved Pi version declares no TypeBox dependency", async () => {
	await withStubNpm('["1.2.0"]', "", async (temp, calls, options) => {
		await expect(resolveLatestPi(temp, options)).rejects.toSatisfy((error: Error) => {
			expect(error.message).toMatch(/Pi coding-agent 1\.2\.0 did not declare a usable TypeBox version/);
			expect(error.message).toContain(JSON.stringify(""));
			return true;
		});
		expect(calls().map((args) => args[1])).toStrictEqual([
			"@earendil-works/pi-coding-agent@latest",
			"@earendil-works/pi-coding-agent@1.2.0",
		]);
	});
});

test("resolveLatestPi resolves the Pi version and the TypeBox version it requires", async () => {
	await withStubNpm('["1.2.0"]', '["1.3.27"]', async (temp, _calls, options) => {
		expect(await resolveLatestPi(temp, options)).toStrictEqual({ piVersion: "1.2.0", typeboxVersion: "1.3.27" });
	});
});
