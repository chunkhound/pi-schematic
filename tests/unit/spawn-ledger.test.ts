// ── Run-spend sink contract ─────────────────────────────────────────
// Child spend belongs to the run ledger from the moment it is incurred: the host sink
// receives each child's cumulative usage keyed by tool-call id, every flush REPLACES that
// row (an accumulating host would multiply spend by the flush count), and a sink installed
// after the run started never receives a write. The settle flush must run before dispose
// even when unsubscribe throws, and message_end flushes fold only assistant/tool-result ends.
//
// Extracted from spawn.test.ts so the spawn suite separates the run-spend ledger contract
// from the spawn lifecycle; the real-child parity of live snapshots vs the settled row
// lives in spawn-runtime-compatibility.test.ts.
import { expect, test, vi } from "vitest";
import { assertPresent } from "../assertions.js";
import { usageByModel } from "../../usage.js";
import { createState, type ChildUsageSink } from "../../state.js";
import { executeSpawn, registerSpawnTool } from "../../spawn/index.js";
import type { CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import {
	assertChildRegistriesCleared,
	assertErrorResult,
	executeSpawnTool,
	executeWithFailingCleanup,
	EMPTY_CHILD_USAGE,
	assistantMessageEntry,
	mockFactoryWith,
	toolResultEntry,
	mockSessionFactory,
	sessionResult,
	spawnContext,
	usageFixtureUsd,
} from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { isControlCodePoint } from "../../model-groups/display.js";
import { group } from "./model-groups-helpers.js";
import { spawnModel } from "./helpers.js";

function hasControlChars(text: string): boolean {
	for (const ch of text) {
		const code = ch.codePointAt(0);
		if (code !== undefined && isControlCodePoint(code)) {
			return true;
		}
	}
	return false;
}

interface RunSpawnOptions {
	state?: ReturnType<typeof createState>;
	sink?: ChildUsageSink;
	signal?: AbortSignal;
	notify?: (message: string, level?: string) => void;
	factory?: () => Promise<CreateAgentSessionResult>;
}

/** Run a headless spawn under `state`; `signal` drives the abort path, `notify` feeds the UI, and `factory` supplies the child session. */
async function runSpawn(options: RunSpawnOptions = {}) {
	const state = options.state ?? createState();
	if (options.sink) {
		state.childUsageSink = { owner: "test-run", sink: options.sink };
	}
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	return executeSpawn(
		"spawn-sanitize",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp", ...(options.notify ? { notify: options.notify } : {}) }),
		state,
		{ prompt: "Do the task" },
		options.signal,
		undefined,
		"medium",
		options.factory ?? (() => Promise.resolve(sessionResult(mockSessionFactory()))),
	);
}

test("spawn flushes child spend to the run sink keyed by tool-call id", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const pi = await createTestHost(
		(api) => {
			registerSpawnTool(
				api,
				state,
				mockFactoryWith({
					prompt: () => Promise.resolve(),
					getEntries: () => [
						{ type: "usage", id: "us1", parentId: null, timestamp: "", kind: "classifier", provider: "p", model: "m", usage: usageFixtureUsd(0.25) },
					],
				}),
			);
		},
		{ activeTools: ["read", "bash", "spawn"] },
	);
	const result = await executeSpawnTool(
		pi,
		"spawn-ledger-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
	);

	expect(result.details.route).toStrictEqual({ status: "inherited", provider: "test", modelId: "mock-model" });
	expect(rows).toStrictEqual([["spawn-ledger-1", "test", "mock-model", result.usage]]);
	expect(result.usage.cost.total).toBe(0.25);
	assertChildRegistriesCleared(state);
});

