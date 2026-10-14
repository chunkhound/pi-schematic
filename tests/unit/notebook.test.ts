import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { CustomEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { createState, resetState, invalidateHandoffState } from "../../state.js";
import { registerNotebookRehydration, reconstructNotebook } from "../../notebook/rehydration.js";
import { buildNotebookDiscardDrafts, formatByteCap, formatPagePreview, saveNotebookPage, resetNotebookWriteLock } from "../../notebook/store.js";
import { openInPager, resolvePager, spawnPager, __setPagerRuntimeForTests } from "../../notebook/pager.js";
import { createNotebookToolDefinitions } from "../../notebook/tools.js";
import { __setSingletons, createWriteLock, getSingletons } from "../../runtime-singletons.js";
import { STATUS_KEY_TOPIC, WIDGET_KEY_WARNING } from "../../tui.js";
import { callHandlers, handoffToolResult, turnEndEvent, makeTUICtx, createDeferred, theme, stripAnsi, runRealChildInvocation } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost } from "./test-host.js";
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

// ── Notebook write-size fixtures (issue #42) ──────────────────────────

const C = "first\nsecond";
const L = (n: number) => Array(n).fill("x").join("\n");
const B = "a".repeat(25600) + "\n" + "b".repeat(25600);
const U = "é".repeat(12800) + "\n" + "z".repeat(25600);
const R = "x".repeat(51201);
const UR = "é".repeat(25600) + "x";
const F = "x".repeat(51200);
const M = "a".repeat(25600) + "\n" + "b".repeat(25599);

const Tlines = { truncatedBy: "lines", totalLines: 2001, totalBytes: 4001, outputLines: 2000, outputBytes: 3999 } as const;
const Tbytes = { truncatedBy: "bytes", totalLines: 2, totalBytes: 51201, outputLines: 1, outputBytes: 25600 } as const;
const ReportLines = "TRUNCATED by lines: kept 2000 of 2001 lines (3999 of 4001 bytes); tail dropped. Split this page into smaller pages.";
const ReportBytes = "TRUNCATED by bytes: kept 1 of 2 lines (25600 of 51201 bytes); tail dropped. Split this page into smaller pages.";
const Notice = "Notice: This page was clipped at write time; its stored body is incomplete.";
const rejectMessage = (name: string) => `Notebook page "${name}" rejected: first line exceeds ${formatByteCap(DEFAULT_MAX_BYTES)}. Split it into shorter lines or smaller pages.`;
const emptyHeadRejectMessage = (name: string) => `Notebook page "${name}" rejected: the first non-empty line exceeds ${formatByteCap(DEFAULT_MAX_BYTES)}, so truncation would retain no content. Split it into shorter lines or smaller pages.`;
const DescriptionSuffix =
	`Content is limited to ${DEFAULT_MAX_LINES} lines / ${formatByteCap(DEFAULT_MAX_BYTES)}. ` +
	"The beginning is kept, the tail is dropped, and truncation is reported. " +
	"A write whose retained head would be empty (for example, an oversized first line) is rejected.";

/** Complete-write final text for a single page. */
function completeFinalText(name: string, body: string): string {
	const preview = formatPagePreview(body);
	return `Saved notebook page "${name}".` + (preview ? `\n${preview}` : "") + `\n\nNotebook Pages:\n  ${name}: ${preview}`;
}

/** Clipped-write final text: report lands after the preview and before the page list. */
function clippedFinalText(name: string, body: string, report: string): string {
	const preview = formatPagePreview(body);
	return `Saved notebook page "${name}".` + (preview ? `\n${preview}` : "") + `\n\n${report}\n\nNotebook Pages:\n  ${name}: ${preview}`;
}

/** Complete-write onUpdate text. */
function completeUpdateText(name: string, body: string): string {
	const preview = formatPagePreview(body);
	return `Saved "${name}"` + (preview ? `: ${preview}` : "");
}

/** Clipped-write onUpdate text: report appended after the preview. */
function clippedUpdateText(name: string, body: string, report: string): string {
	const preview = formatPagePreview(body);
	return `Saved "${name}"` + (preview ? `: ${preview}` : "") + `\n\n${report}`;
}

/** Single-page read envelope without any notice. */
function readBase(name: string, body: string): string {
	return `--- ${name} ---\n${body}\n---\nNotebook Pages:\n  ${name}: ${formatPagePreview(body)}`;
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
	delete (branch[0] as { data: { version?: unknown; clipped?: unknown } }).data.version;
	delete (branch[0] as { data: { version?: unknown; clipped?: unknown } }).data.clipped;

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
	assert.deepEqual(addResult.details, { entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
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
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "alpha", truncation: null, clipped: false });
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
	assert.deepEqual(update.details, { entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
	assert.equal(record.statuses.get("pi-schematic-notebook"), "📒 1");
	assert.deepEqual(result.details, { entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
});

test("notebook tool renderers expose stable call/result summaries", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi as any, state);

	const addCall = notebookWrite.renderCall!({ name: "entry-a", content: "first line\nsecond line" }, theme, {} as any) as Text;
	assert.match(stripAnsi(addCall.render(120).join("\n")), /notebook_write "entry-a": first line/);

	const addResult = notebookWrite.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a"], preview: "first line", truncation: null, clipped: false } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a", content: "first line\nsecond line" } } as any,
	) as Text;
	assert.match(stripAnsi(addResult.render(120).join("\n")), /Saved "entry-a": first line/);
	assert.match(stripAnsi(addResult.render(120).join("\n")), /entry-a/);

	const getResult = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body", clipped: false } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	assert.match(stripAnsi(getResult.render(120).join("\n")), /"entry-a"/);
	assert.match(stripAnsi(getResult.render(120).join("\n")), /body/);

	const getResultWithDelimiters = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "line 1\n---\nline 2", clipped: false } },
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

test("/notebook selection previews the chosen entry when no pager is available", async (t) => {
	__setPagerRuntimeForTests({ resolvePager: () => undefined });
	t.after(() => __setPagerRuntimeForTests(null));

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
	assert.doesNotMatch(bodyLines, /PI_PAGER/, "an uncut page shows no truncation hint");
	// Second keypress leaves the inline preview
	overlay.handleInput("\r");
	assert.equal(doneCalls, 1);
});

test("/notebook inline preview hints at $PI_PAGER when it cuts a long page", async (t) => {
	__setPagerRuntimeForTests({ resolvePager: () => undefined });
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "x".repeat(500) + "TAIL" }, undefined, undefined, makeTUICtx());
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

	overlay.handleInput("\r");
	const preview = stripAnsi(overlay.render(120).join("\n"));
	assert.doesNotMatch(preview, /TAIL/);
	assert.match(preview, /set \$PI_PAGER to a full-screen pager \(e\.g\. less\) to view the full page/);
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
	assert.match(lines, /enter view/);
});

