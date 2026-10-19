/**
 * Spawn tool for the pi-schematic extension.
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
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type AssistantMessage, type ModelThinkingLevel, type TextContent, type Usage } from "@earendil-works/pi-ai";
import {
	READONLY_CHILD_AUTHORITY_NOTE,
	READONLY_NO_SHELL_SUMMARY,
	READONLY_WRITE_EDIT_SUMMARY,
} from "../notifications.js";
import {
	createAgentSession,
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortChildSession, type SchematicState } from "../state.js";
import { formatByteCap, formatPageList } from "../notebook/store.js";
import { createNotebookToolDefinitions } from "../notebook/tools.js";
import { resolveSpawnModelRoute } from "../model-groups/router.js";
import { productionConstraintRegistry, type ConstraintRegistry } from "../model-groups/constraints/registry.js";
import { MODEL_GROUP_MODALITY_PROSE } from "../model-groups/types.js";
import { applyReadonlyBashGuard } from "../readonly-bash.js";
import { HANDOFF_TOOL_NAME } from "../handoff/tool.js";
import { THINKING_LEVELS } from "../thinking-levels.js";
import {
	renderSpawnCall,
	renderSpawnResult,
} from "./renderer.js";
import {
	getLastAssistantText,
	getStopReasonOutcome,
	type SpawnOutcome,
	type SpawnResultDetails,
} from "./shared.js";

// ── Helpers ───────────────────────────────────────────────────────────

function getLastAssistantMessage(messages: AgentSession["messages"]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message || error.name : String(error);
}

function describeAbort(reason: unknown): string {
	return reason === undefined ? "Child agent aborted." : `Child agent aborted: ${failureMessage(reason)}`;
}

function notifyCleanupFailure(ctx: ExtensionContext, error: unknown): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`Spawn cleanup failed: ${failureMessage(error)}`, "error");
}

/** Ignore Pi's AbortError only when the current child was cancelled without a reset. */
function shouldSwallowPromptError(error: unknown, isStale: () => boolean, wasAborted: boolean): boolean {
	if (isStale()) return false;
	if (!wasAborted) return false;
	// Pi contracts AbortError via AbortSignal standard
	return (error as Error)?.name === "AbortError";
}

type ChildAccounting = {
	usage: Usage;
	/** Absent when the child's entries could not be read or summed. */
	stats?: Record<string, number>;
};

function emptyChildUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Mirrors pi-coding-agent's unexported combineUsage: the optional token splits appear only once some usage reports them. */
function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function statsOf(usage: Usage, turns: number): Record<string, number> {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		// Provider-reported usage.totalTokens may differ from Pi's four-field session-stat projection.
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: usage.cost.total,
		turns,
	};
}

function collectChildAccounting(session: Pick<AgentSession, "sessionManager">): ChildAccounting {
	// Degraded on purpose: the child's answer or failure text is worth more than its
	// accounting, so an entry list that cannot be read or summed counts as zero usage
	// and the result reports statsUnavailable instead of losing that text.
	try {
		let usage = emptyChildUsage();
		let assistantTurns = 0;
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				if (entry.usage) usage = combineUsage(usage, entry.usage);
			} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				usage = combineUsage(usage, entry.usage);
			} else if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "assistant") {
					assistantTurns++;
					if (message.usage) usage = combineUsage(usage, message.usage);
				} else if (message.role === "toolResult" && message.usage) {
					usage = combineUsage(usage, message.usage);
				}
			}
		}
		return { usage, stats: statsOf(usage, assistantTurns) };
	} catch {
		return { usage: emptyChildUsage() };
	}
}

