// WHY: the shell audit entries are the user's post-run view. They are pure renderers
// over a persisted WorkflowEffect, so assert their visible contract without a terminal.
import { expect, test } from "vitest";
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
	const appended: { type: string; data: unknown }[] = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => {
			appended.push({ type, data });
		},
	};
	const tui = {
		requestRender: () => {
			throw new Error("render failed");
		},
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget: (_key: string, factory: (tui: unknown) => unknown) => {
				factory(tui);
			},
			notify: () => {},
		},
	};
	const activity = createShellActivity({ getPi: () => pi as never, getCtx: () => ctx as never });
	activity.onEffect({ phase: "start", effect: { id: 1, name: "shell", detail: "echo hi", ok: true, durationMs: 0 } });
	expect(() => {
		activity.onEffect({ phase: "end", effect: { id: 1, name: "shell", detail: "echo hi", ok: true, durationMs: 1, output: "hi" } });
	}).toThrow(/render failed/);
	expect(appended.length, "the audit row lands before the throwing render").toBe(1);
	expect(appended[0].type).toBe(WORKFLOW_SHELL_ENTRY_TYPE);
	activity.dispose();
});

test("collapsed shell entry shows the command, status, and duration but not output", () => {
	const lines = renderWorkflowShellEntry(shellEntry({ output: "line1\nline2" }), false, identityTheme).render(80);
	const joined = lines.join("\n");
	expect(joined).toContain("$ echo hi");
	expect(joined).toContain("ok");
	expect(joined).toContain("120ms");
	expect(!joined.includes("line1"), "collapsed entry hides output").toBe(true);
	for (const line of lines) {
		expect(visibleWidth(line) <= 80).toBe(true);
	}
});

test("expanded shell entry reveals output and the truncation path", () => {
	const lines = renderWorkflowShellEntry(
		shellEntry({ ok: false, killed: true, output: "out1", truncated: true, fullOutputPath: "/tmp/full.txt" }),
		true,
		identityTheme,
	).render(80);
	const joined = lines.join("\n");
	expect(joined).toContain("killed");
	expect(joined).toContain("out1");
	expect(joined).toContain("/tmp/full.txt");
	for (const line of lines) {
		expect(visibleWidth(line) <= 80).toBe(true);
	}
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
	expect(lines.some((line) => line.includes("hello log"))).toBe(true);
	for (const line of lines) {
		expect(visibleWidth(line) <= 80).toBe(true);
	}
});