test("resolvePager keeps fallback less interactive without changing LESS", () => {
	for (const PAGER of [undefined, "", "   "]) {
		const env = { PI_PAGER: PAGER, PAGER, LESS: "-FRX" };
		assert.deepEqual(
			resolvePager(env, "linux", () => true),
			{ cmd: "less", args: ["-R", "-+F", "-+X"] },
		);
		assert.deepEqual(env, { PI_PAGER: PAGER, PAGER, LESS: "-FRX" });
	}
	assert.deepEqual(
		resolvePager({}, "darwin", () => true),
		{ cmd: "less", args: ["-R", "-+F", "-+X"] },
	);
	assert.equal(resolvePager({}, "linux", () => false), undefined);
	// Windows never probes less — $PI_PAGER/$PAGER are the only way to get a pager.
	assert.equal(resolvePager({}, "win32", () => assert.fail("must not probe on Windows")), undefined);
});

test("resolvePager prefers PI_PAGER over PAGER and falls back when it is blank", () => {
	const noProbe = () => assert.fail("configured pagers must not probe less");
	assert.deepEqual(
		resolvePager({ PI_PAGER: "batcat --plain", PAGER: "more" }, "linux", noProbe),
		{ cmd: "batcat", args: ["--plain", "--paging=always"] },
	);
	assert.deepEqual(
		resolvePager({ PI_PAGER: "less -R" }, "linux", noProbe),
		{ cmd: "less", args: ["-R", "-+F", "-+X"] },
	);
	for (const PI_PAGER of [undefined, "", "   "]) {
		assert.deepEqual(
			resolvePager({ PI_PAGER, PAGER: "most -s" }, "linux", noProbe),
			{ cmd: "most", args: ["-s"] },
			`PI_PAGER=${JSON.stringify(PI_PAGER)}`,
		);
	}
});

test("resolvePager treats cat and more pagers as no pager so the inline preview is used", () => {
	const noProbe = () => assert.fail("cat and more must not fall back to less");
	const cases: Array<{ env: NodeJS.ProcessEnv; platform: NodeJS.Platform }> = [
		{ env: { PI_PAGER: "cat" }, platform: "linux" },
		{ env: { PAGER: "cat" }, platform: "linux" },
		{ env: { PI_PAGER: "cat", PAGER: "less" }, platform: "linux" },
		{ env: { PAGER: "/bin/cat -v" }, platform: "darwin" },
		{ env: { PAGER: "C:\\tools\\CAT.EXE" }, platform: "win32" },
		{ env: { PAGER: "more" }, platform: "linux" },
		{ env: { PI_PAGER: "/usr/bin/more -d", PAGER: "less" }, platform: "linux" },
		{ env: { PAGER: "C:\\Windows\\System32\\more.com" }, platform: "win32" },
	];
	for (const { env, platform } of cases) {
		assert.equal(resolvePager(env, platform, noProbe), undefined, `${platform}: ${JSON.stringify(env)}`);
	}
	// Only the effective pager matters: PI_PAGER still wins over PAGER=cat.
	assert.deepEqual(
		resolvePager({ PI_PAGER: "less", PAGER: "cat" }, "linux", noProbe),
		{ cmd: "less", args: ["-+F", "-+X"] },
	);
});

test("resolvePager overrides quit-if-one-screen and no-init for configured less executables", () => {
	const cases: Array<{ pager: string; platform: NodeJS.Platform; cmd: string; args: string[] }> = [
		{ pager: "less", platform: "linux", cmd: "less", args: ["-+F", "-+X"] },
		{ pager: "  less\t-R  ", platform: "linux", cmd: "less", args: ["-R", "-+F", "-+X"] },
		{ pager: "less -F", platform: "linux", cmd: "less", args: ["-F", "-+F", "-+X"] },
		{ pager: "less -FRX", platform: "linux", cmd: "less", args: ["-FRX", "-+F", "-+X"] },
		{ pager: "less --quit-if-one-screen -S", platform: "linux", cmd: "less", args: ["--quit-if-one-screen", "-S", "-+F", "-+X"] },
		{ pager: "less --no-init -R", platform: "linux", cmd: "less", args: ["--no-init", "-R", "-+F", "-+X"] },
		{ pager: "less -+F -F", platform: "linux", cmd: "less", args: ["-+F", "-F", "-+F", "-+X"] },
		{ pager: "/usr/bin/less -R", platform: "linux", cmd: "/usr/bin/less", args: ["-R", "-+F", "-+X"] },
		{ pager: "./less -F", platform: "darwin", cmd: "./less", args: ["-F", "-+F", "-+X"] },
		{ pager: "less -FRX --", platform: "linux", cmd: "less", args: ["-FRX", "-+F", "-+X", "--"] },
		{ pager: "less -- -F", platform: "linux", cmd: "less", args: ["-+F", "-+X", "--", "-F"] },
		{ pager: "less", platform: "win32", cmd: "less", args: ["-+F", "-+X"] },
		{ pager: "LESS -R", platform: "win32", cmd: "LESS", args: ["-R", "-+F", "-+X"] },
		{ pager: "less.exe -FRX", platform: "win32", cmd: "less.exe", args: ["-FRX", "-+F", "-+X"] },
		{ pager: "C:\\tools\\LESS.EXE -F", platform: "win32", cmd: "C:\\tools\\LESS.EXE", args: ["-F", "-+F", "-+X"] },
		{ pager: "C:/tools/less.exe -R", platform: "win32", cmd: "C:/tools/less.exe", args: ["-R", "-+F", "-+X"] },
	];
	for (const { pager, platform, cmd, args } of cases) {
		const env = { PAGER: pager, LESS: "-FRX" };
		assert.deepEqual(
			resolvePager(env, platform, () => assert.fail("configured pagers must not probe less")),
			{ cmd, args },
			`${platform}: ${pager}`,
		);
		assert.deepEqual(env, { PAGER: pager, LESS: "-FRX" });
	}
});

test("resolvePager forces paging for configured bat executables", () => {
	const cases: Array<{ pager: string; platform: NodeJS.Platform; cmd: string; args: string[] }> = [
		{ pager: "bat", platform: "linux", cmd: "bat", args: ["--paging=always"] },
		{ pager: "batcat --plain", platform: "linux", cmd: "batcat", args: ["--plain", "--paging=always"] },
		{ pager: "bat --paging=never", platform: "linux", cmd: "bat", args: ["--paging=never", "--paging=always"] },
		{ pager: "/opt/less/bat --plain", platform: "linux", cmd: "/opt/less/bat", args: ["--plain", "--paging=always"] },
		{ pager: "/usr/bin/batcat -p --", platform: "linux", cmd: "/usr/bin/batcat", args: ["-p", "--paging=always", "--"] },
		{ pager: "bat.exe --plain", platform: "win32", cmd: "bat.exe", args: ["--plain", "--paging=always"] },
		{ pager: "C:\\tools\\BATCAT.EXE", platform: "win32", cmd: "C:\\tools\\BATCAT.EXE", args: ["--paging=always"] },
	];
	for (const { pager, platform, cmd, args } of cases) {
		assert.deepEqual(
			resolvePager({ PAGER: pager }, platform, () => assert.fail("configured pagers must not probe less")),
			{ cmd, args },
			`${platform}: ${pager}`,
		);
	}
});

