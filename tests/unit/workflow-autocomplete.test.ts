import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkflowAutocompleteProvider, registerWorkflowAutocomplete, ROOT_DESCRIPTIONS } from "../../workflow/autocomplete.js";
import { registerModelGroupAutocomplete } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import { WORKFLOW_ROOTS, type WorkflowFileEntry, type WorkflowRootSource } from "../../workflow/file.js";
import { tmpDir } from "./helpers.js";

const ENTRIES: WorkflowFileEntry[] = [
	{ name: "precommit-review", path: "/agent/workflows/precommit-review.js", source: "global" },
	{ name: "review", path: "/proj/.pi/workflows/review.js", source: "project" },
	{ name: "smoke", path: "/proj/.pi/workflows/smoke.js", source: "project" },
];

function harness(entries: WorkflowFileEntry[] = ENTRIES) {
	let delegated = 0;
	const current = {
		getSuggestions: async () => {
			delegated += 1;
			return { prefix: "", items: [{ value: "delegated", label: "delegated" }] };
		},
		applyCompletion: () => "applied",
		shouldTriggerFileCompletion: () => false,
	};
	const provide = createWorkflowAutocompleteProvider(async () => entries)(current as any);
	return { provide, delegated: () => delegated };
}

async function suggest(provide: any, line: string) {
	return provide.getSuggestions([line], 0, line.length, {});
}

test("/workflow completion works from a partial command and every full prefix form", async () => {
	const { provide, delegated } = harness();

	for (const line of ["/w", "/work", "/workf", "/workflow", "/workflow:"]) {
		const suggestions = await suggest(provide, line);
		assert.deepEqual(suggestions.items.map((item: any) => item.label), ["/workflow precommit-review", "/workflow review", "/workflow smoke"], line);
		assert.equal(suggestions.prefix, line, line);
	}

	const all = await suggest(provide, "/workflow");
	assert.deepEqual(all.items.map((item: any) => item.value), ["/workflow precommit-review ", "/workflow review ", "/workflow smoke "]);

	const smoke = await suggest(provide, "/workflow smo");
	assert.deepEqual(smoke.items.map((item: any) => item.label), ["/workflow smoke"]);
	assert.equal(smoke.prefix, "/workflow smo");
	assert.equal(smoke.items[0].value, "/workflow smoke ");
	assert.equal(smoke.items[0].description, ".pi/workflows");

	const fuzzy = await suggest(provide, "/workflow pcr");
	assert.deepEqual(fuzzy.items.map((item: any) => item.label), ["/workflow precommit-review"]);
	assert.equal(fuzzy.items[0].description, "global");

	const ranked = await suggest(provide, "/workflow review");
	assert.equal(ranked.items[0].label, "/workflow review");
	assert.ok(ranked.items.some((item: any) => item.label === "/workflow precommit-review"));

	assert.equal(delegated(), 0);
});

// WHY: the completion menu labels each root; every discovery root must carry a label, and a
// new root fails compile until its Record entry exists.
test("completion labels every discovery root", async () => {
	const sources = WORKFLOW_ROOTS.map((root) => root.source);
	assert.deepEqual(Object.keys(ROOT_DESCRIPTIONS).sort(), [...new Set(sources)].sort(), "the label map covers exactly the root labels");
	for (const source of Object.keys(ROOT_DESCRIPTIONS) as WorkflowRootSource[]) {
		const { provide } = harness([{ name: "wf", path: `/root/${source}/wf.js`, source }]);
		const suggestions = await suggest(provide, "/workflow");
		assert.equal(suggestions.items[0].description, ROOT_DESCRIPTIONS[source], source);
	}
});

test("/workflow completion delegates the lone slash, other commands, paths, and args", async () => {
	const { provide, delegated } = harness();
	for (const line of ["/", "/help", "/workflows", "/workflowx", "/workflow ./local", "/workflow smoke arg", "/workflow:smoke arg"]) {
		const suggestions = await suggest(provide, line);
		assert.deepEqual(suggestions.items.map((item: any) => item.value), ["delegated"], line);
	}
	assert.equal(delegated(), 7);
});

