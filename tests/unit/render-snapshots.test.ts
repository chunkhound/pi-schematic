/**
 * Snapshot tests for TUI render output.
 *
 * Compares every render variant with its golden file in tests/snapshots/
 * through Vitest's file snapshots: a missing golden file is written in a
 * local run and fails the test under CI, and `--update=all` rewrites them.
 *
 * No MockPi needed — uses real Theme, real TUI components via the harness.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { createState, type SchematicState } from "../../state.js";
import {
	renderSpawnCall,
	renderSpawnResult,
} from "../../spawn/renderer.js";
import { updateIndicators } from "../../tui.js";
import { useTestHarness } from "../test-utils.js";
import { createSession, makeTUICtx, theme } from "./helpers.js";

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

// ── Snapshot helpers ──────────────────────────────────────────────────

/** Strip OSC terminal escape sequences for portable snapshot comparison. */
function stripOSC(s: string): string {
	return s.replace(/\u001b\]133;[A-Z][^\u0007]*\u0007/g, "");
}

async function expectGoldenFile(name: string, actual: string): Promise<void> {
	const cleaned = stripOSC(actual);
	const goldenPath = join(SNAPSHOT_DIR, `${name}.txt`);
	await expect(
		cleaned,
		`Snapshot ${name} does not match golden file ${goldenPath}, or the file is missing. ` +
			"Run `npm run test:snapshots:update` to rewrite it, or a local `npm test` to write a missing one.",
	).toMatchFileSnapshot(goldenPath);
}

function withHarness(run: (state: SchematicState) => Promise<void>): Promise<void> {
	useTestHarness();
	const state = createState();
	return run(state);
}

// ── Snapshot width ────────────────────────────────────────────────────

const SNAP_WIDTH = 80;

// ═══════════════════════════════════════════════════════════════════════
// 1–2: Spawn call (renderSpawnCall)
// ═══════════════════════════════════════════════════════════════════════

test("spawn call collapsed matches snapshot", async () => {
	const component = renderSpawnCall(
		{ prompt: "Research the rate limits for the OpenAI API and document the results.", thinking: "medium" },
		theme,
		{ expanded: false },
	);

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("spawn-call-collapsed", rtb.toSnapshot());
});

test("spawn call long prompt matches snapshot", async () => {
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
	await expectGoldenFile("spawn-call-long", rtb.toSnapshot());
});

// ═══════════════════════════════════════════════════════════════════════
// 3–5: Spawn result (renderSpawnResult, static Text path, no child session)
// ═══════════════════════════════════════════════════════════════════════

test("spawn result success matches snapshot", () => withHarness(async (state) => {
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

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("spawn-result-success", rtb.toSnapshot());
}));

test("spawn result error matches snapshot", () => withHarness(async (state) => {
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

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("spawn-result-error", rtb.toSnapshot());
}));

test("spawn result aborted matches snapshot", () => withHarness(async (state) => {
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

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("spawn-result-aborted", rtb.toSnapshot());
}));

// ═══════════════════════════════════════════════════════════════════════
// 6–8: NestedAgentSessionComponent (via renderSpawnResult with child session)
// ═══════════════════════════════════════════════════════════════════════

test("nested collapsed running matches snapshot", () => withHarness(async (state) => {
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

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("nested-collapsed-running", rtb.toSnapshot());
}));

test("nested collapsed success matches snapshot", () => withHarness(async (state) => {
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

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("nested-collapsed-success", rtb.toSnapshot());
}));

test("nested expanded matches snapshot", () => withHarness(async (state) => {
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

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("nested-expanded", rtb.toSnapshot());
}));

// ═══════════════════════════════════════════════════════════════════════
// 9–11: Context indicator snapshots
// ═══════════════════════════════════════════════════════════════════════

test.for([30, 50, 70])("context indicator at %i% matches snapshot", async (percent) => {
	const state = createState();
	const record = { statuses: new Map<string, string | undefined>(), widgets: new Map<string, string[] | undefined>() };
	const ctx = makeTUICtx({ percent, record });

	updateIndicators(ctx, state);
	const status = record.statuses.get("pi-schematic-ctx") ?? "";
	await expectGoldenFile(`indicator-${String(percent)}`, status);
});
