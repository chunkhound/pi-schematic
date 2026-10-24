import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { assertSynchronizedPackageVersions, assertInstalledMatchesDeclared } = await import(
	new URL("../../scripts/dependency-graph-assertions.mjs", import.meta.url).href,
);

const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

test("latest compatibility lane guards every installed Pi package", () => {
	const source = readFileSync(new URL("../../scripts/test-compat-current.mjs", import.meta.url), "utf8");
	assert.match(source, /["']@earendil-works\/pi-agent-core["']/i);
});

function dependency(version: string, dependencies = {}): object {
	return { version, dependencies };
}

function graph(piVersion = "0.99.0", typeboxVersion = "2.0.0"): object {
	return {
		name: "synthetic-install",
		version: "1.0.0",
		dependencies: {
			"@earendil-works/pi-ai": dependency(piVersion, { typebox: dependency(typeboxVersion) }),
			"@earendil-works/pi-coding-agent": dependency(piVersion, {
				"@earendil-works/pi-agent-core": dependency(piVersion),
				"@earendil-works/pi-ai": dependency(piVersion, { typebox: dependency(typeboxVersion) }),
				"@earendil-works/pi-tui": dependency(piVersion),
			}),
			"@earendil-works/pi-tui": dependency(piVersion),
			typebox: dependency(typeboxVersion),
		},
	};
}

test("latest assertions accept recursively synchronized Pi and TypeBox versions", () => {
	const current = graph();
	assert.equal(assertSynchronizedPackageVersions(current, PI_PACKAGES), "0.99.0");
	assert.equal(assertSynchronizedPackageVersions(current, ["typebox"]), "2.0.0");
});

test("latest assertions reject mixed nested Pi and TypeBox versions", () => {
	const mixedCore = graph() as any;
	mixedCore.dependencies["@earendil-works/pi-coding-agent"].dependencies["@earendil-works/pi-agent-core"].version = "0.98.0";
	assert.throws(() => assertSynchronizedPackageVersions(mixedCore, PI_PACKAGES), /synchronized.*0\.98\.0.*0\.99\.0/i);

	const mixedTypebox = graph() as any;
	mixedTypebox.dependencies["@earendil-works/pi-ai"].dependencies.typebox.version = "1.9.0";
	assert.throws(() => assertSynchronizedPackageVersions(mixedTypebox, ["typebox"]), /synchronized.*1\.9\.0.*2\.0\.0/i);
});

/** A throwaway project whose package.json and node_modules versions the guard can read. */
function scratchProject(declared: Record<string, string>, installed: Record<string, string | undefined>): string {
	const root = mkdtempSync(join(tmpdir(), "dep-graph-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: declared }));
	for (const [name, version] of Object.entries(installed)) {
		if (version === undefined) continue;
		const directory = join(root, "node_modules", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
	}
	return root;
}

test("the stale-install guard accepts a node_modules that matches package.json", () => {
	const root = scratchProject(
		{ "@earendil-works/pi-coding-agent": "0.99.2", typebox: "1.3.27" },
		{ "@earendil-works/pi-coding-agent": "0.99.2", typebox: "1.3.27" },
	);
	try {
		assert.doesNotThrow(() => assertInstalledMatchesDeclared(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the stale-install guard rejects a node_modules older than package.json", () => {
	const root = scratchProject(
		{ "@earendil-works/pi-coding-agent": "0.99.2" },
		{ "@earendil-works/pi-coding-agent": "0.84.1" },
	);
	try {
		assert.throws(
			() => assertInstalledMatchesDeclared(root),
			/installed 0\.84\.1.*declares 0\.99\.2/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the stale-install guard rejects a missing installed package", () => {
	const root = scratchProject({ typebox: "1.3.27" }, { typebox: undefined });
	try {
		assert.throws(() => assertInstalledMatchesDeclared(root), /installed missing.*declares 1\.3\.27/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
