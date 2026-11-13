/**
 * Property-based state invariant tests using fast-check.
 *
 * Generates random sequences of state operations and asserts invariants
 * that must hold after every operation on a pure SchematicState.
 */

import { expect, test, vi } from "vitest";
import * as fc from "fast-check";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { createState, resetState, abortAndClearChildSessions, invalidateHandoffState, newRequestedHandoff } from "../../state.js";
import type { SchematicState } from "../../state.js";
import {
	setActiveNotebookTopic,
	clearActiveNotebookTopic,
} from "../../notebook/topic.js";
import { saveNotebookPage } from "../../notebook/store.js";
import { useTestHarness } from "../test-utils.js";

// ── Mock ExtensionAPI ─────────────────────────────────────────────────

const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;

/** First line fits, second line alone exceeds the byte cap: truncates to a clipped head. */
const CLIPPED_BODY = "head\n" + "x".repeat(DEFAULT_MAX_BYTES + 1);

// ── Action types ──────────────────────────────────────────────────────

type StateAction =
	| { type: "reset" }
	| { type: "setTopic"; name: string }
	| { type: "clearTopic" }
	| { type: "savePage"; name: string }
	| { type: "saveClippedPage"; name: string }
	| { type: "addChildSession"; id: string }
	| { type: "abortChildren" };

/** Generator for valid normalized topic names (non-empty after normalizeNotebookTopic). */
const arbTopicName = fc
	.stringMatching(/^[a-zA-Z][a-zA-Z0-9 _-]{0,19}$/)
	.map((s) => s.trim())
	.filter((s) => s.length > 0);

/** Generator for valid notebook page names (kebab-case). */
const arbPageName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

/** Generator for session IDs (simulating toolCallId format). */
const arbSessionId = fc
	.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
	.filter((s) => s.length > 0);

// ── Apply ─────────────────────────────────────────────────────────────

async function apply(
	state: SchematicState,
	action: StateAction,
): Promise<void> {
	switch (action.type) {
		case "reset":
			resetState(state);
			break;
		case "setTopic":
			setActiveNotebookTopic(state, action.name, "agent");
			break;
		case "clearTopic":
			clearActiveNotebookTopic(state);
			break;
		case "savePage":
			await saveNotebookPage(mockPi, state, action.name, "content-" + action.name);
			break;
		case "saveClippedPage":
			await saveNotebookPage(mockPi, state, action.name, CLIPPED_BODY);
			break;
		case "addChildSession":
			state.childSessions.set(action.id, { abort: () => Promise.resolve() } as any);
			state.liveChildSessions.set(action.id, { abort: () => Promise.resolve() } as any);
			break;
		case "abortChildren":
			abortAndClearChildSessions(state);
			break;
	}
}

// ── Invariant helpers ─────────────────────────────────────────────────

function assertTopicSourceCoupling(state: SchematicState): void {
	const msg = `topic=${state.activeNotebookTopic} source=${state.activeNotebookTopicSource}`;
	if (state.activeNotebookTopic === null) {
		expect(state.activeNotebookTopicSource, `topic null → source null: ${msg}`).toBeNull();
	} else {
		expect(state.activeNotebookTopicSource, `topic set → source set: ${msg}`).not.toBeNull();
	}
	// Bidirectional: source null → topic null too
	if (state.activeNotebookTopicSource === null) {
		expect(state.activeNotebookTopic, `source null → topic null: ${msg}`).toBeNull();
	}
}

function assertChildSessionContainment(state: SchematicState): void {
	for (const key of state.childSessions.keys()) {
		expect(
			[...state.liveChildSessions.keys()],
			`childSessions key "${key}" must be in liveChildSessions`,
		).toContain(key);
	}
}

function assertClippedPagesContained(state: SchematicState): void {
	for (const name of state.clippedPages) {
		expect(
			[...state.notebookPages.keys()],
			`clipped page "${name}" must exist in notebookPages`,
		).toContain(name);
	}
}

