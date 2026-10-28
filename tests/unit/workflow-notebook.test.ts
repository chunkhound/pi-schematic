// Notebook handles exercised through the public `workflow.notebook*` globals
// (createWorkflowHost seam); no workflow-internal imports.
import { expect, test } from "vitest";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

function notebookHost(state = createState()): { host: WorkflowHost; state: ReturnType<typeof createState>; appended: { customType: string; data: unknown }[] } {
	const appended: { customType: string; data: unknown }[] = [];
	const deps: WorkflowHostDeps = {
		pi: {
			appendEntry: (customType: string, data?: unknown) => {
				appended.push({ customType, data });
			},
		} as unknown as WorkflowHostDeps["pi"],
		state,
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: () => null,
		setReadonly: (enabled: boolean) => enabled,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
	return { host: createWorkflowHost(deps), state, appended };
}

function handle(host: WorkflowHost, name: string): { execute: (args?: unknown, context?: unknown) => Promise<unknown> } {
	const tool = host.globals().find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`missing handle: ${name}`);
	}
	const execute = tool.execute.bind(tool) as (args: unknown, context: unknown) => Promise<unknown>;
	// Default context: inspectors need no signal; the sandbox always supplies one.
	return { execute: (args, context = {}) => execute(args, context) };
}

test("workflow.notebookRead returns the body and throws on a bad name or a missing page", async () => {
	const state = createState();
	state.notebookPages.set("findings", "body");
	const { host } = notebookHost(state);
	expect(await handle(host, "workflow.notebookRead").execute("findings")).toBe("body");
	await expect(() => handle(host, "workflow.notebookRead").execute("missing")).rejects.toThrow(/no page named/);
	await expect(() => handle(host, "workflow.notebookRead").execute(42)).rejects.toThrow(/string page name/);
});

test("workflow.notebookIndex lists pages with first-line previews", async () => {
	const state = createState();
	state.notebookPages.set("z", "z line");
	state.notebookPages.set("a", "a line");
	const { host } = notebookHost(state);
	expect(await handle(host, "workflow.notebookIndex").execute(undefined)).toStrictEqual([
		{ name: "a", preview: "a line" },
		{ name: "z", preview: "z line" },
	]);
});

test("workflow.notebookWrite persists the page and appends the notebook entry", async () => {
	const { host, appended } = notebookHost();
	const result = await handle(host, "workflow.notebookWrite").execute({ name: "findings", content: "first line\nsecond line" });
	expect(result).toBeNull();
	expect(await handle(host, "workflow.notebookRead").execute("findings")).toBe("first line\nsecond line");
	expect(appended[0]?.customType).toBe("notebook-entry");
	// The preview buffered for the next run is host-internal state; its compose,
	// consume-once, and failure-buffering behavior is pinned end-to-end by
	// tests/e2e/workflow-host.test.ts (prompt-composition suite).
});

test("workflow.notebookWrite rejects malformed arguments without persisting", async () => {
	const { host, state } = notebookHost();
	await expect(handle(host, "workflow.notebookWrite").execute({ name: "x" })).rejects.toThrow(/name, content/);
	await expect(handle(host, "workflow.notebookWrite").execute(null)).rejects.toThrow(/name, content/);
	expect(state.notebookPages.size).toBe(0);
});

test("workflow.notebookTopic reports the active topic and its source", async () => {
	const state = createState();
	const { host } = notebookHost(state);
	expect(await handle(host, "workflow.notebookTopic").execute(undefined)).toStrictEqual({ topic: null, source: null });
	state.activeNotebookTopic = "runtime";
	state.activeNotebookTopicSource = "agent";
	expect(await handle(host, "workflow.notebookTopic").execute(undefined)).toStrictEqual({ topic: "runtime", source: "agent" });
});

// WHY: a write-truncated page must not read back silently: the reader mirrors the
// notebook_read tool's clipped-at-write-time notice.
test("workflow.notebookRead surfaces a page that was clipped at write time", async () => {
	const state = createState();
	state.notebookPages.set("big", "kept");
	state.clippedPages.add("big");
	const { host } = notebookHost(state);
	const body = (await handle(host, "workflow.notebookRead").execute("big")) as string;
	expect(body).toMatch(/^kept/);
	expect(body).toMatch(/clipped at write time/);
});
