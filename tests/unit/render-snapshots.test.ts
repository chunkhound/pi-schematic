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
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";

import { createState, type SchematicState } from "../../state.js";
import { renderSpawnCall, renderSpawnResult } from "../../spawn/renderer.js";
import { useTestHarness } from "../test-utils.js";
import { realTheme } from "../support/theme.js";
import { assistantMessage, createSubscribableSession } from "../support/session.js";

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

async function expectGoldenFile(name: string, actual: string): Promise<void> {
	const cleaned = stripTerminalSequences(actual);
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

// pi's theme is global and initTheme() cannot be undone, so every test in this file runs with it:
// nested tool components and the collapsed call's expand hint render only with a theme.
beforeAll(() => {
	initTheme();
});

// ── Snapshot width ────────────────────────────────────────────────────

const SNAP_WIDTH = 80;

// ═══════════════════════════════════════════════════════════════════════
// 1–2: Spawn call (renderSpawnCall)
// ═══════════════════════════════════════════════════════════════════════

test("spawn call collapsed matches snapshot", async () => {
	const component = renderSpawnCall({ prompt: "Research the rate limits for the OpenAI API and document the results.", thinking: "medium" }, realTheme, {
		expanded: false,
	});

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

	const component = renderSpawnCall({ prompt, thinking: "high" }, realTheme, { expanded: false });

	const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
	await expectGoldenFile("spawn-call-long", rtb.toSnapshot());
});

// ═══════════════════════════════════════════════════════════════════════
// 3: Spawn result (renderSpawnResult, static Text path, no child session)
// ═══════════════════════════════════════════════════════════════════════

test("spawn result success matches snapshot", () =>
	withHarness(async (state) => {
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
			realTheme,
			{ toolCallId: "tc-1", invalidate: vi.fn(), showImages: false, lastComponent: undefined },
			state,
		);

		const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
		await expectGoldenFile("spawn-result-success", rtb.toSnapshot());
	}));

// ═══════════════════════════════════════════════════════════════════════
// 4–7: NestedAgentSessionComponent (via renderSpawnResult with child session)
// ═══════════════════════════════════════════════════════════════════════

test("nested collapsed running matches snapshot", () =>
	withHarness(async (state) => {
		const session = createSubscribableSession("/tmp").session;
		state.childSessions.set("tc-nested-1", session);

		const component = renderSpawnResult(
			{
				content: [{ type: "text", text: "" }],
				details: { model: "gpt-4o", thinking: "medium" },
			},
			false,
			realTheme,
			{ toolCallId: "tc-nested-1", invalidate: vi.fn(), showImages: false, lastComponent: undefined },
			state,
		);

		const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
		await expectGoldenFile("nested-collapsed-running", rtb.toSnapshot());
	}));

test("nested collapsed success matches snapshot", () =>
	withHarness(async (state) => {
		const session = createSubscribableSession("/tmp", [
			assistantMessage([{ type: "text", text: "Analysis complete. The optimal solution is to use a cache layer with TTL of 300s." }]),
		]).session;
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
			realTheme,
			{ toolCallId: "tc-nested-2", invalidate: vi.fn(), showImages: false, lastComponent: undefined },
			state,
		);

		const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
		await expectGoldenFile("nested-collapsed-success", rtb.toSnapshot());
	}));

test("nested expanded matches snapshot", () =>
	withHarness(async (state) => {
		const session = createSubscribableSession("/tmp", [
			assistantMessage([{ type: "text", text: "Here is the implementation plan. Create data access layer, add caching middleware, wire up the controller." }]),
		]).session;
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
			realTheme,
			{ toolCallId: "tc-nested-3", invalidate: vi.fn(), showImages: false, lastComponent: undefined },
			state,
		);

		const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
		await expectGoldenFile("nested-expanded", rtb.toSnapshot());
	}));

test("nested expanded tool call matches snapshot", () =>
	withHarness(async (state) => {
		const session = createSubscribableSession("/tmp", [
			assistantMessage([{ type: "toolCall", id: "tc-lookup", name: "lookup_note", arguments: { path: "src/cache.ts" } }], { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolCallId: "tc-lookup",
				toolName: "lookup_note",
				content: [{ type: "text", text: "export const TTL_SECONDS = 300;" }],
				isError: false,
				timestamp: 1_767_225_600_000,
			},
		]).session;
		state.childSessions.set("tc-nested-4", session);

		const component = renderSpawnResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					model: "gpt-4o",
					thinking: "medium",
					outcome: "success" as const,
					stats: { inputTokens: 120, outputTokens: 40, turns: 1, cost: 0.01 },
				},
			},
			true,
			realTheme,
			{ toolCallId: "tc-nested-4", invalidate: vi.fn(), showImages: false, lastComponent: undefined },
			state,
		);

		const rtb = new RenderTestBackend().render(component, SNAP_WIDTH);
		await expectGoldenFile("nested-expanded-tool-call", rtb.toSnapshot());
	}));
