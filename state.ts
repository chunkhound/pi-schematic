/**
 * Shared mutable state for the agenticoding extension.
 *
 * Single source of truth that all modules read/write through.
 * Mutable by design — this is session-scoped imperative state.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelGroupsBootValidation, ResolvedModelGroup } from "./model-groups/types.js";
import type { FrontmatterEntry, FrontmatterIssue } from "./frontmatter-cache.js";
import type { NotebookTopicBoundaryHint } from "./notebook/topic.js";
import type { HandoffPayload } from "./handoff/format.js";

export interface AgenticodingState {
	/** Compact notebook pages keyed by kebab-case name */
	notebookPages: Map<string, string>;

	/** Notebook generation counter. 0 = no writes yet; 1 = first write; bumped on discard. */
	epoch: number;

	/** Current semantic frame for topic-aware spawn vs handoff decisions. */
	activeNotebookTopic: string | null;

	/** Whether the current topic came from the human or the agent. */
	activeNotebookTopicSource: "human" | "agent" | null;

	/**
	 * Boundary cue consumed after a topic change. Human readonly boundaries remain
	 * queued while context usage is unavailable or below the handoff threshold so a
	 * later eligible context hook can promote them to the handoff bypass.
	 */
	pendingTopicBoundaryHint: NotebookTopicBoundaryHint | null;

	/** Last context usage percent from getContextUsage() */
	lastContextPercent: number | null;

	/**
	 * Generation marker queued by the tool until the matching compaction hook consumes
	 * it. The successor message is built at tool-call time and carried by the
	 * completion callback, so no request payload belongs here.
	 */
	pendingHandoff: { generation: number } | null;

	/** Monotonically increasing identity used to ignore stale compaction callbacks. */
	handoffGeneration: number;

	/** Generation of the compaction currently in flight, if any. */
	handoffCompactionGeneration: number | null;

	/** Exact successor payload and its durable per-cut recovery key retained until direct completion finalizes. */
	pendingHandoffDelivery: { generation: number; payload: HandoffPayload; recoveryKey: string } | null;

	/**
	 * Successor delivery already requested by recovery in this process.
	 * Coalesces repeated recovery triggers for one persisted handoff cut while the
	 * delivery is pending; cleared when a run settles and reset on session_start.
	 * Deliberately not cleared on branch switch (invalidateHandoffState): the
	 * durable cut key lets a cut shared across `/tree` branches coalesce instead
	 * of double-sending. Entries carrying a v1 payload but no recovery key fall
	 * back to their persisted entry identity; legacy entries without a payload
	 * are never recovered (recovery.ts stops at the newest unreadable cut).
	 */
	recoveryRequestedMessage: { handoffEntryId: string | null; recoveryKey: string | null; message: string } | null;

	/** Prepared notebook discard awaiting the matching successful handoff callback. */
	pendingNotebookDiscard: { generation: number; nextEpoch: number; deleted: string[] } | null;

	/**
	 * High-water mark for discard epochs. Advanced in-memory by prepare;
	 * derived from the branch by reconstruction (max valid observed page/
	 * generation epoch). Survives failed attempts and restarts so retries
	 * cannot reuse a staged epoch and resurrect orphaned survivor entries.
	 */
	discardEpochWatermark: number;

	/**
	 * Required handoff request that stays alive until a real tool-driven compaction
	 * succeeds, is explicitly reset, or ages out via watchdog enforcement.
	 */
	pendingRequestedHandoff: {
		/** True only after the current session has actually called the handoff tool. */
		toolCalled: boolean;
		/** Turn counter for repeated "you still owe the user a handoff" nudges. */
		enforcementAttempts: number;
		/** Human `/handoff <direction>` instruction, or null when the model must supply one. */
		nextInstruction: string | null;
	} | null;

	/** Boot-time Model Groups validation snapshot used by /model-groups. */
	modelGroups: {
		groups: ResolvedModelGroup[];
		validation: ModelGroupsBootValidation | null;
	};

	/**
	 * Published child agent sessions keyed by toolCallId.
	 * Lifecycle: executeSpawn publishes → renderSpawnResult claims via get+delete.
	 * This is only the render handoff queue, not the full live-session registry.
	 */
	childSessions: Map<string, AgentSession>;

	/**
	 * All live child agent sessions keyed by toolCallId, including claimed ones.
	 * Reset/teardown aborts this registry so claimed children cannot outlive /new or UI disposal.
	 * Completed children remove themselves from this registry before returning.
	 *
	 * INVARIANT: This Map is never replaced — only cleared via .clear().
	 * Spawn renderer ownership checks read this registry after attach, so its
	 * identity must stay stable across resets, completion cleanup, and disposal.
	 */
	liveChildSessions: Map<string, AgentSession>;

	/**
	 * Generation counter for child-session ownership.
	 * Increment on /new so stale child updates/results cannot touch fresh state.
	 */
	childSessionEpoch: number;

	/** One abort promise per child session, shared by signal and reset cleanup. WeakMap entries are GC'd with the session; no manual clear needed. */
	childAbortPromises: WeakMap<AgentSession, Promise<void>>;

	/** Whether readonly mode is active — write/edit blocked; handoff needs explicit /handoff or a human topic boundary; bash writes limited to temp. */
	readonlyEnabled: boolean;

	/** One-shot flag: deliver a readonly ON or OFF nudge via context hook, then clear. */
	readonlyNudgePending: boolean;

	/** Session-owned frontmatter cache for loaded skills. */
	frontmatterSkillCache: Map<string, FrontmatterEntry>;

	/** Session-owned frontmatter cache for resolved prompt commands. */
	frontmatterPromptCache: Map<string, FrontmatterEntry>;

	/** Frontmatter issues keyed by skill name. */
	frontmatterSkillIssues: Map<string, FrontmatterIssue>;

	/** Frontmatter issues keyed by prompt command name. */
	frontmatterPromptIssues: Map<string, FrontmatterIssue>;

	/**
	 * FIFO slash-command intents extracted from queued user inputs, deferred to
	 * before_agent_start where the frontmatter cache is populated.
	 * Empty = no pending toggle.
	 *
	 * `type` preserves `/skill:name` vs generic `/name` so lookup can target the
	 * correct readonly source without conflating skills and prompt templates.
	 * Enqueued in `input`, drained in `before_agent_start` until the first real
	 * readonly decision, cleared on session reset.
	 */
	pendingReadonlyCommands: Array<{ type: "skill" | "command"; name: string }>;

	/**
	 * Last context-percentage band at which the watchdog nudge was delivered.
	 * null = never delivered. Bands: null (<30), 0 (30-49), 1 (50-69), 2 (70+).
	 * Used to throttle nudges — only nudge when crossing into a higher band.
	 */
	lastWatchdogBand: number | null;

}