test("resolvePager leaves other pagers and wrappers unchanged", () => {
	const cases: Array<{ pager: string; platform: NodeJS.Platform; cmd: string; args: string[] }> = [
		{ pager: "less-wrapper -F", platform: "linux", cmd: "less-wrapper", args: ["-F"] },
		{ pager: "env less -FRX", platform: "linux", cmd: "env", args: ["less", "-FRX"] },
		{ pager: "LESS -F", platform: "linux", cmd: "LESS", args: ["-F"] },
		{ pager: "less.exe -F", platform: "linux", cmd: "less.exe", args: ["-F"] },
		{ pager: "less.cmd -F", platform: "win32", cmd: "less.cmd", args: ["-F"] },
		{ pager: "env bat --plain", platform: "linux", cmd: "env", args: ["bat", "--plain"] },
		{ pager: "bat-wrapper", platform: "linux", cmd: "bat-wrapper", args: [] },
		{ pager: "bat.exe --plain", platform: "linux", cmd: "bat.exe", args: ["--plain"] },
		{ pager: "bat.cmd --plain", platform: "win32", cmd: "bat.cmd", args: ["--plain"] },
	];
	for (const { pager, platform, cmd, args } of cases) {
		assert.deepEqual(
			resolvePager({ PAGER: pager }, platform, () => assert.fail("configured pagers must not probe less")),
			{ cmd, args },
			`${platform}: ${pager}`,
		);
	}
});

test("spawnPager rejects with a readable error when the pager binary is missing", async (t) => {
	if (process.platform === "win32") {
		t.skip("shell: true reports a missing binary only as a cmd.exe exit code");
		return;
	}
	await assert.rejects(
		spawnPager("body", { cmd: "pi-schematic-definitely-missing-xyz", args: [] }),
		/pi-schematic-definitely-missing-xyz not found/,
	);
});

test("spawnPager pipes the full body to the child's stdin", async () => {
	const tmpDir = await mkdtemp(join(tmpdir(), "pager-stdin-test-"));
	const scriptPath = join(tmpDir, "pager.cjs");
	const outPath = join(tmpDir, "out.txt");
	try {
		// Writes only to a file — produces no stdout, so the child's
		// inherited stdout doesn't pollute the test runner's own output.
		// A script file, not `-e`: shell: true on Windows joins args unquoted,
		// which would split a multi-word -e script apart.
		const script = [
			'const fs = require("node:fs");',
			"const chunks = [];",
			'process.stdin.on("data", (c) => chunks.push(c));',
			'process.stdin.on("end", () => { fs.writeFileSync(process.argv[2], Buffer.concat(chunks)); });',
		].join("\n");
		await writeFile(scriptPath, script);
		const body = "line one\nline two\n";

		await spawnPager(body, { cmd: process.execPath, args: [scriptPath, outPath] });

		assert.equal(await readFile(outPath, "utf8"), body);
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
});

test("spawnPager resolves when the pager exits without reading stdin (EPIPE/EOF is swallowed)", async () => {
	// Several MB comfortably exceeds the OS pipe buffer (64KB on Linux), so
	// the write is still in flight — and hits EPIPE (EOF on Windows) — when
	// the child's immediate exit closes the read end, instead of completing
	// before the child even starts.
	const body = "x".repeat(5 * 1024 * 1024);

	await assert.doesNotReject(
		spawnPager(body, { cmd: process.execPath, args: ["-e", "process.exit(0)"] }),
	);
});

test("spawnPager resolves when the pager exits nonzero", async () => {
	await assert.doesNotReject(
		spawnPager("body", { cmd: process.execPath, args: ["-e", "process.exit(1)"] }),
	);
});

test("/notebook enter suspends the TUI, awaits the pager, then restores the TUI and reopens the list", async (t) => {
	const events: string[] = [];
	const spawned = createDeferred();
	const pagerExit = createDeferred();
	__setPagerRuntimeForTests({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async (body, pager) => {
			events.push(`spawn:${pager.cmd}:${body}`);
			spawned.resolve();
			await pagerExit.promise;
		},
	});
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "zeta", content: "old body" }, undefined, undefined, makeTUICtx());
	await notebookWrite.execute("2", { name: "alpha", content: "other" }, undefined, undefined, makeTUICtx());

	const tui = {
		stop: () => events.push("stop"),
		start: () => events.push("start"),
		requestRender: (force?: boolean) => events.push(`render:${force ? "force" : "soft"}`),
	};

	let customCalls = 0;
	const renders: string[] = [];
	const handlerPromise = pi.commands.get("notebook")!.handler("", makeTUICtx({
		percent: 20,
		custom: async (build: any) => {
			customCalls++;
			if (customCalls > 2) return undefined;
			let result: unknown;
			const overlay = build(tui, theme, {}, (value: unknown) => { result = value; });
			if (customCalls === 1) {
				// Move off the default index 0 so the reopen assertion proves cursor restore.
				overlay.handleInput("\x1b[B");
				overlay.handleInput("\r");
			} else {
				renders.push(stripAnsi(overlay.render(120).join("\n")));
				return undefined;
			}
			return result;
		},
	}));

	// Wait until the pager is running before letting it exit.
	await spawned.promise;
	// Ignore any overlay-side renders queued by handleInput before done() resolved.
	const lifecycle = () => events.filter((e) => e === "stop" || e === "start" || e.startsWith("spawn:") || e === "render:force");
	assert.deepEqual(lifecycle(), ["stop", "spawn:pager:old body"], "TUI must be stopped before spawn");
	pagerExit.resolve();
	await handlerPromise;

	assert.deepEqual(lifecycle(), ["stop", "spawn:pager:old body", "start", "render:force"]);
	assert.equal(customCalls, 2, "list must reopen after pager exits");
	const arrowLine = renders[0]!.split("\n").find((l) => l.includes("→"));
	assert.ok(arrowLine, `expected a cursor row, got:\n${renders[0]}`);
	assert.match(arrowLine!, /zeta/);
	assert.doesNotMatch(arrowLine!, /alpha/);
});

/**
 * ctx.ui.custom stub: runs beforeEnter, then presses Enter on the first open.
 * Every later open is rendered into `reopens` and closed.
 */
function enterOnFirstOpen(beforeEnter: () => void = () => {}) {
	const reopens: string[] = [];
	let opened = false;
	const custom = async (build: any) => {
		let result: unknown;
		const overlay = build({ stop: () => {}, start: () => {}, requestRender: () => {} }, theme, {}, (value: unknown) => { result = value; });
		if (opened) {
			reopens.push(stripAnsi(overlay.render(120).join("\n")));
			return undefined;
		}
		opened = true;
		beforeEnter();
		overlay.handleInput("\r");
		return result;
	};
	return { custom, reopens };
}

