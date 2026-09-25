import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Text } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createState, resetState, invalidateHandoffState } from "../../state.js";
import { registerNotebookRehydration, reconstructNotebook } from "../../notebook/rehydration.js";
import { commitNotebookDiscard, prepareNotebookDiscard, saveNotebookPage, resetNotebookWriteLock } from "../../notebook/store.js";
import { createNotebookToolDefinitions } from "../../notebook/tools.js";
import { __setSingletons, createWriteLock, getSingletons } from "../../runtime-singletons.js";
import { STATUS_KEY_TOPIC, WIDGET_KEY_WARNING } from "../../tui.js";
import { makeTUICtx, createDeferred, theme, stripAnsi } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import type { TestPI } from "./test-host.js";

function persistedBranch(pi: TestPI): object[] {
	return pi.appendedEntries.map(({ customType, data }) => ({
		type: "custom",
		customType,
		data,
	}));
}

async function rehydratePersistedNotebook(pi: TestPI) {
	const state = createState();
	const restoredPi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = restoredPi.handlers.get("session_start")!;
	await handler({}, { sessionManager: { getBranch: () => persistedBranch(pi) } });
	return state;
}

// ── Notebook rehydration tests ────────────────────────────────────────

test("notebook rehydration rebuilds the latest epoch and enables notebook tools", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "ledger-entry", data: { epoch: 1, name: "old", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 2, name: "keep", content: "new" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 2, name: "keep", content: "newer" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 2);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["keep", "newer"]]);
	assert.deepEqual(pi.activeTools, ["notebook_read", "notebook_index"]);
});


test("notebook rehydration rebuilds from the latest persisted epoch and avoids duplicate active tools", async () => {
	const state = createState();
	state.epoch = 7;
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state), { activeTools: ["read", "notebook_read", "notebook_index"] });
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "notebook-entry", data: { epoch: 6, name: "stale", content: "old" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 7, name: "keep", content: "fresh" } },
					{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "future", content: "latest" } },
				],
			},
		},
	);

	assert.equal(state.epoch, 8);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["future", "latest"]]);
	assert.deepEqual(pi.activeTools, ["read", "notebook_read", "notebook_index"]);
});


test("notebook rehydration clears stale in-memory notebook state when persisted history is empty", async () => {
	const state = createState();
	state.epoch = 7;
	state.notebookPages.set("stale", "stale body");
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [],
			},
		},
	);

	assert.equal(state.epoch, 0);
	assert.deepEqual(Array.from(state.notebookPages.entries()), []);
	assert.deepEqual(pi.activeTools, ["notebook_read", "notebook_index"]);
});

test("notebook rehydration ignores null and malformed branch entries", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [
					null,
					undefined,
					"bad-string",
					{ type: "custom", customType: "notebook-entry", data: { epoch: 1, name: "keep", content: "valid" } },
					null,
					{ customType: "notebook-entry" },
				],
			},
		},
	);

	assert.equal(state.epoch, 1);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["keep", "valid"]]);
});

test("future-version notebook entries have zero effect on rehydrated state", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;

	// Real writes through the real store (both land at epoch 1).
	await saveNotebookPage(pi as any, state, "current", "ok");
	await saveNotebookPage(pi as any, state, "other", "old");

	// Simulate a future-format writer through the real persistence API. No
	// existing writer emits version 2, so the version discriminator is the
	// only synthetic field; envelope and payload match a real future entry.
	pi.appendEntry("notebook-generation", { version: 2, epoch: 9 });
	pi.appendEntry("notebook-entry", { version: 2, epoch: 9, name: "future", content: "x" });

	await handler({}, { sessionManager: { getBranch: () => persistedBranch(pi) } });

	// Generation marker site: the future epoch 9 must not be adopted.
	assert.equal(state.epoch, 1);
	// Watermark site: the future page's epoch 9 must not inflate the discard watermark.
	assert.equal(state.discardEpochWatermark, 1);
	// Candidate site: the future page is absent and valid pages survive (skip, not abort).
	assert.deepEqual(Array.from(state.notebookPages.entries()).sort(), [
		["current", "ok"],
		["other", "old"],
	]);
});

