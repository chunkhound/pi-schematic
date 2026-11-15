import { expect, onTestFinished, test, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_MAX_BYTES, SessionManager, type CustomEntryDraft, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { createState, resetState, invalidateHandoffState, type SchematicState } from "../../state.js";
import { registerNotebookRehydration, reconstructNotebook } from "../../notebook/rehydration.js";
import { buildNotebookDiscardDrafts, formatPagePreview, formatPageTuiPreview, saveNotebookPage } from "../../notebook/store.js";
import { resolvePager } from "../../notebook/pager.js";
import { createNotebookToolDefinitions, registerNotebookTools } from "../../notebook/tools.js";
import { __setSingletons, createWriteLock, getSingletons } from "../../runtime-singletons.js";
import { STATUS_KEY_TOPIC, WIDGET_KEY_WARNING } from "../../tui.js";
import { assertPresent, expectSuffix } from "../assertions.js";
import { createDeferred, createToolRenderContext, detailsOf, firstText, recordOf } from "./helpers.js";
import { createModelRegistry } from "../support/model-registry.js";
import { createRunner, type CustomComponentDriver, type RunnerFixture } from "../support/runner.js";
import { appendDrafts } from "../support/session.js";
import { realTheme } from "../support/theme.js";

const ESCAPE = "\x1b";
const CONTEXT_USAGE = { tokens: 84_000, percent: 42, contextWindow: 200_000 };

/** The notebook tools and rehydration over a test-owned state, with the `pi` they registered through. */
interface NotebookHost {
	state: SchematicState;
	fixture: RunnerFixture;
	api: ExtensionAPI;
}

/** Loads the notebook tools and rehydration over a fresh state; with `ui` the recording UI uses the real Theme. */
async function notebookHost(options: { ui?: boolean; activeTools?: string[]; session?: SessionManager } = {}): Promise<NotebookHost> {
	const state = createState();
	const captured: { api?: ExtensionAPI } = {};
	const fixture = await createRunner({
		cwd: process.cwd(),
		mode: options.ui === true ? "tui" : "print",
		factories: [
			(api) => {
				captured.api = api;
				registerNotebookTools(api, state);
				registerNotebookRehydration(api, state);
			},
		],
		sessionManager: options.session ?? SessionManager.inMemory(process.cwd()),
		ui: options.ui === true ? { theme: realTheme } : undefined,
		context: { getContextUsage: () => CONTEXT_USAGE },
		activeTools: options.activeTools ?? [],
	});
	if (captured.api === undefined) {
		throw new Error("The notebook factory did not run.");
	}
	return { state, fixture, api: captured.api };
}

/** The shipped extension, headless or with the recording UI and `custom` driver, at 20% context usage. */
async function shippedHost(options: { custom?: CustomComponentDriver; session?: SessionManager; activeTools?: string[]; headless?: boolean } = {}) {
	return createRunner({
		cwd: process.cwd(),
		mode: options.headless === true ? "print" : "tui",
		sessionManager: options.session ?? SessionManager.inMemory(process.cwd()),
		modelRegistry: await createModelRegistry({}),
		ui: options.headless === true ? undefined : { theme: realTheme, custom: options.custom },
		context: {
			getContextUsage: () => ({ tokens: 40_000, percent: 20, contextWindow: 200_000 }),
			isProjectTrusted: () => false,
		},
		activeTools: options.activeTools ?? [],
	});
}

/** A session holding `entries` as custom entries, in order. */
function sessionWith(entries: readonly { customType: string; data?: unknown }[]): SessionManager {
	const session = SessionManager.inMemory(process.cwd());
	for (const { customType, data } of entries) {
		session.appendCustomEntry(customType, data);
	}
	return session;
}

/** A fresh notebook host rehydrated by `session_start` from `session`. */
async function rehydrated(session: SessionManager): Promise<NotebookHost> {
	const host = await notebookHost({ session });
	await host.fixture.runner.emit({ type: "session_start", reason: "startup" });
	return host;
}

/** The data of the appended entry at `index` (negative counts from the end); throws unless it is an object. */
function appendedData({ fixture }: { fixture: RunnerFixture }, index: number): Record<string, unknown> {
	const entry = fixture.host.appendedEntries.at(index);
	if (entry === undefined) {
		throw new Error(`No appended entry at index ${String(index)}.`);
	}
	return recordOf(entry.data, "the appended entry data");
}

/** An `onUpdate` callback that records each update; `last()` throws when none arrived. */
function recordUpdates() {
	const updates: { content: unknown[]; details: unknown }[] = [];
	return {
		onUpdate: (update: { content: unknown[]; details: unknown }) => {
			updates.push(update);
		},
		last: () => {
			const update = updates.at(-1);
			if (update === undefined) {
				throw new Error("onUpdate was not called.");
			}
			return update;
		},
	};
}

function updateText(update: { content: unknown[] }): string {
	return stringOf(recordOf(update.content.at(0), "the update's first content block").text, "the update's text");
}

function stringOf(value: unknown, what: string): string {
	if (typeof value !== "string") {
		throw new Error(`Expected ${what} to be a string.`);
	}
	return value;
}

function plain(lines: string[]): string {
	return stripTerminalSequences(lines.join("\n"));
}

/**
 * A `ctx.ui.custom` driver for the /notebook list: the n-th opened list is rendered into `renders`,
 * then `opens[n]` acts on it; a list opened after the last step is closed with Esc.
 */
function listDriver(...opens: ((component: Component) => void | Promise<void>)[]) {
	const renders: string[] = [];
	let calls = 0;
	const driver: CustomComponentDriver = async (component) => {
		const open = opens.at(calls);
		calls++;
		renders.push(plain(component.render(120)));
		if (open === undefined) {
			component.handleInput?.(ESCAPE);
			return;
		}
		await open(component);
	};
	return {
		driver,
		renders,
		get opened() {
			return calls;
		},
	};
}

function press(component: Component, ...keys: string[]): void {
	for (const key of keys) {
		component.handleInput?.(key);
	}
}

/** Runs `/notebook` on the shipped extension with no pager configured. */
async function runNotebook(fixture: RunnerFixture, args = ""): Promise<void> {
	await fixture.command("notebook").handler(args, fixture.runner.createCommandContext());
}

async function writePage(fixture: RunnerFixture, name: string, content: string): Promise<void> {
	await fixture.tool("notebook_write").execute("seed", { name, content });
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
const A77 = "a".repeat(77) + "...";

const Tlines = { truncatedBy: "lines", totalLines: 2001, totalBytes: 4001, outputLines: 2000, outputBytes: 3999 } as const;
const Tbytes = { truncatedBy: "bytes", totalLines: 2, totalBytes: 51201, outputLines: 1, outputBytes: 25600 } as const;
const ReportLines = "TRUNCATED by lines: kept 2000 of 2001 lines (3999 of 4001 bytes); tail dropped. Split this page into smaller pages.";
const ReportBytes = "TRUNCATED by bytes: kept 1 of 2 lines (25600 of 51201 bytes); tail dropped. Split this page into smaller pages.";
const Notice = "Notice: This page was clipped at write time; its stored body is incomplete.";
const rejectMessage = (name: string) =>
	`Notebook page "${name}" rejected: first line exceeds 50 KiB (51200 bytes). Split it into shorter lines or smaller pages.`;
const emptyHeadRejectMessage = (name: string) =>
	`Notebook page "${name}" rejected: the first non-empty line exceeds 50 KiB (51200 bytes), so truncation would retain no content. Split it into shorter lines or smaller pages.`;
const DescriptionSuffix =
	"Content is limited to 2000 lines / 50 KiB (51200 bytes). The beginning is kept, the tail is dropped, and truncation is reported. A write whose retained head would be empty (for example, an oversized first line) is rejected.";

/** The read envelope of a single page `page` whose preview is `preview`. */
function readBase(body: string, preview: string): string {
	return `--- page ---\n${body}\n---\nNotebook Pages:\n  page: ${preview}`;
}

// ── Notebook rehydration tests ────────────────────────────────────────

test("notebook rehydration rebuilds the latest epoch and enables notebook tools", async () => {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 1, name: "old", content: "old" });
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 2, name: "keep", content: "new" });
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 2, name: "keep", content: "newer" });
	const { state, fixture } = await notebookHost({ session, activeTools: ["read", "notebook_read"] });

	await fixture.runner.emit({ type: "session_start", reason: "startup" });

	expect(state.epoch).toBe(2);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["keep", "newer"]]);
	expect(fixture.host.activeTools, "notebook_index is added once, notebook_read is not repeated").toStrictEqual(["read", "notebook_read", "notebook_index"]);
});

