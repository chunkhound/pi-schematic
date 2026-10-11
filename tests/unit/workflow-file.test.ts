import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpDir } from "./helpers.js";
import { parseWorkflowArgs, listWorkflows, readWorkflow, resolveWorkflowPath } from "../../workflow/file.js";

test("parseWorkflowArgs takes the first token as the workflow and keeps the rest verbatim", () => {
	assert.deepEqual(parseWorkflowArgs("review.js"), { name: "review.js", args: "" });
	assert.deepEqual(parseWorkflowArgs("review.js foo bar"), { name: "review.js", args: "foo bar" });
	assert.deepEqual(parseWorkflowArgs("  review.js   foo  "), { name: "review.js", args: "  foo  " });
	assert.deepEqual(parseWorkflowArgs(""), { name: "", args: "" });
});

test("resolveWorkflowPath prefers cwd/.pi/workflows over the agent dir", async () => {
	const root = await tmpDir();
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	try {
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await mkdir(join(agent, "workflows"), { recursive: true });
		await writeFile(join(cwd, ".pi", "workflows", "wf.js"), "cwd");
		await writeFile(join(agent, "workflows", "wf.js"), "agent");

		assert.equal(resolveWorkflowPath("wf", cwd, agent), join(cwd, ".pi", "workflows", "wf.js"));
		await rm(join(cwd, ".pi", "workflows", "wf.js"));
		assert.equal(resolveWorkflowPath("wf", cwd, agent), join(agent, "workflows", "wf.js"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveWorkflowPath resolves path-like names against cwd and appends .js", async () => {
	const root = await tmpDir();
	try {
		await writeFile(join(root, "local.js"), "x");
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "mod.js"), "y");

		assert.equal(resolveWorkflowPath("./local", root, "/nope"), join(root, "local.js"));
		assert.equal(resolveWorkflowPath("nested/mod", root, "/nope"), join(root, "nested", "mod.js"));
		assert.equal(resolveWorkflowPath(join(root, "local.js"), root, "/nope"), join(root, "local.js"));
		assert.equal(resolveWorkflowPath("nested/missing", root, "/nope"), null);
		assert.equal(resolveWorkflowPath("bare", root, "/nope"), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readWorkflow returns the file source", async () => {
	const root = await tmpDir();
	try {
		await writeFile(join(root, "wf.js"), "return defineWorkflow((workflow) => 1);");
		assert.equal(await readWorkflow(join(root, "wf.js")), "return defineWorkflow((workflow) => 1);");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveWorkflowPath returns null when nothing exists, including empty names", async () => {
	const root = await tmpDir();
	try {
		assert.equal(resolveWorkflowPath("does-not-exist", root, join(root, "agent")), null);
		assert.equal(resolveWorkflowPath("", root, join(root, "agent")), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parseWorkflowArgs whitespace-only yields an empty name", () => {
	assert.deepEqual(parseWorkflowArgs("   "), { name: "", args: "" });
});

test("listWorkflows merges both roots, strips .js, drops non-files, and lets project shadow global", async () => {
	const root = await tmpDir();
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	try {
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await mkdir(join(agent, "workflows"), { recursive: true });
		await writeFile(join(cwd, ".pi", "workflows", "beta.js"), "b");
		await writeFile(join(cwd, ".pi", "workflows", "shared.js"), "p");
		await writeFile(join(cwd, ".pi", "workflows", "notes.txt"), "ignored");
		await mkdir(join(cwd, ".pi", "workflows", "dir.js"), { recursive: true });
		await writeFile(join(agent, "workflows", "alpha.js"), "a");
		await writeFile(join(agent, "workflows", "shared.js"), "g");

		assert.deepEqual(await listWorkflows(cwd, agent), [
			{ name: "alpha", path: join(agent, "workflows", "alpha.js"), source: "global" },
			{ name: "beta", path: join(cwd, ".pi", "workflows", "beta.js"), source: "project" },
			{ name: "shared", path: join(cwd, ".pi", "workflows", "shared.js"), source: "project" },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listWorkflows tolerates missing directories", async () => {
	const root = await tmpDir();
	try {
		assert.deepEqual(await listWorkflows(join(root, "nope"), join(root, "also-nope")), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// WHY: one precedence source (workflowRoots) feeds both resolution and listing, so a
// clashing name must resolve to exactly the file the listing reports for that name.
test("resolveWorkflowPath agrees with listWorkflows for a clashing name", async () => {
	const root = await tmpDir();
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	try {
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await mkdir(join(agent, "workflows"), { recursive: true });
		await writeFile(join(cwd, ".pi", "workflows", "clash.js"), "p");
		await writeFile(join(agent, "workflows", "clash.js"), "g");
		const listed = (await listWorkflows(cwd, agent)).find((entry) => entry.name === "clash");
		assert.ok(listed, "the clashing name is listed");
		assert.equal(listed.source, "project");
		assert.equal(resolveWorkflowPath("clash", cwd, agent), listed.path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
