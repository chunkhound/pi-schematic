import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { SessionManager, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assertPresent, isRecord } from "../assertions.js";
import { createCommandContext, testModel } from "./helpers.js";
import { createState } from "../../state.js";
import { createWorkflowHost, HANDLE_POLICY, isCountedHandle, type WorkflowHandleKind } from "../../workflow/host.js";
import type { WorkflowHandleName, WorkflowHost, WorkflowHostDeps } from "../../workflow/types.js";

const EXPECTED = [
	"workflow.run",
	"workflow.handoff",
	"workflow.classify",
	"workflow.shell",
	"workflow.state",
	"workflow.entries",
	"workflow.notebookIndex",
	"workflow.notebookRead",
	"workflow.notebookWrite",
	"workflow.notebookTopic",
	"workflow.budget",
	"workflow.readonly",
	"workflow.new",
	"workflow.checkpoint",
	"workflow.exit",
];

/** `value` as a non-null; throws `message` when it is null or undefined. */
function requirePresent<T>(value: T | null | undefined, message: string): asserts value is T {
	if (value === null || value === undefined) {
		throw new Error(message);
	}
}

/** Affirm a plain object as the extension API surface the host reads. */
function requireExtensionAPI(value: unknown): asserts value is ExtensionAPI {
	if (!isRecord(value)) {
		throw new Error("expected the extension API surface");
	}
}

/** Affirm a plain object as a model registry stub. */
function requireModelRegistry(value: unknown): asserts value is ModelRegistry {
	if (!isRecord(value)) {
		throw new Error("expected a model registry");
	}
}

/** A model registry whose `members` are its own; any other method throws naming it. */
function stubRegistry(members: Record<string, unknown>): ModelRegistry {
	const candidate: unknown = new Proxy(
		{},
		{
			get(_target, property, receiver) {
				if (typeof property === "string" && Object.hasOwn(members, property)) {
					return Reflect.get(members, property, receiver);
				}
				if (typeof property === "string") {
					return () => {
						throw new Error(`modelRegistry.${property} is not stubbed in this test context.`);
					};
				}
				return undefined;
			},
		},
	);
	requireModelRegistry(candidate);
	return candidate;
}

/** A session manager whose session seams read `getBranch`; anything else delegates to `SessionManager.inMemory`. */
function stubSessionManager(getBranch: () => unknown[], sessionId = "s"): SessionManager {
	return new Proxy(SessionManager.inMemory(), {
		get(_manager, property, receiver) {
			if (property === "getSessionId") {
				return () => sessionId;
			}
			if (property === "getLeafId") {
				return () => null;
			}
			if (property === "getBranch") {
				return getBranch;
			}
			const value: unknown = Reflect.get(SessionManager.inMemory(), property, receiver);
			return value;
		},
	});
}

function fakeDeps(): WorkflowHostDeps {
	const pi: unknown = {
		on: () => () => undefined,
		getCommands: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: () => Promise.resolve(true),
		getSettings: () => ({}),
		appendEntry: () => undefined,
		sendUserMessage: () => undefined,
	};
	requireExtensionAPI(pi);
	const ctx = createCommandContext({
		cwd: "/workspace",
		sessionManager: stubSessionManager(() => []),
		modelRegistry: stubRegistry({ getModelsOfType: () => [], classify: () => Promise.resolve({}) }),
		getContextUsage: () => undefined,
		isIdle: () => true,
	});
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
		shellRun: async () => ({
			content: [{ type: "text", text: "ok" }],
			isError: false,
			structuredContent: { output: "ok", truncated: false, exit_code: 0, wall_time_seconds: 0 },
		}),
	};
}

test("globals expose exactly the two-level workflow.<member> surface", () => {
	const globals = createWorkflowHost(fakeDeps()).globals();
	expect(globals.map((tool) => tool.name)).toStrictEqual(EXPECTED);
	expect(new Set(globals.map((tool) => tool.name)).size).toBe(EXPECTED.length);
	for (const tool of globals) {
		expect(tool.name).toMatch(/^workflow\.[A-Za-z]+$/);
	}
});