test("/workflow completion returns no suggestions (without delegating) when the name matches nothing", async () => {
	const { provide, delegated } = harness();
	assert.equal(await suggest(provide, "/workflow zzz"), null);
	assert.equal(delegated(), 0);
});

test("/workflow completion keeps the command available when no workflows exist", async () => {
	const { provide, delegated } = harness([]);
	const command = await suggest(provide, "/work");
	assert.deepEqual(command.items.map((item: any) => item.value), ["delegated"]);
	assert.equal(delegated(), 1);
	// A name slot miss still stays out of file completion.
	assert.equal(await suggest(provide, "/workflow zzz"), null);
	assert.equal(delegated(), 1);
});

test("workflow completion replaces the token without a second slash and delegates other items", () => {
	const { provide } = harness();

	assert.deepEqual(provide.applyCompletion(["/work"], 0, 5, { value: "/workflow review ", label: "review" }, "/work"), {
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
	assert.deepEqual(provide.applyCompletion(["/workflow smo"], 0, 13, { value: "/workflow smoke ", label: "smoke" }, "/workflow smo"), {
		lines: ["/workflow smoke "],
		cursorLine: 0,
		cursorCol: 16,
	});
	// Delegated items (e.g. the bare command name) keep the built-in behavior.
	assert.equal(provide.applyCompletion(["/work"], 0, 5, { value: "workflow", label: "workflow" }, "/work"), "applied");
	assert.equal(provide.shouldTriggerFileCompletion!([], 0, 0), false);
});

// WHY: accepting with the cursor inside the token must not keep the overlapped suffix, or
// Enter runs the workflow with spurious args (`/workflow review iew`).
test("a mid-token accept drops the overlapped tail", () => {
	const { provide } = harness();
	// "/workflow rev|iew": cursor at index 13, prefix "/workflow rev".
	assert.deepEqual(provide.applyCompletion(["/workflow review"], 0, 13, { value: "/workflow review ", label: "review" }, "/workflow rev"), {
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
	// Args after the token survive, separated by the item's trailing space exactly once.
	assert.deepEqual(provide.applyCompletion(["/workflow rev extra"], 0, 13, { value: "/workflow review ", label: "review" }, "/workflow rev"), {
		lines: ["/workflow review extra"],
		cursorLine: 0,
		cursorCol: 17,
	});
});

// WHY: accepting the command name while the cursor sits inside a longer line must replace the
// whole typed command and args. The matched prefix reaches before the line start, so a naive
// splice re-appends the tail (`/workflow review` @col5 -> `/workflow review review`).
test("a command-name accept inside a longer line replaces the whole command and args", () => {
	const { provide } = harness();
	assert.deepEqual(provide.applyCompletion(["/workflow review"], 0, 5, { value: "/workflow review ", label: "review" }, "/workf"), {
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
	assert.deepEqual(provide.applyCompletion(["/workflow kflow review arg"], 0, 5, { value: "/workflow review ", label: "review" }, "/workf"), {
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
});

test("a discovery failure delegates to the built-in provider", async () => {
	const sentinel = { prefix: "SENTINEL", items: [{ value: "sentinel", label: "sentinel" }] };
	const current = {
		getSuggestions: async () => sentinel,
		applyCompletion: () => "applied",
		shouldTriggerFileCompletion: () => false,
	};
	const provide = createWorkflowAutocompleteProvider(async () => { throw new Error("EACCES"); })(current as any);
	const suggestions = await suggest(provide, "/workflow ");
	assert.deepEqual(suggestions, sentinel, "a discovery failure falls back to the built-in provider");
});

test("registerWorkflowAutocomplete installs one workflow provider per UI and none headless", () => {
	const providers: any[] = [];
	const ctx = { hasUI: true, cwd: "/proj", ui: { addAutocompleteProvider: (factory: any) => providers.push(factory) } };
	registerWorkflowAutocomplete(ctx as any);
	registerWorkflowAutocomplete(ctx as any);
	assert.equal(providers.length, 1);

	registerWorkflowAutocomplete({ hasUI: false, cwd: "/proj", ui: { addAutocompleteProvider: (factory: any) => providers.push(factory) } } as any);
	assert.equal(providers.length, 1);
});

// WHY: the provider is installed once per UI but must complete against the *current*
// session's workflows, so the install-time cwd may not be captured. A temp agent dir keeps
// discovery deterministic: the global workflows directory is empty for both sessions.
async function workflowProject(name: string): Promise<string> {
	const dir = await tmpDir();
	await mkdir(join(dir, ".pi", "workflows"), { recursive: true });
	await writeFile(join(dir, ".pi", "workflows", `${name}.js`), "return defineWorkflow((workflow) => workflow.checkpoint(null));\n");
	return dir;
}

test("the installed provider follows the cwd of the latest session, without a second install", async () => {
	const agentDir = await tmpDir();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const first = await workflowProject("alpha");
	const second = await workflowProject("beta");
	try {
		const factories: Array<(current: any) => any> = [];
		const ui = { addAutocompleteProvider: (factory: (current: any) => any) => factories.push(factory) };
		const builtin = { getSuggestions: async () => null, applyCompletion: () => "applied" };
		const names = async (provider: any) => (await suggest(provider, "/workflow "))?.items.map((item: any) => item.value);

		registerWorkflowAutocomplete({ hasUI: true, cwd: first, ui } as any);
		// A later session on the same UI: per-key dedup keeps one install, ctx.cwd still refreshes.
		registerWorkflowAutocomplete({ hasUI: true, cwd: second, ui } as any);
		assert.equal(factories.length, 1, "one workflow provider per UI");
		const provider = factories[0](builtin);
		assert.deepEqual(await names(provider), ["/workflow beta "], "completion reads the refreshed cwd, not the install-time cwd");

		// A replacement UI gets its own install, bound to its own session.
		const nextFactories: Array<(current: any) => any> = [];
		registerWorkflowAutocomplete({ hasUI: true, cwd: first, ui: { addAutocompleteProvider: (f: any) => nextFactories.push(f) } } as any);
		assert.equal(nextFactories.length, 1, "a fresh UI is not blocked by the per-key guard");
		assert.deepEqual(await names(nextFactories[0](builtin)), ["/workflow alpha "]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await Promise.all([agentDir, first, second].map((dir) => rm(dir, { recursive: true, force: true })));
	}
});

test("workflow and model-groups providers stack on the same UI", () => {
	const factories: any[] = [];
	const ui = { addAutocompleteProvider: (factory: any) => factories.push(factory) };
	const state = createState();
	registerWorkflowAutocomplete({ hasUI: true, cwd: "/proj", ui } as any);
	registerModelGroupAutocomplete({ hasUI: true, ui } as any, state);
	assert.equal(factories.length, 2, "one install per key on the same UI");
	// Re-registering neither key installs again.
	registerWorkflowAutocomplete({ hasUI: true, cwd: "/proj", ui } as any);
	registerModelGroupAutocomplete({ hasUI: true, ui } as any, state);
	assert.equal(factories.length, 2, "per-key idempotency across providers");
});

test("neither provider installs headless", () => {
	const factories: any[] = [];
	const ui = { addAutocompleteProvider: (factory: any) => factories.push(factory) };
	registerWorkflowAutocomplete({ hasUI: false, cwd: "/proj", ui } as any);
	registerModelGroupAutocomplete({ hasUI: false, ui } as any, createState());
	assert.equal(factories.length, 0, "headless contexts install neither key");
});