test("a routed spawn keys the sink row by the group entry's identity", async () => {
	const state = createState();
	const rows: [string, string | null, string, unknown][] = [];
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const routedModel = spawnModel({ provider: "openai", id: "gpt-routed", reasoning: true });
	state.modelGroups.groups = [group("review", { models: [{ provider: "openai", modelId: "gpt-routed", thinkingLevel: "low" }] })];
	const parentRegistry = {
		find: (provider: string, modelId: string) => (provider === "openai" && modelId === "gpt-routed" ? routedModel : undefined),
		hasConfiguredAuth: (model: unknown) => model === routedModel,
	};
	const entries = [assistantMessageEntry("a1", "openai", "gpt-routed", 0.25)];
	const pi = await createTestHost(
		(api) => {
			registerSpawnTool(
				api,
				state,
				mockFactoryWith({
					prompt: () => Promise.resolve(),
					getEntries: () => entries,
				}),
			);
		},
		{ activeTools: ["read", "bash", "spawn"] },
	);
	const result = await executeSpawnTool(
		pi,
		"spawn-routed-sink",
		{ prompt: "Do the task", group: "review" },
		undefined,
		undefined,
		spawnContext({ model: { provider: "openai", id: "parent" }, cwd: "/tmp", modelRegistry: parentRegistry }),
	);

	expect(result.details.route).toStrictEqual({ status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" });
	expect(rows).toStrictEqual([["spawn-routed-sink", "openai", "gpt-routed", result.usage]]);
	// The live row matches the settled ledger row the same entries would produce.
	const spend = usageByModel(entries).get("openai/gpt-routed");
	assertPresent(spend, "expected the routed row to be attributed");
	expect(rows[0][3]).toMatchObject({ cost: { total: spend.costUsd }, totalTokens: spend.totalTokens });
	assertChildRegistriesCleared(state);
});

test("child spend keys follow the effective model that ran, not the requested id", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		// The provider answered under gpt-resolved while the route requested gpt-requested.
		getEntries: () => [assistantMessageEntry("a1", "openai", "gpt-requested", 0.25, "gpt-resolved")],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-effective-model",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	// Spend keys follow what actually ran; the route keeps the requested identity for display.
	expect(rows).toStrictEqual([["spawn-effective-model", "openai", "gpt-resolved", result.usage]]);
	expect(result.details.model).toBe("gpt-resolved");
	expect(result.details.route).toStrictEqual({ status: "inherited", provider: "test", modelId: "mock-model" });
	assertChildRegistriesCleared(state);
});

test("the sink row carries the child's usage-bearing entry count", async () => {
	const rows: [string, string | null, string, unknown, number][] = [];
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage, calls) => {
			rows.push([toolCallId, provider, model, usage, calls]);
		},
	};
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		getEntries: () => [
			assistantMessageEntry("a1", "test", "mock-model", 0.1),
			assistantMessageEntry("a2", "test", "mock-model", 0.15),
			toolResultEntry("t1", { usage: usageFixtureUsd(0.05), model: "mock-model", provider: "test" }),
		],
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	expect(rows).toHaveLength(1);
	expect(rows[0][4]).toBe(3);
	expect(rows[0][3]).toStrictEqual(result.usage);
	assertChildRegistriesCleared(state);
});

