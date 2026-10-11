// Notebook handles exercised through the public `workflow.notebook*` globals
// (createWorkflowHost seam); no workflow-internal imports.
import assert from "node:assert/strict";
import test from "node:test";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

function notebookHost(state = createState()): { host: WorkflowHost; state: ReturnType<typeof createState>; appended: Array<{ customType: string; data: unknown }> } {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const deps: WorkflowHostDeps = {
		pi: {
			appendEntry: (customType: string, data?: unknown) => {
				appended.push({ customType, data });
			},
		} as unknown as WorkflowHostDeps["pi"],
		state,
		limits: { costLimit: null, timeBudgetMs: null },
		getCtx: () => null,
		isReadonly: () => false,
		setReadonly: (enabled: boolean) => enabled,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
	};
	return { host: createWorkflowHost(deps), state, appended };
}

function handle(host: WorkflowHost, name: string): { execute: (args?: unknown, context?: unknown) => Promise<unknown> } {
	const tool = host.globals().find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing handle: ${name}`);
	const execute = tool.execute.bind(tool) as (args: unknown, context: unknown) => Promise<unknown>;
	// Default context: inspectors need no signal; the sandbox always supplies one.
	return { execute: (args, context = {}) => execute(args, context) };
}

test("workflow.notebookRead returns the body and throws on a bad name or a missing page", async () => {
	const state = createState();
	state.notebookPages.set("findings", "body");
	const { host } = notebookHost(state);
	assert.equal(await handle(host, "workflow.notebookRead").execute("findings"), "body");
	await assert.rejects(() => handle(host, "workflow.notebookRead").execute("missing"), /no page named/);
	await assert.rejects(() => handle(host, "workflow.notebookRead").execute(42), /string page name/);
});

test("workflow.notebookIndex lists pages with first-line previews", async () => {
	const state = createState();
	state.notebookPages.set("z", "z line");
	state.notebookPages.set("a", "a line");
	const { host } = notebookHost(state);
	assert.deepEqual(await handle(host, "workflow.notebookIndex").execute(undefined), [
		{ name: "a", preview: "a line" },
		{ name: "z", preview: "z line" },
	]);
});

test("workflow.notebookWrite persists the page and appends the notebook entry", async () => {
	const { host, appended } = notebookHost();
	const result = await handle(host, "workflow.notebookWrite").execute({ name: "findings", content: "first line\nsecond line" });
	assert.equal(result, null);
	assert.equal(await handle(host, "workflow.notebookRead").execute("findings"), "first line\nsecond line");
	assert.equal(appended[0]?.customType, "notebook-entry");
	// The preview buffered for the next run is host-internal state; its compose,
	// consume-once, and failure-buffering behavior is pinned end-to-end by
	// tests/e2e/workflow-host.test.ts (prompt-composition suite).
});

test("workflow.notebookWrite rejects malformed arguments without persisting", async () => {
	const { host, state } = notebookHost();
	await assert.rejects(async () => { await handle(host, "workflow.notebookWrite").execute({ name: "x" }); }, /name, content/);
	await assert.rejects(async () => { await handle(host, "workflow.notebookWrite").execute(null); }, /name, content/);
	assert.equal(state.notebookPages.size, 0);
});

test("workflow.notebookTopic reports the active topic and its source", async () => {
	const state = createState();
	const { host } = notebookHost(state);
	assert.deepEqual(await handle(host, "workflow.notebookTopic").execute(undefined), { topic: null, source: null });
	state.activeNotebookTopic = "runtime";
	state.activeNotebookTopicSource = "agent";
	assert.deepEqual(await handle(host, "workflow.notebookTopic").execute(undefined), { topic: "runtime", source: "agent" });
});
