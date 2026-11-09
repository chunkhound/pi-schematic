import { expect, onTestFinished, test, vi } from "vitest";
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
import { assertPresent, expectSuffix } from "../assertions.js";
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
	const restoredPi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
	const [handler] = restoredPi.handlers.get("session_start")!;
	await handler({}, { sessionManager: { getBranch: () => persistedBranch(pi) } });
	return state;
}

function setPagerRuntime(overrides: Parameters<typeof __setPagerRuntimeForTests>[0]): void {
	__setPagerRuntimeForTests(overrides);
	onTestFinished(() => { __setPagerRuntimeForTests(null); });
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
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
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

	expect(state.epoch).toBe(2);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["keep", "newer"]]);
	expect(pi.activeTools).toStrictEqual(["notebook_read", "notebook_index"]);
});


test("notebook rehydration rebuilds from the latest persisted epoch and avoids duplicate active tools", async () => {
	const state = createState();
	state.epoch = 7;
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); }, { activeTools: ["read", "notebook_read", "notebook_index"] });
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

	expect(state.epoch).toBe(8);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["future", "latest"]]);
	expect(pi.activeTools).toStrictEqual(["read", "notebook_read", "notebook_index"]);
});


test("notebook rehydration clears stale in-memory notebook state when persisted history is empty", async () => {
	const state = createState();
	state.epoch = 7;
	state.notebookPages.set("stale", "stale body");
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
	const [handler] = pi.handlers.get("session_start")!;

	await handler(
		{},
		{
			sessionManager: {
				getBranch: () => [],
			},
		},
	);

	expect(state.epoch).toBe(0);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([]);
	expect(pi.activeTools).toStrictEqual(["notebook_read", "notebook_index"]);
});

test("notebook rehydration ignores null and malformed branch entries", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
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

	expect(state.epoch).toBe(1);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["keep", "valid"]]);
});

test("future-version notebook entries have zero effect on rehydrated state", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
	const [handler] = pi.handlers.get("session_start")!;

	// Real writes through the real store (both land at epoch 1).
	await saveNotebookPage(pi, state, "current", "ok");
	await saveNotebookPage(pi, state, "other", "old");

	// Simulate a future-format writer through the real persistence API. No
	// existing writer emits version 2, so the version discriminator is the
	// only synthetic field; envelope and payload match a real future entry.
	pi.appendEntry("notebook-generation", { version: 2, epoch: 9 });
	pi.appendEntry("notebook-entry", { version: 2, epoch: 9, name: "future", content: "x" });

	await handler({}, { sessionManager: { getBranch: () => persistedBranch(pi) } });

	// Generation marker site: the future epoch 9 must not be adopted.
	expect(state.epoch).toBe(1);
	// Watermark site: the future page's epoch 9 must not inflate the discard watermark.
	expect(state.discardEpochWatermark).toBe(1);
	// Candidate site: the future page is absent and valid pages survive (skip, not abort).
	expect(Array.from(state.notebookPages.entries()).sort()).toStrictEqual([
		["current", "ok"],
		["other", "old"],
	]);
});

test("pre-versioned entries without a version field rehydrate on parity", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
	const [handler] = pi.handlers.get("session_start")!;

	// Real writes through the real store, then strip the version discriminator
	// to reproduce a pre-versioned branch: same envelope and fields, no version.
	await saveNotebookPage(pi, state, "legacy", "old");
	await saveNotebookPage(pi, state, "current", "new");
	const branch = persistedBranch(pi);
	delete (branch[0] as { data: { version?: unknown; clipped?: unknown } }).data.version;
	delete (branch[0] as { data: { version?: unknown; clipped?: unknown } }).data.clipped;

	await handler({}, { sessionManager: { getBranch: () => branch } });

	expect(state.epoch).toBe(1);
	expect(state.discardEpochWatermark).toBe(1);
	expect(Array.from(state.notebookPages.entries()).sort()).toStrictEqual([
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
	expect(indexResult.details.entries).toStrictEqual(["keep"]);

	const readResult = await notebookRead.execute("2", { name: "keep" }, undefined, undefined, {} as any);
	expect(readResult.details.found).toBe(true);
	expect(readResult.details.body).toBe("newer");
	expect(pi.activeTools).toStrictEqual(["read", "notebook_read", "notebook_index"]);
});

// ── Notebook tool contract tests ──────────────────────────────────────

test("notebook tools add/get/list return stable contract details", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi, state);

	const addResult = await notebookWrite.execute("1", { name: "entry-a", content: "first line\nsecond line" }, undefined, undefined, {} as any);
	expect(addResult.details).toStrictEqual({ entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
	expect(state.notebookPages.get("entry-a")).toBe("first line\nsecond line");
	expect(pi.appendedEntries).toHaveLength(1);
	expect(pi.appendedEntries[0].customType).toBe("notebook-entry");
	expect(pi.appendedEntries[0].data.name).toBe("entry-a");

	const getResult = await notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any);
	const details = getResult.details as { found: boolean; entries: string[] };
	expect(details.found).toBe(true);
	expect(details.entries).toStrictEqual(["entry-a"]);
	expect((getResult.content[0] as any).text).toMatch(/--- entry-a ---/);
	expect((getResult.content[0] as any).text).toMatch(/second line/);

	const listResult = await notebookIndex.execute("3", {}, undefined, undefined, {} as any);
	expect(listResult.details).toStrictEqual({ entries: ["entry-a"] });
	expect((listResult.content[0] as any).text).toMatch(/entry-a: first line/);
});

test("child notebook tools reject stale access after reset", async () => {
	const pi = await createTestHost();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	let stale = false;
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi, state, { isStale: () => stale });

	stale = true;
	await expect(notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any)).rejects.toThrow(/invalidated by reset/i);
	await expect(notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, {} as any)).rejects.toThrow(/invalidated by reset/i);
	await expect(notebookIndex.execute("3", {}, undefined, undefined, {} as any)).rejects.toThrow(/invalidated by reset/i);
	expect(state.notebookPages.get("entry-a")).toBe("alpha");
	expect(pi.appendedEntries).toHaveLength(0);
});

test("child notebook_write succeeds while child session is fresh", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state, { isStale: () => false });

	const result = await notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, {} as any);
	expect(result.details).toStrictEqual({ entries: ["entry-a"], preview: "alpha", truncation: null, clipped: false });
	expect(state.notebookPages.get("entry-a")).toBe("alpha");
	expect(pi.appendedEntries).toHaveLength(1);
});

test("notebook_read reports not found with current page names", async () => {
	const pi = await createTestHost();
	const state = createState();
	state.notebookPages.set("entry-a", "alpha");
	state.notebookPages.set("entry-b", "beta");
	const [, notebookRead] = createNotebookToolDefinitions(pi, state);

	const result = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	expect(result.details).toStrictEqual({ entries: ["entry-a", "entry-b"], found: false });
	expect((result.content[0] as any).text).toMatch(/Notebook page "missing" not found\./);
	expect((result.content[0] as any).text).toMatch(/Notebook Pages:\n/);
	expect((result.content[0] as any).text).toMatch(/entry-a: alpha/);
	expect((result.content[0] as any).text).toMatch(/entry-b: beta/);
});

test("notebook tools show empty-state placeholders", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi, state);

	const missing = await notebookRead.execute("1", { name: "missing" }, undefined, undefined, {} as any);
	expect(missing.details).toStrictEqual({ entries: [], found: false });
	expect((missing.content[0] as any).text).toMatch(/Notebook Pages:\n\(empty\)/);

	const list = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	expect(list.details).toStrictEqual({ entries: [] });
	expect((list.content[0] as any).text).toMatch(/Notebook Pages:\n\(empty\)/);
});