test("notebook rehydration clears stale in-memory notebook state when persisted history is empty", async () => {
	const { state, fixture } = await notebookHost();
	state.epoch = 7;
	state.notebookPages.set("stale", "stale body");

	await fixture.runner.emit({ type: "session_start", reason: "startup" });

	expect(state.epoch).toBe(0);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([]);
	expect(fixture.host.activeTools).toStrictEqual(["notebook_read", "notebook_index"]);
});

test("future-version notebook entries have zero effect on rehydrated state", async () => {
	const writer = await notebookHost();
	// Real writes through the real store (both land at epoch 1).
	await saveNotebookPage(writer.api, writer.state, "current", "ok");
	await saveNotebookPage(writer.api, writer.state, "other", "old");
	const session = sessionWith(writer.fixture.host.appendedEntries);
	// A future-format writer: no existing writer emits version 2, so the version discriminator is
	// the only synthetic field; envelope and payload match a real future entry.
	session.appendCustomEntry("notebook-generation", { version: 2, epoch: 9 });
	session.appendCustomEntry("notebook-entry", { version: 2, epoch: 9, name: "future", content: "x" });

	const { state } = await rehydrated(session);

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

test("page entries without a version field have no effect on rehydrated state", async () => {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 1, name: "current", content: "new", clipped: false });
	session.appendCustomEntry("notebook-entry", { epoch: 1, name: "legacy", content: "old" });
	session.appendCustomEntry("notebook-entry", { epoch: 3, name: "later", content: "old" });

	const { state } = await rehydrated(session);

	expect(state.epoch).toBe(1);
	expect(state.discardEpochWatermark).toBe(1);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["current", "new"]]);
});

test("session_start rehydrates the latest persisted notebook state through the full hook chain", async () => {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 6, name: "stale", content: "old" });
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 8, name: "keep", content: "fresh" });
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 8, name: "keep", content: "newer" });
	const fixture = await shippedHost({ session, headless: true, activeTools: ["read", "notebook_read"] });
	await writePage(fixture, "stale-page", "stale body");

	await fixture.runner.emit({ type: "session_start", reason: "resume" });

	const indexResult = await fixture.tool("notebook_index").execute("1", {});
	expect(detailsOf(indexResult).entries).toStrictEqual(["keep"]);
	const readResult = await fixture.tool("notebook_read").execute("2", { name: "keep" });
	expect(detailsOf(readResult).found).toBe(true);
	expect(detailsOf(readResult).body).toBe("newer");
	expect(fixture.host.activeTools).toStrictEqual(["read", "notebook_read", "notebook_index"]);
});

// ── Notebook tool contract tests ──────────────────────────────────────

test("notebook tools add/get/list return stable contract details", async () => {
	const host = await notebookHost();
	const { state, fixture } = host;

	const addResult = await fixture.tool("notebook_write").execute("1", { name: "entry-a", content: "first line\nsecond line" });
	expect(addResult.details).toStrictEqual({ entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
	expect(state.notebookPages.get("entry-a")).toBe("first line\nsecond line");
	expect(fixture.host.appendedEntries).toHaveLength(1);
	expect(fixture.host.appendedEntries[0].customType).toBe("notebook-entry");
	expect(appendedData(host, 0).name).toBe("entry-a");

	const getResult = await fixture.tool("notebook_read").execute("2", { name: "entry-a" });
	const details = detailsOf(getResult);
	expect(details.found).toBe(true);
	expect(details.entries).toStrictEqual(["entry-a"]);
	expect(firstText(getResult)).toMatch(/--- entry-a ---/);
	expect(firstText(getResult)).toMatch(/second line/);

	const listResult = await fixture.tool("notebook_index").execute("3", {});
	expect(listResult.details).toStrictEqual({ entries: ["entry-a"] });
	expect(firstText(listResult)).toMatch(/entry-a: first line/);
});

test("notebook tools reject access once their isStale callback reports stale", async () => {
	const { state, fixture, api } = await notebookHost();
	state.notebookPages.set("entry-a", "alpha");
	let stale = false;
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(api, state, { isStale: () => stale });
	const ctx = fixture.runner.createToolContext("1", undefined);

	stale = true;
	await expect(notebookWrite.execute("1", { name: "entry-a", content: "alpha" }, undefined, undefined, ctx)).rejects.toThrow(/invalidated by reset/i);
	await expect(notebookRead.execute("2", { name: "entry-a" }, undefined, undefined, ctx)).rejects.toThrow(/invalidated by reset/i);
	await expect(notebookIndex.execute("3", {}, undefined, undefined, ctx)).rejects.toThrow(/invalidated by reset/i);
	expect(state.notebookPages.get("entry-a")).toBe("alpha");
	expect(fixture.host.appendedEntries).toHaveLength(0);
});

test("notebook_write succeeds while its isStale callback reports fresh", async () => {
	const { state, fixture, api } = await notebookHost();
	const [notebookWrite] = createNotebookToolDefinitions(api, state, { isStale: () => false });

	const result = await notebookWrite.execute(
		"1",
		{ name: "entry-a", content: "alpha" },
		undefined,
		undefined,
		fixture.runner.createToolContext("1", undefined),
	);
	expect(result.details).toStrictEqual({ entries: ["entry-a"], preview: "alpha", truncation: null, clipped: false });
	expect(state.notebookPages.get("entry-a")).toBe("alpha");
	expect(fixture.host.appendedEntries).toHaveLength(1);
});

test("notebook_read reports not found with current page names", async () => {
	const { state, fixture } = await notebookHost();
	state.notebookPages.set("entry-a", "alpha");
	state.notebookPages.set("entry-b", "beta");

	const result = await fixture.tool("notebook_read").execute("1", { name: "missing" });
	expect(result.details).toStrictEqual({ entries: ["entry-a", "entry-b"], found: false });
	expect(firstText(result)).toMatch(/Notebook page "missing" not found\./);
	expect(firstText(result)).toMatch(/Notebook Pages:\n/);
	expect(firstText(result)).toMatch(/entry-a: alpha/);
	expect(firstText(result)).toMatch(/entry-b: beta/);
});

test("notebook tools show empty-state placeholders", async () => {
	const { fixture } = await notebookHost();

	const missing = await fixture.tool("notebook_read").execute("1", { name: "missing" });
	expect(missing.details).toStrictEqual({ entries: [], found: false });
	expect(firstText(missing)).toMatch(/Notebook Pages:\n\(empty\)/);

	const list = await fixture.tool("notebook_index").execute("2", {});
	expect(list.details).toStrictEqual({ entries: [] });
	expect(firstText(list)).toMatch(/Notebook Pages:\n\(empty\)/);
});

test("notebook_write pushes onUpdate and refreshes UI indicators", async () => {
	const { fixture } = await notebookHost({ ui: true });
	const updates = recordUpdates();

	const result = await fixture.tool("notebook_write").execute("1", { name: "entry-a", content: "first line\nsecond line" }, undefined, updates.onUpdate);

	expect(updateText(updates.last())).toBe('Saved "entry-a": first line');
	expect(updates.last().details).toStrictEqual({ entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
	expect(fixture.ui.statuses.get("pi-schematic-notebook")).toBe("📒 1");
	expect(result.details).toStrictEqual({ entries: ["entry-a"], preview: "first line", truncation: null, clipped: false });
});

async function notebookToolDefinitions() {
	const { state, api } = await notebookHost();
	const [notebookWrite, notebookRead, notebookIndex] = createNotebookToolDefinitions(api, state);
	assertPresent(notebookWrite.renderCall, "notebook_write has a call renderer");
	assertPresent(notebookWrite.renderResult, "notebook_write has a result renderer");
	assertPresent(notebookRead.renderResult, "notebook_read has a result renderer");
	assertPresent(notebookIndex.renderResult, "notebook_index has a result renderer");
	return {
		renderWriteCall: notebookWrite.renderCall,
		renderWriteResult: notebookWrite.renderResult,
		renderReadResult: notebookRead.renderResult,
		renderIndexResult: notebookIndex.renderResult,
	};
}

test("notebook tool renderers expose stable call/result summaries", async () => {
	const { renderWriteCall, renderWriteResult, renderReadResult, renderIndexResult } = await notebookToolDefinitions();

	const addCall = renderWriteCall({ name: "entry-a", content: "first line\nsecond line" }, realTheme, createToolRenderContext());
	expect(addCall.render(120).join("\n")).toContain(
		realTheme.fg("toolTitle", realTheme.bold("notebook_write ")) + realTheme.fg("accent", '"entry-a"') + ": " + realTheme.fg("dim", "first line"),
	);

	const addResult = renderWriteResult(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a"], preview: "first line", truncation: null, clipped: false } },
		{ expanded: true, isPartial: false },
		realTheme,
		createToolRenderContext({ args: { name: "entry-a", content: "first line\nsecond line" } }),
	);
	expect(plain(addResult.render(120))).toMatch(/Saved "entry-a": first line/);

	const getResult = renderReadResult(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body", clipped: false } },
		{ expanded: true, isPartial: false },
		realTheme,
		createToolRenderContext({ args: { name: "entry-a" } }),
	);
	expect(plain(getResult.render(120))).toMatch(/"entry-a"/);
	expect(getResult.render(120).join("\n")).toContain(realTheme.fg("toolOutput", "body"));

	const getResultWithDelimiters = renderReadResult(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "line 1\n---\nline 2", clipped: false } },
		{ expanded: true, isPartial: false },
		realTheme,
		createToolRenderContext({ args: { name: "entry-a" } }),
	);
	expect(plain(getResultWithDelimiters.render(120))).toMatch(/line 1/);
	expect(plain(getResultWithDelimiters.render(120))).toMatch(/line 2/);

	const listResult = renderIndexResult(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a", "entry-b"] } },
		{ expanded: true, isPartial: false },
		realTheme,
		createToolRenderContext(),
	);
	expect(listResult.render(120).join("\n")).toContain(realTheme.fg("muted", "📒 2 pages"));
	expect(plain(listResult.render(120))).toMatch(/entry-a/);
	expect(plain(listResult.render(120))).toMatch(/entry-b/);
});

test("notebook_read renders a missing page as not found", async () => {
	const { renderReadResult } = await notebookToolDefinitions();

	const missing = renderReadResult(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: [], found: false } },
		{ expanded: true, isPartial: false },
		realTheme,
		createToolRenderContext({ args: { name: "missing" } }),
	);

	expect(missing.render(120).join("\n")).toContain(realTheme.fg("error", "✗ ") + realTheme.fg("muted", '"missing" not found'));
});