test("only workflow.run and workflow.shell spread their arguments", () => {
	const globals = createWorkflowHost(fakeDeps()).globals();
	for (const tool of globals) {
		const spread = tool.spread === true;
		expect(spread).toBe(tool.name === "workflow.run" || tool.name === "workflow.shell");
	}
});

test("a real CodemodeSandbox accepts the handle names", async () => {
	const sandbox = new CodemodeSandbox({ globals: createWorkflowHost(fakeDeps()).globals() });
	expect(sandbox).toBeDefined();
	await sandbox.close();
});

test("recordExit aborts on append failure and leaves the exit unset", () => {
	const deps = fakeDeps();
	let exitAppends = 0;
	deps.pi.appendEntry = (type: string) => {
		if (type === "workflow-exit") {
			exitAppends++;
		}
		throw new Error("disk full");
	};
	const host = createWorkflowHost(deps);
	expect(() => {
		host.recordExit({ reason: "error" }, "error");
	}).toThrow(/disk full/);
	expect(host.abortedReason()).toBe("error");
	expect(host.exitRecord()).toBeNull();
	expect(exitAppends).toBe(1);
});

test("recordExit appends once and ignores later outcomes", () => {
	const deps = fakeDeps();
	let appended = 0;
	deps.pi.appendEntry = () => {
		appended++;
	};
	const host = createWorkflowHost(deps);
	host.recordExit({ reason: "done", metadata: { ok: true } }, "error");
	host.recordExit({ reason: "changed" }, "error");
	expect(appended).toBe(1);
	expect(host.exitRecord()).toStrictEqual({ reason: "done", metadata: { ok: true } });
});

test("recordExit maps metadata and checkpoint salvage", () => {
	const makeHost = () => createWorkflowHost(fakeDeps());
	const workflowExit = makeHost();
	workflowExit.recordExit({ reason: "done", metadata: { result: 1 } }, "error");
	expect(workflowExit.exitRecord()).toStrictEqual({ reason: "done", metadata: { result: 1 } });
	const checkpoint = makeHost();
	checkpoint.recordExit({ reason: "cost-limit", partial: { phase: 2 }, checkpoint: true }, "cost-limit");
	expect(checkpoint.exitRecord()?.reason).toBe("cost-limit");
	expect(checkpoint.exitRecord()?.checkpoint).toBe(true);
	expect(checkpoint.exitRecord()?.partial).toStrictEqual({ phase: 2 });
});

test("recordExit keeps error exits and partial-only runs uncheckpointed", () => {
	const makeHost = () => createWorkflowHost(fakeDeps());
	const hardAbort = makeHost();
	hardAbort.recordExit({ reason: "error", partial: null, error: "stopped" }, "error");
	expect(hardAbort.exitRecord()?.reason).toBe("error");
	expect(hardAbort.exitRecord()?.error).toBe("stopped");
	expect(hardAbort.exitRecord()?.partial).toBeNull();
	const commandExit = makeHost();
	commandExit.recordExit({ reason: "error", partial: { phase: 3 } }, "error");
	expect(commandExit.exitRecord()?.checkpoint, "partial data alone does not mark a checkpoint stop").toBeUndefined();
});