test("/notebook pager interaction installs and removes a SIGINT guard", async (t) => {
	const baselineSigint = process.listeners("SIGINT").length;
	let duringSpawnListenerCount = -1;
	__setPagerRuntimeForTests({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async () => {
			duringSpawnListenerCount = process.listeners("SIGINT").length;
		},
	});
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body" }, undefined, undefined, makeTUICtx());

	await pi.commands.get("notebook")!.handler("", makeTUICtx({ percent: 20, custom: enterOnFirstOpen().custom }));

	assert.equal(duringSpawnListenerCount, baselineSigint + 1, "SIGINT guard must be installed during pager");
	assert.equal(process.listeners("SIGINT").length, baselineSigint, "SIGINT guard must be removed after pager");
});

test("openInPager removes the SIGINT guard even if tui.start throws", async (t) => {
	const baselineSigint = process.listeners("SIGINT").length;
	__setPagerRuntimeForTests({ spawnPager: async () => {} });
	t.after(() => __setPagerRuntimeForTests(null));

	const tui = {
		stop: () => {},
		start: () => { throw new Error("start boom"); },
		requestRender: () => {},
	};

	await assert.rejects(
		openInPager(tui as any, "body", { cmd: "pager", args: [] }),
		/start boom/,
	);
	assert.equal(process.listeners("SIGINT").length, baselineSigint, "SIGINT guard must not leak when tui.start throws");
});

test("openInPager propagates a tui.stop failure without spawning, guarding SIGINT, or restarting", async (t) => {
	const baselineSigint = process.listeners("SIGINT").length;
	let spawned = false;
	__setPagerRuntimeForTests({ spawnPager: async () => { spawned = true; } });
	t.after(() => __setPagerRuntimeForTests(null));

	let started = false;
	const tui = {
		stop: () => { throw new Error("stop boom"); },
		start: () => { started = true; },
		requestRender: () => {},
	};

	await assert.rejects(openInPager(tui as any, "body", { cmd: "pager", args: [] }), /stop boom/);
	assert.equal(spawned, false, "pager must not spawn when tui.stop throws");
	assert.equal(process.listeners("SIGINT").length, baselineSigint, "SIGINT guard must not leak when tui.stop throws");
	assert.equal(started, false, "TUI must not restart after a failed stop");
});

test("/notebook surfaces pager spawn errors as a warning notification", async (t) => {
	__setPagerRuntimeForTests({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async () => { throw new Error("boom"); },
	});
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body" }, undefined, undefined, makeTUICtx());

	const notifications: Array<{ message: string; level: string }> = [];
	await pi.commands.get("notebook")!.handler("", makeTUICtx({
		percent: 20,
		notify: (message: string, level: string) => { notifications.push({ message, level }); },
		custom: enterOnFirstOpen().custom,
	}));

	assert.deepEqual(notifications, [{ message: "pager failed: boom", level: "warning" }]);
});

test("/notebook reopens the list when the selected page vanished while it was open", async (t) => {
	let spawned = false;
	__setPagerRuntimeForTests({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async () => { spawned = true; },
	});
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	await pi.tools.get("notebook_write").execute("1", { name: "alpha", content: "body" }, undefined, undefined, makeTUICtx());
	let branch: unknown[] = [];
	const handoffCtx = {
		...makeTUICtx(),
		getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
		sessionManager: { getBranch: () => branch },
	};
	await pi.tools.get("handoff").execute("2", { nextInstruction: "continue", discardPages: ["alpha"] }, undefined, undefined, handoffCtx);
	const results = await callHandlers(pi, "turn_end", turnEndEvent({ toolResults: [handoffToolResult("2")] }), handoffCtx);
	const boundary = results.find((result) => result !== undefined) as { entries: Array<Record<string, unknown>> };
	branch = boundary.entries.map((entry, index) => ({ ...entry, id: `entry-${index}` }));

	// The handoff's cut is confirmed at turn_start and applies the discard while the list is open.
	const { custom, reopens } = enterOnFirstOpen(() => {
		void callHandlers(pi, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 }, handoffCtx);
	});
	await pi.commands.get("notebook")!.handler("", makeTUICtx({ percent: 20, custom }));

	assert.equal(reopens.length, 1, "list must reopen instead of closing");
	assert.match(reopens[0]!, /Notebook \(0 pages\)/);
	assert.equal(spawned, false, "a vanished page must not open the pager");
});

test("/notebook inline preview returns to the list on any key when no pager is available", async (t) => {
	__setPagerRuntimeForTests({ resolvePager: () => undefined });
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "zeta", content: "body line" }, undefined, undefined, makeTUICtx());
	await notebookWrite.execute("2", { name: "alpha", content: "other" }, undefined, undefined, makeTUICtx());

	let customCalls = 0;
	const renders: string[] = [];
	await pi.commands.get("notebook")!.handler("", makeTUICtx({
		percent: 20,
		custom: async (build: any) => {
			customCalls++;
			let result: unknown;
			const overlay = build({ requestRender: () => {} }, theme, {}, (value: unknown) => { result = value; });
			if (customCalls === 1) {
				// Move off the default index 0 so the reopen assertion proves cursor restore.
				overlay.handleInput("\x1b[B");
				overlay.handleInput("\r"); // opens the inline preview
				overlay.handleInput(" ");  // any key returns to the list
				return result;
			}
			renders.push(stripAnsi(overlay.render(120).join("\n")));
			return undefined;
		},
	}));

	assert.equal(customCalls, 2, "list must reopen after the inline preview");
	const arrowLine = renders[0]!.split("\n").find((l) => l.includes("→"));
	assert.ok(arrowLine, `expected a cursor row, got:\n${renders[0]}`);
	assert.match(arrowLine!, /zeta/);
	assert.doesNotMatch(arrowLine!, /alpha/);
});

test("/notebook selecting an empty-content page opens the preview instead of closing the picker", async (t) => {
	__setPagerRuntimeForTests({ resolvePager: () => undefined });
	t.after(() => __setPagerRuntimeForTests(null));

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "" }, undefined, undefined, makeTUICtx());

	let doneCalls = 0;
	await pi.commands.get("notebook")!.handler("", makeTUICtx({
		percent: 20,
		custom: async (build: any) => {
			const overlay = build({ requestRender: () => {} }, theme, {}, () => { doneCalls++; });
			overlay.handleInput("\r"); // Enter on the empty-content page
			assert.equal(doneCalls, 0, "an empty page body must not close the picker early");
			const preview = stripAnsi(overlay.render(120).join("\n"));
			assert.match(preview, /alpha/, "inline preview header must show the page name");
			overlay.handleInput(" "); // any key leaves the inline preview
			assert.equal(doneCalls, 1);
		},
	}));
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
	assert.match(notebookRead.description, /truncation notice/i);
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