/** Pi exports no byte-limited cut for one line (truncateLine counts characters), so cut at the limit and back off to a character boundary. */
function cutToUtf8Bytes(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	let end = Math.min(maxBytes, bytes.length);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function limitResultText(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const lineLimited = lines.length > DEFAULT_MAX_LINES ? lines.slice(0, DEFAULT_MAX_LINES).join("\n") : text;
	const truncated = lineLimited !== text || Buffer.byteLength(lineLimited, "utf8") > DEFAULT_MAX_BYTES;
	if (!truncated) return { text, truncated: false };
	const limitedText = cutToUtf8Bytes(lineLimited, DEFAULT_MAX_BYTES);
	const marker = `[Result truncated to ${DEFAULT_MAX_LINES} lines / ${formatByteCap(DEFAULT_MAX_BYTES)}. ` +
		`Spawn a new child with a narrower request if more is needed.]`;
	return { text: `${limitedText}\n\n${marker}`, truncated: true };
}

function clearSpawnSession(state: SchematicState, toolCallId: string, session: AgentSession): void {
	if (state.childSessions.get(toolCallId) === session) state.childSessions.delete(toolCallId);
	if (state.liveChildSessions.get(toolCallId) === session) state.liveChildSessions.delete(toolCallId);
}

function createSpawnAbortContext(state: SchematicState, session: AgentSession, ctx: ExtensionContext, toolCallId: string) {
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
			void p.catch((e) => {
				try { notifyCleanupFailure(ctx, e); } catch { /* reporting must never reject */ }
			});
		}
		return p;
	};
	const abortAndInvalidate = async (): Promise<never> => {
		clearChildSession();
		try {
			await abortChild();
		} catch {
			// abortChild already reported the rejection through the UI notice.
			throw new Error("Spawn invalidated by reset; child abort failed.");
		}
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
export function buildChildToolNames(
	parentToolNames: string[],
	childTools: ToolDefinition[],
	availableTools?: Pick<ToolInfo, "name" | "sourceInfo">[],
): string[] {
	const inheritableParentToolNames = availableTools
		? getInheritableParentToolNames(parentToolNames, availableTools)
		: parentToolNames;
	const inheritedTools = inheritableParentToolNames.filter((name) => name !== "spawn" && name !== HANDOFF_TOOL_NAME);
	return [...new Set([...inheritedTools, ...childTools.map((tool) => tool.name)])];
}

/**
 * Filter child tool names for readonly mode.
 * Removes write/edit/powershell from the tool list entirely — children start
 * with a fresh context, so there is no cache to preserve.
 */
export function filterReadonlyToolNames(toolNames: string[], readonlyEnabled: boolean): string[] {
	return readonlyEnabled
		? toolNames.filter((name) => name !== "write" && name !== "edit" && name !== "powershell")
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
			THINKING_LEVELS,
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
	state: SchematicState,
	options?: { isStale?: () => boolean },
): ToolDefinition[] {
	return createNotebookToolDefinitions(pi, state, { isStale: options?.isStale });
}


// ── Shared spawn execution logic ──────────────────────────────────────

export type SpawnConstraintRequirements = Record<string, unknown>;
export interface SpawnParameters { prompt: string; group?: string; constraints?: SpawnConstraintRequirements; thinking?: ModelThinkingLevel }

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

/**
 * Runs a child session for a spawn invocation. Failures before a child session
 * exists, including "No model configured", route resolution, constraint
 * validation, and session-factory failures, throw. Every later failure resolves
 * as an isError result with the child's available usage, including a dispose
 * failure after a successful child, whose error replaces the child's answer.
 * Child sessions are registered in childSessions and liveChildSessions before
 * the prompt, then removed on both completion and failure.
 */
export function executeSpawn(
	toolCallId: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: SchematicState,
	params: SpawnParameters,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SpawnResultDetails> | undefined,
	defaultThinking: ModelThinkingLevel,
	sessionFactory: typeof createAgentSession = createAgentSession,
	constraintRegistry: ConstraintRegistry = productionConstraintRegistry,
): Promise<{ content: TextContent[]; details: SpawnResultDetails; usage: Usage; isError?: true }> {
	let execution!: Promise<{ content: TextContent[]; details: SpawnResultDetails; usage: Usage; isError?: true }>;
	execution = (async () => {
		const parentModel = ctx.model;
		if (!parentModel) {
			throw new Error("No model configured. Cannot spawn child agent.");
		}

		const inheritedChildThinking: ModelThinkingLevel = params.thinking ?? defaultThinking;
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
		const requestedChildThinking: ModelThinkingLevel = route.thinking;
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

	const childSessionEpoch = state.childSessionEpoch;
	const isStale = () => state.childSessionEpoch !== childSessionEpoch;
	const childTools = createChildTools(pi, state, { isStale });
	const parentToolNames = pi.getActiveTools();
	const childToolNames = buildChildToolNames(parentToolNames, childTools, pi.getAllTools());
	// Children: readonly vs non-readonly tool strategy differs from the parent.
	// Parent keeps write/edit/powershell in the tool list and blocks at call
	// time to avoid context-cache misses (index.ts). Children start with a
	// fresh context — no cache to preserve — so we remove write/edit/powershell
	// from the tool list entirely (cleaner than advertising tools that always
	// error). The readonly bash guard (sandbox-exec/bwrap or classifyBashCommand
	// fallback) still propagates to children via createReadonlyChildBashTool
	// below.
	//
	// This is a guardrail for a coding agent, not a security boundary.
	const effectiveChildTools = [
		...childTools,
		...(state.readonlyEnabled && childToolNames.includes("bash")
			? [createReadonlyChildBashTool(ctx.cwd)]
			: []),
	];

	const effectiveToolNames = filterReadonlyToolNames(childToolNames, state.readonlyEnabled);

	const listing = formatPageList(state);
	const notebookListing = listing
		? "Available notebook pages:\n" + listing
		: "No notebook pages.";
	const readonlySummary = effectiveToolNames.includes("bash")
		? `${READONLY_WRITE_EDIT_SUMMARY}.`
		: READONLY_NO_SHELL_SUMMARY;
	const readonlyNotice = state.readonlyEnabled
		? `\n\n${readonlySummary}`
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
		`Keep the result under ${DEFAULT_MAX_LINES} lines / ${formatByteCap(DEFAULT_MAX_BYTES)}.`;

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
	const buildResultDetails = (truncated: boolean, outcome: SpawnOutcome, accounting: ChildAccounting): SpawnResultDetails => {
		return {
			model: childModel.id,
			thinking: effectiveChildThinking(),
			truncated,
			outcome,
			route: routeDetails,
			...(accounting.stats ? { stats: accounting.stats } : { statsUnavailable: true }),
		};
	};

	const abortContext = createSpawnAbortContext(state, session, ctx, toolCallId);
	const { invalidatedError, abortChild, clearChildSession, abortAndInvalidate } = abortContext;
	// Node's EventTarget raises a listener's rejected promise as an uncaught exception;
	// abortChild already reports the rejection through the UI notice.
	const onSignalAbort = () => { void abortChild(); };
	const abortBeforePrompt = async (abortedSignal: AbortSignal): Promise<never> => {
		await abortChild();
		throw new Error(describeAbort(abortedSignal.reason));
	};

	const runChild = async (): Promise<{ content: TextContent[]; truncated: boolean; outcome: SpawnOutcome; isError: boolean }> => {
		let primary: { error: unknown } | undefined;
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
					await abortBeforePrompt(signal);
				}

				if (isStale()) {
					await abortAndInvalidate();
				}

				// Register before publishing the running update: onUpdate is component code
				// and may synchronously abort or reset this child.
				signal?.addEventListener("abort", onSignalAbort, { once: true });
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
					await abortBeforePrompt(signal);
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
					await abortAndInvalidate();
				}
				throw error;
			} finally {
				signal?.removeEventListener("abort", onSignalAbort);
			}

			if (isStale()) {
				await abortAndInvalidate();
			}

			const lastAssistant = getLastAssistantMessage(session.messages);
			const outcome = abortContext.wasAborted ? "aborted" : getStopReasonOutcome(lastAssistant?.stopReason) ?? "success";
			const resultText = getLastAssistantText(session.messages);
			if (!resultText && outcome === "success") {
				throw new Error("Child agent produced no output.");
			}
			const errorMessage = lastAssistant?.errorMessage;
			const failureLine = outcome === "error"
				? `Child agent failed: ${errorMessage || "no error message"}`
				: outcome === "aborted"
					? describeAbort(signal?.aborted ? signal.reason : errorMessage || undefined)
					: undefined;
			const fullText = failureLine === undefined ? resultText : `${failureLine}${resultText ? `\n\n${resultText}` : ""}`;
			const { text: finalText, truncated } = limitResultText(fullText);

			// Execution should not retain live children after completion. If the TUI
			// already rendered the child, it still owns the session object itself.
			// Clearing here intentionally makes the component's dispose() a no-op for
			// liveChildSessions — the child already completed so there's nothing to abort.
			clearChildSession();

			if (isStale()) {
				// This late reset has no live child to abort; earlier resets report abort failures.
				throw invalidatedError;
			}

			return {
				content: [{ type: "text" as const, text: finalText }] as TextContent[],
				truncated,
				outcome,
				isError: outcome !== "success",
			};
		} catch (error) {
			primary = { error };
			throw error;
		} finally {
			clearChildSession();
			try {
				// AgentSession always provides dispose(); the guard keeps intentionally
				// partial test doubles compatible with the public session boundary.
				if (typeof session.dispose === "function") session.dispose();
			} catch (cleanupError) {
				if (!primary) {
					throw cleanupError;
				}
				if (ctx.hasUI) {
					notifyCleanupFailure(ctx, cleanupError);
				} else {
					// Headless callers get no UI notification, so the result names both failures.
					throw new Error(`Spawn failed and cleanup failed: ${failureMessage(primary.error)}; ${failureMessage(cleanupError)}`);
				}
			}
		}
	};

	let completed: { content: TextContent[]; truncated: boolean; outcome: SpawnOutcome; isError: boolean };
	try {
		completed = await runChild();
	} catch (error) {
		const accounting = collectChildAccounting(session);
		const { text, truncated } = limitResultText(failureMessage(error));
		const outcome = signal?.aborted && !isStale() ? "aborted" : "error";
		return {
			content: [{ type: "text" as const, text }] as TextContent[],
			details: buildResultDetails(truncated, outcome, accounting),
			usage: accounting.usage,
			isError: true as const,
		};
	}
	const accounting = collectChildAccounting(session);
	return {
		content: completed.content,
		details: buildResultDetails(completed.truncated, completed.outcome, accounting),
		usage: accounting.usage,
		...(completed.isError ? { isError: true as const } : {}),
	};
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
	state: SchematicState,
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
			onUpdate: AgentToolUpdateCallback<SpawnResultDetails> | undefined,
			ctx: ExtensionContext,
		) {
			const parentThinking: ModelThinkingLevel = pi.getThinkingLevel();
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
