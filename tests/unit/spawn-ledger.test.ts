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
import { createState } from "../../state.js";
import { executeSpawn, registerSpawnTool } from "../../spawn/index.js";
import {
	assertChildRegistriesCleared,
	assertErrorResult,
	executeSpawnTool,
	executeWithFailingCleanup,
	EMPTY_CHILD_USAGE,
	assistantMessageEntry,
	mockFactoryWith,
	mockSessionFactory,
	sessionResult,
	spawnContext,
	usageFixtureUsd,
} from "./helpers.js";
import { createTestHost } from "./test-host.js";

function hasControlChars(text: string): boolean {
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			return true;
		}
	}
	return false;
}

/** Run a headless spawn of `session` under `state`; `signal` drives the abort path and `notify` feeds the UI. */
async function runSpawn(
	state: ReturnType<typeof createState>,
	session: ReturnType<typeof mockSessionFactory>,
	signal?: AbortSignal,
	notify?: (message: string, level?: string) => void,
) {
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	return executeSpawn(
		"spawn-sanitize",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp", ...(notify ? { notify } : {}) }),
		state,
		{ prompt: "Do the task" },
		signal,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);
}

test("spawn flushes child spend to the run sink keyed by tool-call id", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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

test("a sink installed after the run started receives no child spend", async () => {
	const lateRows: unknown[] = [];
	const state = createState();
	const session = mockSessionFactory({
		prompt: () => {
			state.childUsageSink = (toolCallId, provider, model, usage) => {
				lateRows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rowsA.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rowsB.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = () => {
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
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-sink-throw",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);
	// The live message_end flush throws first; it must be retained — never propagated into the
	// host dispatch — then reported at settle alongside the settle flush failure.
	await vi.waitFor(() => handler !== undefined);
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
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });

	const noSinkResult = await executeSpawn(
		"spawn-no-sink",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		createState(),
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);
	expect(noSinkResult.details.outcome).toBe("success");
	expect(subscribe, "no sink, no subscription").not.toHaveBeenCalled();

	const state = createState();
	state.childUsageSink = () => undefined;
	const withSinkResult = await executeSpawn(
		"spawn-with-sink",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);
	expect(withSinkResult.details.outcome).toBe("success");
	expect(subscribe, "sink installed, subscription installed").toHaveBeenCalledOnce();
});

test("a child event subscription failure keeps the settled stats without a UI", async () => {
	const state = createState();
	state.childUsageSink = () => undefined;
	const session = mockSessionFactory({
		subscribe: () => {
			throw new Error("subscribe exploded");
		},
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-sub-fail",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

	// A failing subscribe loses live flushes only; it never fails the spawn, reports the degraded
	// subscription in details.teardownFailures even headless, and the settled stats are still
	// computed at settle (statsUnavailable stays reserved for genuinely unsummable entries).
	expect(result.details.outcome).toBe("success");
	expect(result.details.teardownFailures).toContain("Spawn event subscription failed: subscribe exploded");
	expect(result.details.stats).toBeDefined();
	expect(result.details.statsUnavailable).toBeUndefined();
	assertChildRegistriesCleared(state);
});

test("a child event subscription failure notifies when a UI is present and the spawn continues", async () => {
	const notifications: [string, string | undefined][] = [];
	const state = createState();
	state.childUsageSink = () => undefined;
	const session = mockSessionFactory({
		subscribe: () => {
			throw new Error("subscribe exploded");
		},
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-sub-fail-ui",
		pi,
		spawnContext({
			model: { id: "mock-model" },
			cwd: "/tmp",
			notify: (message, level) => {
				notifications.push([message, level]);
			},
		}),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);
	expect(result.details.outcome).toBe("success");
	expect(notifications).toStrictEqual([["Spawn teardown failed: Spawn event subscription failed: subscribe exploded", "warning"]]);
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
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-falsy-dispose",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = () => undefined;
	const session = mockSessionFactory({
		subscribe: () => () => {
			throw new Error("unsubscribe exploded");
		},
		prompt: () => Promise.resolve(),
	});
	const result = await runSpawn(state, session, undefined, notify);
	expect(result.details.outcome).toBe("success");
	expect(result.content).toStrictEqual([{ type: "text", text: "child result" }]);
	expect(notifications).toStrictEqual([["Spawn teardown failed: event unsubscribe failed: unsubscribe exploded", "warning"]]);
	expect(result.details.teardownFailures).toContain("event unsubscribe failed: unsubscribe exploded");
	expect(notify).toHaveBeenCalledOnce();
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
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const result = await executeSpawn(
		"spawn-ctrl-report",
		pi,
		spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		() => Promise.resolve(sessionResult(session)),
	);

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
	const result = await runSpawn(state, session);

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
	const result = await runSpawn(state, session);

	assertErrorResult(result, "Child agent failed: err\nsecond line", EMPTY_CHILD_USAGE);
	assertChildRegistriesCleared(state);
});

test("an abort reason survives verbatim in the aborted result text", async () => {
	const state = createState();
	const controller = new AbortController();
	controller.abort(new Error("stopped\nreason"));
	const session = mockSessionFactory();
	const result = await runSpawn(state, session, controller.signal);

	expect(result.details.outcome).toBe("aborted");
	expect(result.content[0].text).toBe("Child agent aborted: stopped\nreason");
	assertChildRegistriesCleared(state);
});

test("an aborted child leaves a correctly-keyed sink row and never emits unhandledRejection", async () => {
	const rows: [string, string | null, string, unknown][] = [];
	const state = createState();
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = (toolCallId, provider, model, usage) => {
		rows.push([toolCallId, provider, model, usage]);
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
	state.childUsageSink = () => {
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
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	const execution = executeSpawn(
		"spawn-flush-undefined",
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
	state.childUsageSink = () => {
		throw new Error("sink boom");
	};
	const session = mockSessionFactory({
		prompt: () => Promise.resolve(),
		dispose: () => {
			throw new Error("dispose failed");
		},
	});
	const pi = await createTestHost(vi.fn(), { activeTools: ["read", "bash", "spawn"] });
	assertErrorResult(
		await executeSpawn(
			"spawn-cleanup-only",
			pi,
			spawnContext({ model: { id: "mock-model" }, cwd: "/tmp" }),
			state,
			{ prompt: "Do the task" },
			undefined,
			undefined,
			"medium",
			() => Promise.resolve(sessionResult(session)),
		),
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