test("pre-versioned entries without a version field rehydrate on parity", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;

	// Real writes through the real store, then strip the version discriminator
	// to reproduce a pre-versioned branch: same envelope and fields, no version.
	await saveNotebookPage(pi as any, state, "legacy", "old");
	await saveNotebookPage(pi as any, state, "current", "new");
	const branch = persistedBranch(pi);
	delete (branch[0] as { data: { version?: unknown } }).data.version;

	await handler({}, { sessionManager: { getBranch: () => branch } });

	assert.equal(state.epoch, 1);
	assert.equal(state.discardEpochWatermark, 1);
	assert.deepEqual(Array.from(state.notebookPages.entries()).sort(), [
		["current", "new"],
		["legacy", "old"],
	]);
});

test("session_start rehydrates the latest persisted notebook state through the full hook chain", async () => {
	const pi = await createTestHost(undefined, { activeTools: ["read", "notebook_read"] });

	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute(
		"seed",
		{ name: "stale-page", content: "stale body" },
		undefined,
		undefined,
		makeTUICtx({ hasUI: false }),
	);

	const sessionStartHandlers = pi.handlers.get("session_start")!;
	const ctx = {
		hasUI: false,
		getContextUsage: () => null,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "notebook-entry", data: { epoch: 6, name: "stale", content: "old" } },
				{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "keep", content: "fresh" } },
				{ type: "custom", customType: "notebook-entry", data: { epoch: 8, name: "keep", content: "newer" } },
			],
		},
	};
	for (const sessionStart of sessionStartHandlers) {
		await sessionStart({ reason: "resume" }, ctx as any);
	}

	const notebookIndex = pi.tools.get("notebook_index");
	const notebookRead = pi.tools.get("notebook_read");
	const indexResult = await notebookIndex.execute("1", {}, undefined, undefined, {} as any);
	assert.deepEqual(indexResult.details.entries, ["keep"]);

	const readResult = await notebookRead.execute("2", { name: "keep" }, undefined, undefined, {} as any);
	assert.equal(readResult.details.found, true);
	assert.equal(readResult.details.body, "newer");
	assert.deepEqual(pi.activeTools, ["read", "notebook_read", "notebook_index"]);
});

// ── Notebook tool contract tests ──────────────────────────────────────

test("notebook tools add/get/list return stable contract details", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addResult = await notebookWrite.execute("1", { name: "entry-a", content: "first line\nsecond line" }, undefined, undefined, {} as any);
	assert.deepEqual(addResult.details, { entries: ["entry-a"], preview: "first line" });
	assert.equal(state.notebookPages.get("entry-a"), "first line\nsecond line");
	assert.equal(pi.appendedEntries.length, 1);
	assert.equal(pi.appendedEntries[0].customType, "notebook-entry");
	assert.equal(pi.appendedEntries[0].data.name, "entry-a");

	const getResult = await notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any);
	const details = getResult.details as { found: boolean; entries: string[] };
	assert.equal(details.found, true);
	assert.deepEqual(details.entries, ["entry-a"]);
	assert.match((getResult.content[0] as any).text, /--- entry-a ---/);
	assert.match((getResult.content[0] as any).text, /second line/);

	const listResult = await notebookIndex.execute("3", {}, undefined, undefined, {} as any);
	assert.deepEqual(listResult.details, { entries: ["entry-a"] });
	assert.match((listResult.content[0] as any).text, /entry-a: first line/);
});

test("child notebook tools reject stale access after reset", async () => {
	const pi = await createTestHost();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	let stale = false;
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state, { isStale: () => stale });

	stale = true;
	await assert.rejects(
		() => notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	await assert.rejects(
		() => notebookIndex.execute("3", {}, undefined, undefined, {} as any),
		/invalidated by reset/i,
	);
	assert.equal(state.notebookPages.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 0);
});

test("child notebook_write succeeds while child session is fresh", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state, { isStale: () => false });

	const result = await notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "alpha" });
	assert.equal(state.notebookPages.get("entry-a"), "alpha");
	assert.equal(pi.appendedEntries.length, 1);
});