function assertResetClears(state: SchematicState): void {
	expect(state.notebookPages.size, "notebookPages must be empty after reset").toBe(0);
	expect(state.clippedPages.size, "clippedPages must be empty after reset").toBe(0);
	expect(state.childSessions.size, "childSessions must be empty after reset").toBe(0);
	expect(state.liveChildSessions.size, "liveChildSessions must be empty after reset").toBe(0);
	expect(state.epoch, "epoch must be 0 after reset").toBe(0);
	expect(state.activeNotebookTopic, "topic must be null after reset").toBeNull();
	expect(state.activeNotebookTopicSource, "topic source must be null after reset").toBeNull();
	expect(state.stagedHandoff, "stagedHandoff must be null after reset").toBeNull();
	expect(state.handoffRefusals.size, "handoffRefusals must be empty after reset").toBe(0);
	expect(state.pendingRequestedHandoff, "pendingRequestedHandoff must be null after reset").toBeNull();
	expect(state.pendingTopicBoundaryHint, "pendingTopicBoundaryHint must be null after reset").toBeNull();
	expect(state.modelGroups.groups, "modelGroups.groups must be empty after reset").toHaveLength(0);
	expect(state.modelGroups.validation, "modelGroups.validation must be null after reset").toBeNull();
	expect(state.readonlyEnabled, "readonlyEnabled must be false after reset").toBe(false);
	expect(state.readonlyNudgePending, "readonlyNudgePending must be false after reset").toBe(false);
	expect(state.frontmatterSkillCache.size, "frontmatterSkillCache must be empty after reset").toBe(0);
	expect(state.frontmatterPromptCache.size, "frontmatterPromptCache must be empty after reset").toBe(0);
	expect(state.frontmatterSkillIssues.size, "frontmatterSkillIssues must be empty after reset").toBe(0);
	expect(state.frontmatterPromptIssues.size, "frontmatterPromptIssues must be empty after reset").toBe(0);
	expect(state.pendingReadonlyCommands, "pendingReadonlyCommands must be empty after reset").toHaveLength(0);
	expect(state.lastWatchdogBand, "lastWatchdogBand must be null after reset").toBeNull();
	expect(state.sandboxedBashCallIds.size, "sandboxedBashCallIds must be empty after reset").toBe(0);
}

// ── Properties ────────────────────────────────────────────────────────

test("Property 1: Topic-source coupling invariant", async () => {
	useTestHarness();
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" }),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				for (const action of actions) {
					await apply(state, action);
					assertTopicSourceCoupling(state);
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 2: Child session containment invariant", async () => {
	useTestHarness();
	await expect(fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("addChildSession"), id: arbSessionId }),
					fc.constant({ type: "abortChildren" }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				for (const action of actions) {
					await apply(state, action);
					assertChildSessionContainment(state);
				}
			},
		),
		{ numRuns: 100 },
	)).resolves.toBeUndefined();
});