test("a stale sink host from a finished run receives no later child spend", async () => {
	const rowsA: [string, string | null, string, unknown][] = [];
	const rowsB: [string, string | null, string, unknown][] = [];
	let handler: ((event: unknown) => void) | undefined;
	const state = createState();
	state.childUsageSink = {
		owner: "run-a",
		sink: (toolCallId, provider, model, usage) => {
			rowsA.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => {
				handler = undefined;
			};
		},
		prompt: () => Promise.resolve(),
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-stale-host",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	await vi.waitFor(() => handler !== undefined);
	assertPresent(handler);
	// A new run takes over before this spawn flushes again; the stale host must not receive it.
	state.childUsageSink = {
		owner: "run-b",
		sink: (toolCallId, provider, model, usage) => {
			rowsB.push([toolCallId, provider, model, usage]);
		},
	};
	handler({ type: "message_end", message: { role: "assistant", usage: undefined } });
	const result = await execution;

	expect(result.details.outcome).toBe("success");
	expect(rowsA).toStrictEqual([]);
	expect(rowsB).toStrictEqual([]);
	assertChildRegistriesCleared(state);
});

test("a sink installed after the run started receives no child spend", async () => {
	const lateRows: unknown[] = [];
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => {
			state.childUsageSink = {
				owner: "test-run",
				sink: (toolCallId, provider, model, usage) => {
					lateRows.push([toolCallId, provider, model, usage]);
				},
			};
			return Promise.resolve();
		},
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-late-sink",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);
	expect(result.details.outcome).toBe("success");
	expect(lateRows).toStrictEqual([]);
});

test("a sink swapped out mid-run keeps every cumulative write with the original owner", async () => {
	const rowsA: [string, string | null, string, unknown][] = [];
	const rowsB: [string, string | null, string, unknown][] = [];
	let handler: ((event: unknown) => void) | undefined;
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rowsA.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => {
				handler = undefined;
			};
		},
		prompt: () => Promise.resolve(),
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-sink-swap",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	await vi.waitFor(() => handler !== undefined);
	assertPresent(handler);
	// The run owns the sink captured before its first await; swapping the host pointer mid-run must not redirect flushes.
	handler({ type: "message_end", message: { role: "assistant", usage: undefined } });
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rowsB.push([toolCallId, provider, model, usage]);
		},
	};
	handler({ type: "message_end", message: { role: "assistant", usage: undefined } });
	await execution;

	expect(rowsA).toHaveLength(3);
	for (const [, , , usage] of rowsA) {
		expect(usage).toStrictEqual(usageFixtureUsd(0.25));
	}
	expect(rowsB).toStrictEqual([]);
	assertChildRegistriesCleared(state);
});

test("a throwing live sink flush never propagates into Pi's dispatch, skips cleanup, or masks the spawn error", async () => {
	const dispose = vi.fn();
	const state = createState();
	const sink = () => {
		throw new Error("sink boom");
	};
	let handler: ((event: unknown) => void) | undefined;
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => undefined;
		},
		prompt: () => {
			throw new Error("prompt failed");
		},
		dispose,
	});
	const execution = runSpawn({ state, sink, factory: () => Promise.resolve(sessionResult(session)) });
	// The live message_end flush throws first; it must be retained — never propagated into the
	// host dispatch — then reported at settle alongside the settle flush failure.
	await vi.waitUntil(() => handler !== undefined);
	assertPresent(handler);
	handler({ type: "message_end", message: { role: "assistant", usage: usageFixtureUsd(0.1) } });

	assertErrorResult(
		await execution,
		// Identical flush failures (live + settle) collapse into one diagnostic line.
		"Spawn failed and cleanup failed: prompt failed; spend flush failed: sink boom",
		EMPTY_CHILD_USAGE,
	);
	expect(dispose).toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});

test("spawn subscribes to child events only when a live sink is installed", async () => {
	const subscribe = vi.fn(() => vi.fn());
	const session = mockSessionFactory({
		subscribe,
		result: [{ role: "assistant", content: [{ type: "text", text: "child result" }] }],
	});
	const noSinkResult = await runSpawn({ factory: () => Promise.resolve(sessionResult(session)) });
	expect(noSinkResult.details.outcome).toBe("success");
	expect(subscribe, "no sink, no subscription").not.toHaveBeenCalled();

	const state = createState();
	const withSinkResult = await runSpawn({ state, sink: () => undefined, factory: () => Promise.resolve(sessionResult(session)) });
	expect(withSinkResult.details.outcome).toBe("success");
	expect(subscribe, "sink installed, subscription installed").toHaveBeenCalledOnce();
});