test("notebook_read reports not found with current page names", async () => {
	const pi = await createTestHost();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	state.notebookPages.set("entry-b", "beta");
	const [, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	const result = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(result.details, { entries: ["entry-a", "entry-b"], found: false });
	assert.match((result.content[0] as any).text, /Notebook page "missing" not found\./);
	assert.match((result.content[0] as any).text, /Notebook Pages:\n/);
	assert.match((result.content[0] as any).text, /entry-a: alpha/);
	assert.match((result.content[0] as any).text, /entry-b: beta/);
});

test("notebook tools show empty-state placeholders", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const missing = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	assert.deepEqual(missing.details, { entries: [], found: false });
	assert.match((missing.content[0] as any).text, /Notebook Pages:\n\(empty\)/);

	const list = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	assert.deepEqual(list.details, { entries: [] });
	assert.match((list.content[0] as any).text, /Notebook Pages:\n\(empty\)/);
});

test("notebook_write pushes onUpdate and refreshes UI indicators", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	let update: any;

	const result = await notebookWrite.execute(
		"1",
		{ name: "entry-a", content: "first line\nsecond line" },
		undefined,
		(payload: any) => { update = payload; },
		makeTUICtx({ percent: 42, record }),
	);

	assert.equal((update.content[0] as any).text, 'Saved "entry-a": first line');
	assert.deepEqual(update.details, { entries: ["entry-a"], preview: "first line" });
	assert.equal(record.statuses.get("pi-schematic-notebook"), "📒 1");
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "first line" });
});

test("notebook tool renderers expose stable call/result summaries", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addCall = notebookWrite.renderCall!({ name: "entry-a", content: "first line\nsecond line" }, theme, {} as any) as Text;
	assert.match(stripAnsi(addCall.render(120).join("\n")), /notebook_write "entry-a": first line/);

	const addResult = notebookWrite.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a"], preview: "first line" } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a", content: "first line\nsecond line" } } as any,
	) as Text;
	assert.match(stripAnsi(addResult.render(120).join("\n")), /Saved "entry-a": first line/);
	assert.match(stripAnsi(addResult.render(120).join("\n")), /entry-a/);

	const getResult = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body" } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResult.render(120).join("\n")), /"entry-a"/);
	assert.match(stripAnsi(getResult.render(120).join("\n")), /body/);

	const getResultWithDelimiters = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "line 1\n---\nline 2" } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResultWithDelimiters.render(120).join("\n")), /line 1/);
	assert.match(stripAnsi(getResultWithDelimiters.render(120).join("\n")), /line 2/);

	const listResult = notebookIndex.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a", "entry-b"] } },
		{ expanded: true, isPartial: false },
		theme,
		{} as any,
	) as Text;
	assert.match(stripAnsi(listResult.render(120).join("\n")), /2 pages/);
	assert.match(stripAnsi(listResult.render(120).join("\n")), /entry-a/);
	assert.match(stripAnsi(listResult.render(120).join("\n")), /entry-b/);
});

// ── Notebook command / overlay tests ──────────────────────────────────

test("/notebook exits cleanly when headless", async () => {
	const pi = await createTestHost();

	await assert.doesNotReject(() => pi.commands.get("notebook")!.handler("", { hasUI: false }));
});


