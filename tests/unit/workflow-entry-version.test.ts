// Contract: persisted workflow entries carry a schema version. Missing `v` is the legacy
// v1 shape; a newer version must render a safe fallback, never throw inside a process-wide
// renderer or an external consumer.
import assert from "node:assert/strict";
import test from "node:test";
import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";
import { renderWorkflowShellEntry } from "../../workflow/activity.js";
import {
	WORKFLOW_ENTRY_VERSION,
	WORKFLOW_EXIT_ENTRY_TYPE,
	readWorkflowExitEntry,
	type WorkflowExitEntry,
} from "../../workflow/types.js";
import { buildWorkflowSummary, readWorkflowSummaryData, type WorkflowRunSummaryData } from "../../workflow/summary.js";
import { renderWorkflowSummary } from "../../workflow/summary-renderer.js";

const identityTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

function summaryData(): WorkflowRunSummaryData {
	return buildWorkflowSummary(
		"wf",
		"approved",
		undefined,
		{
			startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
			elapsedMs: 65_000,
			checkpoints: 1,
			steps: 2,
			turns: 3,
			classifySteps: 0,
			activity: { run: 2, checkpoint: 1 },
			costUsd: 1,
			spend: [],
			limits: { costLimit: null, timeBudgetMs: null },
			unbounded: false,
			crossedAt: null,
			effects: [],
		},
	);
}

test("workflow-exit reads the legacy shape and the current shape", () => {
	const legacy = { reason: "returned" };
	assert.deepEqual(readWorkflowExitEntry(legacy), { v: WORKFLOW_ENTRY_VERSION, reason: "returned" });
	const current = { v: WORKFLOW_ENTRY_VERSION, reason: "approved", metadata: { round: 2 } } satisfies WorkflowExitEntry;
	assert.deepEqual(readWorkflowExitEntry(current), current);
});

test("workflow-exit refuses malformed and newer entries", () => {
	assert.equal(readWorkflowExitEntry({ reason: 7 }), null);
	assert.equal(readWorkflowExitEntry({ v: WORKFLOW_ENTRY_VERSION + 1, reason: "approved" }), null);
	assert.equal(readWorkflowExitEntry(null), null);
});

test("workflow-summary reads legacy data and round-trips current data", () => {
	const current = summaryData();
	assert.equal(current.v, WORKFLOW_ENTRY_VERSION);
	assert.deepEqual(readWorkflowSummaryData(current), current);
	const { v: _v, ...legacy } = current;
	assert.deepEqual(readWorkflowSummaryData(legacy), current);
});

test("workflow-summary refuses malformed and newer entries", () => {
	assert.equal(readWorkflowSummaryData({ workflow: "wf" }), null);
	const newer = { ...summaryData(), v: WORKFLOW_ENTRY_VERSION + 1 };
	assert.equal(readWorkflowSummaryData(newer), null);
});

test("summary renderer shows a safe fallback for a newer entry", () => {
	const newer = { ...summaryData(), v: WORKFLOW_ENTRY_VERSION + 1 };
	const text = renderWorkflowSummary(newer, false, identityTheme).render(80).join("\n");
	assert.match(text, /newer schematic version/);
	assert.doesNotMatch(text, /TypeError|undefined/);
});

test("shell renderer shows a safe fallback for a newer entry", () => {
	const entry = {
		type: "custom",
		id: "e1",
		parentId: null,
		timestamp: "",
		customType: "workflow-shell",
		data: { v: WORKFLOW_ENTRY_VERSION + 1, id: 1, name: "shell", detail: "echo hi", ok: true, durationMs: 2 },
	} as unknown as CustomEntry<unknown>;
	const text = renderWorkflowShellEntry(entry, false, identityTheme).render(80).join("\n");
	assert.match(text, /newer schematic version/);
});

test("entry type constant stays the persisted wire name", () => {
	assert.equal(WORKFLOW_EXIT_ENTRY_TYPE, "workflow-exit");
});
