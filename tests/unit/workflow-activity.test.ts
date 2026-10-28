// WHY: the shell audit entries are the user's post-run view. They are pure renderers
// over a persisted WorkflowEffect, so assert their visible contract without a terminal.
import assert from "node:assert/strict";
import test from "node:test";
import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createShellActivity,
	renderWorkflowLogEntry,
	renderWorkflowShellEntry,
	WORKFLOW_LOG_ENTRY_TYPE,
	WORKFLOW_SHELL_ENTRY_TYPE,
} from "../../workflow/activity.js";
import type { WorkflowEffect } from "../../workflow/types.js";

/** Identity theme so rendered text is plain, assertion-friendly strings. */
const identityTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

function shellEntry(data: Partial<WorkflowEffect>): CustomEntry<WorkflowEffect> {
	return {
		type: "custom",
		id: "e1",
		parentId: null,
		timestamp: "",
		customType: WORKFLOW_SHELL_ENTRY_TYPE,
		data: { id: 1, name: "shell", detail: "echo hi", ok: true, durationMs: 120, ...data },
	} as unknown as CustomEntry<WorkflowEffect>;
}

test("a throwing UI render never loses the shell audit row", () => {
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = { appendEntry: (type: string, data: unknown) => { appended.push({ type, data }); } };
	const tui = { requestRender: () => { throw new Error("render failed"); } };
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { setWidget: (_key: string, factory: (tui: unknown) => unknown) => { factory(tui); }, notify: () => {} },
	};
	const activity = createShellActivity({ getPi: () => pi as never, getCtx: () => ctx as never });
	activity.onEffect({ phase: "start", effect: { id: 1, name: "shell", detail: "echo hi", ok: true, durationMs: 0 } });
	assert.throws(
		() => activity.onEffect({ phase: "end", effect: { id: 1, name: "shell", detail: "echo hi", ok: true, durationMs: 1, output: "hi" } }),
		/render failed/,
	);
	assert.equal(appended.length, 1, "the audit row lands before the throwing render");
	assert.equal(appended[0]!.type, WORKFLOW_SHELL_ENTRY_TYPE);
	activity.dispose();
});

test("collapsed shell entry shows the command, status, and duration but not output", () => {
	const lines = renderWorkflowShellEntry(shellEntry({ output: "line1\nline2" }), false, identityTheme).render(80);
	const joined = lines.join("\n");
	assert.ok(joined.includes("$ echo hi"), joined);
	assert.ok(joined.includes("ok"), joined);
	assert.ok(joined.includes("120ms"), joined);
	assert.ok(!joined.includes("line1"), "collapsed entry hides output");
	for (const line of lines) assert.ok(visibleWidth(line) <= 80, line);
});

test("expanded shell entry reveals output and the truncation path", () => {
	const lines = renderWorkflowShellEntry(
		shellEntry({ ok: false, killed: true, output: "out1", truncated: true, fullOutputPath: "/tmp/full.txt" }),
		true,
		identityTheme,
	).render(80);
	const joined = lines.join("\n");
	assert.ok(joined.includes("killed"), joined);
	assert.ok(joined.includes("out1"), joined);
	assert.ok(joined.includes("/tmp/full.txt"), joined);
	for (const line of lines) assert.ok(visibleWidth(line) <= 80, line);
});

test("log entry shows the script console text", () => {
	const entry = {
		type: "custom",
		id: "l1",
		parentId: null,
		timestamp: "",
		customType: WORKFLOW_LOG_ENTRY_TYPE,
		data: { text: "hello log" },
	} as unknown as CustomEntry<{ text: string }>;
	const lines = renderWorkflowLogEntry(entry, false, identityTheme).render(80);
	assert.ok(lines.some((line) => line.includes("hello log")), lines.join("\n"));
	for (const line of lines) assert.ok(visibleWidth(line) <= 80, line);
});
