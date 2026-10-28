import { expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkflowAutocompleteProvider, registerWorkflowAutocomplete } from "../../workflow/autocomplete.js";
import { registerModelGroupAutocomplete } from "../../model-groups/autocomplete.js";
import { createState } from "../../state.js";
import type { WorkflowFileEntry } from "../../workflow/file.js";
import { tmpDir } from "./helpers.js";

const ENTRIES: WorkflowFileEntry[] = [
	{ name: "precommit-review", path: "/agent/workflows/precommit-review.js", source: "global", label: "global" },
	{ name: "review", path: "/proj/.pi/workflows/review.js", source: "project", label: ".pi/workflows" },
	{ name: "smoke", path: "/proj/.pi/workflows/smoke.js", source: "project", label: ".pi/workflows" },
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
		expect(suggestions.items.map((item: any) => item.label)).toStrictEqual(["/workflow precommit-review", "/workflow review", "/workflow smoke"]);
		expect(suggestions.prefix).toBe(line);
	}

	const all = await suggest(provide, "/workflow");
	expect(all.items.map((item: any) => item.value)).toStrictEqual(["/workflow precommit-review ", "/workflow review ", "/workflow smoke "]);

	const smoke = await suggest(provide, "/workflow smo");
	expect(smoke.items.map((item: any) => item.label)).toStrictEqual(["/workflow smoke"]);
	expect(smoke.prefix).toBe("/workflow smo");
	expect(smoke.items[0].value).toBe("/workflow smoke ");
	expect(smoke.items[0].description).toBe(".pi/workflows");

	const fuzzy = await suggest(provide, "/workflow pcr");
	expect(fuzzy.items.map((item: any) => item.label)).toStrictEqual(["/workflow precommit-review"]);
	expect(fuzzy.items[0].description).toBe("global");

	const ranked = await suggest(provide, "/workflow review");
	expect(ranked.items[0].label).toBe("/workflow review");
	expect(ranked.items.some((item: any) => item.label === "/workflow precommit-review")).toBe(true);

	expect(delegated()).toBe(0);
});

test("/workflow completion delegates the lone slash, other commands, paths, and args", async () => {
	const { provide, delegated } = harness();
	for (const line of ["/", "/help", "/workflows", "/workflowx", "/workflow ./local", "/workflow smoke arg", "/workflow:smoke arg"]) {
		const suggestions = await suggest(provide, line);
		expect(suggestions.items.map((item: any) => item.value)).toStrictEqual(["delegated"]);
	}
	expect(delegated()).toBe(7);
});

test("/workflow completion returns no suggestions (without delegating) when the name matches nothing", async () => {
	const { provide, delegated } = harness();
	expect(await suggest(provide, "/workflow zzz")).toBeNull();
	expect(delegated()).toBe(0);
});

test("/workflow completion keeps the command available when no workflows exist", async () => {
	const { provide, delegated } = harness([]);
	const command = await suggest(provide, "/work");
	expect(command.items.map((item: any) => item.value)).toStrictEqual(["delegated"]);
	expect(delegated()).toBe(1);
	// A name slot miss still stays out of file completion.
	expect(await suggest(provide, "/workflow zzz")).toBeNull();
	expect(delegated()).toBe(1);
});

