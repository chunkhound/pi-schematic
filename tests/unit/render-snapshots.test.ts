/**
 * Snapshot tests for TUI render output.
 *
 * Creates golden files in tests/snapshots/ for every render variant.
 * Use UPDATE_SNAPSHOTS=1 to create/update golden files.
 *
 * No MockPi needed — uses real Theme, real TUI components via the harness.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { createState, type SchematicState } from "../../state.js";
import {
	renderSpawnCall,
	renderSpawnResult,
} from "../../spawn/renderer.js";
import { updateIndicators } from "../../tui.js";
import { createTestHarness } from "../test-utils.js";
import { createSession, makeTUICtx } from "./helpers.js";

// ── Paths ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "snapshots");

// ── Render test backend ───────────────────────────────────────────────

class RenderTestBackend {
	lines: string[] = [];
	render(component: { render(w: number): string[] }, width = 80): this {
		this.lines = component.render(width);
		return this;
	}
	toSnapshot(): string {
		return this.lines.join("\n");
	}
}

// ── Theme: identity (no styling tokens, clean golden files) ───────────

const theme: Theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

// ── Snapshot helpers ──────────────────────────────────────────────────

function ensureSnapshotDir(): void {
	if (!existsSync(SNAPSHOT_DIR)) {
		mkdirSync(SNAPSHOT_DIR, { recursive: true });
	}
}

/** Normalize line endings so golden files (stored with \n) match on Windows (\r\n). */
function normalizeEOL(s: string): string {
	return s.replace(/\r?\n/g, "\n");
}

/** Strip OSC terminal escape sequences for portable snapshot comparison. */
function stripOSC(s: string): string {
	return s.replace(/\u001b\]133;[A-Z][^\u0007]*\u0007/g, "");
}

function matchSnapshot(name: string, actual: string): void {
	ensureSnapshotDir();
	const file = join(SNAPSHOT_DIR, `${name}.txt`);
	const cleaned = stripOSC(normalizeEOL(actual));
	if (process.env.UPDATE_SNAPSHOTS) {
		writeFileSync(file, cleaned);
		return;
	}
	if (!existsSync(file)) {
		assert.fail(`Snapshot ${name} is missing. Re-run with UPDATE_SNAPSHOTS=1 to create it.`);
	}
	const expected = normalizeEOL(readFileSync(file, "utf-8"));
	assert.equal(cleaned, expected, `Snapshot ${name} does not match`);
}

function withHarness(run: (state: SchematicState) => void): void {
	const harness = createTestHarness();
	const state = createState();
	try {
		run(state);
	} finally {
		harness.teardown();
	}
}

// ── Snapshot width ────────────────────────────────────────────────────

const SNAP_WIDTH = 80;

// ═══════════════════════════════════════════════════════════════════════
// 1–2: Spawn call (renderSpawnCall)
// ═══════════════════════════════════════════════════════════════════════

test("spawn call collapsed matches snapshot", () => {
	const component = renderSpawnCall(
		{ prompt: "Research the rate limits for the OpenAI API and document the results.", thinking: "medium" },
		theme,
		{ expanded: false },
	);

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	matchSnapshot("spawn-call-collapsed", rtb.toSnapshot());
});

test("spawn call long prompt matches snapshot", () => {
	const prompt = [
		"Line 1: Initialize the project structure",
		"Line 2: Set up TypeScript configuration",
		"Line 3: Create the main entry point",
		"Line 4: Add test infrastructure",
		"Line 5: Configure CI/CD pipeline",
		"Line 6: Add documentation",
		"Line 7: Final review and cleanup",
	].join("\n");

	const component = renderSpawnCall(
		{ prompt, thinking: "high" },
		theme,
		{ expanded: false },
	);

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	matchSnapshot("spawn-call-long", rtb.toSnapshot());
});

// ═══════════════════════════════════════════════════════════════════════
// 3–5: Spawn result (renderSpawnResult, static Text path, no child session)
// ═══════════════════════════════════════════════════════════════════════

test("spawn result success matches snapshot", () => withHarness((state) => {
	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "Task completed successfully. All tests pass and documentation is updated." }],
			details: {
				model: "gpt-4o",
				thinking: "medium",
				outcome: "success" as const,
				stats: { inputTokens: 150, outputTokens: 75, turns: 3, cost: 0.023 },
			},
		},
		false,
		theme,
		{ toolCallId: "tc-1", invalidate: () => {}, showImages: false, lastComponent: undefined },
		state,
	);

	const rtb = new RenderTestBackend().render(component as any, SNAP_WIDTH);
	matchSnapshot("spawn-result-success", rtb.toSnapshot());
}));

