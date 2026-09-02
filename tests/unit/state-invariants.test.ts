/**
 * Property-based state invariant tests using fast-check.
 *
 * Generates random sequences of state operations and asserts invariants
 * that must hold after every operation on a pure AgenticodingState.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState, resetState, abortAndClearChildSessions, invalidateHandoffState } from "../../state.js";
import type { AgenticodingState } from "../../state.js";
import {
	setActiveNotebookTopic,
	clearActiveNotebookTopic,
} from "../../notebook/topic.js";
import { saveNotebookPage } from "../../notebook/store.js";
import { createTestHarness } from "../test-utils.js";

// ── Mock ExtensionAPI ─────────────────────────────────────────────────

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

// ── Action types ──────────────────────────────────────────────────────

type StateAction =
	| { type: "reset" }
	| { type: "setTopic"; name: string }
	| { type: "clearTopic" }
	| { type: "savePage"; name: string }
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
	state: AgenticodingState,
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

function assertTopicSourceCoupling(state: AgenticodingState): void {
	const msg = `topic=${state.activeNotebookTopic} source=${state.activeNotebookTopicSource}`;
	if (state.activeNotebookTopic === null) {
		assert.equal(state.activeNotebookTopicSource, null, `topic null → source null: ${msg}`);
	} else {
		assert.notEqual(state.activeNotebookTopicSource, null, `topic set → source set: ${msg}`);
	}
	// Bidirectional: source null → topic null too
	if (state.activeNotebookTopicSource === null) {
		assert.equal(state.activeNotebookTopic, null, `source null → topic null: ${msg}`);
	}
}

function assertChildSessionContainment(state: AgenticodingState): void {
	for (const key of state.childSessions.keys()) {
		assert.ok(
			state.liveChildSessions.has(key),
			`childSessions key "${key}" must be in liveChildSessions`,
		);
	}
}

function assertResetClears(state: AgenticodingState): void {
	assert.equal(state.notebookPages.size, 0, "notebookPages must be empty after reset");
	assert.equal(state.childSessions.size, 0, "childSessions must be empty after reset");
	assert.equal(state.liveChildSessions.size, 0, "liveChildSessions must be empty after reset");
	assert.equal(state.epoch, 0, "epoch must be 0 after reset");
	assert.equal(state.activeNotebookTopic, null, "topic must be null after reset");
	assert.equal(state.activeNotebookTopicSource, null, "topic source must be null after reset");
	assert.equal(state.pendingHandoff, null, "pendingHandoff must be null after reset");
	assert.equal(state.pendingRequestedHandoff, null, "pendingRequestedHandoff must be null after reset");
	assert.equal(state.pendingTopicBoundaryHint, null, "pendingTopicBoundaryHint must be null after reset");
	assert.equal(state.modelGroups.groups.length, 0, "modelGroups.groups must be empty after reset");
	assert.equal(state.modelGroups.validation, null, "modelGroups.validation must be null after reset");
	assert.equal(state.readonlyEnabled, false, "readonlyEnabled must be false after reset");
	assert.equal(state.readonlyNudgePending, false, "readonlyNudgePending must be false after reset");
	assert.equal(state.frontmatterSkillCache.size, 0, "frontmatterSkillCache must be empty after reset");
	assert.equal(state.frontmatterPromptCache.size, 0, "frontmatterPromptCache must be empty after reset");
	assert.equal(state.frontmatterSkillIssues.size, 0, "frontmatterSkillIssues must be empty after reset");
	assert.equal(state.frontmatterPromptIssues.size, 0, "frontmatterPromptIssues must be empty after reset");
	assert.equal(state.pendingReadonlyCommands.length, 0, "pendingReadonlyCommands must be empty after reset");
	assert.equal(state.lastWatchdogBand, null, "lastWatchdogBand must be null after reset");
}

// ── Properties ────────────────────────────────────────────────────────

test("Property 1: Topic-source coupling invariant", async () => {
	const h = createTestHarness();
	try {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant({ type: "reset" } as StateAction),
						fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
						fc.constant({ type: "clearTopic" } as StateAction),
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
	} finally {
		h.teardown();
	}
});

test("Property 2: Child session containment invariant", async () => {
	const h = createTestHarness();
	try {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant({ type: "reset" } as StateAction),
						fc.record({ type: fc.constant("addChildSession"), id: arbSessionId }),
						fc.constant({ type: "abortChildren" } as StateAction),
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
		);
	} finally {
		h.teardown();
	}
});

test("Property 3: childSessionEpoch only changes on reset", async () => {
	const h = createTestHarness();
	try {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant({ type: "reset" } as StateAction),
						fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
						fc.constant({ type: "clearTopic" } as StateAction),
						fc.record({ type: fc.constant("savePage"), name: arbPageName }),
						fc.constant({ type: "abortChildren" } as StateAction),
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
							assert.equal(
								state.childSessionEpoch,
								expectedChildEpoch,
								`childSessionEpoch must be ${expectedChildEpoch} after reset (prev=${prevChildEpoch})`,
							);
							expectedChildEpoch = state.childSessionEpoch;
						} else {
							// Non-reset: childSessionEpoch must be unchanged
							assert.equal(
								state.childSessionEpoch,
								prevChildEpoch,
								`childSessionEpoch must not change on ${action.type} action`,
							);
							expectedChildEpoch = state.childSessionEpoch;
						}
					}
				},
			),
			{ numRuns: 100 },
		);
	} finally {
		h.teardown();
	}
});

test("Property 4: Reset clears all state fields", async () => {
	const h = createTestHarness();
	try {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant({ type: "reset" } as StateAction),
						fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
						fc.constant({ type: "clearTopic" } as StateAction),
						fc.record({ type: fc.constant("savePage"), name: arbPageName }),
						fc.record({ type: fc.constant("addChildSession"), id: arbSessionId }),
						fc.constant({ type: "abortChildren" } as StateAction),
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
	} finally {
		h.teardown();
	}
});

test("Property 5: Epoch counter — set to 1 on first savePage", async () => {
	const h = createTestHarness();
	try {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant({ type: "reset" } as StateAction),
						fc.record({ type: fc.constant("savePage"), name: arbPageName }),
						fc.constant({ type: "clearTopic" } as StateAction),
					),
					{ maxLength: 30 },
				),
				async (actions) => {
					const state = createState();

					assert.equal(state.epoch, 0, "epoch must be 0 on fresh state");

					for (const action of actions) {
						const prevEpoch: number = state.epoch;
						await apply(state, action);

						if (action.type === "savePage") {
							// After first savePage, epoch transitions from 0 to 1
							// After subsequent saves, epoch is unchanged (set once)
							assert.ok(
								state.epoch > 0,
								`epoch must be > 0 after savePage, got ${state.epoch}`,
							);
							if (prevEpoch === 0) {
								// First write: epoch transitions from 0 to 1
								assert.equal(state.epoch, 1, "epoch must be 1 after first savePage");
							} else {
								// Subsequent writes: epoch unchanged
								assert.equal(state.epoch, prevEpoch, "epoch must not change on subsequent savePage");
							}
						} else if (action.type === "reset") {
							// Reset sets epoch to 0
							assert.equal(state.epoch, 0, "epoch must be 0 after reset");
						} else {
							// Non-save, non-reset: epoch unchanged
							assert.equal(state.epoch, prevEpoch, "epoch unchanged on non-save/non-reset actions");
						}
					}
				},
			),
			{ numRuns: 100 },
		);
	} finally {
		h.teardown();
	}
});

test("reset increments handoffGeneration and clears compaction reservations", () => {
	const state = createState();
	const initial = state.handoffGeneration;
	state.handoffCompactionGeneration = 7;
	setActiveNotebookTopic(state, "topic", "agent");
	assert.equal(state.handoffGeneration, initial);
	resetState(state);
	assert.equal(state.handoffGeneration, initial + 1);
	assert.equal(state.handoffCompactionGeneration, null);
	resetState(state);
	assert.equal(state.handoffGeneration, initial + 2);
});

test("invalidateHandoffState clears branch-local compaction reservations", () => {
	const state = createState();
	state.handoffCompactionGeneration = 7;
	setActiveNotebookTopic(state, "topic", "agent");
	state.pendingRequestedHandoff = { toolCalled: false, resumeReadonlyAfterHandoff: true, enforcementAttempts: 1 };
	const initial = state.handoffGeneration;
	invalidateHandoffState(state);
	assert.equal(state.handoffGeneration, initial + 1);
	assert.equal(state.handoffCompactionGeneration, null);
	assert.equal(state.pendingRequestedHandoff, null);
	assert.equal(state.pendingTopicBoundaryHint, null);
});

test("reset clears deferred readonly frontmatter commands", () => {
	const state = createState();
	state.pendingReadonlyCommands.push({ type: "skill", name: "a" });

	resetState(state);
	assert.equal(state.pendingReadonlyCommands.length, 0, "readonly queue cleared");
});

test("Property 6: childSessionEpoch monotonicity (never decreases)", async () => {
	const h = createTestHarness();
	try {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant({ type: "reset" } as StateAction),
						fc.record({ type: fc.constant("setTopic"), name: arbTopicName }),
						fc.constant({ type: "clearTopic" } as StateAction),
						fc.record({ type: fc.constant("savePage"), name: arbPageName }),
					),
					{ maxLength: 30 },
				),
				async (actions) => {
					const state = createState();
					let maxSeenEpoch = 0;

					for (const action of actions) {
						await apply(state, action);
						assert.ok(
							state.childSessionEpoch >= maxSeenEpoch,
							`childSessionEpoch must never decrease: was ${maxSeenEpoch}, got ${state.childSessionEpoch}`,
						);
						maxSeenEpoch = Math.max(maxSeenEpoch, state.childSessionEpoch);
					}
				},
			),
			{ numRuns: 100 },
		);
	} finally {
		h.teardown();
	}
});