test("a guarded call past the cost limit defers the stop to the next checkpoint", async () => {
	const deps = fakeDeps();
	deps.limits = { costLimit: 0, timeBudgetMs: null };
	const host = createWorkflowHost(deps);
	const byName = new Map(host.globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	// The crossing call runs; the run is not aborted mid-effect.
	const shell = (await byName.get("workflow.shell")!.execute(["echo hi"], context)) as { ok: boolean };
	expect(shell.ok).toBe(true);
	expect(host.exitRecord()).toBeNull();
	// The next checkpoint stops the run and salvages its metadata.
	await byName.get("workflow.checkpoint")!.execute({ round: 1 }, context);
	expect(host.exitRecord()?.reason).toBe("cost-limit");
	expect(host.exitRecord()?.checkpoint).toBe(true);
	expect(host.checkpointRecord()?.metadata).toStrictEqual({ round: 1 });
});

/**
 * Per-handle accounting contract derived from the code policy (`HANDLE_POLICY`): guarded
 * handles arm the deferred cost/time stop, counted handles feed the run metrics. Deriving it
 * keeps the test from drifting from the shipped Guarded/Inspectors/terminal partition.
 */
const HANDLE_CONTRACT = Object.keys(HANDLE_POLICY)
	.filter((name): name is WorkflowHandleName => name in HANDLE_POLICY)
	.map((name) => ({
		name,
		guarded: HANDLE_POLICY[name].kind === "guarded",
		counted: isCountedHandle(HANDLE_POLICY[name]),
	}));

interface TableEntry {
	type: string;
	id: string;
	parentId: null;
	message: { role: string };
}

/** Fake env with a working run round-trip: every send settles with one assistant entry. */
function fakeRunDeps(): { deps: WorkflowHostDeps; branch: TableEntry[] } {
	const deps = fakeDeps();
	// notebookRead throws on a missing page, so the table probes read a real page.
	deps.state.notebookPages.set("notes", "body");
	const branch: TableEntry[] = [];
	const settled = new Set<() => void>();
	let seq = 0;
	const nextId = () => `e${++seq}`;
	Object.defineProperty(deps.pi, "on", {
		value: (event: string, handler: () => void) => {
			if (event === "agent_settled") {
				settled.add(handler);
			}
			return () => {
				settled.delete(handler);
			};
		},
		writable: true,
		configurable: true,
	});
	deps.pi.getCommands = () => [
		{ name: "review", source: "prompt", sourceInfo: { path: "/workspace/review", source: "prompt", scope: "project", origin: "top-level" } },
	];
	deps.pi.sendUserMessage = () => {
		branch.push({ type: "message", id: nextId(), parentId: null, message: { role: "user" } });
		branch.push({ type: "message", id: nextId(), parentId: null, message: { role: "assistant" } });
		for (const handler of [...settled]) {
			handler();
		}
	};
	const classifierModel = testModel({ provider: "typesafe", id: "jev", input: ["text"], reasoning: false });
	const ctx = deps.getCtx();
	requirePresent(ctx, "expected a command context");
	ctx.sessionManager = stubSessionManager(() => branch);
	ctx.modelRegistry = stubRegistry({
		getModelsOfType: () => [classifierModel],
		getModelOfType: () => undefined,
		classify: () => Promise.resolve({ api: "x", provider: "typesafe", model: "jev", answers: {}, stopReason: "stop", timestamp: 0 }),
	});
	return { deps, branch };
}

function tableArgs(name: WorkflowHandleName): unknown {
	switch (name) {
		case "run":
			return ["/review"];
		case "handoff":
			return "next: review";
		case "classify":
			return { model: { provider: "typesafe", id: "jev" }, state: {}, questions: {} };
		case "shell":
			return ["echo hi"];
		case "entries":
			return {};
		case "notebookRead":
			return "notes";
		case "notebookWrite":
			return { name: "n", content: "c" };
		case "readonly":
			return false;
		case "checkpoint":
			return { round: 1 };
		case "exit":
			return { reason: "done" };
		default:
			return undefined;
	}
}

async function callHandle(host: WorkflowHost, name: WorkflowHandleName): Promise<unknown> {
	const tool = host.globals().find((candidate) => candidate.name === `workflow.${name}`);
	assertPresent(tool, `missing handle workflow.${name}`);
	return tool.execute(tableArgs(name), { signal: host.signal });
}

test("every handle matches the guarded/counted contract", async () => {
	const globals = createWorkflowHost(fakeDeps())
		.globals()
		.map((tool) => tool.name);
	expect(
		HANDLE_CONTRACT.map((row) => `workflow.${row.name}`),
		"the contract table covers exactly the 15 registered handles",
	).toStrictEqual(globals);
	for (const row of HANDLE_CONTRACT) {
		// Counted probe: one call on a fresh unlimited host feeds the activity ledger.
		const countedHost = createWorkflowHost(fakeRunDeps().deps);
		await callHandle(countedHost, row.name);
		const activity = countedHost.metrics().activity;
		expect(activity[row.name] ?? 0, `${row.name}: counted=${row.counted}`).toBe(row.counted ? 1 : 0);
		// Guarded probe: past the cost limit, guarded effects hard-abort after the
		// deferred budget while inspectors stay reachable (exit/checkpoint end the run
		// through their own terminal path, never via the guard's abort reason).
		const { deps } = fakeRunDeps();
		deps.limits = { costLimit: 0, timeBudgetMs: null };
		const guardedHost = createWorkflowHost(deps);
		for (let i = 0; i < 20; i++) {
			try {
				await callHandle(guardedHost, row.name);
			} catch {
				/* terminal states reject; the abort reason is the signal */
			}
		}
		expect(guardedHost.abortedReason(), `${row.name}: guarded=${row.guarded}`).toBe(row.guarded ? "cost-limit" : null);
	}
});

test("unguarded budget/state/notebookRead/exit stay reachable past the cost limit", async () => {
	const deps = fakeDeps();
	deps.limits = { costLimit: 0, timeBudgetMs: null };
	const byName = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	);
	const context = { signal: new AbortController().signal } as never;
	deps.state.notebookPages.set("notes", "body");
	await byName.get("workflow.budget")!.execute(null, context);
	await byName.get("workflow.state")!.execute(null, context);
	// A missing page throws (documented contract); a real page still reads past the limit.
	expect(await byName.get("workflow.notebookRead")!.execute("notes", context)).toBe("body");
	await byName.get("workflow.exit")!.execute(null, context);
});