test("spawn result error matches snapshot", () => withHarness((state) => {
	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "Failed to connect to API: rate limit exceeded. Retry after 60 seconds." }],
			details: {
				model: "gpt-4o",
				thinking: "high",
				outcome: "error" as const,
				stats: { inputTokens: 42, outputTokens: 0, turns: 1, cost: 0.0042 },
			},
		},
		false,
		theme,
		{ toolCallId: "tc-2", invalidate: () => {}, showImages: false, lastComponent: undefined },
		state,
	);

	const rtb = new RenderTestBackend().render(component as any, SNAP_WIDTH);
	matchSnapshot("spawn-result-error", rtb.toSnapshot());
}));

test("spawn result aborted matches snapshot", () => withHarness((state) => {
	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "Operation cancelled by user request." }],
			details: {
				model: "gpt-4o-mini",
				thinking: "low",
				outcome: "aborted" as const,
				stats: { inputTokens: 10, outputTokens: 0, turns: 0, cost: 0.0005 },
			},
		},
		false,
		theme,
		{ toolCallId: "tc-3", invalidate: () => {}, showImages: false, lastComponent: undefined },
		state,
	);

	const rtb = new RenderTestBackend().render(component as any, SNAP_WIDTH);
	matchSnapshot("spawn-result-aborted", rtb.toSnapshot());
}));

// ═══════════════════════════════════════════════════════════════════════
// 6–8: NestedAgentSessionComponent (via renderSpawnResult with child session)
// ═══════════════════════════════════════════════════════════════════════

test("nested collapsed running matches snapshot", () => withHarness((state) => {
	const session = createSession([]);
	state.childSessions.set("tc-nested-1", session);

	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "" }],
			details: { model: "gpt-4o", thinking: "medium" },
		},
		false,
		theme,
		{ toolCallId: "tc-nested-1", invalidate: () => {}, showImages: false, lastComponent: undefined },
		state,
	);

	const rtb = new RenderTestBackend().render(component as any, SNAP_WIDTH);
	matchSnapshot("nested-collapsed-running", rtb.toSnapshot());
}));

test("nested collapsed success matches snapshot", () => withHarness((state) => {
	const session = createSession([
		{
			role: "assistant",
			content: [{ type: "text", text: "Analysis complete. The optimal solution is to use a cache layer with TTL of 300s." }],
		},
	]);
	state.childSessions.set("tc-nested-2", session);

	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "" }],
			details: {
				model: "gpt-4o",
				thinking: "high",
				outcome: "success" as const,
				stats: { inputTokens: 200, outputTokens: 150, turns: 4, cost: 0.045 },
			},
		},
		false,
		theme,
		{ toolCallId: "tc-nested-2", invalidate: () => {}, showImages: false, lastComponent: undefined },
		state,
	);

	const rtb = new RenderTestBackend().render(component as any, SNAP_WIDTH);
	matchSnapshot("nested-collapsed-success", rtb.toSnapshot());
}));

test("nested expanded matches snapshot", () => withHarness((state) => {
	const session = createSession([
		{
			role: "assistant",
			content: [{ type: "text", text: "Here is the implementation plan. Create data access layer, add caching middleware, wire up the controller." }],
		},
	]);
	state.childSessions.set("tc-nested-3", session);

	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "" }],
			details: {
				model: "gpt-4o",
				thinking: "medium",
				outcome: "success" as const,
				stats: { inputTokens: 100, outputTokens: 50, turns: 2, cost: 0.012 },
			},
		},
		true,
		theme,
		{ toolCallId: "tc-nested-3", invalidate: () => {}, showImages: false, lastComponent: undefined },
		state,
	);

	const rtb = new RenderTestBackend().render(component as any, SNAP_WIDTH);
	matchSnapshot("nested-expanded", rtb.toSnapshot());
}));

// ═══════════════════════════════════════════════════════════════════════
// 9–11: Context indicator snapshots
// ═══════════════════════════════════════════════════════════════════════

test("context indicator at 30% matches snapshot", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 30, record });

	updateIndicators(ctx, state);
	const status = record.statuses.get("pi-schematic-ctx") ?? "";
	matchSnapshot("indicator-30", status);
});

test("context indicator at 50% matches snapshot", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 50, record });

	updateIndicators(ctx, state);
	const status = record.statuses.get("pi-schematic-ctx") ?? "";
	matchSnapshot("indicator-50", status);
});

test("context indicator at 70% matches snapshot", () => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent: 70, record });

	updateIndicators(ctx, state);
	const status = record.statuses.get("pi-schematic-ctx") ?? "";
	matchSnapshot("indicator-70", status);
});