// ── Handoff notebook discard drafts ───────────────────────────────────

async function notebookWithPages(pages: Record<string, string>) {
	const pi = await createTestHost();
	const state = createState();
	for (const [name, content] of Object.entries(pages)) {
		await saveNotebookPage(pi as any, state, name, content);
	}
	return { pi, state };
}

function branchWith(pi: TestPI, drafts: readonly CustomEntryDraft[]): any[] {
	return [
		...persistedBranch(pi),
		...drafts.map(({ customType, data }) => ({ type: "custom", customType, data })),
	];
}

function restoredFrom(branch: any[]) {
	const restored = createState();
	reconstructNotebook(restored, branch);
	return restored;
}

test("buildNotebookDiscardDrafts leaves the state untouched", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const pagesBefore = Array.from(state.notebookPages.entries());

	buildNotebookDiscardDrafts(state, ["page-a"]);

	assert.deepEqual(Array.from(state.notebookPages.entries()), pagesBefore);
	assert.equal(state.epoch, 1);
	assert.equal(state.discardEpochWatermark, 0);
});

test("buildNotebookDiscardDrafts closes the current generation, stages survivors and opens the next generation", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });

	const { drafts, discarded } = buildNotebookDiscardDrafts(state, ["page-b"]);

	assert.equal(discarded, 1);
	assert.deepEqual(drafts, [
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "page-a", content: "content-a", clipped: false } },
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "page-c", content: "content-c", clipped: false } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 2 } },
	]);
});

test("buildNotebookDiscardDrafts keeps a survivor's clipped flag", async () => {
	const { state } = await notebookWithPages({ drop: C, keep: L(2001) });

	const { drafts } = buildNotebookDiscardDrafts(state, ["drop"]);

	const survivor = drafts.find((draft) => draft.customType === "notebook-entry")!;
	assert.deepEqual(survivor.data, { version: 1, epoch: 2, name: "keep", content: L(2000), clipped: true });
});

test("buildNotebookDiscardDrafts moves past the discard watermark", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	state.discardEpochWatermark = 4;

	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	assert.deepEqual(drafts.map((draft) => (draft.data as { epoch: number }).epoch), [1, 5, 5]);
});

test("buildNotebookDiscardDrafts ignores unknown and repeated names", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });

	const result = buildNotebookDiscardDrafts(state, ["page-a", "ghost", "page-a"]);

	assert.equal(result.discarded, 1);
	assert.deepEqual(result, buildNotebookDiscardDrafts(state, ["page-a"]));
});

test("buildNotebookDiscardDrafts writes nothing when no named page exists", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a" });

	assert.deepEqual(buildNotebookDiscardDrafts(state, ["ghost"]), { drafts: [], discarded: 0 });
	assert.deepEqual(buildNotebookDiscardDrafts(state, []), { drafts: [], discarded: 0 });
});

test("discard drafts written to a branch make the survivors the active generation", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	const restored = restoredFrom(branchWith(pi, drafts));

	assert.deepEqual(Array.from(restored.notebookPages.entries()), [["page-b", "content-b"]]);
	assert.equal(restored.epoch, 2);
	assert.equal(restored.discardEpochWatermark, 2);
});

test("discarding every page leaves an empty next generation", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { drafts, discarded } = buildNotebookDiscardDrafts(state, ["page-a", "page-b"]);

	const restored = restoredFrom(branchWith(pi, drafts));

	assert.equal(discarded, 2);
	assert.deepEqual(Array.from(restored.notebookPages.entries()), []);
	assert.equal(restored.epoch, 2);
});

test("survivors staged without their closing generation marker stay invisible to rehydration", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });
	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	const restored = restoredFrom(branchWith(pi, drafts.slice(0, -1)));

	assert.deepEqual(Array.from(restored.notebookPages.entries()).sort(), [
		["page-a", "content-a"], ["page-b", "content-b"], ["page-c", "content-c"],
	]);
	assert.equal(restored.epoch, 1);
	assert.equal(restored.discardEpochWatermark, 2);
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

test("a discard after orphaned staged survivors uses a fresh epoch and does not resurrect them", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });
	// An earlier pass discarding page-b staged survivors at epoch 2 and never closed that generation.
	const orphanDrafts = buildNotebookDiscardDrafts(state, ["page-b"]).drafts.slice(0, -1);

	// A restarted process derives its state from that branch alone.
	const restarted = restoredFrom(branchWith(pi, orphanDrafts));
	const retry = buildNotebookDiscardDrafts(restarted, ["page-a"]);
	const restored = restoredFrom(branchWith(pi, [...orphanDrafts, ...retry.drafts]));

	assert.deepEqual(retry.drafts.map((draft) => (draft.data as { epoch: number }).epoch), [1, 3, 3, 3]);
	assert.deepEqual(Array.from(restored.notebookPages.entries()).sort(), [
		["page-b", "content-b"], ["page-c", "content-c"],
	]);
	assert.equal(restored.epoch, 3);
});

test("branch invalidation preserves the discard watermark until reconstruction derives a fresh one", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const orphan = branchWith(pi, buildNotebookDiscardDrafts(state, ["page-a"]).drafts.slice(0, -1));
	reconstructNotebook(state, orphan);
	assert.equal(state.discardEpochWatermark, 2);

	// Branch switch must not prematurely drop the watermark: a retry that reuses
	// the staged epoch would resurrect orphaned survivors.
	invalidateHandoffState(state);
	assert.equal(state.discardEpochWatermark, 2, "invalidation alone must not reset the watermark");

	// A fresh branch with no staged survivors resets the derived watermark.
	reconstructNotebook(state, []);
	assert.equal(state.epoch, 0);
	assert.equal(state.discardEpochWatermark, 0);
});

test("resetState clears the discard watermark for a fresh session", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	reconstructNotebook(state, branchWith(pi, buildNotebookDiscardDrafts(state, ["page-a"]).drafts.slice(0, -1)));
	assert.equal(state.discardEpochWatermark, 2);

	resetState(state);
	assert.equal(state.discardEpochWatermark, 0, "/new must reset the watermark with the session");
	assert.equal(state.epoch, 0);
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

// ── Notebook write-size contract (issue #42) ───────────────────────────

test("complete write exposes null truncation and false clipped", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);

	const saved = await saveNotebookPage(pi as any, state, "page", C);
	assert.deepEqual(saved, { entries: ["page"], preview: "first", truncation: null, clipped: false });
	assert.deepEqual(pi.appendedEntries[0].data, { version: 1, epoch: 1, name: "page", content: C, clipped: false });

	let update: any;
	const result = await notebookWrite.execute("2", { name: "page", content: C }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ hasUI: false }));
	assert.equal((result.content[0] as any).text, completeFinalText("page", C));
	assert.equal((update.content[0] as any).text, completeUpdateText("page", C));
	assert.deepEqual(result.details, { entries: ["page"], preview: "first", truncation: null, clipped: false });
	assert.deepEqual(update.details, { entries: ["page"], preview: "first", truncation: null, clipped: false });
});