test("collapsed notebook_write and notebook_read results show no list and no body", async () => {
	const { renderWriteResult, renderReadResult } = await notebookToolDefinitions();

	const writeResult = renderWriteResult(
		{ content: [{ type: "text", text: "" }], details: { entries: ["entry-a", "entry-b"], preview: "first line", truncation: null, clipped: false } },
		{ expanded: false, isPartial: false },
		realTheme,
		createToolRenderContext({ args: { name: "entry-a", content: "first line" } }),
	);
	const readResult = renderReadResult(
		{ content: [{ type: "text", text: "ignored" }], details: { entries: ["entry-a"], found: true, body: "body", clipped: false } },
		{ expanded: false, isPartial: false },
		realTheme,
		createToolRenderContext({ args: { name: "entry-a" } }),
	);

	expect([plain(writeResult.render(120)).trimEnd(), plain(readResult.render(120)).trimEnd()]).toStrictEqual(['✓ Saved "entry-a": first line', '✓ "entry-a"']);
});

test("notebook_write call summary omits the preview for an empty first line", async () => {
	const { renderWriteCall } = await notebookToolDefinitions();

	const call = renderWriteCall({ name: "entry-a", content: "\nsecond line" }, realTheme, createToolRenderContext());

	expect(plain(call.render(120)).trimEnd()).toBe('notebook_write "entry-a"');
});

// ── Notebook command / overlay tests ──────────────────────────────────

test("/notebook exits cleanly when headless", async () => {
	const fixture = await shippedHost({ headless: true });

	await expect(runNotebook(fixture)).resolves.toBeUndefined();
});

test("/notebook <topic> notifies with info on first set and warning on boundary change", async () => {
	const fixture = await shippedHost();

	await runNotebook(fixture, "oauth");
	await runNotebook(fixture, "billing");

	const { notifications, statuses, widgets } = fixture.ui;
	expect(notifications[0]).toStrictEqual({ message: "Active notebook topic: oauth", type: "info" });
	expect(notifications[1].message).toMatch(/Active notebook topic changed: oauth → billing/);
	expect(notifications[1].type).toBe("warning");
	expect(statuses.get(STATUS_KEY_TOPIC)).toBe("🧭 billing");
	expect(widgets.get(WIDGET_KEY_WARNING)).toBeUndefined();
});

test("/notebook with the current topic notifies it at info level", async () => {
	const fixture = await shippedHost();
	await runNotebook(fixture, "billing");

	await runNotebook(fixture, "billing");

	expect(fixture.ui.notifications.at(-1)).toStrictEqual({ message: "Active notebook topic: billing", type: "info" });
});

test("readonly /notebook boundary notification explains deferred handoff eligibility", async () => {
	const fixture = await shippedHost();

	await fixture.command("readonly").handler("", fixture.runner.createCommandContext());
	await runNotebook(fixture, "oauth");
	await runNotebook(fixture, "billing");

	const message = fixture.ui.notifications.at(-1)?.message ?? "";
	expect(message).toMatch(/handoff exception activates.*once the context is ready/i);
	expect(message).toMatch(/until then this boundary is advisory/i);
	expect(message).not.toMatch(/ask the user for an explicit \/handoff/i);
});

/** The shipped extension with `custom` as the /notebook list driver and no pager configured. */
async function notebookList(custom: CustomComponentDriver): Promise<RunnerFixture> {
	vi.stubEnv("PI_PAGER", "cat");
	return shippedHost({ custom });
}

test("/notebook empty overlay renders empty state and closes on input", async () => {
	const list = listDriver((component) => {
		press(component, "x");
	});
	const fixture = await notebookList(list.driver);

	await runNotebook(fixture);

	expect(list.renders[0]).toMatch(/Notebook \(0 pages\)/);
	expect(list.renders[0]).toMatch(/\(empty\) — use notebook_write to create pages/);
	expect(list.opened, "the input closes the list").toBe(1);
});

test("/notebook selection previews the chosen entry when no pager is available", async () => {
	const previews: string[] = [];
	const list = listDriver((component) => {
		press(component, "\r");
		previews.push(plain(component.render(120)));
		press(component, " ");
	});
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "alpha", "body line\nsecond line");

	await runNotebook(fixture);

	expect(previews[0]).toMatch(/body line/);
	expect(previews[0]).toMatch(/alpha/);
	expect(previews[0], "an uncut page shows no truncation hint").not.toMatch(/PI_PAGER/);
	expect(list.opened, "body shown inline, the key press returns to the reopened list").toBe(2);
});

test("/notebook inline preview hints at $PI_PAGER when it cuts a long page", async () => {
	const previews: string[] = [];
	const list = listDriver((component) => {
		press(component, "\r");
		previews.push(plain(component.render(120)));
		press(component, " ");
	});
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "alpha", "x".repeat(500) + "TAIL");

	await runNotebook(fixture);

	expect(previews[0]).not.toMatch(/TAIL/);
	expect(previews[0]).toMatch(/set \$PI_PAGER to a full-screen pager \(e\.g\. less\) to view the full page/);
});

test("/notebook overlay sorts entries consistently", async () => {
	const list = listDriver();
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "zeta", "last");
	await writePage(fixture, "alpha", "first");

	await runNotebook(fixture);

	const lines = list.renders[0];
	expect(lines).toContain("alpha");
	expect(lines).toContain("zeta");
	expect(lines.indexOf("alpha"), lines).toBeLessThan(lines.indexOf("zeta"));
	expect(lines).toMatch(/enter view/);
});