/** Create a fresh state instance. Call reset() on /new. */
export function createState(): AgenticodingState {
	const childSessions = new Map<string, AgentSession>();
	const liveChildSessions = new Map<string, AgentSession>();
	const frontmatterSkillCache = new Map<string, FrontmatterEntry>();
	const frontmatterPromptCache = new Map<string, FrontmatterEntry>();
	const frontmatterSkillIssues = new Map<string, FrontmatterIssue>();
	const frontmatterPromptIssues = new Map<string, FrontmatterIssue>();
	const state: AgenticodingState = {
		notebookPages: new Map(),
		epoch: 0,
		activeNotebookTopic: null,
		activeNotebookTopicSource: null,
		pendingTopicBoundaryHint: null,
		lastContextPercent: null,
		pendingHandoff: null,
		handoffGeneration: 0,
		handoffCompactionGeneration: null,
		pendingHandoffDelivery: null,
		recoveryRequestedMessage: null,
		pendingNotebookDiscard: null,
		discardEpochWatermark: 0,
		pendingRequestedHandoff: null,
		modelGroups: { groups: [], validation: null },
		childSessions,
		liveChildSessions,
		childSessionEpoch: 0,
		childAbortPromises: new WeakMap(),
		readonlyEnabled: false,
		readonlyNudgePending: false,
		frontmatterSkillCache,
		frontmatterPromptCache,
		frontmatterSkillIssues,
		frontmatterPromptIssues,
		pendingReadonlyCommands: [],
		lastWatchdogBand: null,
	};
	// Prevent replacement — spawn lifecycle code and renderer ownership checks
	// depend on stable map identity. Only .clear() and .delete() are valid —
	// assigning a new Map would silently break child-session invalidation.
	Object.defineProperty(state, 'childSessions', {
		get: () => childSessions,
		set: () => { throw new Error('childSessions cannot be replaced — use .clear() instead'); },
		enumerable: true,
		configurable: false,
	});
	Object.defineProperty(state, 'liveChildSessions', {
		get: () => liveChildSessions,
		set: () => { throw new Error('liveChildSessions cannot be replaced — use .clear() instead'); },
		enumerable: true,
		configurable: false,
	});
	return state;
}