test("notebook_write pushes onUpdate and refreshes UI indicators", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	let update: any;

	const result = await notebookWrite.execute(
		"1",
		{ name: "entry-a", content: "first line\nsecond line" },
		undefined,
		(payload: any) => { update = payload; },
		makeTUICtx({ percent: 42, record }),
	);

	expect((update.content[0]).text).toBe('Saved "entry-a": first line');
	expect(update.details).toStrictEqual({ entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
	expect(record.statuses.get("pi-schematic-notebook")).toBe("📒 1");
	expect(result.details).toStrictEqual({ entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
});

test("notebook tool renderers expose stable call/result summaries", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(pi, state);

	const addCall = notebookWrite.renderCall!({ name: "entry-a", content: "first line\nsecond line" }, theme, {} as any) as Text;
	expect(stripAnsi(addCall.render(120).join("\n"))).toMatch(/notebook_write "entry-a": first line/);

	const addResult = notebookWrite.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a"], preview: "first line", truncation: null, clipped: false } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a", content: "first line\nsecond line" } } as any,
	) as Text;
	expect(stripAnsi(addResult.render(120).join("\n"))).toMatch(/Saved "entry-a": first line/);
	expect(stripAnsi(addResult.render(120).join("\n"))).toMatch(/entry-a/);

	const getResult = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body", clipped: false } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	expect(stripAnsi(getResult.render(120).join("\n"))).toMatch(/"entry-a"/);
	expect(stripAnsi(getResult.render(120).join("\n"))).toMatch(/body/);

	const getResultWithDelimiters = notebookRead.renderResult!(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "line 1\n---\nline 2", clipped: false } },
		{ expanded: true, isPartial: false },
		theme,
		{ args: { name: "entry-a" } } as any,
	) as Text;
	expect(stripAnsi(getResultWithDelimiters.render(120).join("\n"))).toMatch(/line 1/);
	expect(stripAnsi(getResultWithDelimiters.render(120).join("\n"))).toMatch(/line 2/);

	const listResult = notebookIndex.renderResult!(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a", "entry-b"] } },
		{ expanded: true, isPartial: false },
		theme,
		{} as any,
	) as Text;
	expect(stripAnsi(listResult.render(120).join("\n"))).toMatch(/2 pages/);
	expect(stripAnsi(listResult.render(120).join("\n"))).toMatch(/entry-a/);
	expect(stripAnsi(listResult.render(120).join("\n"))).toMatch(/entry-b/);
});

// ── Notebook command / overlay tests ──────────────────────────────────

test("/notebook exits cleanly when headless", async () => {
	const pi = await createTestHost();

	await expect(pi.commands.get("notebook")!.handler("", { hasUI: false })).resolves.toBeUndefined();
});


test("/notebook <topic> notifies with info on first set and warning on boundary change", async () => {
	const pi = await createTestHost();
	const notifications: { message: string; level: string }[] = [];
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

	expect(notifications[0]).toStrictEqual({ message: "Active notebook topic: oauth", level: "info" });
	expect(notifications[1].message).toMatch(/Active notebook topic changed: oauth → billing/);
	expect(notifications[1].level).toBe("warning");
	expect(statuses.get(STATUS_KEY_TOPIC)).toBe("🧭 billing");
	expect(widgets.get(WIDGET_KEY_WARNING)).toBeUndefined();
});

test("readonly /notebook boundary notification explains deferred handoff eligibility", async () => {
	const pi = await createTestHost();
	const notifications: { message: string; level: string }[] = [];
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

	expect(notifications.at(-1)?.message ?? "").toMatch(/handoff exception activates.*once the context is ready/i);
	expect(notifications.at(-1)?.message ?? "").toMatch(/until then this boundary is advisory/i);
	expect(notifications.at(-1)?.message ?? "").not.toMatch(/ask the user for an explicit \/handoff/i);
});


test("/notebook empty overlay renders empty state and closes on input", async () => {
	const pi = await createTestHost();
	let overlay: any;
	const done = vi.fn();

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, done);
			},
		},
	});

	const lines = stripAnsi(overlay.render(120).join("\n"));
	expect(lines).toMatch(/Notebook \(0 pages\)/);
	expect(lines).toMatch(/\(empty\) — use notebook_write to create pages/);
	overlay.handleInput("x");
	expect(done).toHaveBeenCalledOnce();
});

test("/notebook selection previews the chosen entry when no pager is available", async () => {
	setPagerRuntime({ resolvePager: () => undefined });

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body line\nsecond line" }, undefined, undefined, makeTUICtx());
	let overlay: any;
	const done = vi.fn();

	await pi.commands.get("notebook")!.handler("", {
		hasUI: true,
		ui: {
			theme,
			custom: async (build: any) => {
				overlay = build({ requestRender: () => {} }, theme, {}, done);
			},
		},
	});

	// First Enter selects the entry — shows body inline, done() not yet called
	overlay.handleInput("\r");
	expect(done, "body shown inline, overlay stays open").not.toHaveBeenCalled();
	const bodyLines = stripAnsi(overlay.render(120).join("\n"));
	expect(bodyLines).toMatch(/body line/);
	expect(bodyLines).toMatch(/alpha/);
	expect(bodyLines, "an uncut page shows no truncation hint").not.toMatch(/PI_PAGER/);
	// Second keypress leaves the inline preview
	overlay.handleInput("\r");
	expect(done).toHaveBeenCalledOnce();
});

test("/notebook inline preview hints at $PI_PAGER when it cuts a long page", async () => {
	setPagerRuntime({ resolvePager: () => undefined });

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
	expect(preview).not.toMatch(/TAIL/);
	expect(preview).toMatch(/set \$PI_PAGER to a full-screen pager \(e\.g\. less\) to view the full page/);
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
	expect(lines).toContain("alpha");
	expect(lines).toContain("zeta");
	expect(lines.indexOf("alpha"), lines).toBeLessThan(lines.indexOf("zeta"));
	expect(lines).toMatch(/enter view/);
});

test("resolvePager keeps fallback less interactive without changing LESS", () => {
	for (const PAGER of [undefined, "", "   "]) {
		const env = { PI_PAGER: PAGER, PAGER, LESS: "-FRX" };
		expect(resolvePager(env, "linux", () => true)).toStrictEqual({ cmd: "less", args: ["-R", "-+F", "-+X"] });
		expect(env).toStrictEqual({ PI_PAGER: PAGER, PAGER, LESS: "-FRX" });
	}
	expect(resolvePager({}, "darwin", () => true)).toStrictEqual({ cmd: "less", args: ["-R", "-+F", "-+X"] });
	expect(resolvePager({}, "linux", () => false)).toBeUndefined();
	// Windows never probes less — $PI_PAGER/$PAGER are the only way to get a pager.
	expect(resolvePager({}, "win32", () => expect.unreachable("must not probe on Windows"))).toBeUndefined();
});

test("resolvePager prefers PI_PAGER over PAGER and falls back when it is blank", () => {
	const noProbe = () => expect.unreachable("configured pagers must not probe less");
	expect(resolvePager({ PI_PAGER: "batcat --plain", PAGER: "more" }, "linux", noProbe)).toStrictEqual({ cmd: "batcat", args: ["--plain", "--paging=always"] });
	expect(resolvePager({ PI_PAGER: "less -R" }, "linux", noProbe)).toStrictEqual({ cmd: "less", args: ["-R", "-+F", "-+X"] });
	for (const PI_PAGER of [undefined, "", "   "]) {
		expect(resolvePager({ PI_PAGER, PAGER: "most -s" }, "linux", noProbe), `PI_PAGER=${JSON.stringify(PI_PAGER)}`).toStrictEqual({ cmd: "most", args: ["-s"] });
	}
});