test("/notebook escape closes the picker without opening a page", async () => {
	const list = listDriver((component) => {
		press(component, ESCAPE);
	});
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "alpha", "body");

	await runNotebook(fixture);

	expect(list.opened, "the list is not reopened").toBe(1);
	expect(list.renders[0]).not.toMatch(/any key back/);
});

test("/notebook inline preview returns to the list on any key when no pager is available", async () => {
	const list = listDriver((component) => {
		// Move off the default index 0 so the reopen assertion proves cursor restore.
		press(component, "\x1b[B", "\r", " ");
	});
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "zeta", "body line");
	await writePage(fixture, "alpha", "other");

	await runNotebook(fixture);

	expect(list.opened, "list must reopen after the inline preview").toBe(2);
	const arrowLine = list.renders[1].split("\n").find((l) => l.includes("→"));
	assertPresent(arrowLine, `expected a cursor row, got:\n${list.renders[1]}`);
	expect(arrowLine).toMatch(/zeta/);
	expect(arrowLine).not.toMatch(/alpha/);
});

test("/notebook selecting an empty-content page opens the preview instead of closing the picker", async () => {
	const previews: string[] = [];
	const list = listDriver((component) => {
		press(component, "\r"); // Enter on the empty-content page
		previews.push(plain(component.render(120)));
		press(component, " "); // any key leaves the inline preview
	});
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "alpha", "");

	await runNotebook(fixture);

	expect(list.opened, "an empty page body must not close the picker early").toBe(2);
	expect(previews[0], "inline preview header must show the page name").toMatch(/alpha/);
});

// ── resolvePager tests ────────────────────────────────────────────────

const lessProbes = {
	present: () => true,
	absent: () => false,
	unprobed: () => expect.unreachable("must not probe less"),
};

test.for([
	{ label: "PAGER unset on linux", env: { LESS: "-FRX" }, platform: "linux", less: "present", expected: { cmd: "less", args: ["-R", "-+F", "-+X"] } },
	{
		label: "PAGER empty on linux",
		env: { PI_PAGER: "", PAGER: "", LESS: "-FRX" },
		platform: "linux",
		less: "present",
		expected: { cmd: "less", args: ["-R", "-+F", "-+X"] },
	},
	{
		label: "PAGER blank on linux",
		env: { PI_PAGER: "   ", PAGER: "   ", LESS: "-FRX" },
		platform: "linux",
		less: "present",
		expected: { cmd: "less", args: ["-R", "-+F", "-+X"] },
	},
	{ label: "PAGER unset on darwin", env: {}, platform: "darwin", less: "present", expected: { cmd: "less", args: ["-R", "-+F", "-+X"] } },
	{ label: "no less on linux", env: {}, platform: "linux", less: "absent", expected: undefined },
	// Windows never probes less: $PI_PAGER/$PAGER are the only way to get a pager.
	{ label: "PAGER unset on win32", env: {}, platform: "win32", less: "unprobed", expected: undefined },
] as const)("resolvePager keeps fallback less interactive without changing LESS: $label", ({ env, platform, less, expected }) => {
	expect(resolvePager(env, platform, lessProbes[less])).toStrictEqual(expected);
});

