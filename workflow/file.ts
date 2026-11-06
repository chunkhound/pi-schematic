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

/** The two discovery roots, in precedence order: project shadows global. Each row
 * carries its own label so completion reads `entry.label` and a new root fails compile without one. */
export function workflowRoots(cwd: string, agentDir: string) {
	return [
		{ dir: join(cwd, ".pi", "workflows"), label: ".pi/workflows", source: "project" },
		{ dir: join(agentDir, "workflows"), label: "global", source: "global" },
	] as const;
}

/** Every discovery root's source. A new root widens this union and forces label coverage above. */
export type WorkflowRootSource = (ReturnType<typeof workflowRoots>)[number]["source"];

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
	source: WorkflowRootSource;
	/** Human-readable root label for completion descriptions. */
	label: string;
}

/**
 * List discoverable bare-name workflows. The result matches {@link resolveWorkflowPath}
 * precedence by iterating the same {@link workflowRoots} (project before global). Symlinked
 * files resolve (`statSync` follows) but are not listed (`dirent.isFile()`). Sorted by name for a stable UI.
 */
export async function listWorkflows(cwd: string, agentDir: string): Promise<WorkflowFileEntry[]> {
	const layers = await Promise.all(workflowRoots(cwd, agentDir).map((root) => listWorkflowDir(root.dir, root.source, root.label)));
	// First-wins dedupe across precedence-ordered layers (project before global), then sort by name.
	const byName = new Map<string, WorkflowFileEntry>();
	for (const entry of layers.flat()) if (!byName.has(entry.name)) byName.set(entry.name, entry);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listWorkflowDir(dir: string, source: WorkflowFileEntry["source"], label: string): Promise<WorkflowFileEntry[]> {
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
		.map((dirent) => ({ name: dirent.name.slice(0, -3), path: join(dir, dirent.name), source, label }));
}