// WHY: the exit reason is a shared contract (deriveExitReason): reserved tokens reject
// before anything is recorded, an object reason survives, and a missing reason is "returned".
test("workflow.exit rejects reserved reasons and derives the record reason", async () => {
	const context = { signal: new AbortController().signal } as never;
	const exitOf = (host: WorkflowHost) => new Map(host.globals().map((tool) => [tool.name, tool])).get("workflow.exit")!;
	const rejecting = createWorkflowHost(fakeDeps());
	await expect(exitOf(rejecting).execute("cost-limit", context)).rejects.toThrow(/reserved abort reason/);
	expect(rejecting.exitRecord(), "a rejected exit records nothing").toBeNull();
	const approved = createWorkflowHost(fakeDeps());
	await exitOf(approved).execute({ reason: "approved" }, context);
	expect(approved.exitRecord()?.reason).toBe("approved");
	const bare = createWorkflowHost(fakeDeps());
	await exitOf(bare).execute(undefined, context);
	expect(bare.exitRecord()?.reason).toBe("returned");
});

// WHY: previews buffer until the send happens; a dispatch failure must restore them for
// the next run instead of dropping them, while the sent boundary is the real dispatch.
test("a dispatch failure keeps buffered previews for the next run", async () => {
	const { deps, branch } = fakeRunDeps();
	const sent: string[] = [];
	const settled = new Set<() => void>();
	(deps.pi as unknown as { on: unknown }).on = (event: string, handler: () => void) => {
		if (event === "agent_settled") {
			settled.add(handler);
		}
		return () => {
			settled.delete(handler);
		};
	};
	let failDispatch = true;
	let seq = 0;
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (text: string) => {
		sent.push(text);
		if (failDispatch) {
			throw new Error("dispatch down");
		}
		branch.push({ type: "message", id: `u${++seq}`, parentId: null, message: { role: "user" } });
		branch.push({ type: "message", id: `a${seq}`, parentId: null, message: { role: "assistant" } });
		for (const handler of [...settled]) {
			handler();
		}
	};
	const host = createWorkflowHost(deps);
	const byName = new Map(host.globals().map((tool) => [tool.name, tool]));
	const context = { signal: new AbortController().signal } as never;
	await byName.get("workflow.notebookWrite")!.execute({ name: "perf", content: "body" }, context);
	await expect(byName.get("workflow.run")!.execute(["/review"], context)).rejects.toThrow(/dispatch down/);
	failDispatch = false;
	await byName.get("workflow.run")!.execute(["/review"], context);
	expect(sent.length).toBe(2);
	expect(sent[1]).toMatch(/Notebook page "perf" written/);
});