test.for([
	{ label: "PI_PAGER over PAGER", env: { PI_PAGER: "batcat --plain", PAGER: "more" }, expected: { cmd: "batcat", args: ["--plain", "--paging=always"] } },
	{ label: "PI_PAGER alone", env: { PI_PAGER: "less -R" }, expected: { cmd: "less", args: ["-R", "-+F", "-+X"] } },
	{ label: "PI_PAGER unset", env: { PAGER: "most -s" }, expected: { cmd: "most", args: ["-s"] } },
	{ label: "PI_PAGER empty", env: { PI_PAGER: "", PAGER: "most -s" }, expected: { cmd: "most", args: ["-s"] } },
	{ label: "PI_PAGER blank", env: { PI_PAGER: "   ", PAGER: "most -s" }, expected: { cmd: "most", args: ["-s"] } },
] as const)("resolvePager prefers PI_PAGER over PAGER and falls back when it is blank: $label", ({ env, expected }) => {
	expect(resolvePager(env, "linux", lessProbes.unprobed)).toStrictEqual(expected);
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

test.for([
	{ pager: "less", platform: "linux", cmd: "less", args: ["-+F", "-+X"] },
	{ pager: "  less\t-R  ", platform: "linux", cmd: "less", args: ["-R", "-+F", "-+X"] },
	{ pager: "less -+F -F", platform: "linux", cmd: "less", args: ["-+F", "-F", "-+F", "-+X"] },
	{ pager: "/usr/bin/less -R", platform: "linux", cmd: "/usr/bin/less", args: ["-R", "-+F", "-+X"] },
	{ pager: "less -FRX --", platform: "linux", cmd: "less", args: ["-FRX", "-+F", "-+X", "--"] },
	{ pager: "less -- -F", platform: "linux", cmd: "less", args: ["-+F", "-+X", "--", "-F"] },
	{ pager: "less", platform: "win32", cmd: "less", args: ["-+F", "-+X"] },
	{ pager: "LESS -R", platform: "win32", cmd: "LESS", args: ["-R", "-+F", "-+X"] },
	{ pager: "less.exe -FRX", platform: "win32", cmd: "less.exe", args: ["-FRX", "-+F", "-+X"] },
	{ pager: "C:\\tools\\LESS.EXE -F", platform: "win32", cmd: "C:\\tools\\LESS.EXE", args: ["-F", "-+F", "-+X"] },
	{ pager: "C:/tools/less.exe -R", platform: "win32", cmd: "C:/tools/less.exe", args: ["-R", "-+F", "-+X"] },
] as const)("resolvePager overrides quit-if-one-screen and no-init for configured less executables: $pager on $platform", ({ pager, platform, cmd, args }) => {
	expect(resolvePager({ PAGER: pager, LESS: "-FRX" }, platform, lessProbes.unprobed)).toStrictEqual({ cmd, args });
});

test.for([
	{ pager: "bat", platform: "linux", cmd: "bat", args: ["--paging=always"] },
	{ pager: "batcat --plain", platform: "linux", cmd: "batcat", args: ["--plain", "--paging=always"] },
	{ pager: "bat --paging=never", platform: "linux", cmd: "bat", args: ["--paging=never", "--paging=always"] },
	{ pager: "/opt/less/bat --plain", platform: "linux", cmd: "/opt/less/bat", args: ["--plain", "--paging=always"] },
	{ pager: "/usr/bin/batcat -p --", platform: "linux", cmd: "/usr/bin/batcat", args: ["-p", "--paging=always", "--"] },
	{ pager: "bat.exe --plain", platform: "win32", cmd: "bat.exe", args: ["--plain", "--paging=always"] },
	{ pager: "C:\\tools\\BATCAT.EXE", platform: "win32", cmd: "C:\\tools\\BATCAT.EXE", args: ["--paging=always"] },
] as const)("resolvePager forces paging for configured bat executables: $pager on $platform", ({ pager, platform, cmd, args }) => {
	expect(resolvePager({ PAGER: pager }, platform, lessProbes.unprobed)).toStrictEqual({ cmd, args });
});

test.for([
	{ pager: "less-wrapper -F", platform: "linux", cmd: "less-wrapper", args: ["-F"] },
	{ pager: "env less -FRX", platform: "linux", cmd: "env", args: ["less", "-FRX"] },
	{ pager: "LESS -F", platform: "linux", cmd: "LESS", args: ["-F"] },
	{ pager: "less.exe -F", platform: "linux", cmd: "less.exe", args: ["-F"] },
	{ pager: "less.cmd -F", platform: "win32", cmd: "less.cmd", args: ["-F"] },
	{ pager: "env bat --plain", platform: "linux", cmd: "env", args: ["bat", "--plain"] },
	{ pager: "bat-wrapper", platform: "linux", cmd: "bat-wrapper", args: [] },
	{ pager: "bat.exe --plain", platform: "linux", cmd: "bat.exe", args: ["--plain"] },
	{ pager: "bat.cmd --plain", platform: "win32", cmd: "bat.cmd", args: ["--plain"] },
] as const)("resolvePager leaves other pagers and wrappers unchanged: $pager on $platform", ({ pager, platform, cmd, args }) => {
	expect(resolvePager({ PAGER: pager }, platform, lessProbes.unprobed)).toStrictEqual({ cmd, args });
});

// ── saveNotebookPage tests ────────────────────────────────────────────

test("saveNotebookPage serializes concurrent writes and preserves completion order", async () => {
	const host = await notebookHost();
	const { state, api } = host;
	const firstGate = createDeferred();
	const order: string[] = [];

	const first = saveNotebookPage(api, state, "entry-a", "first", async () => {
		order.push("first:start");
		await firstGate.promise;
		order.push("first:end");
	});
	const second = saveNotebookPage(api, state, "entry-a", "second", () => {
		order.push("second:start");
		return Promise.resolve();
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
	expect(host.fixture.host.appendedEntries.map((entry) => recordOf(entry.data, "the appended entry data").content)).toStrictEqual(["first", "second"]);
});

test("saveNotebookPage keeps write order across runtime singleton swaps", async () => {
	const { state, api } = await notebookHost();
	const previousSingletons = getSingletons();
	const firstGate = createDeferred();
	const order: string[] = [];

	try {
		const first = saveNotebookPage(api, state, "entry-a", "first", async () => {
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
		const second = saveNotebookPage(api, state, "entry-a", "second", () => {
			order.push("second:start");
			return Promise.resolve();
		});

		await Promise.resolve();
		expect(order).toStrictEqual(["first:start"]);
		firstGate.resolve();
		await Promise.all([first, second]);

		expect(order).toStrictEqual(["first:start", "first:end", "second:start"]);
		expect(state.notebookPages.get("entry-a")).toBe("second");
	} finally {
		firstGate.resolve();
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage rejects true reentrancy explicitly", async () => {
	const { state, api } = await notebookHost();

	await expect(
		saveNotebookPage(api, state, "outer", "outer", async () => {
			await saveNotebookPage(api, state, "inner", "inner");
		}),
	).rejects.toThrow(/not reentrant/i);
	expect(state.notebookPages.size).toBe(0);
});

test("saveNotebookPage stays non-reentrant across runtime singleton swaps", async () => {
	const { state, api } = await notebookHost();
	const previousSingletons = getSingletons();

	try {
		await expect(
			Promise.race([
				saveNotebookPage(api, state, "outer", "outer", async () => {
					__setSingletons({
						writeLock: createWriteLock(),
						writeContext: new AsyncLocalStorage<true>(),
						frameScheduler: getSingletons().frameScheduler,
					});
					await saveNotebookPage(api, state, "inner", "inner");
				}),
				new Promise<never>((_, reject) => {
					setTimeout(() => {
						reject(new Error("timeout"));
					}, 1000);
				}),
			]),
		).rejects.toThrow(/not reentrant/i);
		expect(state.notebookPages.size).toBe(0);
	} finally {
		__setSingletons(previousSingletons, { forceWriteLock: true });
	}
});

test("saveNotebookPage releases the lock when assertWritable throws", async () => {
	const { state, api } = await notebookHost();

	await expect(
		saveNotebookPage(
			api,
			state,
			"broken",
			"value",
			() =>
				new Promise<never>(() => {
					throw new Error("blocked");
				}),
		),
	).rejects.toThrow(/blocked/);
	await expect(saveNotebookPage(api, state, "fresh", "value")).resolves.toMatchObject({ clipped: false });
	expect(state.notebookPages.get("fresh")).toBe("value");
});

test("saveNotebookPage truncates oversized content before persisting", async () => {
	const host = await notebookHost();
	const content = "first line\n" + "detail\n".repeat(3000);

	const result = await saveNotebookPage(host.api, host.state, "large-page", content);
	const persisted = stringOf(appendedData(host, 0).content, "the persisted content");

	expect(persisted.length, "oversized notebook content should be truncated").toBeLessThan(content.length);
	expect(host.state.notebookPages.get("large-page")).toBe(persisted);
	expect(result.preview).toBe("first line");
	expect(persisted).toMatch(/^first line/m);
});

test("resetState clears epoch and the next notebook write starts a fresh generation", async () => {
	const host = await notebookHost();
	const { state, api } = host;

	await saveNotebookPage(api, state, "entry-a", "first");
	await saveNotebookPage(api, state, "entry-b", "second");
	expect(state.epoch).toBe(1);
	expect(appendedData(host, 0).epoch).toBe(1);
	expect(appendedData(host, 1).epoch).toBe(1);

	resetState(state);
	expect(state.epoch).toBe(0);

	await saveNotebookPage(api, state, "entry-c", "third");
	expect(state.epoch).toBe(1);
	expect(appendedData(host, 2).epoch).toBe(1);
});

// ── Notebook tool definition metadata tests ───────────────────────────

test("notebook tool definitions include prompt hints when withPromptHints is true", async () => {
	const { state, api } = await notebookHost();
	const tools = createNotebookToolDefinitions(api, state, { withPromptHints: true });

	expect(
		tools.map((tool) => ({ name: tool.name, promptSnippet: typeof tool.promptSnippet, promptGuidelines: (tool.promptGuidelines?.length ?? 0) > 0 })),
	).toStrictEqual([
		{ name: "notebook_write", promptSnippet: "string", promptGuidelines: true },
		{ name: "notebook_read", promptSnippet: "string", promptGuidelines: true },
		{ name: "notebook_index", promptSnippet: "string", promptGuidelines: true },
	]);
});

test("notebook tool definitions omit prompt hints by default", async () => {
	const { state, api } = await notebookHost();
	const tools = createNotebookToolDefinitions(api, state);

	expect(tools.map((tool) => ({ name: tool.name, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines }))).toStrictEqual([
		{ name: "notebook_write", promptSnippet: undefined, promptGuidelines: undefined },
		{ name: "notebook_read", promptSnippet: undefined, promptGuidelines: undefined },
		{ name: "notebook_index", promptSnippet: undefined, promptGuidelines: undefined },
	]);
});

// ── Handoff notebook discard drafts ───────────────────────────────────

async function notebookWithPages(pages: Record<string, string>): Promise<NotebookHost> {
	const host = await notebookHost();
	for (const [name, content] of Object.entries(pages)) {
		await saveNotebookPage(host.api, host.state, name, content);
	}
	return host;
}

/** The branch of a session holding what `host` persisted, then `drafts`. */
function branchWith(host: NotebookHost, drafts: readonly CustomEntryDraft[]): SessionEntry[] {
	const session = sessionWith(host.fixture.host.appendedEntries);
	appendDrafts(session, drafts);
	return session.getBranch();
}

function restoredFrom(branch: readonly SessionEntry[]): SchematicState {
	const restored = createState();
	reconstructNotebook(restored, branch);
	return restored;
}

function draftEpochs(drafts: readonly CustomEntryDraft[]): unknown[] {
	return drafts.map((draft) => recordOf(draft.data, "the draft data").epoch);
}

test("buildNotebookDiscardDrafts leaves the state untouched", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });

	buildNotebookDiscardDrafts(state, ["page-a"]);

	expect(Array.from(state.notebookPages.entries())).toStrictEqual([
		["page-a", "content-a"],
		["page-b", "content-b"],
	]);
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

	const survivor = drafts.find((draft) => draft.customType === "notebook-entry");
	assertPresent(survivor, "the kept page survives as a notebook entry");
	expect(survivor.data).toStrictEqual({ version: 1, epoch: 2, name: "keep", content: L(2000), clipped: true });
});

test("buildNotebookDiscardDrafts moves past the discard watermark", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	state.discardEpochWatermark = 4;

	const { drafts } = buildNotebookDiscardDrafts(state, ["page-a"]);

	expect(draftEpochs(drafts)).toStrictEqual([1, 5, 5]);
});

test("buildNotebookDiscardDrafts ignores unknown and repeated names", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });

	const result = buildNotebookDiscardDrafts(state, ["page-a", "ghost", "page-a"]);

	expect(result).toStrictEqual({
		drafts: [
			{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 1 } },
			{ type: "custom", customType: "notebook-entry", data: { version: 1, epoch: 2, name: "page-b", content: "content-b", clipped: false } },
			{ type: "custom", customType: "notebook-generation", data: { version: 1, epoch: 2 } },
		],
		discarded: 1,
	});
});