const catAndMoreCases: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }[] = [
	{ env: { PI_PAGER: "cat" }, platform: "linux" },
	{ env: { PAGER: "cat" }, platform: "linux" },
	{ env: { PI_PAGER: "cat", PAGER: "less" }, platform: "linux" },
	{ env: { PAGER: "/bin/cat -v" }, platform: "darwin" },
	{ env: { PAGER: "C:\\tools\\CAT.EXE" }, platform: "win32" },
	{ env: { PAGER: "more" }, platform: "linux" },
	{ env: { PI_PAGER: "/usr/bin/more -d", PAGER: "less" }, platform: "linux" },
	{ env: { PAGER: "C:\\Windows\\System32\\more.com" }, platform: "win32" },
];

test.for(catAndMoreCases)("resolvePager treats cat and more pagers as no pager so the inline preview is used ($env on $platform)", ({ env, platform }) => {
	const noProbe = () => expect.unreachable("cat and more must not fall back to less");
	expect(resolvePager(env, platform, noProbe), `${platform}: ${JSON.stringify(env)}`).toBeUndefined();
});

test("resolvePager treats cat and more pagers as no pager so the inline preview is used", () => {
	const noProbe = () => expect.unreachable("cat and more must not fall back to less");
	// Only the effective pager matters: PI_PAGER still wins over PAGER=cat.
	expect(resolvePager({ PI_PAGER: "less", PAGER: "cat" }, "linux", noProbe)).toStrictEqual({ cmd: "less", args: ["-+F", "-+X"] });
});

test("resolvePager overrides quit-if-one-screen and no-init for configured less executables", () => {
	const cases: { pager: string; platform: NodeJS.Platform; cmd: string; args: string[] }[] = [
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
		expect(resolvePager(env, platform, () => expect.unreachable("configured pagers must not probe less")), `${platform}: ${pager}`).toStrictEqual({ cmd, args });
		expect(env).toStrictEqual({ PAGER: pager, LESS: "-FRX" });
	}
});

test("resolvePager forces paging for configured bat executables", () => {
	const cases: { pager: string; platform: NodeJS.Platform; cmd: string; args: string[] }[] = [
		{ pager: "bat", platform: "linux", cmd: "bat", args: ["--paging=always"] },
		{ pager: "batcat --plain", platform: "linux", cmd: "batcat", args: ["--plain", "--paging=always"] },
		{ pager: "bat --paging=never", platform: "linux", cmd: "bat", args: ["--paging=never", "--paging=always"] },
		{ pager: "/opt/less/bat --plain", platform: "linux", cmd: "/opt/less/bat", args: ["--plain", "--paging=always"] },
		{ pager: "/usr/bin/batcat -p --", platform: "linux", cmd: "/usr/bin/batcat", args: ["-p", "--paging=always", "--"] },
		{ pager: "bat.exe --plain", platform: "win32", cmd: "bat.exe", args: ["--plain", "--paging=always"] },
		{ pager: "C:\\tools\\BATCAT.EXE", platform: "win32", cmd: "C:\\tools\\BATCAT.EXE", args: ["--paging=always"] },
	];
	for (const { pager, platform, cmd, args } of cases) {
		expect(resolvePager({ PAGER: pager }, platform, () => expect.unreachable("configured pagers must not probe less")), `${platform}: ${pager}`).toStrictEqual({ cmd, args });
	}
});

test("resolvePager leaves other pagers and wrappers unchanged", () => {
	const cases: { pager: string; platform: NodeJS.Platform; cmd: string; args: string[] }[] = [
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
		expect(resolvePager({ PAGER: pager }, platform, () => expect.unreachable("configured pagers must not probe less")), `${platform}: ${pager}`).toStrictEqual({ cmd, args });
	}
});

test("spawnPager rejects with a readable error when the pager binary is missing", async ({ skip }) => {
	if (process.platform === "win32") {
		skip("shell: true reports a missing binary only as a cmd.exe exit code");
	}
	await expect(spawnPager("body", { cmd: "pi-schematic-definitely-missing-xyz", args: [] })).rejects.toThrow(/pi-schematic-definitely-missing-xyz not found/);
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

		expect(await readFile(outPath, "utf8")).toBe(body);
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

	await expect(spawnPager(body, { cmd: process.execPath, args: ["-e", "process.exit(0)"] })).resolves.toBeUndefined();
});

test("spawnPager resolves when the pager exits nonzero", async () => {
	await expect(spawnPager("body", { cmd: process.execPath, args: ["-e", "process.exit(1)"] })).resolves.toBeUndefined();
});

test("/notebook enter suspends the TUI, awaits the pager, then restores the TUI and reopens the list", async () => {
	const events: string[] = [];
	const spawned = createDeferred();
	const pagerExit = createDeferred();
	setPagerRuntime({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async (body, pager) => {
			events.push(`spawn:${pager.cmd}:${body}`);
			spawned.resolve();
			await pagerExit.promise;
		},
	});

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
			if (customCalls > 2) {return undefined;}
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
	expect(lifecycle(), "TUI must be stopped before spawn").toStrictEqual(["stop", "spawn:pager:old body"]);
	pagerExit.resolve();
	await handlerPromise;

	expect(lifecycle()).toStrictEqual(["stop", "spawn:pager:old body", "start", "render:force"]);
	expect(customCalls, "list must reopen after pager exits").toBe(2);
	const arrowLine = renders[0].split("\n").find((l) => l.includes("→"));
	assertPresent(arrowLine, `expected a cursor row, got:\n${renders[0]}`);
	expect(arrowLine).toMatch(/zeta/);
	expect(arrowLine).not.toMatch(/alpha/);
});

/**
 * ctx.ui.custom stub: runs beforeEnter, then presses Enter on the first open.
 * Every later open is rendered into `reopens` and closed.
 */
function enterOnFirstOpen(beforeEnter: () => void | Promise<void> = () => {}) {
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
		await beforeEnter();
		overlay.handleInput("\r");
		return result;
	};
	return { custom, reopens };
}

test("/notebook pager interaction installs and removes a SIGINT guard", async () => {
	const baselineSigint = process.listeners("SIGINT").length;
	let duringSpawnListenerCount = -1;
	setPagerRuntime({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async () => {
			duringSpawnListenerCount = process.listeners("SIGINT").length;
		},
	});

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body" }, undefined, undefined, makeTUICtx());

	await pi.commands.get("notebook")!.handler("", makeTUICtx({ percent: 20, custom: enterOnFirstOpen().custom }));

	expect(duringSpawnListenerCount, "SIGINT guard must be installed during pager").toBe(baselineSigint + 1);
	expect(process.listeners("SIGINT"), "SIGINT guard must be removed after pager").toHaveLength(baselineSigint);
});

test("openInPager removes the SIGINT guard even if tui.start throws", async () => {
	const baselineSigint = process.listeners("SIGINT").length;
	setPagerRuntime({ spawnPager: async () => {} });

	const tui = {
		stop: () => {},
		start: () => { throw new Error("start boom"); },
		requestRender: () => {},
	};

	await expect(openInPager(tui as any, "body", { cmd: "pager", args: [] })).rejects.toThrow(/start boom/);
	expect(process.listeners("SIGINT"), "SIGINT guard must not leak when tui.start throws").toHaveLength(baselineSigint);
});

test("openInPager propagates a tui.stop failure without spawning, guarding SIGINT, or restarting", async () => {
	const baselineSigint = process.listeners("SIGINT").length;
	const spawnPager = vi.fn(async () => {});
	setPagerRuntime({ spawnPager });

	const start = vi.fn();
	const tui = {
		stop: () => { throw new Error("stop boom"); },
		start,
		requestRender: () => {},
	};

	await expect(openInPager(tui as any, "body", { cmd: "pager", args: [] })).rejects.toThrow(/stop boom/);
	expect(spawnPager, "pager must not spawn when tui.stop throws").not.toHaveBeenCalled();
	expect(process.listeners("SIGINT"), "SIGINT guard must not leak when tui.stop throws").toHaveLength(baselineSigint);
	expect(start, "TUI must not restart after a failed stop").not.toHaveBeenCalled();
});