// WHY: the abort guard is only reachable in the settle-to-nudge gap: every earlier abort path
// rejects `activeRun`. Abort there must not send a nudge into a cancelled run.
test("an abort between the first settle and the nudge sends no second message", async () => {
	const { deps, branch } = fakeRunDeps();
	const settled = new Set<() => void>();
	(deps.pi as unknown as { on: unknown }).on = (event: string, handler: () => void) => {
		if (event === "agent_settled") {
			settled.add(handler);
		}
		return () => {
			settled.delete(handler);
		};
	};
	const sent: string[] = [];
	let seq = 0;
	const settle = () => {
		for (const handler of [...settled]) {
			handler();
		}
	};
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (text: string) => {
		sent.push(text);
		branch.push({ type: "message", id: `u${++seq}`, parentId: null, message: { role: "user" } });
		// A second send settles at once, so a missing abort guard fails on the send count, not a hang.
		if (sent.length > 1) {
			branch.push({ type: "message", id: `a${seq}`, parentId: null, message: { role: "assistant" } });
			settle();
		}
	};
	// Output arming needs the tool registry seams; this test exercises dispatch only.
	Object.assign(deps.pi, { registerTool: () => {}, setActiveTools: () => {} });
	(deps.getCtx() as unknown as { abort: () => void }).abort = () => {};
	const host = createWorkflowHost(deps);
	const runTool = host.globals().find((tool) => tool.name === "workflow.run");
	assertPresent(runTool, "workflow.run is registered");
	const run = runTool.execute(["/review", { output: {} }], { signal: host.signal }) as Promise<unknown>;
	for (let i = 0; i < 20 && sent.length === 0; i++) {
		await Promise.resolve();
	}
	expect(sent.length, "the first dispatch is in flight").toBe(1);
	// Flush past the dispatch await so the first correlation is already pending when it settles.
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
	branch.push({ type: "message", id: "a1", parentId: null, message: { role: "assistant" } });
	settle();
	// The settle queues sendCorrelated's continuation first; this abort then lands after it clears
	// `activeRun`, leaving only the nudge guard between the cancellation and a second send.
	queueMicrotask(() => {
		host.abort("cancelled");
	});
	await expect(run).rejects.toThrow(/did not call workflow_output/);
	expect(sent.length, "a cancelled run gets no nudge").toBe(1);
	expect(host.abortedReason()).toBe("cancelled");
});

// WHY: docs/workflows.md's Handles table is the user-facing contract for the handle union;
// this pins it to the runtime surface so a handle added or removed forces a docs edit.
test("the docs Handles table lists exactly the runtime handle surface", () => {
	const doc = readFileSync(new URL("../../docs/workflows.md", import.meta.url), "utf8");
	const docHandles = [...doc.matchAll(/^\| `workflow\.([A-Za-z]+)`\s+\|/gm)].map((m) => m[1]);
	const runtimeHandles = createWorkflowHost(fakeDeps())
		.globals()
		.map((tool) => tool.name.replace(/^workflow\./, ""));
	expect([...docHandles].sort()).toStrictEqual([...runtimeHandles].sort());
	expect(docHandles.length, "a 16th handle must also edit the docs table").toBe(EXPECTED.length);
});

// WHY: readonly is a posture switch, so a coerced argument ("false" → true) would flip it
// silently. Only a real boolean may change the posture; anything else fails by name.
test("workflow.readonly accepts only a boolean and leaves the posture unchanged otherwise", async () => {
	const deps = fakeDeps();
	let posture = false;
	deps.setReadonly = (enabled) => {
		posture = deps.state.readonlyEnabled = enabled;
		return enabled;
	};
	const readonly = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	).get("workflow.readonly")!;
	const context = { signal: new AbortController().signal } as never;
	for (const bad of [undefined, "false", 1]) {
		await expect(async () => readonly.execute(bad, context)).rejects.toThrow(/workflow\.readonly takes a boolean/);
		expect(posture, `posture after ${String(bad)}`).toBe(false);
	}
	expect(await readonly.execute(true, context)).toStrictEqual({ readonly: true });
	expect(posture).toBe(true);
});