test("buildNotebookDiscardDrafts writes nothing when no named page exists", async () => {
	const { state } = await notebookWithPages({ "page-a": "content-a" });

	expect(buildNotebookDiscardDrafts(state, ["ghost"])).toStrictEqual({ drafts: [], discarded: 0 });
	expect(buildNotebookDiscardDrafts(state, [])).toStrictEqual({ drafts: [], discarded: 0 });
});

test("discard drafts written to a branch make the survivors the active generation", async () => {
	const host = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { drafts } = buildNotebookDiscardDrafts(host.state, ["page-a"]);

	const restored = restoredFrom(branchWith(host, drafts));

	expect(Array.from(restored.notebookPages.entries())).toStrictEqual([["page-b", "content-b"]]);
	expect(restored.epoch).toBe(2);
	expect(restored.discardEpochWatermark).toBe(2);
});

test("discarding every page leaves an empty next generation", async () => {
	const host = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { drafts, discarded } = buildNotebookDiscardDrafts(host.state, ["page-a", "page-b"]);

	const restored = restoredFrom(branchWith(host, drafts));

	expect(discarded).toBe(2);
	expect(Array.from(restored.notebookPages.entries())).toStrictEqual([]);
	expect(restored.epoch).toBe(2);
});

test("survivors staged without their closing generation marker stay invisible to rehydration", async () => {
	const host = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });
	const { drafts } = buildNotebookDiscardDrafts(host.state, ["page-a"]);

	const restored = restoredFrom(branchWith(host, drafts.slice(0, -1)));

	expect(Array.from(restored.notebookPages.entries()).sort()).toStrictEqual([
		["page-a", "content-a"],
		["page-b", "content-b"],
		["page-c", "content-c"],
	]);
	expect(restored.epoch).toBe(1);
	expect(restored.discardEpochWatermark).toBe(2);
});

test("a discard after orphaned staged survivors uses a fresh epoch and does not resurrect them", async () => {
	const host = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b", "page-c": "content-c" });
	// An earlier pass discarding page-b staged survivors at epoch 2 and never closed that generation.
	const orphanDrafts = buildNotebookDiscardDrafts(host.state, ["page-b"]).drafts.slice(0, -1);

	const restarted = restoredFrom(branchWith(host, orphanDrafts));
	const retry = buildNotebookDiscardDrafts(restarted, ["page-a"]);
	const restored = restoredFrom(branchWith(host, [...orphanDrafts, ...retry.drafts]));

	expect(draftEpochs(retry.drafts)).toStrictEqual([1, 3, 3, 3]);
	expect(Array.from(restored.notebookPages.entries()).sort()).toStrictEqual([
		["page-b", "content-b"],
		["page-c", "content-c"],
	]);
	expect(restored.epoch).toBe(3);
});

test("branch invalidation preserves the discard watermark until reconstruction derives a fresh one", async () => {
	const host = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { state } = host;
	reconstructNotebook(state, branchWith(host, buildNotebookDiscardDrafts(state, ["page-a"]).drafts.slice(0, -1)));
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
	const host = await notebookWithPages({ "page-a": "content-a", "page-b": "content-b" });
	const { state } = host;
	reconstructNotebook(state, branchWith(host, buildNotebookDiscardDrafts(state, ["page-a"]).drafts.slice(0, -1)));
	expect(state.discardEpochWatermark).toBe(2);

	resetState(state);
	expect(state.discardEpochWatermark, "/new must reset the watermark with the session").toBe(0);
	expect(state.epoch).toBe(0);
});

test("session_tree rehydrates notebook state branch-scoped: pages and epoch follow the branch, writes use B state", async () => {
	const session = SessionManager.inMemory(process.cwd());
	// Branch A: pages a,b at committed epoch 1.
	const firstGeneration = session.appendCustomEntry("notebook-generation", { version: 1, epoch: 1 });
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 1, name: "page-a", content: "a-v1", clipped: false });
	const leafA = session.appendCustomEntry("notebook-entry", { version: 1, epoch: 1, name: "page-b", content: "b-v1", clipped: false });
	// Branch B: diverged from A via a discard — committed epoch 2, only x,y kept.
	session.branch(firstGeneration);
	session.appendCustomEntry("notebook-generation", { version: 1, epoch: 2 });
	session.appendCustomEntry("notebook-entry", { version: 1, epoch: 2, name: "page-x", content: "x-v1", clipped: false });
	const leafB = session.appendCustomEntry("notebook-entry", { version: 1, epoch: 2, name: "page-y", content: "y-v1", clipped: false });
	const fixture = await shippedHost({ session, headless: true });
	const host = { fixture };
	const navigate = async (leaf: string) => {
		session.branch(leaf);
		await fixture.runner.emit({ type: "session_tree", newLeafId: leaf, oldLeafId: null });
	};
	const pageNames = async () => detailsOf(await fixture.tool("notebook_index").execute("index", {})).entries;

	// Enter A.
	await navigate(leafA);
	expect(await pageNames()).toStrictEqual(["page-a", "page-b"]);

	// Navigate to B — pages immediately follow the active branch.
	await navigate(leafB);
	expect(await pageNames()).toStrictEqual(["page-x", "page-y"]);

	// A write on B uses B's committed epoch and lands on B's pages.
	await writePage(fixture, "page-z", "z-v1");
	expect(appendedData(host, -1).epoch, "write on B must use B's committed epoch").toBe(2);
	expect(await pageNames()).toStrictEqual(["page-x", "page-y", "page-z"]);

	// Back to A — A's branch-scoped pages restored, epoch follows A again.
	await navigate(leafA);
	expect(await pageNames(), "returning to A must restore its pages").toStrictEqual(["page-a", "page-b"]);
	await writePage(fixture, "page-a", "a-v2");
	expect(appendedData(host, -1).epoch, "write after returning to A must use A's epoch").toBe(1);
});

// ── Notebook write-size contract (issue #42) ───────────────────────────

test("complete write exposes null truncation and false clipped", async () => {
	const host = await notebookHost();
	const { state, api, fixture } = host;

	const saved = await saveNotebookPage(api, state, "page", C);
	expect(saved).toStrictEqual({ entries: ["page"], preview: "first", truncation: null, clipped: false });
	expect(appendedData(host, 0)).toStrictEqual({ version: 1, epoch: 1, name: "page", content: C, clipped: false });

	const updates = recordUpdates();
	const result = await fixture.tool("notebook_write").execute("2", { name: "page", content: C }, undefined, updates.onUpdate);
	expect(firstText(result)).toBe('Saved notebook page "page".\nfirst\n\nNotebook Pages:\n  page: first');
	expect(updateText(updates.last())).toBe('Saved "page": first');
	expect(result.details).toStrictEqual({ entries: ["page"], preview: "first", truncation: null, clipped: false });
	expect(updates.last().details).toStrictEqual({ entries: ["page"], preview: "first", truncation: null, clipped: false });
});