test("line overflow returns exact head and line report", async () => {
	const pi = await createTestHost();
	const state = createState();

	const saved = await saveNotebookPage(pi as any, state, "page", L(2001));
	assert.equal(state.notebookPages.get("page"), L(2000));
	assert.deepEqual(saved, { entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	assert.deepEqual(pi.appendedEntries[0].data, { version: 1, epoch: 1, name: "page", content: L(2000), clipped: true });
});

test("byte overflow retains whole lines and reports bytes (ASCII + UTF-8)", async () => {
	const pi = await createTestHost();
	const state = createState();

	const ascii = await saveNotebookPage(pi as any, state, "page", B);
	assert.equal(state.notebookPages.get("page"), "a".repeat(25600));
	assert.deepEqual(ascii, { entries: ["page"], preview: formatPagePreview("a".repeat(25600)), truncation: Tbytes, clipped: true });
	assert.deepEqual(pi.appendedEntries[0].data, { version: 1, epoch: 1, name: "page", content: "a".repeat(25600), clipped: true });

	const utf8 = await saveNotebookPage(pi as any, state, "page", U);
	assert.equal(state.notebookPages.get("page"), "é".repeat(12800));
	assert.deepEqual(utf8, { entries: ["page"], preview: formatPagePreview("é".repeat(12800)), truncation: Tbytes, clipped: true });
	assert.deepEqual(pi.appendedEntries[1].data, { version: 1, epoch: 1, name: "page", content: "é".repeat(12800), clipped: true });
});

test("write final and update text report clipping without a badge", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);

	let update: any;
	const result = await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ hasUI: false }));

	const body = L(2000);
	assert.equal((result.content[0] as any).text, clippedFinalText("page", body, ReportLines));
	assert.equal(update.content[0].text, clippedUpdateText("page", body, ReportLines));
	assert.deepEqual(result.details, { entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	assert.deepEqual(update.details, { entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	assert.doesNotMatch((result.content[0] as any).text, /\[truncated\]/);
	assert.doesNotMatch(update.content[0].text, /\[truncated\]/);
});

test("write final and update text report byte clipping", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);

	let update: any;
	const result = await notebookWrite.execute("1", { name: "page", content: B }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ hasUI: false }));

	const body = "a".repeat(25600);
	assert.equal((result.content[0] as any).text, clippedFinalText("page", body, ReportBytes));
	assert.equal(update.content[0].text, clippedUpdateText("page", body, ReportBytes));
	assert.deepEqual(result.details, { entries: ["page"], preview: formatPagePreview(body), truncation: Tbytes, clipped: true });
	assert.deepEqual(update.details, result.details);
	assert.match((result.content[0] as any).text, /TRUNCATED by bytes/);
});

test("read appends a generic notice only for a flagged page", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, undefined, makeTUICtx({ hasUI: false }));
	const clipped = await notebookRead.execute("2", { name: "page" }, undefined, undefined, {} as any);
	const body = L(2000);
	assert.equal((clipped.content[0] as any).text, `${readBase("page", body)}\n\n${Notice}`);
	assert.equal((clipped.content[0] as any).text.split(Notice).length - 1, 1);
	assert.deepEqual(clipped.details, { entries: ["page"], found: true, body, clipped: true });

	await notebookWrite.execute("3", { name: "page", content: C }, undefined, undefined, makeTUICtx({ hasUI: false }));
	const complete = await notebookRead.execute("4", { name: "page" }, undefined, undefined, {} as any);
	assert.equal((complete.content[0] as any).text, readBase("page", C));
	assert.doesNotMatch((complete.content[0] as any).text, /Notice:/);
	assert.deepEqual(complete.details, { entries: ["page"], found: true, body: C, clipped: false });
});

test("oversized first line rejects a new page without side effects", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, , notebookIndex] = createNotebookToolDefinitions(pi as any, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };

	for (const content of [R, UR]) {
		await assert.rejects(
			() => saveNotebookPage(pi as any, state, "page", content),
			(error: unknown) => error instanceof Error && error.message === rejectMessage("page"),
		);
	}

	let updateCalled = false;
	await assert.rejects(
		() => notebookWrite.execute("1", { name: "page", content: R }, undefined, () => { updateCalled = true; }, makeTUICtx({ hasUI: true, record })),
		(error: unknown) => error instanceof Error && error.message === rejectMessage("page"),
	);
	assert.equal(updateCalled, false);
	assert.equal(state.notebookPages.size, 0);
	assert.equal(state.epoch, 0);
	assert.equal(state.discardEpochWatermark, 0);
	assert.equal(pi.appendedEntries.length, 0);
	assert.equal(record.statuses.size, 0);
	assert.equal(record.widgets.size, 0);

	await saveNotebookPage(pi as any, state, "page", C);
	assert.equal(state.notebookPages.get("page"), C);
	const index = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	assert.deepEqual(index.details, { entries: ["page"] });
});

test("rejected overwrite preserves prior body and clipped flag", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	await saveNotebookPage(pi as any, state, "page", C);
	const epochBefore = state.epoch;
	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "page", R),
		(error: unknown) => error instanceof Error && error.message === rejectMessage("page"),
	);
	assert.equal(state.notebookPages.get("page"), C);
	assert.equal(state.epoch, epochBefore);
	assert.equal(pi.appendedEntries.length, 1);
	let read = await notebookRead.execute("2", { name: "page" }, undefined, undefined, {} as any);
	assert.equal((read.content[0] as any).text, readBase("page", C));
	assert.equal((read.details as any).clipped, false);

	await saveNotebookPage(pi as any, state, "page", L(2001));
	const epochClipped = state.epoch;
	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "page", R),
		(error: unknown) => error instanceof Error && error.message === rejectMessage("page"),
	);
	assert.equal(state.notebookPages.get("page"), L(2000));
	assert.equal(state.epoch, epochClipped);
	read = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	assert.equal((read.details as any).clipped, true);
	assert.equal((read.content[0] as any).text.endsWith(`\n\n${Notice}`), true);
});