test("/notebook surfaces pager spawn errors as a warning notification", async () => {
	setPagerRuntime({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager: async () => { throw new Error("boom"); },
	});

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "body" }, undefined, undefined, makeTUICtx());

	const notifications: { message: string; level: string }[] = [];
	await pi.commands.get("notebook")!.handler("", makeTUICtx({
		percent: 20,
		notify: (message: string, level: string) => { notifications.push({ message, level }); },
		custom: enterOnFirstOpen().custom,
	}));

	expect(notifications).toStrictEqual([{ message: "pager failed: boom", level: "warning" }]);
});

test("/notebook reopens the list when the selected page vanished while it was open", async () => {
	const spawnPager = vi.fn(async () => {});
	setPagerRuntime({
		resolvePager: () => ({ cmd: "pager", args: [] }),
		spawnPager,
	});

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
	const boundary = results.find((result) => result !== undefined) as { entries: Record<string, unknown>[] };
	branch = boundary.entries.map((entry, index) => ({ ...entry, id: `entry-${index}` }));

	// turn_start applies the discard after the list was built with alpha and before Enter selects it.
	const { custom, reopens } = enterOnFirstOpen(async () => {
		await callHandlers(pi, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 }, handoffCtx);
	});
	await pi.commands.get("notebook")!.handler("", makeTUICtx({ percent: 20, custom }));

	expect(reopens, "list must reopen instead of closing").toHaveLength(1);
	expect(reopens[0]).toMatch(/Notebook \(0 pages\)/);
	expect(spawnPager, "a vanished page must not open the pager").not.toHaveBeenCalled();
});

test("/notebook inline preview returns to the list on any key when no pager is available", async () => {
	setPagerRuntime({ resolvePager: () => undefined });

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

	expect(customCalls, "list must reopen after the inline preview").toBe(2);
	const arrowLine = renders[0].split("\n").find((l) => l.includes("→"));
	assertPresent(arrowLine, `expected a cursor row, got:\n${renders[0]}`);
	expect(arrowLine).toMatch(/zeta/);
	expect(arrowLine).not.toMatch(/alpha/);
});

test("/notebook selecting an empty-content page opens the preview instead of closing the picker", async () => {
	setPagerRuntime({ resolvePager: () => undefined });

	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	await notebookWrite.execute("1", { name: "alpha", content: "" }, undefined, undefined, makeTUICtx());

	const done = vi.fn();
	await pi.commands.get("notebook")!.handler("", makeTUICtx({
		percent: 20,
		custom: async (build: any) => {
			const overlay = build({ requestRender: () => {} }, theme, {}, done);
			overlay.handleInput("\r"); // Enter on the empty-content page
			expect(done, "an empty page body must not close the picker early").not.toHaveBeenCalled();
			const preview = stripAnsi(overlay.render(120).join("\n"));
			expect(preview, "inline preview header must show the page name").toMatch(/alpha/);
			overlay.handleInput(" "); // any key leaves the inline preview
			expect(done).toHaveBeenCalledOnce();
		},
	}));
});

// ── saveNotebookPage tests ────────────────────────────────────────────

test("saveNotebookPage serializes concurrent writes and preserves completion order", async () => {
	const pi = await createTestHost();
	const state = createState();
	const firstGate = createDeferred();
	const order: string[] = [];

	const first = saveNotebookPage(pi, state, "entry-a", "first", async () => {
		order.push("first:start");
		await firstGate.promise;
		order.push("first:end");
	});
	const second = saveNotebookPage(pi, state, "entry-a", "second", async () => {
		order.push("second:start");
	});
	// Both writes hold the module-level lock, so a failing check must not leave them running into the next test.
	onTestFinished(async () => {
		firstGate.resolve();
		await Promise.allSettled([first, second]);
	});

	await Promise.resolve();
	expect(order).toStrictEqual(["first:start"]);
	firstGate.resolve();
	await Promise.all([first, second]);

	expect(order).toStrictEqual(["first:start", "first:end", "second:start"]);
	expect(state.notebookPages.get("entry-a")).toBe("second");
	expect(pi.appendedEntries.map((entry) => entry.data.content)).toStrictEqual(["first", "second"]);
});