test("a child event subscription failure keeps the settled stats without a UI", async () => {
	const state = createState();
	const session = mockSessionFactory({
		subscribe: () => {
			throw new Error("subscribe exploded");
		},
	});
	const result = await runSpawn({ state, sink: () => undefined, factory: () => Promise.resolve(sessionResult(session)) });

	// A failing subscribe loses live flushes only; it never fails the spawn, reports the degraded
	// subscription in details.teardownFailures even headless, and the settled stats are still
	// computed at settle (statsUnavailable stays reserved for genuinely unsummable entries).
	expect(result.details.outcome).toBe("success");
	expect(result.details.teardownFailures).toContain("event subscription failed: subscribe exploded");
	expect(result.details.stats).toBeDefined();
	expect(result.details.statsUnavailable).toBeUndefined();
	assertChildRegistriesCleared(state);
});

test("a child event subscription failure notifies when a UI is present and the spawn continues", async () => {
	const notifications: [string, string | undefined][] = [];
	const state = createState();
	const session = mockSessionFactory({
		subscribe: () => {
			throw new Error("subscribe exploded");
		},
	});
	const result = await runSpawn({
		state,
		sink: () => undefined,
		notify: (message, level) => {
			notifications.push([message, level]);
		},
		factory: () => Promise.resolve(sessionResult(session)),
	});
	expect(result.details.outcome).toBe("success");
	expect(notifications).toStrictEqual([["Spawn teardown failed: event subscription failed: subscribe exploded", "warning"]]);
	assertChildRegistriesCleared(state);
});

test("headless spawn surfaces falsy teardown throw values", async () => {
	const { execution, state } = await executeWithFailingCleanup("prompt failed", 0);

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; session dispose failed: 0", EMPTY_CHILD_USAGE);
	assertChildRegistriesCleared(state);
});

test("a falsy teardown throw without a spawn failure still surfaces", async () => {
	const zero: unknown = 0;
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw zero;
		},
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	assertErrorResult(result, "session dispose failed: 0", EMPTY_CHILD_USAGE);
	assertChildRegistriesCleared(state);
});

test("headless spawn names both flush and dispose failures", async () => {
	const { execution, state } = await executeWithFailingCleanup(new Error("prompt failed"), new Error("dispose failed"), undefined, () => {
		throw new Error("sink boom");
	});

	assertErrorResult(
		await execution,
		"Spawn failed and cleanup failed: prompt failed; spend flush failed: sink boom; session dispose failed: dispose failed",
		EMPTY_CHILD_USAGE,
	);
	assertChildRegistriesCleared(state);
});

test("the settle flush runs even when unsubscribe throws", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		subscribe: () => () => {
			throw new Error("unsubscribe exploded");
		},
		prompt: () => Promise.resolve(),
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-unsub-throw",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	// An unsubscribe throw is instrumentation-only: it degrades, never fails the successful run, so
	// the reply stands and the report names the failure in details.teardownFailures.
	expect(result.details.outcome).toBe("success");
	expect(result.isError).toBeUndefined();
	expect(result.content).toStrictEqual([{ type: "text", text: "child result" }]);
	expect(result.details.teardownFailures).toContain("event unsubscribe failed: unsubscribe exploded");
	expect(rows).toStrictEqual([["spawn-unsub-throw", "test", "mock-model", usageFixtureUsd(0.25)]]);
	assertChildRegistriesCleared(state);
});

test.each([
	["the notifier succeeds", false],
	["the notifier throws", true],
])("an unsubscribe throw warns once via the UI and keeps the reply when %s", async (_, notifyThrows) => {
	const notifications: [string, string | undefined][] = [];
	const notify = vi.fn((message: string, level?: string) => {
		notifications.push([message, level]);
		if (notifyThrows) {
			throw new Error("notify exploded");
		}
	});
	const state = createState();
	const session = mockSessionFactory({
		subscribe: () => () => {
			throw new Error("unsubscribe exploded");
		},
		prompt: () => Promise.resolve(),
	});
	const result = await runSpawn({
		state,
		sink: () => undefined,
		notify,
		factory: () => Promise.resolve(sessionResult(session)),
	});
	expect(result.details.outcome).toBe("success");
	expect(result.content).toStrictEqual([{ type: "text", text: "child result" }]);
	expect(notifications).toStrictEqual([["Spawn teardown failed: event unsubscribe failed: unsubscribe exploded", "warning"]]);
	expect(result.details.teardownFailures).toContain("event unsubscribe failed: unsubscribe exploded");
	expect(notify).toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});