test("workflow completion replaces the token without a second slash and delegates other items", () => {
	const { provide } = harness();

	expect(provide.applyCompletion(["/work"], 0, 5, { value: "/workflow review ", label: "review" }, "/work")).toStrictEqual({
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
	expect(provide.applyCompletion(["/workflow smo"], 0, 13, { value: "/workflow smoke ", label: "smoke" }, "/workflow smo")).toStrictEqual({
		lines: ["/workflow smoke "],
		cursorLine: 0,
		cursorCol: 16,
	});
	// Delegated items (e.g. the bare command name) keep the built-in behavior.
	expect(provide.applyCompletion(["/work"], 0, 5, { value: "workflow", label: "workflow" }, "/work")).toBe("applied");
	expect(provide.shouldTriggerFileCompletion!([], 0, 0)).toBe(false);
});

// WHY: accepting with the cursor inside the token must not keep the overlapped suffix, or
// Enter runs the workflow with spurious args (`/workflow review iew`).
test("a mid-token accept drops the overlapped tail", () => {
	const { provide } = harness();
	// "/workflow rev|iew": cursor at index 13, prefix "/workflow rev".
	expect(provide.applyCompletion(["/workflow review"], 0, 13, { value: "/workflow review ", label: "review" }, "/workflow rev")).toStrictEqual({
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
	// Args after the token survive, separated by the item's trailing space exactly once.
	expect(provide.applyCompletion(["/workflow rev extra"], 0, 13, { value: "/workflow review ", label: "review" }, "/workflow rev")).toStrictEqual({
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
	expect(provide.applyCompletion(["/workflow review"], 0, 5, { value: "/workflow review ", label: "review" }, "/workf")).toStrictEqual({
		lines: ["/workflow review "],
		cursorLine: 0,
		cursorCol: 17,
	});
	expect(provide.applyCompletion(["/workflow kflow review arg"], 0, 5, { value: "/workflow review ", label: "review" }, "/workf")).toStrictEqual({
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
	const provide = createWorkflowAutocompleteProvider(async () => {
		throw new Error("EACCES");
	})(current as any);
	const suggestions = await suggest(provide, "/workflow ");
	expect(suggestions).toStrictEqual(sentinel);
});

test("registerWorkflowAutocomplete installs one workflow provider per UI and none headless", () => {
	const providers: any[] = [];
	const ctx = { hasUI: true, cwd: "/proj", ui: { addAutocompleteProvider: (factory: any) => providers.push(factory) } };
	registerWorkflowAutocomplete(ctx as any);
	registerWorkflowAutocomplete(ctx as any);
	expect(providers.length).toBe(1);

	registerWorkflowAutocomplete({ hasUI: false, cwd: "/proj", ui: { addAutocompleteProvider: (factory: any) => providers.push(factory) } } as any);
	expect(providers.length).toBe(1);
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
		const factories: ((current: any) => any)[] = [];
		const ui = { addAutocompleteProvider: (factory: (current: any) => any) => factories.push(factory) };
		const builtin = { getSuggestions: async () => null, applyCompletion: () => "applied" };
		const names = async (provider: any) => (await suggest(provider, "/workflow "))?.items.map((item: any) => item.value);

		registerWorkflowAutocomplete({ hasUI: true, cwd: first, ui } as any);
		// A later session on the same UI: per-key dedup keeps one install, ctx.cwd still refreshes.
		registerWorkflowAutocomplete({ hasUI: true, cwd: second, ui } as any);
		expect(factories.length).toBe(1);
		const provider = factories[0](builtin);
		expect(await names(provider)).toStrictEqual(["/workflow beta "]);

		// A replacement UI gets its own install, bound to its own session.
		const nextFactories: ((current: any) => any)[] = [];
		registerWorkflowAutocomplete({ hasUI: true, cwd: first, ui: { addAutocompleteProvider: (f: any) => nextFactories.push(f) } } as any);
		expect(nextFactories.length).toBe(1);
		expect(await names(nextFactories[0](builtin))).toStrictEqual(["/workflow alpha "]);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await Promise.all([agentDir, first, second].map((dir) => rm(dir, { recursive: true, force: true })));
	}
});

test("two UIs keep their own completion cwd", async () => {
	const agentDir = await tmpDir();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const first = await workflowProject("alpha");
	const second = await workflowProject("beta");
	try {
		const builtin = { getSuggestions: async () => null, applyCompletion: () => "applied" };
		const factoriesA: ((current: any) => any)[] = [];
		const factoriesB: ((current: any) => any)[] = [];
		const uiA = { addAutocompleteProvider: (factory: (current: any) => any) => factoriesA.push(factory) };
		const uiB = { addAutocompleteProvider: (factory: (current: any) => any) => factoriesB.push(factory) };
		const names = async (provider: any) => (await suggest(provider, "/workflow "))?.items.map((item: any) => item.value);

		registerWorkflowAutocomplete({ hasUI: true, cwd: first, ui: uiA } as any);
		registerWorkflowAutocomplete({ hasUI: true, cwd: second, ui: uiB } as any);
		expect(await names(factoriesA[0](builtin))).toStrictEqual(["/workflow alpha "]);
		expect(await names(factoriesB[0](builtin))).toStrictEqual(["/workflow beta "]);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await Promise.all([agentDir, first, second].map((dir) => rm(dir, { recursive: true, force: true })));
	}
});

test("workflow and model-groups providers stack on the same UI", () => {
	const factories: any[] = [];
	const ui = { addAutocompleteProvider: (factory: any) => factories.push(factory) };
	const state = createState();
	registerWorkflowAutocomplete({ hasUI: true, cwd: "/proj", ui } as any);
	registerModelGroupAutocomplete({ hasUI: true, ui } as any, state);
	expect(factories.length).toBe(2);
	// Re-registering neither key installs again.
	registerWorkflowAutocomplete({ hasUI: true, cwd: "/proj", ui } as any);
	registerModelGroupAutocomplete({ hasUI: true, ui } as any, state);
	expect(factories.length).toBe(2);
});

test("neither provider installs headless", () => {
	const factories: any[] = [];
	const ui = { addAutocompleteProvider: (factory: any) => factories.push(factory) };
	registerWorkflowAutocomplete({ hasUI: false, cwd: "/proj", ui } as any);
	registerModelGroupAutocomplete({ hasUI: false, ui } as any, createState());
	expect(factories.length).toBe(0);
});