test("/notebook <topic> notifies with info on first set and warning on boundary change", async () => {
	const pi = await createTestHost();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const ctx = {
		hasUI: true,
		getContextUsage: () => ({ percent: 20 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			setStatus: (key: string, status: string | undefined) => { statuses.set(key, status); },
			setWidget: (key: string, content: string[] | undefined) => { widgets.set(key, content); },
		},
	};

	await pi.commands.get("notebook")!.handler("oauth", ctx as any);
	await pi.commands.get("notebook")!.handler("billing", ctx as any);

	assert.deepEqual(notifications[0], { message: "Active notebook topic: oauth", level: "info" });
	assert.match(notifications[1].message, /Active notebook topic changed: oauth → billing/);
	assert.equal(notifications[1].level, "warning");
	assert.equal(statuses.get(STATUS_KEY_TOPIC), "🧭 billing");
	assert.equal(widgets.get(WIDGET_KEY_WARNING), undefined);
});

test("readonly /notebook boundary notification explains deferred handoff eligibility", async () => {
	const pi = await createTestHost();
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		hasUI: true,
		getContextUsage: () => ({ percent: 20 }),
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			setStatus: () => {},
			setWidget: () => {},
		},
	};

	await pi.commands.get("readonly")!.handler("", ctx as any);
	await pi.commands.get("notebook")!.handler("oauth", ctx as any);
	await pi.commands.get("notebook")!.handler("billing", ctx as any);

	assert.match(notifications.at(-1)?.message ?? "", /handoff exception activates.*once the context is ready/i);
	assert.match(notifications.at(-1)?.message ?? "", /until then this boundary is advisory/i);
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /ask the user for an explicit \/handoff/i);
});


test("/notebook empty overlay renders empty state and closes on input", async () => {
	const pi = await createTestHost();
	let overlay: any;
	let doneCalls = 0;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	assert.match(lines, /Notebook \(0 pages\)/);
	assert.match(lines, /\(empty\) — use notebook_write to create pages/);
	overlay.handleInput("x");
	assert.equal(doneCalls, 1);
});

test("/notebook selection previews the chosen entry", async () => {
	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body line\nsecond line" }, undefined, undefined, makeTUICtx());
	let overlay: any;
	let doneCalls = 0;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			},
		},
	});

	// First Enter selects the entry — shows body inline, done() not yet called
	overlay.handleInput("\r");
	assert.equal(doneCalls, 0, "body shown inline, overlay stays open");
	const bodyLines = stripAnsi(overlay.render(120).join("\n"));
	assert.match(bodyLines, /body line/);
	assert.match(bodyLines, /alpha/);
	// Second keypress closes the overlay
	overlay.handleInput("\r");
	assert.equal(doneCalls, 1);
});

test("/notebook overlay sorts entries consistently", async () => {
	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "zeta", content: "last" }, undefined, undefined, makeTUICtx());
	await notebookWrite.execute("2", { name: "alpha", content: "first" }, undefined, undefined, makeTUICtx());
	let overlay: any;

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, () => {});
			},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	assert.ok(lines.indexOf("alpha") < lines.indexOf("zeta"), lines);
});

// ── saveNotebookPage tests ────────────────────────────────────────────

test("saveNotebookPage serializes concurrent writes and preserves completion order", async () => {
	const pi = await createTestHost();
	const state = createState();
	const firstGate = createDeferred();
	const order: string[] = [];

	const first = saveNotebookPage(pi as any, state, "entry-a", "first", async () => {
		order.push("first:start");
		await firstGate.promise;
		order.push("first:end");
	});
	const second = saveNotebookPage(pi as any, state, "entry-a", "second", async () => {
		order.push("second:start");
	});

	await Promise.resolve();
	assert.deepEqual(order, ["first:start"]);
	firstGate.resolve();
	await Promise.all([first, second]);

	assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
	assert.equal(state.notebookPages.get("entry-a"), "second");
	assert.deepEqual(pi.appendedEntries.map((entry) => entry.data.content), ["first", "second"]);
});

test("saveNotebookPage keeps write order across runtime singleton swaps", async () => {
	const pi = await createTestHost();
	const state = createState();
	const previousSingletons = getSingletons();
	const firstGate = createDeferred();
	const order: string[] = [];

	try {
		const first = saveNotebookPage(pi as any, state, "entry-a", "first", async () => {
			order.push("first:start");
			await firstGate.promise;
			order.push("first:end");
		});
		await Promise.resolve();

		__setSingletons({
			writeLock: createWriteLock(),
			writeContext: new AsyncLocalStorage<true>(),
			frameScheduler: getSingletons().frameScheduler,
		});
		const second = saveNotebookPage(pi as any, state, "entry-a", "second", async () => {
			order.push("second:start");
		});

		await Promise.resolve();
		assert.deepEqual(order, ["first:start"]);
		firstGate.resolve();
		await Promise.all([first, second]);

		assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
		assert.equal(state.notebookPages.get("entry-a"), "second");
	} finally {
		firstGate.resolve();
		resetNotebookWriteLock();
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage rejects true reentrancy explicitly", async () => {
	const pi = await createTestHost();
	const state = createState();

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "outer", "outer", async () => {
			await saveNotebookPage(pi as any, state, "inner", "inner");
		}),
		/not reentrant/i,
	);
	assert.equal(state.notebookPages.size, 0);
});