test("saveNotebookPage keeps write order across runtime singleton swaps", async () => {
	const pi = await createTestHost();
	const state = createState();
	const previousSingletons = getSingletons();
	const firstGate = createDeferred();
	const order: string[] = [];

	try {
		const first = saveNotebookPage(pi, state, "entry-a", "first", async () => {
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
		const second = saveNotebookPage(pi, state, "entry-a", "second", async () => {
			order.push("second:start");
		});

		await Promise.resolve();
		expect(order).toStrictEqual(["first:start"]);
		firstGate.resolve();
		await Promise.all([first, second]);

		expect(order).toStrictEqual(["first:start", "first:end", "second:start"]);
		expect(state.notebookPages.get("entry-a")).toBe("second");
	} finally {
		firstGate.resolve();
		resetNotebookWriteLock();
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage rejects true reentrancy explicitly", async () => {
	const pi = await createTestHost();
	const state = createState();

	await expect(saveNotebookPage(pi as any, state, "outer", "outer", async () => {
		await saveNotebookPage(pi, state, "inner", "inner");
	})).rejects.toThrow(/not reentrant/i);
	expect(state.notebookPages.size).toBe(0);
});

test("saveNotebookPage stays non-reentrant across runtime singleton swaps", async () => {
	const pi = await createTestHost();
	const state = createState();
	const previousSingletons = getSingletons();

	try {
		await expect(Promise.race([
			saveNotebookPage(pi as any, state, "outer", "outer", async () => {
				__setSingletons({
					writeLock: createWriteLock(),
					writeContext: new AsyncLocalStorage<true>(),
					frameScheduler: getSingletons().frameScheduler,
				});
				await saveNotebookPage(pi, state, "inner", "inner");
			}),
			new Promise<never>((_, reject) => {
				setTimeout(() => { reject(new Error("timeout")); }, 1000);
			}),
		])).rejects.toThrow(/not reentrant/i);
		expect(state.notebookPages.size).toBe(0);
	} finally {
		resetNotebookWriteLock();
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage releases the lock when assertWritable throws", async () => {
	const pi = await createTestHost();
	const state = createState();

	await expect(saveNotebookPage(pi as any, state, "broken", "value", async () => {
		throw new Error("blocked");
	})).rejects.toThrow(/blocked/);
	await expect(saveNotebookPage(pi as any, state, "fresh", "value")).resolves.toMatchObject({ clipped: false });
	expect(state.notebookPages.get("fresh")).toBe("value");
});

test("resetNotebookWriteLock clears abandoned lock state for later writes", async () => {
	const pi = await createTestHost();
	const state = createState();
	const gate = createDeferred();
	void saveNotebookPage(pi, state, "stuck", "value", async () => {
		await gate.promise;
	});
	await Promise.resolve();
	resetNotebookWriteLock();

	await expect(saveNotebookPage(pi as any, state, "fresh", "value")).resolves.toMatchObject({ clipped: false });
	expect(state.notebookPages.get("fresh")).toBe("value");
	gate.resolve();
});


test("saveNotebookPage truncates oversized content before persisting", async () => {
	const pi = await createTestHost();
	const state = createState();
	const content = "first line\n" + "detail\n".repeat(3000);

	const result = await saveNotebookPage(pi, state, "large-page", content);
	const persisted = pi.appendedEntries[0].data.content;

	expect(persisted.length, "oversized notebook content should be truncated").toBeLessThan(content.length);
	expect(state.notebookPages.get("large-page")).toBe(persisted);
	expect(result.preview).toBe("first line");
	expect(persisted).toMatch(/^first line/m);
});


test("resetState clears epoch and the next notebook write starts a fresh generation", async () => {
	const pi = await createTestHost();
	const state = createState();

	await saveNotebookPage(pi, state, "entry-a", "first");
	await saveNotebookPage(pi, state, "entry-b", "second");
	expect(state.epoch).toBe(1);
	expect(pi.appendedEntries[0].data.epoch).toBe(1);
	expect(pi.appendedEntries[1].data.epoch).toBe(1);

	resetState(state);
	expect(state.epoch).toBe(0);

	await saveNotebookPage(pi, state, "entry-c", "third");
	expect(state.epoch).toBe(1);
	expect(pi.appendedEntries[2].data.epoch).toBe(1);
});

// ── Notebook tool definition metadata tests ───────────────────────────

test("notebook tool definitions include prompt hints when withPromptHints is true", async () => {
	const pi = await createTestHost();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi, state, { withPromptHints: true });

	for (const tool of tools) {
		expect(tool.promptSnippet, `${tool.name} should have promptSnippet when withPromptHints=true`).toBeTypeOf("string");
		expect(tool.promptGuidelines, `${tool.name} should have promptGuidelines when withPromptHints=true`).toSatisfy(Array.isArray);
	}
	const notebookWrite = tools.find(t => t.name === "notebook_write")!;
	const notebookRead = tools.find(t => t.name === "notebook_read")!;
	const notebookIndex = tools.find(t => t.name === "notebook_index")!;

	// Structural invariants: all guidelines exist and are non-trivial
	for (const tool of tools) {
		expect(tool.promptGuidelines!.length, `${tool.name} should have at least 2 promptGuidelines`).toBeGreaterThanOrEqual(2);
		expect(tool.promptGuidelines!.filter((g: string) => !(g.length > 10)), `${tool.name} each guideline should be non-trivial`).toStrictEqual([]);
	}

	// Conceptual: notebook_write is future-context oriented
	const writeGuidelines = notebookWrite.promptGuidelines!.join(" ");
	expect(writeGuidelines).toMatch(/subject-oriented pages/i);
	expect(writeGuidelines).toMatch(/fresh context/i);
	expect(writeGuidelines).toMatch(/belongs in handoff/i);
	expect(notebookIndex.promptGuidelines!.join(" ")).toMatch(/relevant memory pages/i);

	// Conceptual: descriptions mention the notebook-page metaphor and durable memory contract
	expect(notebookWrite.description).toMatch(/page|future contexts/i);
	expect(JSON.stringify(notebookWrite.parameters)).toMatch(/high-value knowledge/i);
	expect(JSON.stringify(notebookWrite.parameters)).not.toMatch(/grounding/i);
	expect(notebookRead.description).toMatch(/notebook page|page/i);
	expect(notebookRead.description).toMatch(/truncation notice/i);
	expect(notebookIndex.description).toMatch(/notebook index|index/i);
});

test("notebook tool definitions omit prompt hints by default", async () => {
	const pi = await createTestHost();
	const state = createState();
	const tools = createNotebookToolDefinitions(pi, state);

	for (const tool of tools) {
		expect(tool.promptSnippet, `${tool.name} should not have promptSnippet by default`).toBeUndefined();
		expect(tool.promptGuidelines, `${tool.name} should not have promptGuidelines by default`).toBeUndefined();
	}
});

// ── Handoff notebook discard drafts ───────────────────────────────────

async function notebookWithPages(pages: Record<string, string>) {
	const pi = await createTestHost();
	const state = createState();
	for (const [name, content] of Object.entries(pages)) {
		await saveNotebookPage(pi, state, name, content);
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

	expect(Array.from(state.notebookPages.entries())).toStrictEqual(pagesBefore);
	expect(state.epoch).toBe(1);
	expect(state.discardEpochWatermark).toBe(0);
});

test("buildNotebookDiscardDrafts closes the current generation, stages survivors and opens the next generation", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });

	const { drafts, discarded } = buildNotebookDiscardDrafts(state, ["page-b"]);

	expect(discarded).toBe(1);
	expect(drafts).toStrictEqual([
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
	expect(survivor.data).toStrictEqual({ version: 1, epoch: 2, name: "keep", content: L(2000), clipped: true });
});

test("buildNotebookDiscardDrafts moves past the discard watermark", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	state.discardEpochWatermark = 4;

	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	expect(drafts.map((draft) => (draft.data as { epoch: number }).epoch)).toStrictEqual([1, 5, 5]);
});

test("buildNotebookDiscardDrafts ignores unknown and repeated names", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });

	const result = buildNotebookDiscardDrafts(state, ["page-a", "ghost", "page-a"]);

	expect(result.discarded).toBe(1);
	expect(result).toStrictEqual(buildNotebookDiscardDrafts(state, ["page-a"]));
});

test("buildNotebookDiscardDrafts writes nothing when no named page exists", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a" });

	expect(buildNotebookDiscardDrafts(state, ["ghost"])).toStrictEqual({ drafts: [], discarded: 0 });
	expect(buildNotebookDiscardDrafts(state, [])).toStrictEqual({ drafts: [], discarded: 0 });
});

test("discard drafts written to a branch make the survivors the active generation", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	const restored = restoredFrom(branchWith(pi, drafts));

	expect(Array.from(restored.notebookPages.entries())).toStrictEqual([["page-b", "content-b"]]);
	expect(restored.epoch).toBe(2);
	expect(restored.discardEpochWatermark).toBe(2);
});

test("discarding every page leaves an empty next generation", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { drafts, discarded } = buildNotebookDiscardDrafts(state, ["page-a", "page-b"]);

	const restored = restoredFrom(branchWith(pi, drafts));

	expect(discarded).toBe(2);
	expect(Array.from(restored.notebookPages.entries())).toStrictEqual([]);
	expect(restored.epoch).toBe(2);
});

test("survivors staged without their closing generation marker stay invisible to rehydration", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });
	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	const restored = restoredFrom(branchWith(pi, drafts.slice(0, -1)));

	expect(Array.from(restored.notebookPages.entries()).sort()).toStrictEqual([
		["page-a", "content-a"], ["page-b", "content-b"], ["page-c", "content-c"],
	]);
	expect(restored.epoch).toBe(1);
	expect(restored.discardEpochWatermark).toBe(2);
});

test("rehydration uses only the active session branch", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
	const [handler] = pi.handlers.get("session_start")!;

	await handler({}, { sessionManager: { getBranch: () => [
		{ type: "custom", customType: "notebook-entry", data: { epoch: 1, name: "active", content: "kept" } },
		{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
	] } });

	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["active", "kept"]]);
});

test("a discard after orphaned staged survivors uses a fresh epoch and does not resurrect them", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });
	// An earlier pass discarding page-b staged survivors at epoch 2 and never closed that generation.
	const orphanDrafts = buildNotebookDiscardDrafts(state, ["page-b"]).drafts.slice(0, -1);

	const restarted = restoredFrom(branchWith(pi, orphanDrafts));
	const retry = buildNotebookDiscardDrafts(restarted, ["page-a"]);
	const restored = restoredFrom(branchWith(pi, [...orphanDrafts, ...retry.drafts]));

	expect(retry.drafts.map((draft) => (draft.data as { epoch: number }).epoch)).toStrictEqual([1, 3, 3, 3]);
	expect(Array.from(restored.notebookPages.entries()).sort()).toStrictEqual([
		["page-b", "content-b"], ["page-c", "content-c"],
	]);
	expect(restored.epoch).toBe(3);
});

test("branch invalidation preserves the discard watermark until reconstruction derives a fresh one", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const orphan = branchWith(pi, buildNotebookDiscardDrafts(state, ["page-a"]).drafts.slice(0, -1));
	reconstructNotebook(state, orphan);
	expect(state.discardEpochWatermark).toBe(2);

	// Branch switch must not prematurely drop the watermark: a retry that reuses
	// the staged epoch would resurrect orphaned survivors.
	invalidateHandoffState(state);
	expect(state.discardEpochWatermark, "invalidation alone must not reset the watermark").toBe(2);

	// A fresh branch with no staged survivors resets the derived watermark.
	reconstructNotebook(state, []);
	expect(state.epoch).toBe(0);
	expect(state.discardEpochWatermark).toBe(0);
});