test("bidi and zero-width characters are stripped from teardown reports", async () => {
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw new Error("a\u202eb\u202c\u200b");
		},
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	// U+202E (right-to-left override) and U+200B (zero-width space) distort or hide text;
	// both must be dropped so the report cannot spoof its own order.
	expect(result.content[0].text).toBe("session dispose failed: ab");
	expect(hasControlChars(result.content[0].text)).toBe(false);
	assertChildRegistriesCleared(state);
});

test("an all-escape diagnostic names a placeholder instead of an empty reason", async () => {
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw new Error("\x1b[31m\x1b[0m");
		},
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	expect(result.content[0].text).toBe("session dispose failed: (no details)");
	assertChildRegistriesCleared(state);
});

test("diagnostic truncation keeps an astral pair intact", async () => {
	// 199 a's + an astral emoji + tails: 201 UTF-16 units exceed the 200-unit cap, and cutting
	// on code points keeps the emoji whole instead of splitting its surrogate pair.
	const long = "a".repeat(199) + "😀" + "b".repeat(6);
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw new Error(long);
		},
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	const text = result.content[0].text;
	expect(text.startsWith("session dispose failed: ")).toBe(true);
	const suffix = text.slice("session dispose failed: ".length);
	expect(Array.from(suffix).slice(-2)).toStrictEqual(["😀", "…"]);
	// No lone surrogate survives the cut.
	expect(suffix).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	assertChildRegistriesCleared(state);
});

test("control characters are stripped from teardown reports", async () => {
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw new Error("\x1b[31mred\x1b[0m\x1b");
		},
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	// The dispose throw (with ANSI escapes and a bare ESC) must surface as visible text only: no
	// control bytes and no leftover ANSI fragments like "[31m".
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toBe("session dispose failed: red");
	expect(result.content[0].text).not.toContain("[31m");
	expect(hasControlChars(result.content[0].text)).toBe(false);
	assertChildRegistriesCleared(state);
});

test("a primary error keeps its newline in the result text", async () => {
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => {
			throw new Error("first\nsecond");
		},
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	assertErrorResult(result, "first\nsecond", EMPTY_CHILD_USAGE);
	assertChildRegistriesCleared(state);
});

test("the Child agent failed line keeps Pi's errorMessage verbatim", async () => {
	const state = createState();
	const session = mockSessionFactory({
		result: [
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "err\nsecond line",
			},
		],
	});
	const result = await runSpawn({ state, factory: () => Promise.resolve(sessionResult(session)) });

	assertErrorResult(result, "Child agent failed: err\nsecond line", EMPTY_CHILD_USAGE);
	assertChildRegistriesCleared(state);
});

test("an abort reason survives verbatim in the aborted result text", async () => {
	const state = createState();
	const controller = new AbortController();
	controller.abort(new Error("stopped\nreason"));
	const session = mockSessionFactory();
	const result = await runSpawn({ state, signal: controller.signal, factory: () => Promise.resolve(sessionResult(session)) });

	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("Child agent aborted: stopped\nreason");
	assertChildRegistriesCleared(state);
});