test("saveNotebookPage stays non-reentrant across runtime singleton swaps", async () => {
	const pi = await createTestHost();
	const state = createState();
	const previousSingletons = getSingletons();

	try {
		await assert.rejects(
			() => Promise.race([
				saveNotebookPage(pi as any, state, "outer", "outer", async () => {
					__setSingletons({
						writeLock: createWriteLock(),
						writeContext: new AsyncLocalStorage<true>(),
						frameScheduler: getSingletons().frameScheduler,
					});
					await saveNotebookPage(pi as any, state, "inner", "inner");
				}),
				new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error("timeout")), 1000);
				}),
			]),
			/not reentrant/i,
		);
		assert.equal(state.notebookPages.size, 0);
	} finally {
		resetNotebookWriteLock();
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage releases the lock when assertWritable throws", async () => {
	const pi = await createTestHost();
	const state = createState();

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "broken", "value", async () => {
			throw new Error("blocked");
		}),
		/blocked/,
	);
	await assert.doesNotReject(() => saveNotebookPage(pi as any, state, "fresh", "value"));
	assert.equal(state.notebookPages.get("fresh"), "value");
});

test("resetNotebookWriteLock clears abandoned lock state for later writes", async () => {
	const pi = await createTestHost();
	const state = createState();
	const gate = createDeferred();
	void saveNotebookPage(pi as any, state, "stuck", "value", async () => {
		await gate.promise;
	});
	await Promise.resolve();
	resetNotebookWriteLock();

	await assert.doesNotReject(() => saveNotebookPage(pi as any, state, "fresh", "value"));
	assert.equal(state.notebookPages.get("fresh"), "value");
	gate.resolve();
});


test("saveNotebookPage truncates oversized content before persisting", async () => {
	const pi = await createTestHost();
	const state = createState();
	const content = "first line\n" + "detail\n".repeat(3000);

	const result = await saveNotebookPage(pi as any, state, "large-page", content);
	const persisted = pi.appendedEntries[0].data.content;

	assert.ok(persisted.length < content.length, "oversized notebook content should be truncated");
	assert.equal(state.notebookPages.get("large-page"), persisted);
	assert.equal(result.preview, "first line");
	assert.match(persisted, /^first line/m);
});


test("resetState clears epoch and the next notebook write starts a fresh generation", async () => {
	const pi = await createTestHost();
	const state = createState();

	await saveNotebookPage(pi as any, state, "entry-a", "first");
	await saveNotebookPage(pi as any, state, "entry-b", "second");
	assert.equal(state.epoch, 1);
	assert.equal(pi.appendedEntries[0].data.epoch, 1);
	assert.equal(pi.appendedEntries[1].data.epoch, 1);

	resetState(state);
	assert.equal(state.epoch, 0);

	await saveNotebookPage(pi as any, state, "entry-c", "third");
	assert.equal(state.epoch, 1);
	assert.equal(pi.appendedEntries[2].data.epoch, 1);
});

// ── Notebook tool definition metadata tests ───────────────────────────

