// WHY: one module owns how a `/workflow` argument becomes a workflow file on disk:
// first-token parsing, cwd/agent-dir resolution precedence, and source read.
import { statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface ParsedWorkflowArgs {
	/** First whitespace-delimited token: the workflow name or path. */
	name: string;
	/** Everything after the first whitespace, verbatim. Empty when only a name is given. */
	args: string;
}

/** Split `/workflow <workflow> [args]`; the remainder after the first token is kept verbatim. */
export function parseWorkflowArgs(raw: string): ParsedWorkflowArgs {
	const start = raw.replace(/^\s+/, "");
	const split = start.search(/\s/);
	if (split === -1) return { name: start, args: "" };
	return { name: start.slice(0, split), args: start.slice(split + 1) };
}

/** Path-like names resolve against cwd; bare names use the two workflows directories. */
export function isPathLike(name: string): boolean {
	return isAbsolute(name) || name.startsWith(".") || name.includes("/") || name.includes("\\");
}

/** The suffix is optional in the argument and always required on disk. */
function withJs(name: string): string {
	return name.endsWith(".js") ? name : `${name}.js`;
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Single precedence source: the project workflows dir shadows the global one.
 * Both {@link resolveWorkflowPath} and {@link listWorkflows} read these roots. */
export function workflowRoots(cwd: string, agentDir: string): Array<{ dir: string; source: "project" | "global" }> {
	return [
		{ dir: join(cwd, ".pi", "workflows"), source: "project" },
		{ dir: join(agentDir, "workflows"), source: "global" },
	];
}

/**
 * Resolve a workflow name to a file. Path-like names resolve against `cwd`;
 * bare names try the {@link workflowRoots} in order.
 * Returns the first existing file, or null.
 */
export function resolveWorkflowPath(name: string, cwd: string, agentDir: string): string | null {
	if (isPathLike(name)) {
		const candidate = resolve(cwd, withJs(name));
		return isFile(candidate) ? candidate : null;
	}
	for (const root of workflowRoots(cwd, agentDir)) {
		const candidate = join(root.dir, withJs(name));
		if (isFile(candidate)) return candidate;
	}
	return null;
}

/** Read a workflow file's source. */
export function readWorkflow(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export interface WorkflowFileEntry {
	/** Bare workflow name, without the `.js` suffix. */
	name: string;
	/** Absolute path to the workflow file. */
	path: string;
	/** Discovery root; a project entry shadows a global entry with the same name. */
	source: "project" | "global";
}

/**
 * List discoverable bare-name workflows. The result matches {@link resolveWorkflowPath}
 * precedence via the shared {@link workflowRoots} (project before global), so completion
 * and resolution cannot disagree. Sorted by name for a stable UI.
 */
export async function listWorkflows(cwd: string, agentDir: string): Promise<WorkflowFileEntry[]> {
	const [projectRoot, globalRoot] = workflowRoots(cwd, agentDir);
	const project = await listWorkflowDir(projectRoot.dir, projectRoot.source);
	const global = await listWorkflowDir(globalRoot.dir, globalRoot.source);
	const projectNames = new Set(project.map((entry) => entry.name));
	const merged = [...project, ...global.filter((entry) => !projectNames.has(entry.name))];
	return merged.sort((a, b) => a.name.localeCompare(b.name));
}

async function listWorkflowDir(dir: string, source: WorkflowFileEntry["source"]): Promise<WorkflowFileEntry[]> {
	let dirents;
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		// A missing directory means "no workflows here"; any other failure stays loud.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return dirents
		.filter((dirent) => dirent.isFile() && dirent.name.endsWith(".js"))
		.map((dirent) => ({ name: dirent.name.slice(0, -3), path: join(dir, dirent.name), source }));
}