test("line overflow returns exact head and line report", async () => {
	const host = await notebookHost();

	const saved = await saveNotebookPage(host.api, host.state, "page", L(2001));
	expect(host.state.notebookPages.get("page")).toBe(L(2000));
	expect(saved).toStrictEqual({ entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	expect(appendedData(host, 0)).toStrictEqual({ version: 1, epoch: 1, name: "page", content: L(2000), clipped: true });
});

test("byte overflow retains whole lines and reports bytes (ASCII + UTF-8)", async () => {
	const host = await notebookHost();
	const { state, api } = host;

	const ascii = await saveNotebookPage(api, state, "page", B);
	expect(state.notebookPages.get("page")).toBe("a".repeat(25600));
	expect(ascii).toStrictEqual({ entries: ["page"], preview: A77, truncation: Tbytes, clipped: true });
	expect(appendedData(host, 0)).toStrictEqual({ version: 1, epoch: 1, name: "page", content: "a".repeat(25600), clipped: true });

	const utf8 = await saveNotebookPage(api, state, "page", U);
	expect(state.notebookPages.get("page")).toBe("é".repeat(12800));
	expect(utf8).toStrictEqual({ entries: ["page"], preview: "é".repeat(77) + "...", truncation: Tbytes, clipped: true });
	expect(appendedData(host, 1)).toStrictEqual({ version: 1, epoch: 1, name: "page", content: "é".repeat(12800), clipped: true });
});

test("write final and update text report clipping without a badge", async () => {
	const { fixture } = await notebookHost();

	const updates = recordUpdates();
	const result = await fixture.tool("notebook_write").execute("1", { name: "page", content: L(2001) }, undefined, updates.onUpdate);

	expect(firstText(result)).toBe(`Saved notebook page "page".\nx\n\n${ReportLines}\n\nNotebook Pages:\n  page: x`);
	expect(updateText(updates.last())).toBe(`Saved "page": x\n\n${ReportLines}`);
	expect(result.details).toStrictEqual({ entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	expect(updates.last().details).toStrictEqual({ entries: ["page"], preview: "x", truncation: Tlines, clipped: true });
	expect(firstText(result)).not.toMatch(/\[truncated\]/);
	expect(updateText(updates.last())).not.toMatch(/\[truncated\]/);
});

test("write final and update text report byte clipping", async () => {
	const { fixture } = await notebookHost();

	const updates = recordUpdates();
	const result = await fixture.tool("notebook_write").execute("1", { name: "page", content: B }, undefined, updates.onUpdate);

	expect(firstText(result)).toBe(`Saved notebook page "page".\n${A77}\n\n${ReportBytes}\n\nNotebook Pages:\n  page: ${A77}`);
	expect(updateText(updates.last())).toBe(`Saved "page": ${A77}\n\n${ReportBytes}`);
	expect(result.details).toStrictEqual({ entries: ["page"], preview: A77, truncation: Tbytes, clipped: true });
	expect(updates.last().details).toStrictEqual(result.details);
	expect(firstText(result)).toMatch(/TRUNCATED by bytes/);
});

test("read appends a generic notice only for a flagged page", async () => {
	const { fixture } = await notebookHost();
	const notebookRead = fixture.tool("notebook_read");

	await writePage(fixture, "page", L(2001));
	const clipped = await notebookRead.execute("2", { name: "page" });
	const body = L(2000);
	expect(firstText(clipped)).toBe(`${readBase(body, "x")}\n\n${Notice}`);
	expect(firstText(clipped).split(Notice).length - 1).toBe(1);
	expect(clipped.details).toStrictEqual({ entries: ["page"], found: true, body, clipped: true });

	await writePage(fixture, "page", C);
	const complete = await notebookRead.execute("4", { name: "page" });
	expect(firstText(complete)).toBe(readBase(C, "first"));
	expect(firstText(complete)).not.toMatch(/Notice:/);
	expect(complete.details).toStrictEqual({ entries: ["page"], found: true, body: C, clipped: false });
});

test("oversized first line rejects a new page without side effects", async () => {
	const { state, api, fixture } = await notebookHost({ ui: true });

	await expect(saveNotebookPage(api, state, "page", R)).rejects.toThrow(new Error(rejectMessage("page")));
	await expect(saveNotebookPage(api, state, "page", UR)).rejects.toThrow(new Error(rejectMessage("page")));

	const onUpdate = vi.fn();
	await expect(fixture.tool("notebook_write").execute("1", { name: "page", content: R }, undefined, onUpdate)).rejects.toThrow(
		new Error(rejectMessage("page")),
	);
	expect(onUpdate).not.toHaveBeenCalled();
	expect(state.notebookPages.size).toBe(0);
	expect(state.epoch).toBe(0);
	expect(state.discardEpochWatermark).toBe(0);
	expect(fixture.host.appendedEntries).toHaveLength(0);
	expect(fixture.ui.statuses.size).toBe(0);
	expect(fixture.ui.widgets.size).toBe(0);

	await saveNotebookPage(api, state, "page", C);
	expect(state.notebookPages.get("page")).toBe(C);
	const index = await fixture.tool("notebook_index").execute("2", {});
	expect(index.details).toStrictEqual({ entries: ["page"] });
});

test("rejected overwrite preserves prior body and clipped flag", async () => {
	const { state, api, fixture } = await notebookHost();
	const notebookRead = fixture.tool("notebook_read");

	await saveNotebookPage(api, state, "page", C);
	const epochBefore = state.epoch;
	await expect(saveNotebookPage(api, state, "page", R)).rejects.toThrow(new Error(rejectMessage("page")));
	expect(state.notebookPages.get("page")).toBe(C);
	expect(state.epoch).toBe(epochBefore);
	expect(fixture.host.appendedEntries).toHaveLength(1);
	let read = await notebookRead.execute("2", { name: "page" });
	expect(firstText(read)).toBe(readBase(C, "first"));
	expect(detailsOf(read).clipped).toBe(false);

	await saveNotebookPage(api, state, "page", L(2001));
	const epochClipped = state.epoch;
	await expect(saveNotebookPage(api, state, "page", R)).rejects.toThrow(new Error(rejectMessage("page")));
	expect(state.notebookPages.get("page")).toBe(L(2000));
	expect(state.epoch).toBe(epochClipped);
	read = await notebookRead.execute("3", { name: "page" });
	expect(detailsOf(read).clipped).toBe(true);
	expectSuffix(firstText(read), `\n\n${Notice}`);
});

test("blank first line plus oversized line rejects and preserves prior page state", async () => {
	const { state, api, fixture } = await notebookHost({ ui: true });
	const blankFirstLineOverflow = "\n" + "x".repeat(DEFAULT_MAX_BYTES + 1);

	await saveNotebookPage(api, state, "page", C);
	const epochBefore = state.epoch;
	const entriesBefore = fixture.host.appendedEntries.length;

	await expect(saveNotebookPage(api, state, "page", blankFirstLineOverflow)).rejects.toThrow(new Error(emptyHeadRejectMessage("page")));

	const onUpdate = vi.fn();
	await expect(fixture.tool("notebook_write").execute("2", { name: "page", content: blankFirstLineOverflow }, undefined, onUpdate)).rejects.toThrow(
		new Error(emptyHeadRejectMessage("page")),
	);
	expect(onUpdate).not.toHaveBeenCalled();
	expect(state.notebookPages.get("page")).toBe(C);
	expect([...state.clippedPages]).not.toContain("page");
	expect(state.epoch).toBe(epochBefore);
	expect(fixture.host.appendedEntries).toHaveLength(entriesBefore);
	expect(fixture.ui.statuses.size).toBe(0);
	expect(fixture.ui.widgets.size).toBe(0);

	// A clipped prior page is equally protected: body, flag, epoch and entries stay.
	await saveNotebookPage(api, state, "page", L(2001));
	const epochClipped = state.epoch;
	const entriesClipped = fixture.host.appendedEntries.length;
	await expect(saveNotebookPage(api, state, "page", blankFirstLineOverflow)).rejects.toThrow(new Error(emptyHeadRejectMessage("page")));
	const read = await fixture.tool("notebook_read").execute("3", { name: "page" });
	expect(state.notebookPages.get("page")).toBe(L(2000));
	expect([...state.clippedPages]).toContain("page");
	expect(state.epoch).toBe(epochClipped);
	expect(fixture.host.appendedEntries).toHaveLength(entriesClipped);
	expect(detailsOf(read).body).toBe(L(2000));
	expect(detailsOf(read).clipped).toBe(true);

	// An untruncated empty write is still accepted by the new guard.
	await saveNotebookPage(api, state, "page", "");
	expect(state.notebookPages.get("page")).toBe("");
	expect([...state.clippedPages]).not.toContain("page");
});

test("clipped flag survives fresh reconstruction without persisted quantities", async () => {
	const host = await notebookHost();
	await writePage(host.fixture, "page", L(2001));

	expect(Object.keys(appendedData(host, 0)).sort()).toStrictEqual(["clipped", "content", "epoch", "name", "version"]);
	expect(appendedData(host, 0).clipped).toBe(true);

	const restored = await rehydrated(sessionWith(host.fixture.host.appendedEntries));
	const read = await restored.fixture.tool("notebook_read").execute("1", { name: "page" });
	expect(detailsOf(read).clipped).toBe(true);
	expectSuffix(firstText(read), `\n\n${Notice}`);
});

test("complete overwrite clears a durable clipped flag", async () => {
	const host = await notebookHost();
	const { fixture } = host;

	await writePage(fixture, "page", L(2001));
	await writePage(fixture, "page", C);

	expect(appendedData(host, -1).clipped).toBe(false);
	const read = await fixture.tool("notebook_read").execute("3", { name: "page" });
	expect(read.details).toStrictEqual({ entries: ["page"], found: true, body: C, clipped: false });
	expect(firstText(read)).toBe(readBase(C, "first"));

	const restored = await rehydrated(sessionWith(fixture.host.appendedEntries));
	const restoredResult = await restored.fixture.tool("notebook_read").execute("4", { name: "page" });
	expect(detailsOf(restoredResult).clipped).toBe(false);
});

test("discard survivor retains its durable clipped flag", async () => {
	const host = await notebookWithPages({ drop: C, keep: L(2001) });

	const restored = await rehydrated(sessionWith([...host.fixture.host.appendedEntries, ...buildNotebookDiscardDrafts(host.state, ["drop"]).drafts]));

	expect(restored.state.notebookPages.get("keep")).toBe(L(2000));
	const read = await restored.fixture.tool("notebook_read").execute("1", { name: "keep" });
	expect(detailsOf(read).clipped).toBe(true);
});

test("formatPageTuiPreview appends a badge only when clipped", () => {
	expect(formatPageTuiPreview(L(2000), true)).toBe("x [truncated]");
	expect(formatPageTuiPreview(C, false)).toBe("first");
	expect(formatPageTuiPreview("p".repeat(81) + "\ntail", true)).toBe("p".repeat(77) + "... [truncated]");
});

test("formatPageTuiPreview shows a bare badge for a clipped page with an empty first line", () => {
	expect(formatPageTuiPreview("\nbody", true)).toBe("[truncated]");
});

test("/notebook selector badges clipped pages without changing stored bodies", async () => {
	const list = listDriver();
	const fixture = await notebookList(list.driver);
	await writePage(fixture, "clipped-page", L(2001));
	await writePage(fixture, "complete-page", C);

	await runNotebook(fixture);

	const lines = list.renders[0].split("\n");
	const clippedLine = lines.find((line) => line.includes("clipped-page"));
	assertPresent(clippedLine, "the selector shows a clipped-page row");
	expect(clippedLine).toMatch(/x \[truncated\]/);
	const completeLine = lines.find((line) => line.includes("complete-page"));
	assertPresent(completeLine, "the selector shows a complete-page row");
	expect(completeLine).toMatch(/first/);
	expect(completeLine).not.toMatch(/\[truncated\]/);

	const read = fixture.tool("notebook_read");
	const clippedRead = await read.execute("3", { name: "clipped-page" });
	expect(detailsOf(clippedRead).body).toBe(L(2000));
	expect(detailsOf(clippedRead).clipped).toBe(true);
	const completeRead = await read.execute("4", { name: "complete-page" });
	expect(detailsOf(completeRead).body).toBe(C);
	expect(detailsOf(completeRead).clipped).toBe(false);
});

test("notebook_write descriptions state the shared write-size semantics", async () => {
	const { fixture } = await notebookHost();
	const notebookWrite = fixture.registeredTool("notebook_write").definition;

	expectSuffix(notebookWrite.description, DescriptionSuffix);
	const parameters = recordOf(notebookWrite.parameters, "the notebook_write parameters");
	const contentDescription = stringOf(
		recordOf(recordOf(parameters.properties, "the parameter properties").content, "the content parameter").description,
		"the content parameter description",
	);
	expectSuffix(contentDescription, DescriptionSuffix);
});

// ── Notebook write-size green regression net ───────────────────────────

test("plain preview preserves the 80-character boundary", () => {
	expect(formatPagePreview("p".repeat(80))).toBe("p".repeat(80));
	expect(formatPagePreview("p".repeat(81) + "\ntail")).toBe("p".repeat(77) + "...");
});

test("plain page list and index preserve previews and alphabetical order", async () => {
	const { state, api, fixture } = await notebookHost();
	await saveNotebookPage(api, state, "zeta", "last");
	await saveNotebookPage(api, state, "alpha", "first");

	const index = await fixture.tool("notebook_index").execute("1", {});
	expect(index.details).toStrictEqual({ entries: ["alpha", "zeta"] });
	expect(firstText(index)).toMatch(/ {2}alpha: first\n {2}zeta: last/);
	expect(firstText(index)).not.toMatch(/\[truncated\]|Notice:/);
});

test("complete and empty bodies remain accepted at the existing caps", async () => {
	const { state, api, fixture } = await notebookHost();
	await saveNotebookPage(api, state, "c", C);
	await saveNotebookPage(api, state, "l", L(2000));
	await saveNotebookPage(api, state, "f", F);
	await saveNotebookPage(api, state, "m", M);
	await saveNotebookPage(api, state, "empty", "");

	expect(Array.from(state.notebookPages.entries())).toStrictEqual([
		["c", C],
		["l", L(2000)],
		["f", F],
		["m", M],
		["empty", ""],
	]);
	const read = await fixture.tool("notebook_read").execute("1", { name: "empty" });
	expect(detailsOf(read).found).toBe(true);
	expect(detailsOf(read).body).toBe("");
});

test("model listing surfaces remain free of clipping decorations", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-03-04T12:00:00Z"));
	onTestFinished(() => {
		vi.useRealTimers();
	});
	const fixture = await shippedHost({ headless: true });
	const updates = recordUpdates();
	const writeResult = await fixture.tool("notebook_write").execute("1", { name: "page", content: L(2001) }, undefined, updates.onUpdate);
	const indexResult = await fixture.tool("notebook_index").execute("2", {});
	const readResult = await fixture.tool("notebook_read").execute("3", { name: "page" });
	const writeTexts = [firstText(writeResult), updateText(updates.last())];

	const modelTexts = [...writeTexts, firstText(indexResult), firstText(readResult)];
	expect(
		modelTexts.filter((text) => text.includes("[truncated]")),
		"model text must not carry the TUI badge",
	).toStrictEqual([]);
	expect(
		[...writeTexts, firstText(indexResult)].filter((text) => text.includes("Notice:")),
		"notice must not leak into non-read surfaces",
	).toStrictEqual([]);

	// Notebook section through the real before_agent_start hook.
	const result = await fixture.runner.emitBeforeAgentStart(
		{ messageType: "user", prompt: "go" },
		fixture.systemPromptOptions({ customPrompt: "Base system prompt." }),
	);
	const listing = result.systemPromptOptions.sections.schematic_notebook;
	assertPresent(listing);
	expect(listing).not.toMatch(/\[truncated\]/);
	expect(listing).not.toMatch(/Notice:/);
	expect(listing).toMatch(/ {2}page: x/);
	const assembled = fixture.systemPrompt;
	expect(assembled).toMatch(/ {2}page: x/);
	expect(assembled).not.toMatch(/\[truncated\]/);
	expect(assembled).not.toMatch(/Notice:/);
});

test("unknown notebook entry types have zero effect on reconstructed state", async () => {
	const writer = await notebookHost();
	await saveNotebookPage(writer.api, writer.state, "page", C);
	const session = sessionWith(writer.fixture.host.appendedEntries);
	session.appendCustomEntry("unknown-notebook-type", { version: 1, epoch: 9, name: "ghost", content: "x" });
	session.appendCustomEntry("ledger-entry", { version: 1, epoch: 9, name: "ledger", content: "x" });
	session.appendCustomEntry("some-other-entry", { version: 1, epoch: 9 });

	const { state } = await rehydrated(session);

	expect(state.epoch).toBe(1);
	expect(state.discardEpochWatermark).toBe(1);
	expect(Array.from(state.notebookPages.entries())).toStrictEqual([["page", C]]);
});
