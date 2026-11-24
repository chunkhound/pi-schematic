import { expect, test } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpDir } from "./helpers.js";
import { parseWorkflowArgs, listWorkflows, readWorkflow, resolveWorkflowPath, workflowRoots, type WorkflowFileEntry } from "../../workflow/file.js";

test("parseWorkflowArgs takes the first token as the workflow and keeps the rest verbatim", () => {
	expect(parseWorkflowArgs("review.js")).toStrictEqual({ name: "review.js", args: "" });
	expect(parseWorkflowArgs("review.js foo bar")).toStrictEqual({ name: "review.js", args: "foo bar" });
	expect(parseWorkflowArgs("  review.js   foo  ")).toStrictEqual({ name: "review.js", args: "  foo  " });
	expect(parseWorkflowArgs("")).toStrictEqual({ name: "", args: "" });
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

		expect(resolveWorkflowPath("wf", cwd, agent)).toBe(join(cwd, ".pi", "workflows", "wf.js"));
		await rm(join(cwd, ".pi", "workflows", "wf.js"));
		expect(resolveWorkflowPath("wf", cwd, agent)).toBe(join(agent, "workflows", "wf.js"));
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

		expect(resolveWorkflowPath("./local", root, "/nope")).toBe(join(root, "local.js"));
		expect(resolveWorkflowPath("nested/mod", root, "/nope")).toBe(join(root, "nested", "mod.js"));
		expect(resolveWorkflowPath(join(root, "local.js"), root, "/nope")).toBe(join(root, "local.js"));
		expect(resolveWorkflowPath("nested/missing", root, "/nope")).toBeNull();
		expect(resolveWorkflowPath("bare", root, "/nope")).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("readWorkflow returns the file source", async () => {
	const root = await tmpDir();
	try {
		await writeFile(join(root, "wf.js"), "return defineWorkflow((workflow) => 1);");
		expect(await readWorkflow(join(root, "wf.js"))).toBe("return defineWorkflow((workflow) => 1);");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveWorkflowPath returns null when nothing exists, including empty names", async () => {
	const root = await tmpDir();
	try {
		expect(resolveWorkflowPath("does-not-exist", root, join(root, "agent"))).toBeNull();
		expect(resolveWorkflowPath("", root, join(root, "agent"))).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parseWorkflowArgs whitespace-only yields an empty name", () => {
	expect(parseWorkflowArgs("   ")).toStrictEqual({ name: "", args: "" });
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

		expect(await listWorkflows(cwd, agent)).toStrictEqual([
			{ name: "alpha", path: join(agent, "workflows", "alpha.js"), source: "global", label: "global" },
			{ name: "beta", path: join(cwd, ".pi", "workflows", "beta.js"), source: "project", label: ".pi/workflows" },
			{ name: "shared", path: join(cwd, ".pi", "workflows", "shared.js"), source: "project", label: ".pi/workflows" },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listWorkflows tolerates missing directories", async () => {
	const root = await tmpDir();
	try {
		expect(await listWorkflows(join(root, "nope"), join(root, "also-nope"))).toStrictEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workflowRoots resolves to expected directories", () => {
	const cwd = "/project";
	const agentDir = "/agent";
	const roots = workflowRoots(cwd, agentDir);
	expect(roots[0].dir).toStrictEqual(join(cwd, ".pi", "workflows"));
	expect(roots[1].dir).toStrictEqual(join(agentDir, "workflows"));
	expect(roots.map((root) => root.source)).toStrictEqual(["project", "global"]);
});

// WHY: the listing reads `dirent.isFile()` (symlinks excluded) while resolution follows the
// symlink via `statSync`, so the two deliberately disagree for a symlinked workflow. This pins
// the contract stated on `listWorkflows`, so a change to either side must update this test.
test("a symlinked workflow resolves but is not listed", { skip: process.platform === "win32" }, async () => {
	const root = await tmpDir();
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	try {
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await writeFile(join(root, "real.js"), "x");
		await symlink(join(root, "real.js"), join(cwd, ".pi", "workflows", "link.js"));
		expect(resolveWorkflowPath("link", cwd, agent)).toBe(join(cwd, ".pi", "workflows", "link.js"));
		expect((await listWorkflows(cwd, agent)).find((entry) => entry.name === "link")).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

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
		expect(listed, "the clashing name is listed").toBeDefined();
		if (!listed) {
			throw new Error("the clashing name is listed");
		}
		expect(listed.source).toBe("project");
		expect(resolveWorkflowPath("clash", cwd, agent)).toBe(listed.path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