test("blank first line plus oversized line rejects and preserves prior page state", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead] = createNotebookToolDefinitions(pi as any, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const blankFirstLineOverflow = "\n" + "x".repeat(DEFAULT_MAX_BYTES + 1);

	await saveNotebookPage(pi as any, state, "page", C);
	const epochBefore = state.epoch;
	const entriesBefore = pi.appendedEntries.length;

	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "page", blankFirstLineOverflow),
		(error: unknown) => error instanceof Error && error.message === emptyHeadRejectMessage("page"),
	);

	let updateCalled = false;
	await assert.rejects(
		() => notebookWrite.execute("2", { name: "page", content: blankFirstLineOverflow }, undefined, () => { updateCalled = true; }, makeTUICtx({ hasUI: true, record })),
		(error: unknown) => error instanceof Error && error.message === emptyHeadRejectMessage("page"),
	);
	assert.equal(updateCalled, false);
	assert.equal(state.notebookPages.get("page"), C);
	assert.equal(state.clippedPages.has("page"), false);
	assert.equal(state.epoch, epochBefore);
	assert.equal(pi.appendedEntries.length, entriesBefore);
	assert.equal(record.statuses.size, 0);
	assert.equal(record.widgets.size, 0);

	// A clipped prior page is equally protected: body, flag, epoch and entries stay.
	await saveNotebookPage(pi as any, state, "page", L(2001));
	const epochClipped = state.epoch;
	const entriesClipped = pi.appendedEntries.length;
	await assert.rejects(
		() => saveNotebookPage(pi as any, state, "page", blankFirstLineOverflow),
		(error: unknown) => error instanceof Error && error.message === emptyHeadRejectMessage("page"),
	);
	const read = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	assert.equal(state.notebookPages.get("page"), L(2000));
	assert.equal(state.clippedPages.has("page"), true);
	assert.equal(state.epoch, epochClipped);
	assert.equal(pi.appendedEntries.length, entriesClipped);
	assert.equal((read.details as any).body, L(2000));
	assert.equal((read.details as any).clipped, true);

	// An untruncated empty write is still accepted by the new guard.
	await saveNotebookPage(pi as any, state, "page", "");
	assert.equal(state.notebookPages.get("page"), "");
	assert.equal(state.clippedPages.has("page"), false);
});

test("clipped flag survives fresh reconstruction without persisted quantities", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);
	await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, undefined, makeTUICtx({ hasUI: false }));

	assert.deepEqual(Object.keys(pi.appendedEntries[0].data).sort(), ["clipped", "content", "epoch", "name", "version"]);
	assert.equal((pi.appendedEntries[0].data as any).clipped, true);

	const restored = await rehydratePersistedNotebook(pi);
	const restoredPi = await createTestHost();
	const [, restoredRead] = createNotebookToolDefinitions(restoredPi as any, restored);
	const read = await restoredRead.execute("1", { name: "page" }, undefined, undefined, {} as any);
	assert.equal((read.details as any).clipped, true);
	assert.equal((read.content[0] as any).text.endsWith(`\n\n${Notice}`), true);
});

test("complete overwrite clears a durable clipped flag", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, undefined, makeTUICtx({ hasUI: false }));
	await notebookWrite.execute("2", { name: "page", content: C }, undefined, undefined, makeTUICtx({ hasUI: false }));

	assert.equal((pi.appendedEntries.at(-1)!.data as any).clipped, false);
	const read = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	assert.deepEqual(read.details, { entries: ["page"], found: true, body: C, clipped: false });
	assert.equal((read.content[0] as any).text, readBase("page", C));

	const restored = await rehydratePersistedNotebook(pi);
	const restoredPi = await createTestHost();
	const [, restoredRead] = createNotebookToolDefinitions(restoredPi as any, restored);
	const restoredResult = await restoredRead.execute("4", { name: "page" }, undefined, undefined, {} as any);
	assert.equal((restoredResult.details as any).clipped, false);
});

test("legacy page entries without clipped read as false", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerNotebookRehydration(api, state));
	const [handler] = pi.handlers.get("session_start")!;
	await handler({}, { sessionManager: { getBranch: () => [
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "v1", content: C } },
		{ type: "custom", customType: "notebook-entry", data: { epoch: 1, name: "unversioned", content: C } },
		{ type: "custom", customType: "ledger-entry", data: { epoch: 1, name: "ledger", content: C } },
	] } });

	const toolPi = await createTestHost();
	const [, notebookRead] = createNotebookToolDefinitions(toolPi as any, state);
	const list = `  ledger: first\n  unversioned: first\n  v1: first`;
	for (const name of ["v1", "unversioned", "ledger"]) {
		const read = await notebookRead.execute("1", { name }, undefined, undefined, {} as any);
		assert.equal((read.content[0] as any).text, `--- ${name} ---\n${C}\n---\nNotebook Pages:\n${list}`);
		assert.deepEqual(read.details, { entries: ["ledger", "unversioned", "v1"], found: true, body: C, clipped: false });
	}
});

test("discard survivor retains its durable clipped flag", async () => {
	const { pi, state } = await notebookWithPages({ drop: C, keep: L(2001) });

	const restored = restoredFrom(branchWith(pi, buildNotebookDiscardDrafts(state, ["drop"]).drafts));

	assert.equal(restored.notebookPages.get("keep"), L(2000));
	const restoredPi = await createTestHost();
	const [, restoredRead] = createNotebookToolDefinitions(restoredPi as any, restored);
	const read = await restoredRead.execute("1", { name: "keep" }, undefined, undefined, {} as any);
	assert.equal((read.details as any).clipped, true);
});

test("formatPageTuiPreview appends a badge only when clipped", async () => {
	const mod = (await import("../../notebook/store.js")) as unknown as Record<string, unknown>;
	assert.equal(typeof mod["formatPageTuiPreview"], "function");
	const formatPageTuiPreview = mod["formatPageTuiPreview"] as (content: string, clipped: boolean) => string;

	assert.equal(formatPageTuiPreview(L(2000), true), "x [truncated]");
	assert.equal(formatPageTuiPreview(C, false), "first");
	assert.equal(formatPageTuiPreview("p".repeat(81) + "\ntail", true), "p".repeat(77) + "... [truncated]");
});

test("/notebook selector badges clipped pages without changing stored bodies", async () => {
	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "clipped-page", content: L(2001) }, undefined, undefined, makeTUICtx());
	await notebookWrite.execute("2", { name: "complete-page", content: C }, undefined, undefined, makeTUICtx());

	let overlay: any;
	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: { theme, custom: async (build: any) => { overlay = build({ requestRender: () => {} }, theme, {}, () => {}); } },
	});

	const lines = stripAnsi(overlay.render(200).join("\n")).split("\n");
	const clippedLine = lines.find((line) => line.includes("clipped-page"))!;
	assert.match(clippedLine, /x \[truncated\]/);
	const completeLine = lines.find((line) => line.includes("complete-page"))!;
	assert.match(completeLine, /first/);
	assert.doesNotMatch(completeLine, /\[truncated\]/);

	const read = pi.tools.get("notebook_read");
	const clippedRead = await read.execute("3", { name: "clipped-page" }, undefined, undefined, {} as any);
	assert.equal((clippedRead.details as any).body, L(2000));
	assert.equal((clippedRead.details as any).clipped, true);
	const completeRead = await read.execute("4", { name: "complete-page" }, undefined, undefined, {} as any);
	assert.equal((completeRead.details as any).body, C);
	assert.equal((completeRead.details as any).clipped, false);
});