test("notebook tool definitions include prompt hints when withPromptHints is true", async () => {
	const pi = await createTestHost();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi as any, state, { withPromptHints: true });

	for (const tool of tools) {
		assert.ok(typeof tool.promptSnippet === "string", `${tool.name} should have promptSnippet when withPromptHints=true`);
		assert.ok(Array.isArray(tool.promptGuidelines), `${tool.name} should have promptGuidelines when withPromptHints=true`);
	}
	const notebookWrite = tools.find(t => t.name === "notebook_write")!;
	const notebookRead = tools.find(t => t.name === "notebook_read")!;
	const notebookIndex = tools.find(t => t.name === "notebook_index")!;

	// Structural invariants: all guidelines exist and are non-trivial
	for (const tool of tools) {
		assert.ok(tool.promptGuidelines!.length >= 2, `${tool.name} should have at least 2 promptGuidelines`);
		assert.ok(tool.promptGuidelines!.every((g: string) => g.length > 10), `${tool.name} each guideline should be non-trivial`);
	}

	// Conceptual: notebook_write is future-context oriented
	const writeGuidelines = notebookWrite.promptGuidelines!.join(" ");
	assert.match(writeGuidelines, /subject-oriented pages/i);
	assert.match(writeGuidelines, /fresh context/i);
	assert.match(writeGuidelines, /belongs in handoff/i);
	assert.match(notebookIndex.promptGuidelines!.join(" "), /relevant memory pages/i);

	// Conceptual: descriptions mention the notebook-page metaphor and durable memory contract
	assert.match(notebookWrite.description, /page|future contexts/i);
	assert.match(JSON.stringify(notebookWrite.parameters), /high-value knowledge/i);
	assert.doesNotMatch(JSON.stringify(notebookWrite.parameters), /grounding/i);
	assert.match(notebookRead.description, /notebook page|page/i);
	assert.match(notebookIndex.description, /notebook index|index/i);
});

test("notebook tool definitions omit prompt hints by default", async () => {
	const pi = await createTestHost();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi as any, state);

	for (const tool of tools) {
		assert.equal(tool.promptSnippet, undefined, `${tool.name} should not have promptSnippet by default`);
		assert.equal(tool.promptGuidelines, undefined, `${tool.name} should not have promptGuidelines by default`);
	}
});

// ── Transactional handoff discard tests ───────────────────────────────

test("prepared discard remains invisible to a fresh active-branch rehydration", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");

	const deleted = await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	const restored = await rehydratePersistedNotebook(pi);

	assert.deepEqual(deleted, ["page-a"]);
	assert.equal(state.epoch, 1);
	assert.deepEqual(Array.from(restored.notebookPages.entries()).sort(), [
		["page-a", "content-a"], ["page-b", "content-b"],
	]);
	assert.equal(restored.epoch, 1);
});

test("committed discard advances the active generation and persists survivors", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");

	await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	commitNotebookDiscard(pi as any, state, 1);
	const restored = await rehydratePersistedNotebook(pi);

	assert.equal(state.epoch, 2);
	assert.deepEqual(Array.from(state.notebookPages.entries()), [["page-b", "content-b"]]);
	assert.deepEqual(Array.from(restored.notebookPages.entries()), [["page-b", "content-b"]]);
	assert.deepEqual(pi.appendedEntries.filter((entry) => entry.customType === "notebook-generation").map((entry) => entry.data), [
		{ version: 1, epoch: 1 }, { version: 1, epoch: 2 },
	]);
});

test("partial survivor staging failure rehydrates the prior committed generation", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");
	await saveNotebookPage(pi as any, state, "page-c", "content-c");
	let calls = 0;
	const throwingPi = {
		...pi as any,
		appendEntry: (...args: any[]) => {
			if (++calls > 2) throw new Error("persist failed");
			(pi as any).appendEntry(...args);
		},
	};

	await assert.rejects(() => prepareNotebookDiscard(throwingPi, state, 1, ["page-a"]), /persist failed/);
	const restored = await rehydratePersistedNotebook(pi);

	assert.deepEqual(Array.from(restored.notebookPages.entries()).sort(), [
		["page-a", "content-a"], ["page-b", "content-b"], ["page-c", "content-c"],
	]);
	assert.equal(restored.epoch, 1);
});

test("rehydration uses only the active session branch", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;

	await handler({}, { sessionManager: { getBranch: () => [
		{ type: "custom", customType: "notebook-entry", data: { epoch: 1, name: "active", content: "kept" } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
	] } });

	assert.deepEqual(Array.from(state.notebookPages.entries()), [["active", "kept"]]);
});