test("an aborted child leaves a correctly-keyed sink row and never emits unhandledRejection", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const controller = new AbortController();
		let promptStarted!: () => void;
		let rejectPrompt!: (err: Error) => void;
		const started = new Promise<void>((resolve) => {
			promptStarted = resolve;
		});
		const session = mockSessionFactory({
			prompt: async () => {
				promptStarted();
				await new Promise<void>((_, reject) => {
					rejectPrompt = reject;
				});
			},
			abort: () => {
				rejectPrompt(Object.assign(new Error("aborted"), { name: "AbortError" }));
				// Non-stringable rejection: the reporter must observe it, never an unhandledRejection.
				return new Promise<never>(() => {
					throw Object.create(null);
				});
			},
			getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
		});
		const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
		const execution = executeSpawn(
			"spawn-aborted-sink",
			pi,
			spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
			state,
			{ prompt: "Do the task" },
			controller.signal,
			undefined,
			"medium",
			() => Promise.resolve(sessionResult(session)),
		);
		await started;
		controller.abort();
		const result = await execution;
		// Cross the next event-loop turn so any detached rejection microtask has flushed.
		await new Promise((resolve) => setImmediate(resolve));

		expect(result.details.outcome).toBe("aborted");
		expect(rows).toStrictEqual([["spawn-aborted-sink", "test", "mock-model", result.usage]]);
		expect(unhandled).toHaveLength(0);
		assertChildRegistriesCleared(state);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a failed child leaves a correctly-keyed sink row", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		prompt: () => {
			throw new Error("prompt failed");
		},
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-error-sink",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	expect(result.details.outcome).toBe("error");
	expect(rows).toStrictEqual([["spawn-error-sink", "test", "mock-model", result.usage]]);
	assertChildRegistriesCleared(state);
});

test("an unreadable child entry list never writes a zero ledger row and preserves live rows", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	let handler: ((event: unknown) => void) | undefined;
	let readable = true;
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => {
				handler = undefined;
			};
		},
		prompt: () => Promise.resolve(),
		// The live flush reads entries once; later reads (settle flush, final stats) throw, so
		// the settle must skip the sink instead of writing a zero row.
		getEntries: () => {
			if (readable) {
				readable = false;
				return [assistantMessageEntry("a1", "test", "mock-model", 0.25)];
			}
			throw new Error("entries unreadable");
		},
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-unreadable-entries",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	await vi.waitFor(() => handler !== undefined);
	assertPresent(handler);
	// A live flush over readable entries lands one real row: $0.25, not zero.
	handler({ type: "message_end", message: { role: "assistant", usage: undefined } });
	const result = await execution;

	// Only the live row remains — the unreadable settle skipped the write — keyed by tool-call
	// id with the real total; the final accounting degrades visibly instead.
	expect(rows).toStrictEqual([["spawn-unreadable-entries", "test", "mock-model", usageFixtureUsd(0.25)]]);
	expect(result.details.statsUnavailable).toBe(true);
	expect(result.details.stats).toBeUndefined();
	assertChildRegistriesCleared(state);
});

test("each sink flush replaces the toolCallId row with cumulative usage", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	let handler: ((event: unknown) => void) | undefined;
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => {
				handler = undefined;
			};
		},
		prompt: () => Promise.resolve(),
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-replaces",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	await vi.waitFor(() => handler !== undefined);
	const emit = handler;
	assertPresent(emit);
	// Two live flushes over unchanged entries plus the settle flush must each deliver the same
	// cumulative total; a replacing host never multiplies the child's spend.
	emit({ type: "message_end", message: { role: "assistant", usage: undefined } });
	emit({ type: "message_end", message: { role: "assistant", usage: undefined } });
	const result = await execution;

	expect(rows).toHaveLength(3);
	for (const [, , , usage] of rows) {
		expect(usage).toStrictEqual(usageFixtureUsd(0.25));
	}
	expect(rows[2][3]).toStrictEqual(result.usage);
	// A retained subscriber delivering message_end after settle is inert: the settled row stands.
	emit({ type: "message_end", message: { role: "assistant", usage: usageFixtureUsd(9) } });
	expect(rows).toHaveLength(3);
	assertChildRegistriesCleared(state);
});