/** Reset all state. Used on /new or session reset. */
export function resetState(state: AgenticodingState): void {
	state.childSessionEpoch++;
	state.notebookPages.clear();
	state.epoch = 0; // sentinel: 0 = not yet initialized; set to 1 on first write
	// /new abandons the previous session tree; the watermark dies with it. A
	// fresh session has no staged epochs, so derivation on its empty branch is 0.
	state.discardEpochWatermark = 0;
	state.activeNotebookTopic = null;
	state.activeNotebookTopicSource = null;
	state.lastContextPercent = null;
	invalidateHandoffState(state);
	// /new abandons the previous session completely; do not carry its in-flight
	// reservation into the fresh session.
	state.handoffCompactionGeneration = null;
	state.recoveryRequestedMessage = null;
	state.modelGroups.groups = [];
	state.modelGroups.validation = null;
	state.readonlyEnabled = false;
	state.readonlyNudgePending = false;
	state.frontmatterSkillCache.clear();
	state.frontmatterPromptCache.clear();
	state.frontmatterSkillIssues.clear();
	state.frontmatterPromptIssues.clear();
	state.pendingReadonlyCommands.length = 0;
	abortAndClearChildSessions(state);
}

/** Invalidate handoff work that belongs to a previous session-tree branch. */
export function invalidateHandoffState(state: AgenticodingState): void {
	state.handoffGeneration++;
	state.pendingHandoff = null;
	state.handoffCompactionGeneration = null;
	state.pendingHandoffDelivery = null;
	state.pendingNotebookDiscard = null;
	// The discard watermark is deliberately NOT reset here. A branch change is
	// immediately followed by reconstruction, which derives the watermark from
	// the newly active branch (staged survivor epochs included). Resetting early
	// would let a retry reuse a staged epoch and resurrect orphaned entries.
	//
	// An interrupted discard left staged survivors + a stray generation marker in
	// the branch; reconstruction ignores them (currentEpoch never advances), so
	// the orphaned entries are harmless.
	state.pendingRequestedHandoff = null;
	state.pendingTopicBoundaryHint = null;
	state.lastWatchdogBand = null;
	// A branch switch abandons the old compaction path completely. Release the
	// overlap guard now so the new branch cannot get stuck waiting on callbacks
	// from work that no longer belongs to the active session tree.
	// recoveryRequestedMessage is deliberately NOT reset here — see its state doc.
}

/** Return the session's single shared abort operation, starting it if necessary. */
export function abortChildSession(state: AgenticodingState, session: AgentSession): Promise<void> {
	const existing = state.childAbortPromises.get(session);
	if (existing) return existing;

	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const abortPromise = new Promise<void>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	state.childAbortPromises.set(session, abortPromise);
	try {
		Promise.resolve(session.abort()).then(resolve, reject);
	} catch (error) {
		reject(error);
	}
	return abortPromise;
}

/** Abort all active child sessions and clear both registries. Called on /new (session reset). */
export function abortAndClearChildSessions(state: AgenticodingState): void {
	const sessions = new Set([...state.childSessions.values(), ...state.liveChildSessions.values()]);
	state.childSessions.clear();
	state.liveChildSessions.clear();
	for (const session of sessions) {
		void abortChildSession(state, session).catch(() => {});
	}
}