test("resetState clears the discard watermark for a fresh session", async () => {
	const { pi, state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	reconstructNotebook(state, branchWith(pi, buildNotebookDiscardDrafts(state, ["page-a"]).drafts.slice(0, -1)));
	expect(state.discardEpochWatermark).toBe(2);

	resetState(state);
	expect(state.discardEpochWatermark, "/new must reset the watermark with the session").toBe(0);
	expect(state.epoch).toBe(0);
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
	expect(indexResult.details.entries).toStrictEqual(["page-a", "page-b"]);

	// Navigate to B — pages immediately follow the active branch.
	await sessionTree({}, treeCtx(branchB));
	indexResult = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	expect(indexResult.details.entries).toStrictEqual(["page-x", "page-y"]);

	// A write on B uses B's committed epoch and lands on B's pages.
	await notebookWrite.execute("3", { name: "page-z", content: "z-v1" }, undefined, undefined, makeTUICtx({ hasUI: false }));
	expect(pi.appendedEntries.at(-1)!.data.epoch, "write on B must use B's committed epoch").toBe(2);
	indexResult = await notebookIndex.execute("4", {}, undefined, undefined, {} as any);
	expect(indexResult.details.entries).toStrictEqual(["page-x", "page-y", "page-z"]);

	// Back to A — A's branch-scoped pages restored, epoch follows A again.
	await sessionTree({}, treeCtx(branchA));
	indexResult = await notebookIndex.execute("5", {}, undefined, undefined, {} as any);
	expect(indexResult.details.entries, "returning to A must restore its pages").toStrictEqual(["page-a", "page-b"]);
	await notebookWrite.execute("6", { name: "page-a", content: "a-v2" }, undefined, undefined, makeTUICtx({ hasUI: false }));
	expect(pi.appendedEntries.at(-1)!.data.epoch, "write after returning to A must use A's epoch").toBe(1);
});

// ── Notebook write-size contract (issue #42) ───────────────────────────

test("complete write exposes null truncation and false clipped", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);

	const saved = await saveNotebookPage(pi, state, "page", C);
	expect(saved).toStrictEqual({ entries: ["page"], preview: "first", truncation: null, clipped: false });
	expect(pi.appendedEntries[0].data).toStrictEqual({ version: 1, epoch: 1, name: "page", content: C, clipped: false });

	let update: any;
	const result = await notebookWrite.execute("2", { name: "page", content: C }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ hasUI: false }));
	expect((result.content[0] as any).text).toBe(completeFinalText("page", C));
	expect((update.content[0]).text).toBe(completeUpdateText("page", C));
	expect(result.details).toStrictEqual({ entries: ["page"], preview: "first", truncation: null, clipped: false });
	expect(update.details).toStrictEqual({ entries: ["page"], preview: "first", truncation: null, clipped: false });
});

test("line overflow returns exact head and line report", async () => {
	const pi = await createTestHost();
	const state = createState();

	const saved = await saveNotebookPage(pi, state, "page", L(2001));
	expect(state.notebookPages.get("page")).toBe(L(2000));
	expect(saved).toStrictEqual({ entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	expect(pi.appendedEntries[0].data).toStrictEqual({ version: 1, epoch: 1, name: "page", content: L(2000), clipped: true });
});

test("byte overflow retains whole lines and reports bytes (ASCII + UTF-8)", async () => {
	const pi = await createTestHost();
	const state = createState();

	const ascii = await saveNotebookPage(pi, state, "page", B);
	expect(state.notebookPages.get("page")).toBe("a".repeat(25600));
	expect(ascii).toStrictEqual({ entries: ["page"], preview: formatPagePreview("a".repeat(25600)), truncation: Tbytes, clipped: true });
	expect(pi.appendedEntries[0].data).toStrictEqual({ version: 1, epoch: 1, name: "page", content: "a".repeat(25600), clipped: true });

	const utf8 = await saveNotebookPage(pi, state, "page", U);
	expect(state.notebookPages.get("page")).toBe("é".repeat(12800));
	expect(utf8).toStrictEqual({ entries: ["page"], preview: formatPagePreview("é".repeat(12800)), truncation: Tbytes, clipped: true });
	expect(pi.appendedEntries[1].data).toStrictEqual({ version: 1, epoch: 1, name: "page", content: "é".repeat(12800), clipped: true });
});

test("write final and update text report clipping without a badge", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);

	let update: any;
	const result = await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ hasUI: false }));

	const body = L(2000);
	expect((result.content[0] as any).text).toBe(clippedFinalText("page", body, ReportLines));
	expect(update.content[0].text).toBe(clippedUpdateText("page", body, ReportLines));
	expect(result.details).toStrictEqual({ entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	expect(update.details).toStrictEqual({ entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	expect((result.content[0] as any).text).not.toMatch(/\[truncated\]/);
	expect(update.content[0].text).not.toMatch(/\[truncated\]/);
});

test("write final and update text report byte clipping", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);

	let update: any;
	const result = await notebookWrite.execute("1", { name: "page", content: B }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ hasUI: false }));

	const body = "a".repeat(25600);
	expect((result.content[0] as any).text).toBe(clippedFinalText("page", body, ReportBytes));
	expect(update.content[0].text).toBe(clippedUpdateText("page", body, ReportBytes));
	expect(result.details).toStrictEqual({ entries: ["page"], preview: formatPagePreview(body), truncation: Tbytes, clipped: true });
	expect(update.details).toStrictEqual(result.details);
	expect((result.content[0] as any).text).toMatch(/TRUNCATED by bytes/);
});

test("read appends a generic notice only for a flagged page", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead] = createNotebookToolDefinitions(pi, state);

	await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, undefined, makeTUICtx({ hasUI: false }));
	const clipped = await notebookRead.execute("2", { name: "page" }, undefined, undefined, {} as any);
	const body = L(2000);
	expect((clipped.content[0] as any).text).toBe(`${readBase("page", body)}\n\n${Notice}`);
	expect((clipped.content[0] as any).text.split(Notice).length - 1).toBe(1);
	expect(clipped.details).toStrictEqual({ entries: ["page"], found: true, body, clipped: true });

	await notebookWrite.execute("3", { name: "page", content: C }, undefined, undefined, makeTUICtx({ hasUI: false }));
	const complete = await notebookRead.execute("4", { name: "page" }, undefined, undefined, {} as any);
	expect((complete.content[0] as any).text).toBe(readBase("page", C));
	expect((complete.content[0] as any).text).not.toMatch(/Notice:/);
	expect(complete.details).toStrictEqual({ entries: ["page"], found: true, body: C, clipped: false });
});

test("oversized first line rejects a new page without side effects", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, , notebookIndex] = createNotebookToolDefinitions(pi, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };

	for (const content of [R, UR]) {
		await expect(saveNotebookPage(pi as any, state, "page", content)).rejects.toThrow(new Error(rejectMessage("page")));
	}

	const onUpdate = vi.fn();
	await expect(notebookWrite.execute("1", { name: "page", content: R }, undefined, onUpdate, makeTUICtx({ hasUI: true, record }))).rejects.toThrow(new Error(rejectMessage("page")));
	expect(onUpdate).not.toHaveBeenCalled();
	expect(state.notebookPages.size).toBe(0);
	expect(state.epoch).toBe(0);
	expect(state.discardEpochWatermark).toBe(0);
	expect(pi.appendedEntries).toHaveLength(0);
	expect(record.statuses.size).toBe(0);
	expect(record.widgets.size).toBe(0);

	await saveNotebookPage(pi, state, "page", C);
	expect(state.notebookPages.get("page")).toBe(C);
	const index = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	expect(index.details).toStrictEqual({ entries: ["page"] });
});