// WHY: a redundant `workflow.readonly(x)` must not re-notify or queue a stale hidden message;
// the notice (indicator refresh + nudge) belongs only to an actual posture change.
test("workflow.readonly notifies only when the posture changes", async () => {
	const deps = fakeDeps();
	const toggles: boolean[] = [];
	deps.setReadonly = (enabled) => {
		deps.state.readonlyEnabled = enabled;
		return enabled;
	};
	deps.onReadonlyToggled = (enabled) => {
		toggles.push(enabled);
	};
	const readonly = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	).get("workflow.readonly")!;
	const context = { signal: new AbortController().signal } as never;

	await readonly.execute(false, context);
	expect(toggles, "a redundant readwrite call emits no notice").toStrictEqual([]);
	await readonly.execute(true, context);
	await readonly.execute(true, context);
	expect(toggles, "only the first enable emits a notice").toStrictEqual([true]);
});

// WHY: run options arrive untyped from workflow JS. A malformed field must fail by name
// before dispatch, and the previews buffered for the next run must survive the rejection.
test("workflow.run rejects a malformed options object before dispatch and keeps buffered previews", async () => {
	const { deps } = fakeRunDeps();
	const sent: string[] = [];
	const dispatch = (deps.pi as unknown as { sendUserMessage: (...args: unknown[]) => void }).sendUserMessage;
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (...args: unknown[]) => {
		sent.push(args[0] as string);
		dispatch(...args);
	};
	const tools = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	);
	const context = { signal: new AbortController().signal } as never;
	await tools.get("workflow.notebookWrite")!.execute({ name: "perf", content: "body" }, context);
	const rejected: [unknown, RegExp][] = [
		[{ model: "p/m" }, /options\.model must be \{ provider: string, id: string \}/],
		[{ model: { provider: "p" } }, /options\.model must be/],
		[{ thinking: "turbo" }, /options\.thinking must be one of minimal, low, medium, high, xhigh, max/],
		[["high"], /options must be an object/],
	];
	for (const [options, pattern] of rejected) {
		await expect(async () => tools.get("workflow.run")!.execute(["/review", options], context)).rejects.toThrow(pattern);
	}
	expect(sent.length, "a rejected options object never dispatches").toBe(0);
	await tools.get("workflow.run")!.execute(["/review"], context);
	expect(sent.length).toBe(1);
	expect(sent[0], "the buffered preview reaches the next run").toMatch(/Notebook page "perf" written/);
});

// WHY: a failed advisory record must not vanish silently: the UI notice names the missing
// transcript record, and a recorded failure reads as a plain notice.
test("a host error notice names a transcript record that could not be persisted", async () => {
	const deps = fakeDeps();
	const notices: string[] = [];
	deps.notify = (message) => {
		notices.push(message);
	};
	deps.onProgress = () => {
		throw new Error("ui down");
	};
	const shell = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	).get("workflow.shell")!;
	const context = { signal: new AbortController().signal } as never;
	deps.pi.appendEntry = () => {
		throw new Error("append down");
	};
	await shell.execute(["echo hi"], context);
	expect(notices[0]).toBe("workflow progress failed: ui down (transcript record not persisted)");
	deps.pi.appendEntry = () => {};
	notices.length = 0;
	await shell.execute(["echo hi"], context);
	expect(notices[0]).toBe("workflow progress failed: ui down");
});

// WHY: the exit record has exactly one writer (host.recordExit); a second append site would
// reintroduce the split-writer bug (F3). This static guard keeps the append single-sourced.
test("the workflow-exit record has exactly one writer file", () => {
	const dir = new URL("../../workflow/", import.meta.url);
	const writers = readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.filter((name) => readFileSync(new URL(name, dir), "utf8").includes("appendEntry(WORKFLOW_EXIT_ENTRY_TYPE"));
	expect(writers, "only the host may append the run's exit record").toStrictEqual(["host.ts"]);
});