test("failed discard retry with same set uses fresh epoch and does not resurrect orphaned survivors", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");
	await saveNotebookPage(pi as any, state, "page-c", "content-c");

	// First attempt: prepare + simulate failure (don't commit)
	const deleted1 = await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	assert.deepEqual(deleted1, ["page-a"]);
	assert.equal(state.discardEpochWatermark, 2);

	// Simulate failed handoff — clear pending discard but watermark remains
	state.pendingNotebookDiscard = null;

	// Retry with same discard set
	const deleted2 = await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	assert.deepEqual(deleted2, ["page-a"]);
	assert.equal(state.discardEpochWatermark, 3, "retry must use a higher epoch");

	// Commit the retry
	commitNotebookDiscard(pi as any, state, 1);
	assert.equal(state.epoch, 3);

	// Rehydrate: only the retry survivors at epoch 3 should appear
	const restored = await rehydratePersistedNotebook(pi);
	assert.deepEqual(Array.from(restored.notebookPages.entries()).sort(), [
		["page-b", "content-b"], ["page-c", "content-c"],
	]);
	assert.equal(restored.epoch, 3);
});

test("failed discard retry with different set uses fresh epoch", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");
	await saveNotebookPage(pi as any, state, "page-c", "content-c");

	// First attempt: discard page-a
	await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	assert.equal(state.discardEpochWatermark, 2);
	state.pendingNotebookDiscard = null; // simulate failure

	// Retry with different set: discard page-b
	await prepareNotebookDiscard(pi as any, state, 1, ["page-b"]);
	assert.equal(state.discardEpochWatermark, 3, "retry must use a higher epoch");

	commitNotebookDiscard(pi as any, state, 1);
	assert.equal(state.epoch, 3);

	const restored = await rehydratePersistedNotebook(pi);
	assert.deepEqual(Array.from(restored.notebookPages.entries()).sort(), [
		["page-a", "content-a"], ["page-c", "content-c"],
	]);
	assert.equal(restored.epoch, 3);
});

test("failed discard retry with all-pages discard uses fresh epoch", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");

	// First attempt: discard page-a
	await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	state.pendingNotebookDiscard = null; // simulate failure

	// Retry: discard everything
	await prepareNotebookDiscard(pi as any, state, 1, ["page-a", "page-b"]);
	assert.equal(state.discardEpochWatermark, 3);

	commitNotebookDiscard(pi as any, state, 1);
	assert.equal(state.epoch, 3);

	const restored = await rehydratePersistedNotebook(pi);
	assert.deepEqual(Array.from(restored.notebookPages.entries()), []);
	assert.equal(restored.epoch, 3);
});

test("branch invalidation preserves the discard watermark until reconstruction derives a fresh one", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");

	// Advance watermark via failed discard
	await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	assert.equal(state.discardEpochWatermark, 2);
	state.pendingNotebookDiscard = null; // simulate failure

	// Branch switch must not prematurely drop the watermark: a retry that reuses
	// the staged epoch would resurrect orphaned survivors.
	invalidateHandoffState(state);
	assert.equal(state.discardEpochWatermark, 2, "invalidation alone must not reset the watermark");

	// Reconstruction on the newly active branch derives the watermark from the
	// branch itself — staged survivor epochs included (restart-safe).
	reconstructNotebook(state, persistedBranch(pi) as any);
	assert.equal(state.epoch, 1, "state.epoch stays the committed epoch");
	assert.equal(state.discardEpochWatermark, 2);

	// A fresh branch with no staged survivors resets the derived watermark.
	reconstructNotebook(state, []);
	assert.equal(state.epoch, 0);
	assert.equal(state.discardEpochWatermark, 0);
});

test("resetState clears the discard watermark for a fresh session", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	assert.equal(state.discardEpochWatermark, 2);

	resetState(state);
	assert.equal(state.discardEpochWatermark, 0, "/new must reset the watermark with the session");
	assert.equal(state.epoch, 0);
});