test("rejected overwrite preserves prior body and clipped flag", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, notebookRead] = createNotebookToolDefinitions(pi, state);

	await saveNotebookPage(pi, state, "page", C);
	const epochBefore = state.epoch;
	await expect(saveNotebookPage(pi as any, state, "page", R)).rejects.toThrow(new Error(rejectMessage("page")));
	expect(state.notebookPages.get("page")).toBe(C);
	expect(state.epoch).toBe(epochBefore);
	expect(pi.appendedEntries).toHaveLength(1);
	let read = await notebookRead.execute("2", { name: "page" }, undefined, undefined, {} as any);
	expect((read.content[0] as any).text).toBe(readBase("page", C));
	expect((read.details as any).clipped).toBe(false);

	await saveNotebookPage(pi, state, "page", L(2001));
	const epochClipped = state.epoch;
	await expect(saveNotebookPage(pi as any, state, "page", R)).rejects.toThrow(new Error(rejectMessage("page")));
	expect(state.notebookPages.get("page")).toBe(L(2000));
	expect(state.epoch).toBe(epochClipped);
	read = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	expect((read.details as any).clipped).toBe(true);
	expectSuffix((read.content[0] as any).text, `\n\n${Notice}`);
});

test("blank first line plus oversized line rejects and preserves prior page state", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead] = createNotebookToolDefinitions(pi, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const blankFirstLineOverflow = "\n" + "x".repeat(DEFAULT_MAX_BYTES + 1);

	await saveNotebookPage(pi, state, "page", C);
	const epochBefore = state.epoch;
	const entriesBefore = pi.appendedEntries.length;

	await expect(saveNotebookPage(pi as any, state, "page", blankFirstLineOverflow)).rejects.toThrow(new Error(emptyHeadRejectMessage("page")));

	const onUpdate = vi.fn();
	await expect(notebookWrite.execute("2", { name: "page", content: blankFirstLineOverflow }, undefined, onUpdate, makeTUICtx({ hasUI: true, record }))).rejects.toThrow(new Error(emptyHeadRejectMessage("page")));
	expect(onUpdate).not.toHaveBeenCalled();
	expect(state.notebookPages.get("page")).toBe(C);
	expect([...state.clippedPages]).not.toContain("page");
	expect(state.epoch).toBe(epochBefore);
	expect(pi.appendedEntries).toHaveLength(entriesBefore);
	expect(record.statuses.size).toBe(0);
	expect(record.widgets.size).toBe(0);

	// A clipped prior page is equally protected: body, flag, epoch and entries stay.
	await saveNotebookPage(pi, state, "page", L(2001));
	const epochClipped = state.epoch;
	const entriesClipped = pi.appendedEntries.length;
	await expect(saveNotebookPage(pi as any, state, "page", blankFirstLineOverflow)).rejects.toThrow(new Error(emptyHeadRejectMessage("page")));
	const read = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	expect(state.notebookPages.get("page")).toBe(L(2000));
	expect([...state.clippedPages]).toContain("page");
	expect(state.epoch).toBe(epochClipped);
	expect(pi.appendedEntries).toHaveLength(entriesClipped);
	expect((read.details as any).body).toBe(L(2000));
	expect((read.details as any).clipped).toBe(true);

	// An untruncated empty write is still accepted by the new guard.
	await saveNotebookPage(pi, state, "page", "");
	expect(state.notebookPages.get("page")).toBe("");
	expect([...state.clippedPages]).not.toContain("page");
});

test("clipped flag survives fresh reconstruction without persisted quantities", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);
	await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, undefined, makeTUICtx({ hasUI: false }));

	expect(Object.keys(pi.appendedEntries[0].data).sort()).toStrictEqual(["clipped", "content", "epoch", "name", "version"]);
	expect((pi.appendedEntries[0].data).clipped).toBe(true);

	const restored = await rehydratePersistedNotebook(pi);
	const restoredPi = await createTestHost();
	const [, restoredRead] = createNotebookToolDefinitions(restoredPi, restored);
	const read = await restoredRead.execute("1", { name: "page" }, undefined, undefined, {} as any);
	expect((read.details as any).clipped).toBe(true);
	expectSuffix((read.content[0] as any).text, `\n\n${Notice}`);
});

test("complete overwrite clears a durable clipped flag", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite, notebookRead] = createNotebookToolDefinitions(pi, state);

	await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, undefined, makeTUICtx({ hasUI: false }));
	await notebookWrite.execute("2", { name: "page", content: C }, undefined, undefined, makeTUICtx({ hasUI: false }));

	expect((pi.appendedEntries.at(-1)!.data).clipped).toBe(false);
	const read = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	expect(read.details).toStrictEqual({ entries: ["page"], found: true, body: C, clipped: false });
	expect((read.content[0] as any).text).toBe(readBase("page", C));

	const restored = await rehydratePersistedNotebook(pi);
	const restoredPi = await createTestHost();
	const [, restoredRead] = createNotebookToolDefinitions(restoredPi, restored);
	const restoredResult = await restoredRead.execute("4", { name: "page" }, undefined, undefined, {} as any);
	expect((restoredResult.details as any).clipped).toBe(false);
});

test("legacy page entries without clipped read as false", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerNotebookRehydration(api, state); });
	const [handler] = pi.handlers.get("session_start")!;
	await handler({}, { sessionManager: { getBranch: () => [
		{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 1, name: "v1", content: C } },
		{ type: "custom", customType: "notebook-entry", data: { epoch: 1, name: "unversioned", content: C } },
		{ type: "custom", customType: "ledger-entry", data: { epoch: 1, name: "ledger", content: C } },
	] } });

	const toolPi = await createTestHost();
	const [, notebookRead] = createNotebookToolDefinitions(toolPi, state);
	const list = `  ledger: first\n  unversioned: first\n  v1: first`;
	for (const name of ["v1", "unversioned", "ledger"]) {
		const read = await notebookRead.execute("1", { name }, undefined, undefined, {} as any);
		expect((read.content[0] as any).text).toBe(`--- ${name} ---\n${C}\n---\nNotebook Pages:\n${list}`);
		expect(read.details).toStrictEqual({ entries: ["ledger", "unversioned", "v1"], found: true, body: C, clipped: false });
	}
});

test("discard survivor retains its durable clipped flag", async () => {
	const { pi, state } = await notebookWithPages({ drop: C, keep: L(2001) });

	const restored = restoredFrom(branchWith(pi, buildNotebookDiscardDrafts(state, ["drop"]).drafts));

	expect(restored.notebookPages.get("keep")).toBe(L(2000));
	const restoredPi = await createTestHost();
	const [, restoredRead] = createNotebookToolDefinitions(restoredPi, restored);
	const read = await restoredRead.execute("1", { name: "keep" }, undefined, undefined, {} as any);
	expect((read.details as any).clipped).toBe(true);
});

test("formatPageTuiPreview appends a badge only when clipped", async () => {
	const mod = (await import("../../notebook/store.js")) as unknown as Record<string, unknown>;
	expect(mod.formatPageTuiPreview).toBeTypeOf("function");
	const formatPageTuiPreview = mod.formatPageTuiPreview as (content: string, clipped: boolean) => string;

	expect(formatPageTuiPreview(L(2000), true)).toBe("x [truncated]");
	expect(formatPageTuiPreview(C, false)).toBe("first");
	expect(formatPageTuiPreview("p".repeat(81) + "\ntail", true)).toBe("p".repeat(77) + "... [truncated]");
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
	expect(clippedLine).toMatch(/x \[truncated\]/);
	const completeLine = lines.find((line) => line.includes("complete-page"))!;
	expect(completeLine).toMatch(/first/);
	expect(completeLine).not.toMatch(/\[truncated\]/);

	const read = pi.tools.get("notebook_read");
	const clippedRead = await read.execute("3", { name: "clipped-page" }, undefined, undefined, {} as any);
	expect((clippedRead.details).body).toBe(L(2000));
	expect((clippedRead.details).clipped).toBe(true);
	const completeRead = await read.execute("4", { name: "complete-page" }, undefined, undefined, {} as any);
	expect((completeRead.details).body).toBe(C);
	expect((completeRead.details).clipped).toBe(false);
});