// WHY: docs/workflows.md states the handle count and partitions the surface into guarded,
// inspector, and terminal categories; the contract table must stay in lockstep so a new
// handle cannot silently stale the docs or land in the wrong category.
const WORKFLOWS_DOC = readFileSync(new URL("../../docs/workflows.md", import.meta.url), "utf8");

test("the handle count and partition stated in docs/workflows.md stay in sync", () => {
	expect(WORKFLOWS_DOC, "docs/workflows.md states the handle count; update both together").toMatch(/The surface is 15 handles/);
	const names = (line: string) => [...line.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1]).sort();
	const bullet = (label: string): string[] => {
		const match = new RegExp(`^- \\*\\*${label}:\\*\\* ?(.+)$`, "m").exec(WORKFLOWS_DOC);
		assertPresent(match, `docs/workflows.md lost the ${label} bullet`);
		return names(match[1]);
	};
	const contractGuarded = HANDLE_CONTRACT.filter((row) => row.guarded)
		.map((row) => row.name)
		.sort();
	const handleNames = Object.keys(HANDLE_POLICY) as WorkflowHandleName[];
	const byKind = (kind: WorkflowHandleKind) => handleNames.filter((name) => HANDLE_POLICY[name].kind === kind).sort();
	const guarded = bullet("Guarded");
	const inspectors = bullet("Inspectors");
	expect(guarded, "the docs Guarded list must match the guarded handles").toStrictEqual(contractGuarded);
	expect(guarded, "the docs Guarded list must match HANDLE_POLICY").toStrictEqual(byKind("guarded"));
	expect(inspectors, "the docs Inspectors list must match HANDLE_POLICY").toStrictEqual(byKind("inspector"));
});

test("the docs terminal handles and partition cover every handle exactly once", () => {
	const names = (line: string) => [...line.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1]).sort();
	const bullet = (label: string): string[] => {
		const match = new RegExp(`^- \\*\\*${label}:\\*\\* ?(.+)$`, "m").exec(WORKFLOWS_DOC);
		assertPresent(match, `docs/workflows.md lost the ${label} bullet`);
		return names(match[1]);
	};
	const terminalMatch = /^- `([A-Za-z]+)` and `([A-Za-z]+)` stay reachable too;/m.exec(WORKFLOWS_DOC);
	assertPresent(terminalMatch, "docs/workflows.md lost the terminal-handle bullet");
	const terminal = [terminalMatch[1], terminalMatch[2]].sort();
	const handleNames = Object.keys(HANDLE_POLICY) as WorkflowHandleName[];
	const byKind = (kind: WorkflowHandleKind) => handleNames.filter((name) => HANDLE_POLICY[name].kind === kind).sort();
	const guarded = bullet("Guarded");
	const inspectors = bullet("Inspectors");
	expect(terminal, "the docs terminal handles must match HANDLE_POLICY control handles").toStrictEqual(byKind("control"));
	expect([...guarded, ...inspectors, ...terminal].sort(), "the docs partition must cover every handle exactly once").toStrictEqual([...handleNames].sort());
});

// WHY: notebookWrite returns null, so the clipping notice must ride the buffered preview;
// otherwise a truncated page reaches the next run silently.
test("workflow.notebookWrite surfaces truncation in the next run's buffered preview", async () => {
	const { deps } = fakeRunDeps();
	const sent: string[] = [];
	const dispatch = (deps.pi as unknown as { sendUserMessage: (...args: unknown[]) => void }).sendUserMessage;
	(deps.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (...args: unknown[]) => {
		sent.push(args[0] as string);
		dispatch(...args);
	};
	const tools = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	);
	const context = { signal: new AbortController().signal } as never;
	const long = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n");

	await tools.get("workflow.notebookWrite")!.execute({ name: "big", content: long }, context);
	await tools.get("workflow.run")!.execute(["/review"], context);
	expect(sent.length).toBe(1);
	expect(sent[0]).toMatch(/Notebook page "big" written/);
	expect(sent[0]).toMatch(/TRUNCATED by lines/);
});

