/**
 * Property-based state invariant tests using fast-check.
 *
 * Generates random sequences of state operations and asserts invariants
 * that must hold after every operation on a pure SchematicState.
 */

import { expect, test } from "vitest";
import * as fc from "fast-check";
import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState, resetState, abortAndClearChildSessions, invalidateHandoffState, newRequestedHandoff } from "../../state.js";
import type { SchematicState } from "../../state.js";
import { setActiveNotebookTopic, clearActiveNotebookTopic } from "../../notebook/topic.js";
import { saveNotebookPage } from "../../notebook/store.js";
import { useTestHarness } from "../test-utils.js";
import { createRunner } from "../support/runner.js";
import { createSession } from "../support/session.js";

// ── Host API ──────────────────────────────────────────────────────────

/** The api pi passes an extension that registers nothing, on a headless runner; saveNotebookPage only appends entries through it. */
async function notebookApi(): Promise<ExtensionAPI> {
	let api: ExtensionAPI | undefined;
	await createRunner({
		cwd: process.cwd(),
		mode: "print",
		factories: [
			(pi) => {
				api = pi;
			},
		],
	});
	if (api === undefined) {
		throw new Error("The extension factory did not run.");
	}
	return api;
}

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
const arbSessionId = fc.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).filter((s) => s.length > 0);

// ── Apply ─────────────────────────────────────────────────────────────

async function apply(pi: ExtensionAPI, state: SchematicState, action: StateAction): Promise<void> {
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
			await saveNotebookPage(pi, state, action.name, "content-" + action.name);
			break;
		case "saveClippedPage":
			await saveNotebookPage(pi, state, action.name, CLIPPED_BODY);
			break;
		case "addChildSession":
			state.childSessions.set(action.id, createSession());
			state.liveChildSessions.set(action.id, createSession());
			break;
		case "abortChildren":
			abortAndClearChildSessions(state);
			break;
	}
}

// ── Invariant helpers ─────────────────────────────────────────────────

function assertTopicSourceCoupling(state: SchematicState): void {
	const msg = `topic=${String(state.activeNotebookTopic)} source=${String(state.activeNotebookTopicSource)}`;
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
		expect([...state.liveChildSessions.keys()], `childSessions key "${key}" must be in liveChildSessions`).toContain(key);
	}
}

function assertClippedPagesContained(state: SchematicState): void {
	for (const name of state.clippedPages) {
		expect([...state.notebookPages.keys()], `clipped page "${name}" must exist in notebookPages`).toContain(name);
	}
}

function assertResetClears(state: SchematicState): void {
	expect(
		{
			notebookPages: state.notebookPages.size,
			clippedPages: state.clippedPages.size,
			childSessions: state.childSessions.size,
			liveChildSessions: state.liveChildSessions.size,
			epoch: state.epoch,
			discardEpochWatermark: state.discardEpochWatermark,
			activeNotebookTopic: state.activeNotebookTopic,
			activeNotebookTopicSource: state.activeNotebookTopicSource,
			stagedHandoff: state.stagedHandoff,
			handoffRefusals: state.handoffRefusals.size,
			handoffFailedInRun: state.handoffFailedInRun,
			readonlyNudgeRearmAtSettle: state.readonlyNudgeRearmAtSettle,
			pendingRequestedHandoff: state.pendingRequestedHandoff,
			pendingTopicBoundaryHint: state.pendingTopicBoundaryHint,
			modelGroups: state.modelGroups.groups.length,
			modelGroupsValidation: state.modelGroups.validation,
			readonlyEnabled: state.readonlyEnabled,
			readonlyNudgePending: state.readonlyNudgePending,
			frontmatterSkillCache: state.frontmatterSkillCache.size,
			frontmatterPromptCache: state.frontmatterPromptCache.size,
			frontmatterSkillIssues: state.frontmatterSkillIssues.size,
			frontmatterPromptIssues: state.frontmatterPromptIssues.size,
			pendingReadonlyCommands: state.pendingReadonlyCommands.length,
			lastWatchdogBand: state.lastWatchdogBand,
			sandboxedBashCallIds: state.sandboxedBashCallIds.size,
		},
		"every field reset owns is back at its initial value",
	).toStrictEqual({
		notebookPages: 0,
		clippedPages: 0,
		childSessions: 0,
		liveChildSessions: 0,
		epoch: 0,
		discardEpochWatermark: 0,
		activeNotebookTopic: null,
		activeNotebookTopicSource: null,
		stagedHandoff: null,
		handoffRefusals: 0,
		handoffFailedInRun: false,
		readonlyNudgeRearmAtSettle: false,
		pendingRequestedHandoff: null,
		pendingTopicBoundaryHint: null,
		modelGroups: 0,
		modelGroupsValidation: null,
		readonlyEnabled: false,
		readonlyNudgePending: false,
		frontmatterSkillCache: 0,
		frontmatterPromptCache: 0,
		frontmatterSkillIssues: 0,
		frontmatterPromptIssues: 0,
		pendingReadonlyCommands: 0,
		lastWatchdogBand: null,
		sandboxedBashCallIds: 0,
	});
}

// ── Properties ────────────────────────────────────────────────────────

test("Property 1: Topic-source coupling invariant", async () => {
	useTestHarness();
	const pi = await notebookApi();
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
					await apply(pi, state, action);
					assertTopicSourceCoupling(state);
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 2: Child session containment invariant", async () => {
	useTestHarness();
	const pi = await notebookApi();
	await expect(
		fc.assert(
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
						await apply(pi, state, action);
						assertChildSessionContainment(state);
					}
				},
			),
			{ numRuns: 100 },
		),
	).resolves.toBeUndefined();
});