test("notebook_write descriptions state the shared write-size semantics", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);

	expectSuffix(notebookWrite.description, DescriptionSuffix);
	const contentDescription = (notebookWrite.parameters as any).properties.content.description as string;
	expectSuffix(contentDescription, DescriptionSuffix);
	expect(JSON.stringify(notebookWrite.parameters)).not.toMatch(/Truncated at 50KB \/ 2000 lines\./);
	expect(notebookWrite.description).not.toMatch(/Truncated at 50KB \/ 2000 lines\./);
});

// ── Notebook write-size green regression net ───────────────────────────

test("plain preview preserves the 80-character boundary", async () => {
	expect(formatPagePreview("p".repeat(80))).toBe("p".repeat(80));
	expect(formatPagePreview("p".repeat(81) + "\ntail")).toBe("p".repeat(77) + "...");
});

test("plain page list and index preserve previews and alphabetical order", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, , notebookIndex] = createNotebookToolDefinitions(pi, state);
	await saveNotebookPage(pi, state, "zeta", "last");
	await saveNotebookPage(pi, state, "alpha", "first");

	const index = await notebookIndex.execute("1", {}, undefined, undefined, {} as any);
	expect(index.details).toStrictEqual({ entries: ["alpha", "zeta"] });
	expect((index.content[0] as any).text).toMatch(/ {2}alpha: first\n {2}zeta: last/);
	expect((index.content[0] as any).text).not.toMatch(/\[truncated\]|Notice:/);
});

test("line overflow retains exactly 2000 whole lines", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi, state, "page", L(2001));
	expect(state.notebookPages.get("page")).toBe(L(2000));
	expect(state.notebookPages.get("page")!.split("\n")).toHaveLength(2000);
});

test("byte overflow preserves the first whole line in ASCII and UTF-8", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi, state, "page", B);
	expect(state.notebookPages.get("page")).toBe("a".repeat(25600));
	expect(state.notebookPages.get("page")!).not.toContain("\n");
	await saveNotebookPage(pi, state, "page", U);
	expect(state.notebookPages.get("page")).toBe("é".repeat(12800));
	expect(state.notebookPages.get("page")!).not.toContain("\n");
});

test("complete and empty bodies remain accepted at the existing caps", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [, notebookRead] = createNotebookToolDefinitions(pi, state);
	const cases: [string, string][] = [["c", C], ["l", L(2000)], ["f", F], ["m", M], ["empty", ""]];
	for (const [name, body] of cases) {
		await saveNotebookPage(pi, state, name, body);
		expect(state.notebookPages.get(name)).toBe(body);
	}
	const read = await notebookRead.execute("1", { name: "empty" }, undefined, undefined, {} as any);
	expect((read.details as any).found).toBe(true);
	expect((read.details as any).body).toBe("");
});

test("complete writes preserve their text list and existing detail fields", async () => {
	const pi = await createTestHost();
	const state = createState();
	const [notebookWrite] = createNotebookToolDefinitions(pi, state);
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	let update: any;

	const result = await notebookWrite.execute("1", { name: "page", content: C }, undefined, (payload: any) => { update = payload; }, makeTUICtx({ percent: 42, record }));
	expect((result.content[0] as any).text).toBe(completeFinalText("page", C));
	expect(update.content[0].text).toBe(completeUpdateText("page", C));
	const project = (details: any) => ({ entries: details.entries, preview: details.preview });
	expect(project(result.details)).toStrictEqual({ entries: ["page"], preview: "first" });
	expect(project(update.details)).toStrictEqual({ entries: ["page"], preview: "first" });
	expect(record.statuses.get("pi-schematic-notebook")).toBe("📒 1");

	const childPi = await createTestHost();
	const childState = createState();
	const [childWrite] = createNotebookToolDefinitions(childPi, childState, { isStale: () => false });
	const childResult = await childWrite.execute("2", { name: "alpha", content: "alpha" }, undefined, undefined, {} as any);
	expect(project(childResult.details)).toStrictEqual({ entries: ["alpha"], preview: "alpha" });
});

test("complete reads preserve their body envelope and existing detail fields", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi, state, "page", C);
	const [, notebookRead] = createNotebookToolDefinitions(pi, state);

	const read = await notebookRead.execute("1", { name: "page" }, undefined, undefined, {} as any);
	expect((read.content[0] as any).text).toBe(readBase("page", C));
	const details = read.details as any;
	expect({ entries: details.entries, found: details.found, body: details.body }).toStrictEqual({ entries: ["page"], found: true, body: C });
	expect((read.content[0] as any).text).not.toMatch(/Notice:|\[truncated\]/);
});

test("model listing surfaces remain free of clipping decorations", async () => {
	const pi = await createTestHost();
	const notebookWrite = pi.tools.get("notebook_write");
	const notebookRead = pi.tools.get("notebook_read");
	const notebookIndex = pi.tools.get("notebook_index");
	let update: any;
	const writeResult = await notebookWrite.execute("1", { name: "page", content: L(2001) }, undefined, (payload: any) => { update = payload; }, makeTUICtx());
	const writeTexts = [(writeResult.content[0]).text, update.content[0].text];
	const indexResult = await notebookIndex.execute("2", {}, undefined, undefined, {} as any);
	const readResult = await notebookRead.execute("3", { name: "page" }, undefined, undefined, {} as any);
	const readText = (readResult.content[0]).text;

	for (const text of [...writeTexts, (indexResult.content[0]).text, readText]) {
		expect(text, `model text must not carry the TUI badge: ${text}`).not.toMatch(/\[truncated\]/);
	}
	for (const text of [...writeTexts, (indexResult.content[0]).text]) {
		expect(text, `notice must not leak into non-read surfaces: ${text}`).not.toMatch(/Notice:/);
	}

	// Notebook section through the real before_agent_start hook.
	const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
	const event = createBeforeAgentStartEvent({ systemPrompt: "Base system prompt." });
	await beforeAgentStart(
		event,
		{ ...makeTUICtx({ hasUI: false }), cwd: process.cwd(), isProjectTrusted: () => false },
	);
	const listing = event.systemPromptOptions.sections.schematic_notebook;
	assertPresent(listing);
	expect(listing).not.toMatch(/\[truncated\]/);
	expect(listing).not.toMatch(/Notice:/);
	expect(listing).toMatch(/ {2}page: x/);
	const assembled = event.systemPrompt;
	expect(assembled).toMatch(/ {2}page: x/);
	expect(assembled).not.toMatch(/\[truncated\]/);
	expect(assembled).not.toMatch(/Notice:/);

	// Spawn prompt through the real child-session seam.
	const proof = await runRealChildInvocation({ prompt: "Do the task.", notebookPages: { page: L(2001) } });
	for (const message of proof.observedMessages) {
		expect(message).not.toMatch(/\[truncated\]/);
		expect(message).not.toMatch(/Notice:/);
	}
});

test("unknown notebook entry types have zero effect on reconstructed state", async () => {
	const pi = await createTestHost();
	const state = createState();
	await saveNotebookPage(pi, state, "page", C);
	pi.appendEntry("unknown-notebook-type", { version: 1, epoch: 9, name: "ghost", content: "x" });
	pi.appendEntry("some-other-entry", { version: 1, epoch: 9 });

	const restored = await rehydratePersistedNotebook(pi);
	expect(restored.epoch).toBe(1);
	expect(restored.discardEpochWatermark).toBe(1);
	expect(Array.from(restored.notebookPages.entries())).toStrictEqual([["page", C]]);
});
