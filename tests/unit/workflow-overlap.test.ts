// Overlap-guard contract (workflow/host.ts): workflow.* calls are serial. Compiled
// workflows are async, so two handles can interleave across an await; the second
// overlapping call must reject with the guard message while the first still completes.
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertPresent } from "../assertions.js";
import { createState } from "../../state.js";
import { createWorkflowHost } from "../../workflow/host.js";
import type { WorkflowHostDeps } from "../../workflow/types.js";

const SHELL_OK = {
	content: [{ type: "text", text: "ok" }],
	isError: false,
	structuredContent: { output: "ok", truncated: false, exit_code: 0, wall_time_seconds: 0 },
};

function fakeDeps(shellRun: NonNullable<WorkflowHostDeps["shellRun"]>): WorkflowHostDeps {
	const pi = {
		on: () => () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
		getSettings: () => ({}),
		appendEntry: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/workspace",
		sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [] },
		getContextUsage: () => undefined,
		modelRegistry: { getModelsOfType: () => [], classify: async () => ({}) },
	} as unknown as ExtensionCommandContext;
	return {
		pi,
		state: createState(),
		limits: { costLimit: null, timeBudgetMs: null },
		unbounded: false,
		getCtx: () => ctx,
		setReadonly: () => false,
		prepareRunFrontmatter: async () => {},
		handoff: async () => {},
		newSession: async () => {},
		shellRun,
	};
}

test("a second overlapping handle call rejects while the first still completes", async () => {
	let openGate!: () => void;
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	const deps = fakeDeps(async () => {
		await gate;
		return SHELL_OK;
	});
	const shell = createWorkflowHost(deps)
		.globals()
		.find((tool) => tool.name === "workflow.shell");
	assertPresent(shell, "workflow.shell is registered");
	const context = { signal: new AbortController().signal } as never;
	const first = shell.execute(["echo one"], context) as Promise<unknown>;
	await expect(shell.execute(["echo two"], context) as Promise<unknown>).rejects.toThrow(/workflow calls must not overlap/);
	openGate();
	await first; // the rejected overlap leaves the in-flight call untouched
	// A serial loop stays legal: once the previous call settled, the next one runs.
	await shell.execute(["echo three"], context);
});