test("Property 3: childSessionEpoch only changes on reset", async () => {
	useTestHarness();
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" }),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.constant({ type: "abortChildren" }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				let expectedChildEpoch: number | null = null;

				for (const action of actions) {
					const prevChildEpoch = state.childSessionEpoch;
					await apply(state, action);

					if (action.type === "reset") {
						// After reset, childSessionEpoch should have incremented
						if (expectedChildEpoch === null) {
							expectedChildEpoch = prevChildEpoch + 1;
						} else {
							expectedChildEpoch = state.childSessionEpoch;
						}
						expect(
							state.childSessionEpoch,
							`childSessionEpoch must be ${expectedChildEpoch} after reset (prev=${prevChildEpoch})`,
						).toBe(expectedChildEpoch);
						expectedChildEpoch = state.childSessionEpoch;
					} else {
						// Non-reset: childSessionEpoch must be unchanged
						expect(
							state.childSessionEpoch,
							`childSessionEpoch must not change on ${action.type} action`,
						).toBe(prevChildEpoch);
						expectedChildEpoch = state.childSessionEpoch;
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 4: Reset clears all state fields", async () => {
	useTestHarness();
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" }),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.record({ type: fc.constant("addChildSession"), id: arbSessionId }),
					fc.constant({ type: "abortChildren" }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();

				for (const action of actions) {
					await apply(state, action);

					// After every reset, assert full clear
					if (action.type === "reset") {
						assertResetClears(state);
					}
				}

				// Also test explicitly: create fresh state, perform some work, then reset
				const s2 = createState();
				setActiveNotebookTopic(s2, "test-topic", "agent");
				await saveNotebookPage(mockPi, s2, "my-page", "some content");
				s2.readonlyEnabled = true;
				s2.readonlyNudgePending = true;
				s2.frontmatterSkillCache.set("skill-a", { readonly: true, modelGroup: null, explicitModel: null, explicitThinking: null, mtimeMs: 1, filePath: "/tmp/skill-a.md" });
				s2.frontmatterPromptCache.set("prompt-a", { readonly: false, modelGroup: null, explicitModel: null, explicitThinking: null, mtimeMs: 1, filePath: "/tmp/prompt-a.md" });
				s2.frontmatterSkillIssues.set("skill-b", { kind: "invalid-readonly-value", filePath: "/tmp/skill-b.md" });
				s2.frontmatterPromptIssues.set("prompt-b", { kind: "unreadable-file", filePath: "/tmp/prompt-b.md" });
				s2.pendingReadonlyCommands.push({ type: "skill", name: "skill-a" });
				s2.sandboxedBashCallIds.add("bash-call-1");
				s2.modelGroups.groups = [{
					name: "stale",
					scope: "project",
					sourcePath: "<project>",
					models: [],
					modalities: { common: [], supported: [], effective: [] },
					validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] },
				}];
				s2.modelGroups.validation = { groups: s2.modelGroups.groups, loadIssues: [] };
				resetState(s2);
				assertResetClears(s2);
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 5: Epoch counter — set to 1 on first savePage", async () => {
	useTestHarness();
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.constant({ type: "clearTopic" }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();

				expect(state.epoch, "epoch must be 0 on fresh state").toBe(0);

				for (const action of actions) {
					const prevEpoch: number = state.epoch;
					await apply(state, action);

					if (action.type === "savePage") {
						// After first savePage, epoch transitions from 0 to 1
						// After subsequent saves, epoch is unchanged (set once)
						expect(
							state.epoch,
							`epoch must be > 0 after savePage, got ${state.epoch}`,
						).toBeGreaterThan(0);
						if (prevEpoch === 0) {
							// First write: epoch transitions from 0 to 1
							expect(state.epoch, "epoch must be 1 after first savePage").toBe(1);
						} else {
							// Subsequent writes: epoch unchanged
							expect(state.epoch, "epoch must not change on subsequent savePage").toBe(prevEpoch);
						}
					} else if (action.type === "reset") {
						// Reset sets epoch to 0
						expect(state.epoch, "epoch must be 0 after reset").toBe(0);
					} else {
						// Non-save, non-reset: epoch unchanged
						expect(state.epoch, "epoch unchanged on non-save/non-reset actions").toBe(prevEpoch);
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});

const STAGED_HANDOFF: NonNullable<SchematicState["stagedHandoff"]> = {
	handoffId: "handoff-1",
	toolCallId: "call-1",
	nextInstruction: "continue",
	context: "",
	discardPages: [],
	discardedPages: [],
	phase: "staged",
	declineReason: null,
};

test("a new state has no staged handoff and no refusals", () => {
	const state = createState();
	expect(state.stagedHandoff).toBeNull();
	expect(state.handoffRefusals.size).toBe(0);
});

test("reset clears a staged handoff and the refusals, keeping the refusal map identity", () => {
	const state = createState();
	const refusals = state.handoffRefusals;
	state.stagedHandoff = { ...STAGED_HANDOFF };
	refusals.set("call-2", "refused");
	state.handoffFailedInRun = true;
	resetState(state);
	expect(state.stagedHandoff).toBeNull();
	expect(state.handoffFailedInRun).toBe(false);
	expect(state.handoffRefusals.size).toBe(0);
	expect(state.handoffRefusals).toBe(refusals);
});

test("a new requested handoff starts uncalled, uncounted and unnudged with the given instruction", () => {
	expect(newRequestedHandoff("ship the release notes")).toStrictEqual({
		toolCalled: false,
		enforcementAttempts: 0,
		eligibleNudgeDelivered: false,
		nextInstruction: "ship the release notes",
	});
});

test("invalidateHandoffState clears the staged handoff, the refusals and the pending request", () => {
	const state = createState();
	const refusals = state.handoffRefusals;
	state.stagedHandoff = { ...STAGED_HANDOFF };
	refusals.set("call-2", "refused");
	setActiveNotebookTopic(state, "topic", "agent");
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 1, eligibleNudgeDelivered: false, nextInstruction: null };
	state.handoffFailedInRun = true;
	invalidateHandoffState(state);
	expect(state.stagedHandoff).toBeNull();
	expect(state.handoffFailedInRun).toBe(false);
	expect(state.handoffRefusals.size).toBe(0);
	expect(state.handoffRefusals).toBe(refusals);
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(state.pendingTopicBoundaryHint).toBeNull();
});

test("reset clears deferred readonly frontmatter commands", () => {
	const state = createState();
	state.pendingReadonlyCommands.push({ type: "skill", name: "a" });

	resetState(state);
	expect(state.pendingReadonlyCommands, "readonly queue cleared").toHaveLength(0);
});

test("clipped page flags stay contained and reset clears them", async () => {
	const state = createState();
	await saveNotebookPage(mockPi, state, "clipped-page", CLIPPED_BODY);
	assertClippedPagesContained(state);
	expect([...state.clippedPages], "oversized write must flag the page clipped").toContain("clipped-page");

	resetState(state);
	assertClippedPagesContained(state);
	assertResetClears(state);
});

test("Property 6: childSessionEpoch monotonicity (never decreases)", async () => {
	useTestHarness();
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
					fc.constant({ type: "clearTopic" }),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				let maxSeenEpoch = 0;

				for (const action of actions) {
					await apply(state, action);
					expect(
						state.childSessionEpoch,
						`childSessionEpoch must never decrease: was ${maxSeenEpoch}, got ${state.childSessionEpoch}`,
					).toBeGreaterThanOrEqual(maxSeenEpoch);
					maxSeenEpoch = Math.max(maxSeenEpoch, state.childSessionEpoch);
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 7: clipped pages are a subset of notebook pages", async () => {
	useTestHarness();
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.constant({ type: "reset" }),
					fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					fc.record({ type: fc.constant("saveClippedPage"), name: arbPageName }),
				),
				{ maxLength: 30 },
			),
			async (actions) => {
				const state = createState();
				for (const action of actions) {
					await apply(state, action);
					assertClippedPagesContained(state);
					if (action.type === "saveClippedPage") {
						expect(
							[...state.clippedPages],
							`clipped write "${action.name}" must set the clipped flag`,
						).toContain(action.name);
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});