test("Property 3: childSessionEpoch only changes on reset", async () => {
	useTestHarness();
	const pi = await notebookApi();
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

				for (const action of actions) {
					const prevChildEpoch = state.childSessionEpoch;
					await apply(pi, state, action);

					// A reset increments childSessionEpoch by one; every other action leaves it unchanged.
					expect(state.childSessionEpoch, `childSessionEpoch after ${action.type} (prev=${prevChildEpoch})`).toBe(
						action.type === "reset" ? prevChildEpoch + 1 : prevChildEpoch,
					);
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 4: Reset clears all state fields", async () => {
	useTestHarness();
	const pi = await notebookApi();
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
					await apply(pi, state, action);

					// After every reset, assert full clear
					if (action.type === "reset") {
						assertResetClears(state);
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});

test("Property 5: Epoch counter — set to 1 on first savePage", async () => {
	useTestHarness();
	const pi = await notebookApi();
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.oneof(fc.constant({ type: "reset" }), fc.record({ type: fc.constant("savePage"), name: arbPageName }), fc.constant({ type: "clearTopic" })), {
				maxLength: 30,
			}),
			async (actions) => {
				const state = createState();

				expect(state.epoch, "epoch must be 0 on fresh state").toBe(0);

				for (const action of actions) {
					const prevEpoch: number = state.epoch;
					await apply(pi, state, action);

					if (action.type === "savePage") {
						// After first savePage, epoch transitions from 0 to 1
						// After subsequent saves, epoch is unchanged (set once)
						expect(state.epoch, `epoch must be > 0 after savePage, got ${state.epoch}`).toBeGreaterThan(0);
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

test("resetState clears every field it owns", async () => {
	useTestHarness();
	const pi = await notebookApi();
	const state = createState();
	setActiveNotebookTopic(state, "test-topic", "agent");
	setActiveNotebookTopic(state, "other-topic", "human");
	await saveNotebookPage(pi, state, "my-page", "some content");
	await saveNotebookPage(pi, state, "clipped-page", CLIPPED_BODY);
	state.discardEpochWatermark = 3;
	state.stagedHandoff = { ...STAGED_HANDOFF };
	state.handoffRefusals.set("call-2", "refused");
	state.handoffFailedInRun = true;
	state.readonlyNudgeRearmAtSettle = true;
	state.pendingRequestedHandoff = newRequestedHandoff("continue");
	state.lastWatchdogBand = 1;
	state.childSessions.set("child-1", createSession());
	state.liveChildSessions.set("child-1", createSession());
	state.readonlyEnabled = true;
	state.readonlyNudgePending = true;
	state.frontmatterSkillCache.set("skill-a", {
		readonly: true,
		modelGroup: null,
		explicitModel: null,
		explicitThinking: null,
		mtimeMs: 1,
		filePath: "/tmp/skill-a.md",
	});
	state.frontmatterPromptCache.set("prompt-a", {
		readonly: false,
		modelGroup: null,
		explicitModel: null,
		explicitThinking: null,
		mtimeMs: 1,
		filePath: "/tmp/prompt-a.md",
	});
	state.frontmatterSkillIssues.set("skill-b", { kind: "invalid-readonly-value", filePath: "/tmp/skill-b.md" });
	state.frontmatterPromptIssues.set("prompt-b", { kind: "unreadable-file", filePath: "/tmp/prompt-b.md" });
	state.pendingReadonlyCommands.push({ type: "skill", name: "skill-a" });
	state.sandboxedBashCallIds.add("bash-call-1");
	state.modelGroups.groups = [
		{
			name: "stale",
			scope: "project",
			sourcePath: "<project>",
			models: [],
			modalities: { common: [], supported: [], effective: [] },
			validation: { unavailableRefs: [], shadowedByProject: false, degraded: false },
			evaluations: [],
		},
	];
	state.modelGroups.validation = { groups: state.modelGroups.groups, loadIssues: [] };

	resetState(state);

	assertResetClears(state);
});

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
	setActiveNotebookTopic(state, "other-topic", "agent");
	state.pendingRequestedHandoff = { toolCalled: false, enforcementAttempts: 1, eligibleNudgeDelivered: false, nextInstruction: null };
	state.handoffFailedInRun = true;
	state.readonlyNudgeRearmAtSettle = true;
	state.lastWatchdogBand = 1;
	invalidateHandoffState(state);
	expect(state.stagedHandoff).toBeNull();
	expect(state.handoffFailedInRun).toBe(false);
	expect(state.readonlyNudgeRearmAtSettle).toBe(false);
	expect(state.lastWatchdogBand).toBeNull();
	expect(state.handoffRefusals.size).toBe(0);
	expect(state.handoffRefusals).toBe(refusals);
	expect(state.pendingRequestedHandoff).toBeNull();
	expect(state.pendingTopicBoundaryHint).toBeNull();
});

test("clipped page flags stay contained and reset clears them", async () => {
	const pi = await notebookApi();
	const state = createState();
	await saveNotebookPage(pi, state, "clipped-page", CLIPPED_BODY);
	assertClippedPagesContained(state);
	expect([...state.clippedPages], "oversized write must flag the page clipped").toContain("clipped-page");

	resetState(state);
	assertClippedPagesContained(state);
	assertResetClears(state);
});

test("Property 7: clipped pages are a subset of notebook pages", async () => {
	useTestHarness();
	const pi = await notebookApi();
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
					await apply(pi, state, action);
					assertClippedPagesContained(state);
					if (action.type === "saveClippedPage") {
						expect([...state.clippedPages], `clipped write "${action.name}" must set the clipped flag`).toContain(action.name);
					}
				}
			},
		),
		{ numRuns: 100 },
	);
});
