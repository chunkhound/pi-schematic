/**
 * Spawn tool for the agenticoding extension.
 *
 * Creates an isolated in-memory child AgentSession for focused subtask execution.
 * Children inherit the parent's model, thinking level, cwd, active registered
 * executable tools, and notebook access.
 * Children do not inherit the spawn or handoff tools (recursion prevention).
 *
 * Spawn is context isolation, not a security boundary. Child agents are trusted
 * extensions of the parent and inherit parent authority by design.
 */

import type {
	AgentSession,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
import {
	READONLY_CHILD_AUTHORITY_NOTE,
	READONLY_WRITE_EDIT_SUMMARY,
} from "../notifications.js";
import {
	createAgentSession,
	createBashToolDefinition,
	defineTool,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortChildSession, type AgenticodingState } from "../state.js";
import { formatPageList } from "../notebook/store.js";
import { createNotebookToolDefinitions } from "../notebook/tools.js";
import { resolveSpawnModelRoute } from "../model-groups/router.js";
import { productionConstraintRegistry, type ConstraintRegistry } from "../model-groups/constraints/registry.js";
import { MODEL_GROUP_MODALITY_PROSE } from "../model-groups/types.js";
import { applyReadonlyBashGuard } from "../readonly-bash.js";
import {
	renderSpawnCall,
	renderSpawnResult,
} from "./renderer.js";
import {
	getLastAssistantText,
	type SpawnOutcome,
	type SpawnResultDetails,
	type ThinkingValue,
} from "./shared.js";

// ── Constants ─────────────────────────────────────────────────────────

const CHILD_MAX_LINES = 2000;
const CHILD_MAX_BYTES = 50 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────

// Widen to accept AgentMessage variants from session messages.
// Functions that read these use runtime type checks.
type AssistantMessageLike = {
	role: string;
	content?: unknown;
	stopReason?: unknown;
};

function getLastAssistantMessage(messages: AssistantMessageLike[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

function getLastAssistantOutcome(messages: AssistantMessageLike[]): SpawnOutcome {
	const stopReason = getLastAssistantMessage(messages)?.stopReason;
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return "success";
}

/**
 * Truncates text to stay within maxLines/maxBytes.
 * Line-count limit is applied first, then byte limit.
 * May end mid-line if the byte limit is the tighter constraint.
 */
export function truncateText(text: string, maxLines: number, maxBytes: number): string {
	const lines = text.split("\n");
	let truncated = lines.slice(0, maxLines).join("\n");
	const encoded = new TextEncoder().encode(truncated);
	if (encoded.length > maxBytes) {
		// Shrink byte-by-byte at the boundary until we have valid UTF-8.
		// This avoids splitting a multi-byte character mid-sequence.
		// An empty slice (0 bytes) is always valid and decodes to empty string.
		let slice = encoded.slice(0, maxBytes);
		for (;;) {
			try {
				truncated = new TextDecoder("utf-8", { fatal: true }).decode(slice);
				break;
			} catch {
				if (slice.length === 0) break;
				slice = slice.slice(0, slice.length - 1);
			}
		}
	}
	return truncated;
}

/**
 * Truncates child agent output to CHILD_MAX_LINES lines / CHILD_MAX_BYTES bytes.
 * Appends a "[Result truncated...]" advisory when truncation occurs.
 * Returns { text, truncated }.
 */
function notifyCleanupFailure(ctx: ExtensionContext, error: unknown): void {
	if (!ctx.hasUI) return;
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(`Spawn cleanup failed: ${message}`, "error");
}

function truncateResult(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const bytes = new TextEncoder().encode(text).length;

	if (lines.length <= CHILD_MAX_LINES && bytes <= CHILD_MAX_BYTES) {
		return { text, truncated: false };
	}

	const truncated = truncateText(text, CHILD_MAX_LINES, CHILD_MAX_BYTES);
	return {
		text:
			truncated +
			`\n\n[Result truncated to ${CHILD_MAX_LINES} lines / ${(CHILD_MAX_BYTES / 1024).toFixed(0)}KB. ` +
			`Ask the child to summarize further if needed.]`,
		truncated: true,
	};
}


/**
 * Build the final list of tool names for a child session.
 *
 * Child sessions inherit parent tool names that are both active in the parent
 * and present in Pi's registered tool registry, regardless of source label.
 * Local child custom tools are added separately. Parent-only custom tools are
 * intentionally excluded so the child never advertises a tool it cannot execute.
 *
 * handoff and spawn never carry into children.
 */
function shouldSwallowPromptError(error: unknown, isStale: () => boolean, wasAborted: boolean): boolean {
	if (isStale()) return false;
	if (!wasAborted) return false;
	// Pi contracts AbortError via AbortSignal standard
	return (error as Error)?.name === "AbortError";
}

function toSpawnStats(sessionStats: any): Record<string, number> {
	return {
		inputTokens: sessionStats.tokens?.input ?? 0,
		outputTokens: sessionStats.tokens?.output ?? 0,
		cacheReadTokens: sessionStats.tokens?.cacheRead ?? 0,
		cacheWriteTokens: sessionStats.tokens?.cacheWrite ?? 0,
		totalTokens: sessionStats.tokens?.total ?? 0,
		cost: sessionStats.cost ?? 0,
		turns: sessionStats.assistantMessages ?? 0,
	};
}

function collectSpawnStats(session: { getSessionStats?: () => unknown }): { stats?: Record<string, number>; statsUnavailable: boolean } {
	try {
		const sessionStats = (session.getSessionStats as (() => any) | undefined)?.();
		return sessionStats
			? { stats: toSpawnStats(sessionStats), statsUnavailable: false }
			: { statsUnavailable: false };
	} catch {
		return { statsUnavailable: true };
	}
}

function clearSpawnSession(state: AgenticodingState, toolCallId: string, session: AgentSession): void {
	if (state.childSessions.get(toolCallId) === session) state.childSessions.delete(toolCallId);
	if (state.liveChildSessions.get(toolCallId) === session) state.liveChildSessions.delete(toolCallId);
}

function createSpawnAbortContext(state: AgenticodingState, session: AgentSession, ctx: ExtensionContext, toolCallId: string) {
	const invalidatedError = new Error("Spawn invalidated by reset.");
	let wasAborted = false;
	let reported: Promise<void> | undefined;
	const clearChildSession = () => clearSpawnSession(state, toolCallId, session);
	const abortChild = () => {
		wasAborted = true;
		const p = abortChildSession(state, session);
		if (p !== reported) {
			reported = p;
			// Report abort failures via UI. Guard against notify itself throwing
			// so the detached promise never emits unhandledRejection.
			// Detached path — the finally(dispose) branch aggregates notify failures
			// differently; here we intentionally swallow to avoid unhandledRejection.
			void p.catch((e) => {
				try { notifyCleanupFailure(ctx, e); } catch { /* reporting must never reject */ }
			});
		}
		return p;
	};
	const abortAndInvalidate = async (cause?: unknown): Promise<never> => {
		clearChildSession();
		let abortFailure: unknown;
		try {
			await abortChild();
		} catch (e) {
			abortFailure = e;
		}
		if (abortFailure !== undefined) {
			const aggregate = new AggregateError(
				[invalidatedError, abortFailure],
				"Spawn invalidated by reset; child abort failed.",
			);
			if (cause !== undefined) (aggregate as unknown as { cause: unknown }).cause = cause;
			throw aggregate;
		}
		if (cause !== undefined) (invalidatedError as unknown as { cause: unknown }).cause = cause;
		throw invalidatedError;
	};
	return { get wasAborted() { return wasAborted; }, invalidatedError, abortChild, clearChildSession, abortAndInvalidate };
}

function getInheritableParentToolNames(parentToolNames: string[], availableTools: Pick<ToolInfo, "name" | "sourceInfo">[]): string[] {
	const activeToolNames = new Set(parentToolNames);
	return availableTools
		.filter((tool) => activeToolNames.has(tool.name))
		.map((tool) => tool.name);
}

export function buildChildToolNames(
	parentToolNames: string[],
	childTools: ToolDefinition[],
	availableTools?: Pick<ToolInfo, "name" | "sourceInfo">[],
): string[] {
	const inheritableParentToolNames = availableTools
		? getInheritableParentToolNames(parentToolNames, availableTools)
		: parentToolNames;
	const inheritedTools = inheritableParentToolNames.filter((name) => name !== "spawn" && name !== "handoff");
	return [...new Set([...inheritedTools, ...childTools.map((tool) => tool.name)])];
}

/**
 * Filter child tool names for readonly mode.
 * Removes write/edit from the tool list entirely — children start with
 * a fresh context, so there is no cache to preserve.
 */
export function filterReadonlyToolNames(toolNames: string[], readonlyEnabled: boolean): string[] {
	return readonlyEnabled
		? toolNames.filter((name) => name !== "write" && name !== "edit")
		: toolNames;
}

/**
 * Create a bash tool definition for readonly-mode child sessions.
 *
 * Applies OS-level sandboxing (sandbox-exec on macOS, bwrap on Linux) when available.
 * Falls back to classifyBashCommand command-pattern inspection when no OS sandbox
 * is available (Windows). The fallback blocks filesystem writes/deletions outside
 * the OS temp dir using the same logic as the parent's tool_call hook.
 */
function createReadonlyChildBashTool(
	cwd: string,
) {
	const bashTool = createBashToolDefinition(cwd, {
		spawnHook: (spawnContext) => {
			const result = applyReadonlyBashGuard(spawnContext.command, cwd);
			if (result.action === "block") {
				throw new Error(result.reason);
			}
			if (result.action === "sandbox") {
				spawnContext.command = result.sandboxedCommand;
			}
			return spawnContext;
		},
	});
	return defineTool(bashTool);
}



// ── Spawn tool metadata ──

const SPAWN_DESCRIPTION =
	"Spawn an isolated child agent for a focused subtask. " +
	"Child inherits parent model, thinking level, cwd, active registered tools executable in the child session, and shared notebook tools unless an optional Model Group routes its model/thinking; children cannot spawn or handoff. " +
	"Reference notebook pages by name — child will notebook_read them on demand.";

const SPAWN_PROMPT_SNIPPET = "Spawn a focused subtask agent";

function spawnPromptGuidelines(constraintRegistry: ConstraintRegistry): string[] {
	const constraintKeys = constraintRegistry.descriptors.map((descriptor) => descriptor.key);
	return [
		"Use spawn to delegate isolated work to child agents. They are trusted extensions of you with their own context and the same authority. Only condensed results are returned.",
		"If the operator requests a known Model Group confidently, pass its exact name as group. If no known/confident group is requested, omit group so the child inherits the parent model/thinking.",
		`Declare constraints when the delegated task needs ${MODEL_GROUP_MODALITY_PROSE} capability; do not work around a missing required modality with third-party tools.`,
		`A constraint is keyed by its exact name (${constraintKeys.join(", ")}); values must match the key's schema — unknown keys or invalid values are rejected before any child is created.`,
		"A specified group is binding: if the operator asks for a specific group and it lacks a needed capability, do NOT substitute a different group or inherit the parent model. Stop and report to the operator that the named group cannot satisfy the task, and ask how to proceed.",
		`Pass modality requirements as constraints: { modalities: { required: [\"text\", ...] } } — modalities is an object whose only key is \"required\" (an array of modality names), not a bare array, and constraints itself is a JSON object, not a JSON string. Valid entries are exactly text, image, or reasoning — do not invent capability names (e.g. \"code\"). Invalid shapes are rejected before any child is created.`,
	];
}

export function buildSpawnParameters(constraintRegistry: ConstraintRegistry) {
	return Type.Object({
		prompt: Type.String({
			description:
				"Self-contained task description. Reference notebook pages by name — " +
				"child will notebook_read them on demand.",
		}),
		group: Type.Optional(Type.String({
			description: "Optional exact Model Group name for child model routing. Omit to inherit the parent model/thinking.",
		})),
		constraints: Type.Optional(Type.Object(Object.fromEntries(constraintRegistry.descriptors.map((descriptor) => [descriptor.key, descriptor.requirement.schema])) as any, {
			description: `Capability requirements for the delegated task — a JSON object keyed by constraint name, not a JSON string and not an array. Keys: ${constraintRegistry.descriptors.map((descriptor) => descriptor.key).join(", ")} — each value must match its key's schema; unknown keys or invalid values are rejected before a child is created.`,
		})),
		thinking: Type.Optional(StringEnum(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
			{
				description:
					"Override child thinking level. A routed Model Group entry may override it.",
			},
		)),
	});
}


/**
 * Build the custom tool set for child agent sessions.
 *
 * Produces notebook tools (write/read/index). Children do not receive the spawn
 * tool to prevent the LLM from attempting recursion.
 *
 * All tools read/write the shared parent state so notebook pages are visible
 * across parent and child contexts.
 */
export function createChildTools(
	pi: ExtensionAPI,
	state: AgenticodingState,
	options?: { isStale?: () => boolean },
): ToolDefinition[] {
	return createNotebookToolDefinitions(pi, state, { isStale: options?.isStale });
}


// ── Shared spawn execution logic ──────────────────────────────────────

/**
 * Creates an isolated child agent session, runs the given prompt, and returns
 * the result with usage stats.
 *
 * Error: "No model configured..." → ctx.model is undefined
 *
 * Side effects on state:
 *   - state.childSessions.set(toolCallId, session) on creation
 *   - state.liveChildSessions.set(toolCallId, session) on creation
 *   - both registries delete(toolCallId) on error and completion paths
 *
 */
export type SpawnConstraintRequirements = Record<string, unknown>;
export interface SpawnParameters { prompt: string; group?: string; constraints?: SpawnConstraintRequirements; thinking?: ThinkingValue }

/** Validate the public constraint envelope once, rejecting unknown keys before routing. */
export function normalizeSpawnRequirements(params: Pick<SpawnParameters, "constraints">, registry: ConstraintRegistry = productionConstraintRegistry): SpawnConstraintRequirements {
	const raw = params.constraints;
	if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("Spawn constraints must be an object.");
	const normalized: SpawnConstraintRequirements = {};
	for (const [key, value] of Object.entries(raw ?? {})) {
		const descriptor = registry.get(key);
		if (!descriptor) throw new Error(`Unknown spawn constraint requirement '${key}'.`);
		const decoded = descriptor.requirement.decode(value, `constraints.${key}`);
		if (!decoded.ok) throw new Error(decoded.message);
		// Keep the envelope shape: resolveSpawnModelRoute is the single decoder of
		// requirement values (schema-shaped envelope in, engine value out), so the
		// router never sees raw/partial shapes that could bypass descriptor validation.
		normalized[key] = value;
	}
	return normalized;
}

export function executeSpawn(
	toolCallId: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: AgenticodingState,
	params: SpawnParameters,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((result: {
				content: TextContent[];
				details: unknown;
		  }) => void)
		| undefined,
	defaultThinking: ThinkingValue,
	sessionFactory: typeof createAgentSession = createAgentSession,
	constraintRegistry: ConstraintRegistry = productionConstraintRegistry,
): Promise<{ content: TextContent[]; details: SpawnResultDetails }> {
	let execution!: Promise<{ content: TextContent[]; details: SpawnResultDetails }>;
	execution = (async () => {
		const parentModel = ctx.model;
		if (!parentModel) {
			throw new Error("No model configured. Cannot spawn child agent.");
		}

		const inheritedChildThinking: ThinkingValue = params.thinking ?? defaultThinking;
		const constraints = normalizeSpawnRequirements(params, constraintRegistry);
		const route = resolveSpawnModelRoute({
			requestedGroup: params.group,
			constraints,
			groups: state.modelGroups.groups,
			parentModel,
			parentThinking: inheritedChildThinking,
			modelRegistry: ctx.modelRegistry,
			constraintRegistry,
		});
		const childModel = route.model;
		const requestedChildThinking: ThinkingValue = route.thinking;
		const routeDetails: SpawnResultDetails["route"] = route.status === "routed"
			? {
					status: "routed",
					group: route.groupName ?? route.requestedGroup ?? params.group?.trim() ?? "",
					provider: route.provider,
					modelId: route.modelId,
				}
			: route.status === "unknown-fallback"
				? {
						status: "unknown-fallback",
						requestedGroup: route.requestedGroup ?? params.group?.trim() ?? "",
						provider: route.provider,
						modelId: route.modelId,
					}
				: { status: "inherited" };

	const listing = formatPageList(state);
	const notebookListing = listing
		? "Available notebook pages:\n" + listing
		: "No notebook pages.";
	const readonlyNotice = state.readonlyEnabled
		? `\n\n${READONLY_WRITE_EDIT_SUMMARY}.`
		: "";
	const authorityNote = state.readonlyEnabled
		? READONLY_CHILD_AUTHORITY_NOTE
		: "You have the same authority as the parent.";
	// Constraint descriptors own child-facing orientation for explicit group
	// ceilings; spawn only presents the generic notes supplied by the route.
	const capabilityNotice =
		route.status === "routed" && route.groupCapabilityCeilings?.length
			? `\n\n## Model Group capability ceiling\n${route.groupCapabilityCeilings.join("\n")}\n\n`
			: "";
	const fullPrompt =
		`You are a focused child agent spawned by a parent agent. ` +
		`${authorityNote} ` +
		`Children cannot spawn further children. ` +
		`Your result will be read by the parent, so be concise and complete.\n\n` +
		`${notebookListing}\n\n` +
		`If you write notebook pages, store only durable shared memory for the parent and future contexts. ` +
		`Keep transient task state in your final reply to the parent.\n\n` +
		`${capabilityNotice}` +
		`## Task\n\n${params.prompt}${readonlyNotice}\n\n` +
		`When complete, provide a concise summary of findings. ` +
		`Keep the result under ${CHILD_MAX_LINES} lines / ${(CHILD_MAX_BYTES / 1024).toFixed(0)}KB.`;

	const childSessionEpoch = state.childSessionEpoch;
	const isStale = () => state.childSessionEpoch !== childSessionEpoch;
	const childTools = createChildTools(pi, state, { isStale });
	const parentToolNames = pi.getActiveTools();
	const childToolNames = buildChildToolNames(parentToolNames, childTools, pi.getAllTools());
	// Children: readonly vs non-readonly tool strategy differs from the parent.
	// Parent keeps write/edit in the tool list and blocks at call time to avoid
	// context-cache misses (index.ts). Children start with a fresh context — no
	// cache to preserve — so we remove write/edit from the tool list entirely
	// (cleaner than advertising tools that always error).  The readonly bash guard
	// (sandbox-exec/bwrap or classifyBashCommand fallback) still propagates to
	// children via createReadonlyChildBashTool below.
	//
	// This is a guardrail for a coding agent, not a security boundary.
	const effectiveChildTools = [
		...childTools,
		...(state.readonlyEnabled && childToolNames.includes("bash")
			? [createReadonlyChildBashTool(ctx.cwd)]
			: []),
	];

	const effectiveToolNames = filterReadonlyToolNames(childToolNames, state.readonlyEnabled);

	const { session } = await sessionFactory({
		sessionManager: SessionManager.inMemory(ctx.cwd),
		model: childModel,
		thinkingLevel: requestedChildThinking,
		cwd: ctx.cwd,
		tools: effectiveToolNames,
		customTools: effectiveChildTools,
	});
	// Pi clamps unsupported requested levels during session creation. Report the
	// public session value so child details describe what actually runs. The
	// fallback keeps intentionally partial session test doubles compatible.
	const effectiveChildThinking = () => session.thinkingLevel ?? requestedChildThinking;

	const abortContext = createSpawnAbortContext(state, session, ctx, toolCallId);
	const { invalidatedError, abortChild, clearChildSession, abortAndInvalidate } = abortContext;

	let hasPrimaryError = false;
	let primaryError: unknown;
	try {
		if (isStale()) {
			await abortAndInvalidate();
		}

	// liveChildSessions must be set before childSessions so the renderer can
	// attach with a fully-published live ownership record.
	state.liveChildSessions.set(toolCallId, session);
	state.childSessions.set(toolCallId, session);

	try {
		if (signal?.aborted) {
			await abortChild();
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Spawn aborted before child session started.");
		}

		if (isStale()) {
			await abortAndInvalidate();
		}

		// Register before publishing the running update: onUpdate is component code
		// and may synchronously abort or reset this child.
		signal?.addEventListener("abort", abortChild, { once: true });
		onUpdate?.({
			content: [],
			details: {
				model: childModel.id,
				thinking: effectiveChildThinking(),
				truncated: false,
				outcome: "running",
				route: routeDetails,
			} satisfies SpawnResultDetails,
		});

		if (signal?.aborted) {
			await abortChild();
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Spawn aborted before child session started.");
		}
		if (isStale()) {
			await abortAndInvalidate();
		}

		try {
			await session.prompt(fullPrompt);
		} catch (error) {
			if (!shouldSwallowPromptError(error, isStale, abortContext.wasAborted)) throw error;
		}
	} catch (error) {
		clearChildSession();
		if (isStale()) {
			await abortAndInvalidate(error);
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", abortChild);
	}

	if (isStale()) {
		await abortAndInvalidate();
	}

	const resultText = getLastAssistantText(session.messages as AssistantMessageLike[]);
	// Aborted children legitimately have no text — empty result is allowed (outcome "aborted"), not "no output" error.
	if (!resultText && !abortContext.wasAborted) {
		clearChildSession();
		throw new Error("Child agent produced no output.");
	}
	const outcome = abortContext.wasAborted ? "aborted" : getLastAssistantOutcome(session.messages as AssistantMessageLike[]);
	const { text: finalText, truncated } = truncateResult(resultText ?? "");

	// Execution should not retain live children after completion. If the TUI
	// already rendered the child, it still owns the session object itself.
	// Clearing here intentionally makes the component's dispose() a no-op for
	// liveChildSessions — the child already completed so there's nothing to abort.
	clearChildSession();

	const { stats, statsUnavailable } = collectSpawnStats(session as { getSessionStats?: () => unknown });

	if (isStale()) {
		// INVARIANT: live ownership was synchronously cleared before stats collection,
		// so this reset could not have initiated a child abort to aggregate — plain
		// invalidatedError is correct. Early stale paths above aggregate via abortAndInvalidate(cause).
		throw invalidatedError;
	}

	const details: SpawnResultDetails = {
		model: childModel.id,
		thinking: effectiveChildThinking(),
		truncated,
		outcome,
		route: routeDetails,
	};
	if (stats) {
		details.stats = stats;
	} else if (statsUnavailable) {
		details.statsUnavailable = true;
	}

		return {
			content: [{ type: "text" as const, text: finalText }] as TextContent[],
			details,
		};
	} catch (error) {
		hasPrimaryError = true;
		primaryError = error;
		throw error;
	} finally {
		clearChildSession();
		try {
			// AgentSession always provides dispose(); the guard keeps intentionally
			// partial test doubles compatible with the public session boundary.
			if (typeof session.dispose === "function") session.dispose();
		} catch (cleanupError) {
			if (!hasPrimaryError) {
				throw cleanupError;
			}
			// Headless callers get no UI notification, so preserve both failures.
			if (ctx.hasUI) {
				try {
					notifyCleanupFailure(ctx, cleanupError);
				} catch (notifyError) {
					// Do not mutate the primary error: its own cause may carry the root failure.
					throw new AggregateError(
						[primaryError, cleanupError, notifyError],
						"Spawn, cleanup, and notification failed.",
					);
				}
			} else {
				throw new AggregateError([primaryError, cleanupError], "Spawn failed and cleanup failed.");
			}
		}
	}
	})();
	return execution;
}

/**
 * Register the spawn tool with pi's tool system.
 *
 * Creates a ToolDefinition that spawns an isolated child AgentSession
 * for focused subtasks. Children inherit the parent model, thinking
 * level, cwd, active registered executable tools, and notebook access.
 *
 * @param pi - Extension API instance for tool registration
 * @param state - Shared session state (child sessions, epoch, notebook)
 */
export function registerSpawnTool(
	pi: ExtensionAPI,
	state: AgenticodingState,
	sessionFactory: typeof createAgentSession = createAgentSession,
	constraintRegistry: ConstraintRegistry = productionConstraintRegistry,
): void {
	pi.registerTool({
		name: "spawn",
		label: "Spawn",
		description: SPAWN_DESCRIPTION,
		promptSnippet: SPAWN_PROMPT_SNIPPET,
		promptGuidelines: spawnPromptGuidelines(constraintRegistry),
		parameters: buildSpawnParameters(constraintRegistry),
		renderShell: "self",

		execute(
			_toolCallId: string,
			params: SpawnParameters,
			signal: AbortSignal | undefined,
			onUpdate:
				| ((result: {
						content: TextContent[];
						details: unknown;
				  }) => void)
				| undefined,
			ctx: ExtensionContext,
		) {
			const parentThinking: ThinkingValue = pi.getThinkingLevel();
			return executeSpawn(
				_toolCallId,
				pi,
				ctx,
				state,
				params,
				signal,
				onUpdate,
				parentThinking,
				sessionFactory,
				constraintRegistry,
			);
		},

		renderCall: renderSpawnCall,

		renderResult(result, { expanded }, theme, context) {
			return renderSpawnResult(result, expanded, theme, context, state);
		},
	});
}