test("notebook_write descriptions state the shared write-size semantics", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);

	assert.equal(notebookWrite.description.endsWith(DescriptionSuffix), true);
	const contentDescription = (notebookWrite.parameters as any).properties.content.description as string;
	assert.equal(contentDescription.endsWith(DescriptionSuffix), true);
	assert.doesNotMatch(JSON.stringify(notebookWrite.parameters), /Truncated at 50KB \/ 2000 lines\./);
	assert.doesNotMatch(notebookWrite.description, /Truncated at 50KB \/ 2000 lines\./);
});

// ── Notebook write-size green regression net ───────────────────────────

test("plain preview preserves the 80-character boundary", async () => {
	assert.equal(formatPagePreview("p".repeat(80)), "p".repeat(80));
	assert.equal(formatPagePreview("p".repeat(81) + "\ntail"), "p".repeat(77) + "...");
});

test("plain page list and index preserve previews and alphabetical order", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, , notebookIndex] = createNotebookToolDefinitions(pi as any, state);
	await saveNotebookPage(pi as any, state, "zeta", "last");
	await saveNotebookPage(pi as any, state, "alpha", "first");

	const index = await notebookIndex.execute("1", {}, undefined, undefined, {} as any);
	assert.deepEqual(index.details, { entries: ["alpha", "zeta"] });
	assert.match((index.content[0] as any).text, /  alpha: first\n  zeta: last/);
	assert.doesNotMatch((index.content[0] as any).text, /\[truncated\]|Notice:/);
});

test("line overflow retains exactly 2000 whole lines", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page", L(2001));
	assert.equal(state.notebookPages.get("page"), L(2000));
	assert.equal(state.notebookPages.get("page")!.split("\n").length, 2000);
});

test("byte overflow preserves the first whole line in ASCII and UTF-8", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page", B);
	assert.equal(state.notebookPages.get("page"), "a".repeat(25600));
	assert.equal(state.notebookPages.get("page")!.includes("\n"), false);
	await saveNotebookPage(pi as any, state, "page", U);
	assert.equal(state.notebookPages.get("page"), "é".repeat(12800));
	assert.equal(state.notebookPages.get("page")!.includes("\n"), false);
});

test("complete and empty bodies remain accepted at the existing caps", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, notebookRead] = createNotebookToolDefinitions(pi as any, state);
	const cases: Array<[string, string]> = [["c", C], ["l", L(2000)], ["f", F], ["m", M], ["empty", ""]];
	for (const [name, body] of cases) {
		await saveNotebookPage(pi as any, state, name, body);
		assert.equal(state.notebookPages.get(name), body);
	}
	const read = await notebookRead.execute("1", { name: "empty" }, undefined, undefined, {} as any);
	assert.equal((read.details as any).found, true);
	assert.equal((read.details as any).body, "");
});

test("complete writes preserve their text list and existing detail fields", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi as any, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	let update: any;

	const result = await notebookWrite.execute("1", { name: "page", content: C }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ percent: 42, record }));
	assert.equal((result.content[0] as any).text, completeFinalText("page", C));
	assert.equal(update.content[0].text, completeUpdateText("page", C));
	const project = (details: any) => ({ entries: details.entries, preview: details.preview });
	assert.deepEqual(project(result.details), { entries: ["page"], preview: "first" });
	assert.deepEqual(project(update.details), { entries: ["page"], preview: "first" });
	assert.equal(record.statuses.get("pi-schematic-notebook"), "📒 1");

	const childPi = await createTestHost();
	const childState = createState();
	const [childWrite] = createNotebookToolDefinitions(childPi as any, childState, { isStale: () => false });
	const childResult = await childWrite.execute("2", { name: "alpha", content: "alpha" }, undefined, undefined, {} as any);
	assert.deepEqual(project(childResult.details), { entries: ["alpha"], preview: "alpha" });
});

test("complete reads preserve their body envelope and existing detail fields", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page", C);
	const [, notebookRead] = createNotebookToolDefinitions(pi as any, state);

	const read = await notebookRead.execute("1", { name: "page" }, undefined, undefined, {} as any);
	assert.equal((read.content[0] as any).text, readBase("page", C));
	const details = read.details as any;
	assert.deepEqual({ entries: details.entries, found: details.found, body: details.body }, { entries: ["page"], found: true, body: C });
	assert.doesNotMatch((read.content[0] as any).text, /Notice:|\[truncated\]/);
});

test("model listing surfaces remain free of clipping decorations", async () => {
	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	const notebookRead = pi.tools.get("notebook_read");
	const notebookIndex = pi.tools.get("notebook_index");
	let update: any;
	const writeResult = await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, (payload: any) => { update = payload; }, makeTUICtx());
	const writeTexts = [(writeResult.content[0] as any).text, update.content[0].text];
	const indexResult = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	const readResult = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	const readText = (readResult.content[0] as any).text;

	for (const text of [...writeTexts, (indexResult.content[0] as any).text, readText]) {
		assert.doesNotMatch(text, /\[truncated\]/, `model text must not carry the TUI badge: ${text}`);
	}
	for (const text of [...writeTexts, (indexResult.content[0] as any).text]) {
		assert.doesNotMatch(text, /Notice:/, `notice must not leak into non-read surfaces: ${text}`);
	}

	// Notebook section through the real before_agent_start hook.
	const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
	const event = createBeforeAgentStartEvent({ systemPrompt: "Base system prompt." });
	await beforeAgentStart(
		event,
		{ ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false },
	);
	const listing = event.systemPromptOptions.sections.schematic_notebook;
	assert.ok(listing !== undefined);
	assert.doesNotMatch(listing, /\[truncated\]/);
	assert.doesNotMatch(listing, /Notice:/);
	assert.match(listing, /  page: x/);
	const assembled = event.systemPrompt;
	assert.match(assembled, /  page: x/);
	assert.doesNotMatch(assembled, /\[truncated\]/);
	assert.doesNotMatch(assembled, /Notice:/);

	// Spawn prompt through the real child-session seam.
	const proof = await runRealChildInvocation({ prompt: "Do the task.", notebookPages: { page: L(2001) } });
	for (const message of proof.observedMessages) {
		assert.doesNotMatch(message, /\[truncated\]/);
		assert.doesNotMatch(message, /Notice:/);
	}
});

test("unknown notebook entry types have zero effect on reconstructed state", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi as any, state, "page", C);
	pi.appendEntry("unknown-notebook-type", { version: 1, epoch: 9, name: "ghost", content: "x" });
	pi.appendEntry("some-other-entry", { version: 1, epoch: 9 });

	const restored = await rehydratePersistedNotebook(pi);
	assert.equal(restored.epoch, 1);
	assert.equal(restored.discardEpochWatermark, 1);
	assert.deepEqual(Array.from(restored.notebookPages.entries()), [["page", C]]);
});