test("restart after a failed discard derives the watermark from observed epochs and cannot resurrect orphaned survivors", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page-a", "content-a");
	await saveNotebookPage(pi as any, state, "page-b", "content-b");
	await saveNotebookPage(pi as any, state, "page-c", "content-c");

	// Failed attempt: survivors staged at epoch 2, never committed.
	await prepareNotebookDiscard(pi as any, state, 1, ["page-a"]);
	state.pendingNotebookDiscard = null; // failure path clears pending discard only

	// Restart: a fresh process state rehydrates from the persisted branch. The
	// watermark must come from the branch itself, not from lost memory.
	const restarted = createState();
	const restartedPi = await createTestHost((api) => registerNotebookRehydration(api, restarted));
	const [handler] = restartedPi.handlers.get("session_start")!;
	await handler({}, { sessionManager: { getBranch: () => persistedBranch(pi) } });

	assert.equal(restarted.epoch, 1, "state.epoch stays the committed epoch after restart");
	assert.equal(restarted.discardEpochWatermark, 2, "watermark derived from the staged survivor epoch");
	assert.deepEqual(Array.from(restarted.notebookPages.entries()).sort(), [
		["page-a", "content-a"], ["page-b", "content-b"], ["page-c", "content-c"],
	], "staged survivors remain invisible until committed");

	// Retry on the restarted process must not reuse the staged epoch 2.
	const deleted = await prepareNotebookDiscard(restartedPi as any, restarted, 1, ["page-a"]);
	assert.deepEqual(deleted, ["page-a"]);
	assert.equal(restarted.discardEpochWatermark, 3, "retry must skip the previously staged epoch");
	commitNotebookDiscard(restartedPi as any, restarted, 1);
	assert.equal(restarted.epoch, 3);

	const final = await rehydratePersistedNotebook(restartedPi);
	assert.deepEqual(Array.from(final.notebookPages.entries()).sort(), [
		["page-b", "content-b"], ["page-c", "content-c"],
	], "orphaned epoch-2 survivors must not resurrect");
	assert.equal(final.epoch, 3);
});

test("session_tree rehydrates notebook state branch-scoped: pages and epoch follow the branch, writes use B state", async () => {
	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	const notebookIndex = pi.tools.get("notebook_index");
	const [sessionTree] = pi.handlers.get("session_tree")!;

	// Branch A: pages a,b at committed epoch 1.
	const branchA = [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "page-a", content: "a-v1" } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "page-b", content: "b-v1" } },
	];
	// Branch B: diverged from A via a discard — committed epoch 2, only x,y kept.
	const branchB = [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 2 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "page-x", content: "x-v1" } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "page-y", content: "y-v1" } },
	];
	const treeCtx = (branch: object[]) => ({ hasUI: false, sessionManager: { getBranch: () => branch } } as any);

	// Enter A.
	await sessionTree({}, treeCtx(branchA));
	let indexResult = await notebookIndex.execute("1", {}, undefined, undefined, {} as any);
	assert.deepEqual(indexResult.details.entries, ["page-a", "page-b"]);

	// Navigate to B — pages immediately follow the active branch.
	await sessionTree({}, treeCtx(branchB));
	indexResult = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	assert.deepEqual(indexResult.details.entries, ["page-x", "page-y"]);

	// A write on B uses B's committed epoch and lands on B's pages.
	await notebookWrite.execute("3", { name: "page-z", content: "z-v1" }, undefined, undefined, makeTUICtx({ hasUI: false }));
	assert.equal(pi.appendedEntries.at(-1)!.data.epoch, 2, "write on B must use B's committed epoch");
	indexResult = await notebookIndex.execute("4", {}, undefined, undefined, {} as any);
	assert.deepEqual(indexResult.details.entries, ["page-x", "page-y", "page-z"]);

	// Back to A — A's branch-scoped pages restored, epoch follows A again.
	await sessionTree({}, treeCtx(branchA));
	indexResult = await notebookIndex.execute("5", {}, undefined, undefined, {} as any);
	assert.deepEqual(indexResult.details.entries, ["page-a", "page-b"], "returning to A must restore its pages");
	await notebookWrite.execute("6", { name: "page-a", content: "a-v2" }, undefined, undefined, makeTUICtx({ hasUI: false }));
	assert.equal(pi.appendedEntries.at(-1)!.data.epoch, 1, "write after returning to A must use A's epoch");
});