test("a message_end under a non-tool role folds no usage into the live row", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	let handler: ((event: unknown) => void) | undefined;
	const state = createState();
	state.childUsageSink = {
		owner: "test-run",
		sink: (toolCallId, provider, model, usage) => {
			rows.push([toolCallId, provider, model, usage]);
		},
	};
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => {
				handler = undefined;
			};
		},
		prompt: () => Promise.resolve(),
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-fold-gate",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	await vi.waitFor(() => handler !== undefined);
	const emit = handler;
	assertPresent(emit);
	// No ending-message role other than assistant/tool-result folds usage onto the child row.
	for (const role of ["user", "system", "custom"] as const) {
		emit({ type: "message_end", message: { role, usage: usageFixtureUsd(9) } });
	}
	await execution;

	expect(rows).toHaveLength(4);
	for (const [, , , usage] of rows) {
		expect(usage).toStrictEqual(usageFixtureUsd(0.25));
	}
	assertChildRegistriesCleared(state);
});

test("a live flush that throws undefined degrades with the failure named", async () => {
	let handler: ((event: unknown) => void) | undefined;
	const state = createState();
	const sink = () => {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- a thrown undefined must survive
		throw undefined;
	};
	const session = mockSessionFactory({
		subscribe: (listener) => {
			handler = listener;
			return () => undefined;
		},
		getEntries: () => [assistantMessageEntry("a1", "test", "mock-model", 0.25)],
	});
	const execution = runSpawn({ state, sink, factory: () => Promise.resolve(sessionResult(session)) });
	await vi.waitUntil(() => handler !== undefined);
	assertPresent(handler);
	handler({ type: "message_end", message: { role: "assistant", usage: undefined } });
	const result = await execution;

	// A thrown undefined is retained and named; the child reply stands and the outcome is preserved.
	expect(result).not.toHaveProperty("isError");
	expect(result.content[0].text).toBe("child result");
	expect(result.details).toMatchObject({ outcome: "success", teardownFailures: ["spend flush failed: undefined"] });
	assertChildRegistriesCleared(state);
});

test("headless spawn aggregates every teardown failure without a primary failure", async () => {
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw new Error("dispose failed");
		},
	});
	assertErrorResult(
		await runSpawn({
			state,
			sink: () => {
				throw new Error("sink boom");
			},
			factory: () => Promise.resolve(sessionResult(session)),
		}),
		"spend flush failed: sink boom; session dispose failed: dispose failed",
		EMPTY_CHILD_USAGE,
	);
	assertChildRegistriesCleared(state);
});
const failingRun = (notify?: Parameters<typeof executeWithFailingCleanup>[2]) =>
	executeWithFailingCleanup(new Error("prompt failed"), new Error("dispose failed"), notify, () => {
		throw new Error("sink boom");
	});
test("UI spawn notifies the combined teardown text once", async () => {
	const notifications: [string, string | undefined][] = [];
	const { execution, state } = await failingRun((message, level) => {
		notifications.push([message, level]);
	});
	const result = await execution;
	assertErrorResult(result, "prompt failed", EMPTY_CHILD_USAGE);
	expect(notifications).toStrictEqual([["Spawn teardown failed: spend flush failed: sink boom; session dispose failed: dispose failed", "error"]]);
	// The notice shown, but the failures still belong to the result details, not only the toast.
	expect(result.details.teardownFailures).toStrictEqual(["spend flush failed: sink boom", "session dispose failed: dispose failed"]);
	assertChildRegistriesCleared(state);
});
test("a throwing cleanup notice falls through to a throw that keeps every failure", async () => {
	const notify = vi.fn(() => {
		throw new Error("notify exploded");
	});
	const { execution, state } = await failingRun(notify);
	assertErrorResult(
		await execution,
		"Spawn failed and cleanup failed: prompt failed; spend flush failed: sink boom; session dispose failed: dispose failed",
		EMPTY_CHILD_USAGE,
	);
	expect(notify).toHaveBeenCalledOnce();
	assertChildRegistriesCleared(state);
});