// WHY: a run-scoped override must never leak across turns, so each restored field is
// independent: a throwing setModel restore must not skip the thinking restore.
test("a throwing model restore still restores the run's thinking level", async () => {
	const { deps } = fakeRunDeps();
	const previousModel = testModel({ provider: "prev", id: "m", input: ["text"], reasoning: false });
	const requestedModel = testModel({ provider: "next", id: "m", input: ["text"], reasoning: false });
	const thinking: (string | undefined)[] = [];
	let setModelCalls = 0;
	deps.pi.setModel = async () => {
		setModelCalls += 1;
		if (setModelCalls === 2) {
			throw new Error("restore down");
		}
		return true;
	};
	deps.pi.setThinkingLevel = (level: string | undefined) => {
		thinking.push(level);
	};
	deps.pi.getThinkingLevel = () => "medium";
	const ctx = deps.getCtx();
	requirePresent(ctx, "expected a command context");
	ctx.model = previousModel;
	ctx.modelRegistry = stubRegistry({ getModelOfType: () => requestedModel });
	const tools = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	);
	const context = { signal: new AbortController().signal };

	await expect(tools.get("workflow.run")!.execute(["/review", { model: requestedModel, thinking: "high" }], context)).rejects.toThrow(
		/override restore failed/,
	);
	expect(thinking, "the thinking restore runs even though setModel threw").toStrictEqual(["high", "medium"]);
});

// WHY: pi's `setModel` resets the thinking level to the per-model/default value, so a model-only
// override must still restore the captured level or it leaks into the session after the run.
test("a model-only override still restores the captured thinking level", async () => {
	const { deps } = fakeRunDeps();
	const previousModel = testModel({ provider: "prev", id: "m", input: ["text"], reasoning: false });
	const requestedModel = testModel({ provider: "next", id: "m", input: ["text"], reasoning: false });
	const thinking: (string | undefined)[] = [];
	deps.pi.setModel = async () => true;
	deps.pi.setThinkingLevel = (level: string | undefined) => {
		thinking.push(level);
	};
	deps.pi.getThinkingLevel = () => "medium";
	const ctx = deps.getCtx();
	requirePresent(ctx, "expected a command context");
	ctx.model = previousModel;
	ctx.modelRegistry = stubRegistry({ getModelOfType: () => requestedModel });
	const tools = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	);
	const context = { signal: new AbortController().signal };

	await tools.get("workflow.run")!.execute(["/review", { model: requestedModel }], context);
	expect(thinking, "the captured level is restored although no thinking was overridden").toStrictEqual(["medium"]);
});

// WHY: arming the output tool mutates run-scoped state, so a registration failure must still
// run the override restore or the run's model/thinking leak into the next turn.
test("a throwing output-tool arming still restores the run's model and thinking", async () => {
	const { deps } = fakeRunDeps();
	const previousModel = testModel({ provider: "prev", id: "m", input: ["text"], reasoning: false });
	const requestedModel = testModel({ provider: "next", id: "m", input: ["text"], reasoning: false });
	const models: unknown[] = [];
	const thinking: (string | undefined)[] = [];
	deps.pi.setModel = async (model: unknown) => {
		models.push(model);
		return true;
	};
	deps.pi.setThinkingLevel = (level: string | undefined) => {
		thinking.push(level);
	};
	deps.pi.getThinkingLevel = () => "medium";
	deps.pi.getActiveTools = () => ["bash"];
	deps.pi.registerTool = () => {
		throw new Error("bad schema");
	};
	const ctx = deps.getCtx();
	requirePresent(ctx, "expected a command context");
	ctx.model = previousModel;
	ctx.modelRegistry = stubRegistry({ getModelOfType: () => requestedModel });
	const tools = new Map(
		createWorkflowHost(deps)
			.globals()
			.map((tool) => [tool.name, tool]),
	);
	const context = { signal: new AbortController().signal } as never;

	await expect(tools.get("workflow.run")!.execute(["/review", { model: requestedModel, thinking: "high", output: {} }], context)).rejects.toThrow(/bad schema/);
	expect(models, "the override restore runs after the arming failure").toStrictEqual([requestedModel, previousModel]);
	expect(thinking).toStrictEqual(["high", "medium"]);
});
