/**
 * pi-schematic v2 — Extension factory.
 *
 * Wires together the three primitives:
 *   spawn     — delegate isolated work to child contexts
 *   notebook   — durable cross-context memory
 *   handoff   — deliberate task pivot via compaction
 *
 * Also registers:
 *   - watchdog (primacy-zone reminder and required-handoff enforcement)
 *   - prompt sections (context primer, current date, topic, model groups, notebook listing)
 *   - state reset on /new
 */

import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { createState, invalidateHandoffState, resetState, type SchematicState } from "./state.js";
import { contextPrimerSection, currentDateSection } from "./system-prompt.js";
import { createPromptSectionRegistry, applyPromptSections } from "./prompt-sections.js";
import { notebookPagesSection, notebookTopicSection } from "./notebook/prompt.js";
import { modelGroupsSection } from "./model-groups/prompt.js";
import { buildAndRecordNudge, registerWatchdog } from "./watchdog.js";
import { registerNotebookTools } from "./notebook/tools.js";
import { ensureNotebookToolsActive, registerNotebookRehydration, reconstructNotebook } from "./notebook/rehydration.js";
import { registerNotebookTopicTool } from "./notebook/topic-tool.js";
import { setActiveNotebookTopic } from "./notebook/topic.js";
import { formatPageTuiPreview } from "./notebook/store.js";
import { openInPager, pagerRuntime, type ResolvedPager } from "./notebook/pager.js";
import { HANDOFF_TOOL_NAME, registerHandoffTool } from "./handoff/tool.js";
import {
	canPromoteBoundary,
	discardNonHumanBoundary,
	markBoundaryAdvisory,
	promoteBoundary,
} from "./readonly-boundary.js";
import { isHandoffEligible, normalizeContextPercent } from "./handoff/eligibility.js";
import { getReadonlyFromBranch } from "./readonly-rehydration.js";
import { HANDOFF_REQUIRED_STATUS } from "./handoff/copy.js";
import { registerHandoffCommand } from "./handoff/command.js";
import { registerHandoffBoundary } from "./handoff/boundary.js";
import {
	READONLY_ACTIVE_SUMMARY,
	READONLY_COMMAND_DESCRIPTION,
	READONLY_DISABLED_NOTIFICATION,
	READONLY_DISABLED_SUMMARY,
	READONLY_ENABLED_STATUS,
	READONLY_HANDOFF_BLOCK_REASON,
	READONLY_HANDOFF_EXCEPTION_SUMMARY,
	READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION,
	READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION,
	READONLY_POWERSHELL_BLOCK_REASON,
	READONLY_WRITE_EDIT_BLOCK_REASON,
	buildModelFrontmatterAuthErrorNotification,
	buildModelFrontmatterErrorNotification,
	buildModelFrontmatterNotification,
	buildModelFrontmatterSetModelErrorNotification,
	buildStreamingModelSelectionBlockedNotification,
	buildStreamingReadonlyFrontmatterBlockedNotification,
	buildModelGroupErrorNotification,
	buildModelGroupNotification,
	buildModelGroupOverrideWarningNotification,
	buildModelGroupSetModelErrorNotification,
	buildThinkingFrontmatterNotification,
	buildReadonlyDisabledContextSuffix,
	buildReadonlyFrontmatterNotification,
	buildReadonlyTopicBoundaryNotification,
} from "./notifications.js";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { registerSpawnTool } from "./spawn/index.js";
import { registerModelGroupsCommand } from "./model-groups/command.js";
import { resolveSpawnModelRoute, SpawnRouteError } from "./model-groups/router.js";
import { registerModelGroupAutocomplete } from "./model-groups/autocomplete.js";
import { getEffectiveModelGroupNames } from "./model-groups/router.js";
import { createModelGroupsAccess, loadModelGroups, summarizeBootValidation, validateModelGroups } from "./model-groups/store.js";
import { escapeDisplayLabel } from "./model-groups/display.js";
import { productionConstraintRegistry } from "./model-groups/constraints/registry.js";
import { isUsableModel } from "./model-groups/availability.js";
import {
	cacheLookupCommand,
	cacheLookupCommandExplicitModel,
	cacheLookupCommandExplicitThinking,
	cacheLookupCommandIssue,
	cacheLookupCommandModelGroup,
	cacheLookupSkill,
	cacheLookupSkillExplicitModel,
	cacheLookupSkillExplicitThinking,
	cacheLookupSkillIssue,
	cacheLookupSkillModelGroup,
	formatFrontmatterIssue,
	populateFromSkills,
	populatePromptCacheFromResolvedCommandsAndDirs,
	populateSkillCacheFromResolvedCommands,
	type FrontmatterIssue,
} from "./frontmatter-cache.js";
import {
	STATUS_KEY_HANDOFF,
	STATUS_KEY_READONLY,
	STATUS_KEY_TOPIC,
	WIDGET_KEY_WARNING,
	updateIndicators,
} from "./tui.js";
import { applyReadonlyBashGuard } from "./readonly-bash.js";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Populate the frontmatter cache from loaded skills and prompt
 * commands/directories. Always called before toggle resolution so the cache
 * is fresh for the current input.
 */
function populateFrontmatterCache(
	state: SchematicState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	skills?: Skill[],
): void {
	const commands = pi.getCommands();
	if (skills) {
		populateFromSkills(state, skills);
	} else {
		populateSkillCacheFromResolvedCommands(state, commands);
	}
	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, ctx.cwd, ctx.isProjectTrusted());
}

const READONLY_BYPASS_COMMANDS = new Set(["readonly", "notebook", "handoff"]);

function isBuiltinReadonlyBypassCommand(name: string): boolean {
	return READONLY_BYPASS_COMMANDS.has(name);
}

type PendingCommand = { type: "skill" | "command"; name: string };
type ModelSelection = {
	model: string | null;
	group: string | null;
	thinking: ModelThinkingLevel | null;
	issue: FrontmatterIssue | null;
};

const cacheResolver = {
	skill: {
		readonly: cacheLookupSkill,
		model: cacheLookupSkillExplicitModel,
		group: cacheLookupSkillModelGroup,
		thinking: cacheLookupSkillExplicitThinking,
		issue: cacheLookupSkillIssue,
	},
	command: {
		readonly: cacheLookupCommand,
		model: cacheLookupCommandExplicitModel,
		group: cacheLookupCommandModelGroup,
		thinking: cacheLookupCommandExplicitThinking,
		issue: cacheLookupCommandIssue,
	},
};

function resolveModelSelection(state: SchematicState, pending: PendingCommand): ModelSelection {
	const resolver = cacheResolver[pending.type];
	return {
		model: resolver.model(state, pending.name),
		group: resolver.group(state, pending.name),
		thinking: resolver.thinking(state, pending.name),
		issue: resolver.issue(state, pending.name),
	};
}

function hasModelSelection(selection: ModelSelection): boolean {
	return Boolean(selection.model || selection.group || selection.thinking);
}

function resolveReadonlySelection(state: SchematicState, pending: PendingCommand): boolean | null {
	return cacheResolver[pending.type].readonly(state, pending.name);
}

function formatCommandRef(command: PendingCommand): string {
	return command.type === "skill" ? `/skill:${command.name}` : `/${command.name}`;
}

function recordFrontmatterIssue(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	command: PendingCommand,
	issue: FrontmatterIssue,
): void {
	pi.appendEntry("pi-schematic-frontmatter-issue", { name: command.name, type: command.type, issue });
	if (ctx.hasUI) {
		ctx.ui.notify(formatFrontmatterIssue(formatCommandRef(command), issue), "warning");
	}
}

// Parallel deferred queues must assign each cache issue to one reporter.
function isReadonlyFrontmatterIssue(issue: FrontmatterIssue): boolean {
	return issue.kind === "invalid-readonly-value" || issue.kind === "malformed-frontmatter" || issue.kind === "unreadable-file";
}

/**
 * Consume any deferred readonly toggle recorded by the `input` handler.
 * Must be called after `populateFrontmatterCache` so the cache is populated.
 */
function consumePendingReadonlyCommands(
	state: SchematicState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	// Readonly is a TUI-only feature. Headless/RPC sessions must not inherit a
	// queued slash-command toggle from some earlier interactive input source, so
	// drop any deferred intents here instead of letting them mutate headless runs.
	if (!ctx.hasUI) {
		state.pendingReadonlyCommands.length = 0;
		return;
	}

	// Consume unknown/malformed queue entries until the first real readonly
	// decision so a stale no-op slash command cannot delay the next valid toggle.
	// Prompt commands may exist only on disk in Pi's standard prompt dirs, so
	// command lookups trust the populated prompt cache instead of re-gating on
	// the live registry here. Known non-prompt commands stay blocked because the
	// cache builder marks their names as shadowed and never loads fallback files.
	while (state.pendingReadonlyCommands.length > 0) {
		const pendingCommand = state.pendingReadonlyCommands.shift();
		if (!pendingCommand) return;

		const readonly = pendingCommand.type === "skill"
			? cacheLookupSkill(state, pendingCommand.name)
			: cacheLookupCommand(state, pendingCommand.name);
		if (readonly === null) {
			const issue = pendingCommand.type === "skill"
				? cacheLookupSkillIssue(state, pendingCommand.name)
				: cacheLookupCommandIssue(state, pendingCommand.name);
			if (issue && isReadonlyFrontmatterIssue(issue)) recordFrontmatterIssue(ctx, pi, pendingCommand, issue);
			continue;
		}

		if (state.readonlyEnabled === readonly) {
			return;
		}

		state.readonlyEnabled = readonly;
		state.readonlyNudgePending = true;
		pi.appendEntry("pi-schematic-readonly", { enabled: readonly });

		if (ctx.hasUI) {
			const commandRef = formatCommandRef(pendingCommand);
			ctx.ui.notify(buildReadonlyFrontmatterNotification(readonly, commandRef), "info");
		}
		return;
	}
}

async function safeSetModel(pi: ExtensionAPI, model: Model<Api>, onError: () => void): Promise<boolean> {
	try {
		if (await pi.setModel(model)) return true;
	} catch {
		// Pi can reject after its configured-auth check succeeds.
	}
	onError();
	return false;
}

async function preflightModelSelection(
	state: SchematicState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	pending: PendingCommand,
	selection = resolveModelSelection(state, pending),
): Promise<boolean> {
	if (!ctx.hasUI || !ctx.model) return false;
	if (selection.issue && !isReadonlyFrontmatterIssue(selection.issue)) {
		recordFrontmatterIssue(ctx, pi, pending, selection.issue);
	}
	const commandRef = formatCommandRef(pending);
	if (selection.model) return handleExplicitModelFrontmatter(ctx, pi, selection, commandRef);
	if (selection.group) return handleModelGroupFrontmatter(state, ctx, pi, selection, commandRef, ctx.model);
	if (selection.thinking) return handleThinkingOnlyFrontmatter(ctx, pi, selection.thinking, commandRef, ctx.model);
	return false;
}

function splitModelId(raw: string): { provider: string; modelId: string } {
	const idx = raw.indexOf("/");
	return { provider: raw.slice(0, idx), modelId: raw.slice(idx + 1) };
}

function findExplicitModel(ctx: ExtensionContext, raw: string, commandRef: string): Model<Api> | null {
	const { provider, modelId } = splitModelId(raw);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(buildModelFrontmatterErrorNotification(provider, modelId, commandRef, "not found in registry"), "error");
		return null;
	}
	if (isUsableModel(ctx.modelRegistry, model)) return model;
	ctx.ui.notify(buildModelFrontmatterAuthErrorNotification(provider, modelId, commandRef), "error");
	return null;
}

function recordExplicitModelSwitch(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	modelRef: string,
	thinking: ModelThinkingLevel | null,
	commandRef: string,
): void {
	const { provider, modelId } = splitModelId(modelRef);
	if (thinking) pi.setThinkingLevel(thinking);
	ctx.ui.notify(buildModelFrontmatterNotification(provider, modelId, commandRef), "info");
	pi.appendEntry("pi-schematic-model-switch", { command: commandRef, provider, modelId, thinking });
}

async function handleExplicitModelFrontmatter(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	selection: ModelSelection,
	commandRef: string,
): Promise<boolean> {
	if (selection.group) ctx.ui.notify(buildModelGroupOverrideWarningNotification(selection.group, commandRef), "warning");
	const model = findExplicitModel(ctx, selection.model!, commandRef);
	if (!model) return true;
	const notifyError = () => {
		const { provider, modelId } = splitModelId(selection.model!);
		ctx.ui.notify(buildModelFrontmatterSetModelErrorNotification(provider, modelId, commandRef), "error");
	};
	if (!await safeSetModel(pi, model, notifyError)) return true;
	const thinking = selection.thinking ? clampThinkingLevel(model, selection.thinking) : null;
	recordExplicitModelSwitch(ctx, pi, selection.model!, thinking, commandRef);
	return false;
}

type ModelRoute = ReturnType<typeof resolveSpawnModelRoute>;

function unknownGroupDetail(state: SchematicState, groupName: string): string {
	const names = getEffectiveModelGroupNames(state.modelGroups.groups);
	const hint = names.length > 5 ? " Run /model-groups to see all available groups."
		: names.length > 0 ? ` Available groups: ${names.join(", ")}.` : "";
	return `Model Group '${groupName}' is not defined.${hint}`;
}

function recordModelGroupSwitch(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	route: Exclude<ModelRoute, { status: "unknown-fallback" }>,
	groupName: string,
	thinking: ModelThinkingLevel,
	commandRef: string,
): void {
	pi.setThinkingLevel(thinking);
	ctx.ui.notify(buildModelGroupNotification(groupName, route.provider, route.modelId, commandRef), "info");
	pi.appendEntry("pi-schematic-model-group-switch", {
		command: commandRef,
		groupName,
		provider: route.provider,
		modelId: route.modelId,
		thinking,
	});
}

async function applyModelGroupRoute(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	route: Exclude<ModelRoute, { status: "unknown-fallback" }>,
	selection: ModelSelection,
	commandRef: string,
): Promise<boolean> {
	const groupName = selection.group!;
	const onError = () => ctx.ui.notify(
		buildModelGroupSetModelErrorNotification(groupName, route.provider, route.modelId, commandRef), "error",
	);
	if (!await safeSetModel(pi, route.model, onError)) return true;
	const thinking = selection.thinking ? clampThinkingLevel(route.model, selection.thinking) : route.thinking;
	recordModelGroupSwitch(ctx, pi, route, groupName, thinking, commandRef);
	return false;
}

function resolveModelGroupRoute(
	state: SchematicState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	groupName: string,
	currentModel: Model<Api>,
): ModelRoute {
	return resolveSpawnModelRoute({
		requestedGroup: groupName,
		groups: state.modelGroups.groups,
		parentModel: currentModel,
		parentThinking: pi.getThinkingLevel(),
		modelRegistry: ctx.modelRegistry,
	});
}

async function handleModelGroupFrontmatter(
	state: SchematicState, ctx: ExtensionContext, pi: ExtensionAPI,
	selection: ModelSelection, commandRef: string, currentModel: Model<Api>,
): Promise<boolean> {
	try {
		const route = resolveModelGroupRoute(state, ctx, pi, selection.group!, currentModel);
		if (route.status !== "unknown-fallback") return applyModelGroupRoute(ctx, pi, route, selection, commandRef);
		const detail = unknownGroupDetail(state, selection.group!);
		ctx.ui.notify(buildModelGroupErrorNotification(selection.group!, commandRef, detail), "error");
		return true;
	} catch (error) {
		if (!(error instanceof SpawnRouteError)) throw error;
		ctx.ui.notify(buildModelGroupErrorNotification(selection.group!, commandRef, error.message), "error");
		return true;
	}
}

function handleThinkingOnlyFrontmatter(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	explicitThinking: ModelThinkingLevel,
	commandRef: string,
	currentModel: Model<Api>,
): boolean {
	const thinking = clampThinkingLevel(currentModel, explicitThinking);
	pi.setThinkingLevel(thinking);
	ctx.ui.notify(buildThinkingFrontmatterNotification(thinking, commandRef), "info");
	pi.appendEntry("pi-schematic-thinking-change", { command: commandRef, thinking });
	return false;
}

function blockStreamingFrontmatter(
	ctx: ExtensionContext,
	pending: PendingCommand,
	selection: ModelSelection,
	readonly: boolean | null,
	streamingBehavior: "steer" | "followUp" | undefined,
): boolean {
	if (!streamingBehavior) return false;
	if (hasModelSelection(selection)) {
		ctx.ui.notify(buildStreamingModelSelectionBlockedNotification(formatCommandRef(pending)), "warning");
		return true;
	}
	if (readonly === null) return false;
	ctx.ui.notify(buildStreamingReadonlyFrontmatterBlockedNotification(formatCommandRef(pending)), "warning");
	return true;
}

function refreshModelGroupsState(state: SchematicState, ctx: ExtensionContext) {
	state.modelGroups.groups = [];
	state.modelGroups.validation = null;
	if (!ctx.cwd || !(ctx as any).modelRegistry) return null;
	const loadedModelGroups = loadModelGroups(createModelGroupsAccess(ctx.cwd, ctx.isProjectTrusted()));
	const resolvedModelGroups = validateModelGroups(loadedModelGroups, (ctx as any).modelRegistry);
	state.modelGroups.groups = resolvedModelGroups;
	state.modelGroups.validation = { groups: resolvedModelGroups, loadIssues: loadedModelGroups.issues };
	return state.modelGroups.validation;
}

export default function (pi: ExtensionAPI): void {
	const state: SchematicState = createState();

	// ── Register all tools ──────────────────────────────────────────
	registerNotebookTools(pi, state);
	registerNotebookTopicTool(pi, state);
	registerHandoffTool(pi, state);
	registerSpawnTool(pi, state);

	// ── Register event handlers ─────────────────────────────────────
	// Handoff boundary first. Its failure path resets toolCalled before the
	// watchdog's agent_settled handler counts the attempt, and the watchdog counts
	// only once toolCalled is reset. Its tool_call refusal of a handoff that
	// shares a message with other calls precedes the readonly block.
	registerHandoffBoundary(pi, state);
	registerWatchdog(pi, state);
	registerNotebookRehydration(pi, state);

	// ── Register commands ───────────────────────────────────────────
	registerHandoffCommand(pi, state);
	registerModelGroupsCommand(pi, state);

	// ── Register prompt sections (render order = registration order) ──
	const promptSections = createPromptSectionRegistry();
	promptSections.register(contextPrimerSection());
	promptSections.register(currentDateSection());
	promptSections.register(notebookTopicSection(state));
	promptSections.register(modelGroupsSection(state, productionConstraintRegistry));
	promptSections.register(notebookPagesSection(state));

	// ── Readonly mode ───────────────────────────────────────────────

	pi.registerFlag("readonly", {
		description: "Start in readonly mode",
		type: "boolean",
		default: false,
	});

	function toggleReadonly(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return; // Toggle is a UI-only command, no-op in headless.
		state.readonlyEnabled = !state.readonlyEnabled;
		// A pendingRequestedHandoff is a promise to perform a real handoff later; tell
		// the user which mode the fresh context will follow, then nudge the model.
		if (state.pendingRequestedHandoff) {
			if (state.readonlyEnabled) {
				ctx.ui.notify(READONLY_PENDING_HANDOFF_READONLY_ON_NOTIFICATION, "info");
			} else {
				ctx.ui.notify(READONLY_PENDING_HANDOFF_READONLY_OFF_NOTIFICATION, "info");
			}
		}
		state.readonlyNudgePending = true;
		pi.appendEntry("pi-schematic-readonly", { enabled: state.readonlyEnabled });
		updateIndicators(ctx, state);
		ctx.ui.notify(
			state.readonlyEnabled
				? READONLY_ENABLED_STATUS
				: READONLY_DISABLED_NOTIFICATION,
			"info",
		);
	}

	pi.registerCommand("readonly", {
		description: READONLY_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => toggleReadonly(ctx),
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Toggle readonly mode",
		handler: async (ctx) => {
			if (ctx.isIdle()) toggleReadonly(ctx);
		},
	});

	function rehydrateReadonlyState(ctx: ExtensionContext): void {
		const wasEnabled = state.readonlyEnabled;
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		state.readonlyEnabled = getReadonlyFromBranch(branch, pi);
		// Nudge whenever readonly is (or was) active: the handoff summary is
		// readonly-free by design, so a rebuilt context must relearn the ON posture from
		// live state, and a toggle to OFF must still be announced.
		if (state.readonlyEnabled || wasEnabled) {
			state.readonlyNudgePending = true;
		}
	}

	// ── Readonly: tool_call blocking ────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		// ── Readonly mode ───────────────────────────────────────────
		// Guardrail for a coding agent (not a security boundary):
		// write/edit/powershell stay in the tool list but are blocked at call
		// time. handoff is also blocked unless pendingRequestedHandoff has
		// activated a narrow temporary bypass for this session's required pivot.
		// That sticky state is created by explicit /handoff or by an eligible
		// readonly human topic boundary. Keeping tools advertised
		// avoids context-cache invalidation from tools disappearing mid-session.
		// Children use the opposite approach (remove from tool list entirely)
		// because they start with a fresh context — see spawn/index.ts.
		if (!state.readonlyEnabled) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true as const,
				reason: READONLY_WRITE_EDIT_BLOCK_REASON,
			};
		}

		if (event.toolName === "powershell") {
			return {
				block: true as const,
				reason: READONLY_POWERSHELL_BLOCK_REASON,
			};
		}

		if (event.toolName === HANDOFF_TOOL_NAME && !state.pendingRequestedHandoff) {
			return {
				block: true as const,
				reason: READONLY_HANDOFF_BLOCK_REASON,
			};
		}

		if (isToolCallEventType("bash", event)) {
			const result = applyReadonlyBashGuard(event.input.command, ctx.cwd);
			if (result.action === "block") {
				return { block: true as const, reason: result.reason };
			}
			if (result.action === "sandbox") {
				// Mutate input.command in-place — SDK has no transform return type.
				// Other tool_call hooks will see the sandbox-wrapped command.
				event.input.command = result.sandboxedCommand;
			}
		}
	});

	// ── Preflight model-selection frontmatter before slash-command expansion ──
	pi.on("input", async (event, ctx) => {
		// Extension-sourced steer/followUp text and headless sessions must not
		// mutate the interactive frontmatter state.
		if (!ctx.hasUI || event.source === "extension") return { action: "continue" };

		const skillName = event.text.match(/^\/skill:([^\s]+)/)?.[1];
		const commandName = event.text.match(/^\/([^\s]+)/)?.[1];
		if (!skillName && !commandName) return { action: "continue" };

		const commands = pi.getCommands();
		const pending = skillName
			? { type: "skill" as const, name: skillName }
			: { type: "command" as const, name: commandName! };
		if (!skillName && isBuiltinReadonlyBypassCommand(pending.name)) return { action: "continue" };
		if (!skillName && commands.some((command) => command.name === pending.name && command.source !== "prompt")) {
			return { action: "continue" };
		}

		// Command metadata is already available at input time. This prevents a
		// failed selection from reaching Pi's expansion/agent-start lifecycle.
		populateFrontmatterCache(state, ctx, pi);
		refreshModelGroupsState(state, ctx);

		const selection = resolveModelSelection(state, pending);
		const readonly = resolveReadonlySelection(state, pending);
		if (blockStreamingFrontmatter(ctx, pending, selection, readonly, event.streamingBehavior)) {
			return { action: "handled" };
		}
		if (await preflightModelSelection(state, ctx, pi, pending, selection)) return { action: "handled" };

		// Readonly intentionally remains deferred: its authority is resolved with
		// Pi's final skill metadata in before_agent_start.
		state.pendingReadonlyCommands.push(pending);
		return { action: "continue" };
	});

	// ── /notebook command — interactive page selector ────────────────
	pi.registerCommand("notebook", {
		description: "Select a notebook page to view, or set the active notebook topic with /notebook <topic>",
		handler: async (args, ctx) => {
			const topicArg = args.trim();
			if (topicArg) {
				const result = setActiveNotebookTopic(state, topicArg, "human");
				if (ctx.hasUI) {
					const message = result.boundaryHint
						? state.readonlyEnabled
							? buildReadonlyTopicBoundaryNotification(result.boundaryHint.from, result.boundaryHint.to)
							: `Active notebook topic changed: ${result.boundaryHint.from} → ${result.boundaryHint.to}. This is a likely task boundary; handoff is recommended before continuing.`
						: `Active notebook topic: ${result.current}`;
					ctx.ui.notify(message, result.boundaryHint ? "warning" : "info");
				}
				updateIndicators(ctx, state);
				return;
			}
			if (!ctx.hasUI) {
				return;
			}

			let lastSelectedName: string | undefined;
			// Resolve once per /notebook so onSelect doesn't run `command -v less` on every Enter.
			const pager = pagerRuntime.resolvePager();
			while (true) {
				// Pi has no extension API to suspend the TUI, so the "pager" result carries
				// custom()'s handle for openInPager, which runs after done() closes the list.
				// It is Pi's long-lived TUI reference, so it stays valid past done().
				const result = await ctx.ui.custom<
					| { action: "pager"; name: string; body: string; tui: TUI; pager: ResolvedPager }
					| { action: "reopen"; name: string }
					| undefined
				>((tui, theme, _kb, done) => {
					const container = new Container();

					container.addChild(
						new DynamicBorder((s: string) => theme.fg("accent", s)),
					);
					container.addChild(
						new Text(theme.fg("accent", theme.bold(` Notebook (${state.notebookPages.size} pages) `)), 1, 0),
					);

					const entries = Array.from(state.notebookPages.entries()).sort(([a], [b]) => a.localeCompare(b));
					let selectList: SelectList | undefined;
					let previewName: string | undefined;
					let finished = false;

					if (entries.length === 0) {
						container.addChild(
							new Text(theme.fg("dim", " (empty) — use notebook_write to create pages"), 1, 0),
						);
					} else {
						const items: SelectItem[] = entries.map(([name, content]) => ({
							value: name,
							label: name,
							description: formatPageTuiPreview(content, state.clippedPages.has(name)),
						}));

						selectList = new SelectList(items, Math.min(items.length, 10), {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						});
						if (lastSelectedName !== undefined) {
							const idx = items.findIndex((it) => it.value === lastSelectedName);
							if (idx >= 0) selectList.setSelectedIndex(idx);
						}
						selectList.onSelect = ({ value }) => {
							const body = state.notebookPages.get(value);
							// A handoff discard can apply while the list is open (the cut completes during the agent run).
							if (body === undefined) {
								finished = true;
								done({ action: "reopen", name: value });
								return;
							}
							// Prefer a real pager when available; else fall back to a
							// truncated inline preview.
							if (pager) {
								finished = true;
								done({ action: "pager", name: value, body, tui, pager });
								return;
							}
							container.clear();
							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
							container.addChild(new Text(theme.fg("accent", theme.bold(` ${value} `)), 1, 0));
							const truncated = body.length > 500;
							container.addChild(new Text(theme.fg("toolOutput", truncated ? body.slice(0, 500) : body), 1, 0));
							if (truncated) container.addChild(new Text(theme.fg("dim", " ... set $PI_PAGER to a full-screen pager (e.g. less) to view the full page "), 1, 0));
							container.addChild(new Text(theme.fg("dim", " any key back "), 1, 0));
							container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
							previewName = value;
							selectList = undefined;
							tui.requestRender();
						};
						selectList.onCancel = () => {
							if (finished) return;
							finished = true;
							done(undefined);
						};
						container.addChild(selectList);
					}

					container.addChild(
						new Text(theme.fg("dim", entries.length === 0
							? " esc close "
							: " \u2191\u2195 navigate \u2022 enter view \u2022 esc close "), 1, 0),
					);
					container.addChild(
						new DynamicBorder((s: string) => theme.fg("accent", s)),
					);

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							if (finished) return;
							if (!selectList) {
								// Any key leaves the inline preview (back to the list) or the empty notebook.
								finished = true;
								done(previewName === undefined ? undefined : { action: "reopen", name: previewName });
								return;
							}
							selectList.handleInput?.(data);
							// Conservative: always repaint after key input.
							// SelectList.handleInput returns void in the current API,
							// so we can't conditionally skip — the cost is negligible.
							tui.requestRender();
						},
					};
				});
				if (!result) return;
				lastSelectedName = result.name;
				if (result.action === "pager") {
					const err = await openInPager(result.tui, result.body, result.pager);
					if (err) ctx.ui.notify(`pager failed: ${err.message}`, "warning");
				}
			}
		},
	});

	// ── before_agent_start: resolve deferred readonly, then write prompt sections ──
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		if (state.pendingReadonlyCommands.length > 0) {
			populateFrontmatterCache(state, ctx, pi, event.systemPromptOptions.skills);
		}
		consumePendingReadonlyCommands(state, ctx, pi);

		// Update TUI indicators before each user-prompt agent run
		updateIndicators(ctx, state);
		refreshModelGroupsState(state, ctx);

		// After refreshModelGroupsState: schematic_model_groups renders from that snapshot.
		return applyPromptSections(event, promptSections.render());
	});

	// ── context: inject toggle-on/toggle-off readonly state + watchdog nudge ──
	// Readonly visibility comes from two channels:
	//   1. toggle-nudge: injected once on mode change (context hook)
	//   2. tool-call blocking errors (tool_call handler)
	// The watchdog nudge is suppressed while readonly is active unless a
	// handoff is pending. pendingRequestedHandoff is created by explicit
	// /handoff or by an eligible human topic boundary. Ineligible boundaries
	// remain advisory, so the guardrail never mandates an impossible handoff.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const percent = normalizeContextPercent(usage?.percent);
		state.lastContextPercent = percent;

		// Build the readonly toggle-nudge (one-shot on mode change)
		let readonlyNudgeMsg: { role: string; customType: string; content: string; display: boolean; timestamp: number } | null = null;
		if (state.readonlyNudgePending) {
			state.readonlyNudgePending = false;
			readonlyNudgeMsg = {
				role: "custom" as const,
				customType: "pi-schematic-readonly-nudge",
				content: state.readonlyEnabled
					? (state.pendingRequestedHandoff ||
						(state.pendingTopicBoundaryHint?.source === "human" && isHandoffEligible(usage)))
						? READONLY_HANDOFF_EXCEPTION_SUMMARY
						: READONLY_ACTIVE_SUMMARY
					: READONLY_DISABLED_SUMMARY +
					  (percent !== null && percent >= 30
						? buildReadonlyDisabledContextSuffix(percent)
						: ""),
				display: false,
				timestamp: Date.now(),
			};
		}
		const appendReadonlyNudge = () => readonlyNudgeMsg
			? { messages: [...event.messages, readonlyNudgeMsg as any] }
			: undefined;

		// In readonly mode, an eligible human topic boundary is equivalent to /handoff:
		// create the same sticky bypass contract only when compaction can proceed.
		// Without an eligible boundary or pending handoff, suppress the watchdog entirely
		// — readonly visibility comes from the toggle-nudge and tool-call blocking
		// errors, not from repeated advisory watchdog text.
		let retainIneligibleHumanBoundary = false;
		if (state.readonlyEnabled && !state.pendingRequestedHandoff) {
			if (discardNonHumanBoundary(state)) {
				state.lastWatchdogBand = null;
				return appendReadonlyNudge();
			}
			if (state.pendingTopicBoundaryHint) {
				if (canPromoteBoundary(state, usage)) {
					promoteBoundary(state, ctx);
				} else if (markBoundaryAdvisory(state)) {
					retainIneligibleHumanBoundary = true;
				} else {
					// Already advised; boundary guidance stays advisory until eligible.
					return appendReadonlyNudge();
				}
			} else {
				// Readonly active, no boundary hint, no pending handoff — suppress watchdog.
				state.lastWatchdogBand = null;
				return appendReadonlyNudge();
			}
		}

		const mustEnforceRequestedHandoff = state.pendingRequestedHandoff !== null;
		if (
			state.pendingRequestedHandoff &&
			!state.pendingRequestedHandoff.toolCalled &&
			isHandoffEligible(usage) &&
			ctx.hasUI &&
			ctx.ui.theme
		) {
			ctx.ui.setStatus(
				STATUS_KEY_HANDOFF,
				ctx.ui.theme.fg("accent", HANDOFF_REQUIRED_STATUS),
			);
		}

		// Below primacy-zone threshold (~30%), skip watchdog unless a boundary
		// hint or a sticky user-requested handoff is pending — context is still
		// fresh enough that ordinary nudges add noise.
		// HACK: `as any` required because readonlyNudgeMsg has customType field not in AgentMessage.
		// Proper fix: augment CustomAgentMessages via module augmentation on @earendil-works/pi-agent-core.
		if (!mustEnforceRequestedHandoff && !state.pendingTopicBoundaryHint && (percent === null || percent < 30)) {
			state.lastWatchdogBand = null;
			return appendReadonlyNudge();
		}

		// Throttle: only nudge when crossing into a higher context-percentage band.
		// Bands: null (<30), 0 (30-49), 1 (50-69), 2 (70+). This prevents nudging
		// every turn once past 30%.
		if (!mustEnforceRequestedHandoff && !state.pendingTopicBoundaryHint) {
			const band = percent! < 50 ? 0 : percent! < 70 ? 1 : 2;
			if (state.lastWatchdogBand !== null && band <= state.lastWatchdogBand) {
				return appendReadonlyNudge();
			}
			state.lastWatchdogBand = band;
		}

		const nudge = buildAndRecordNudge(state, percent, isHandoffEligible(usage));
		if (!retainIneligibleHumanBoundary) state.pendingTopicBoundaryHint = null;
		return {
			messages: [
				...event.messages,
				...(readonlyNudgeMsg ? [readonlyNudgeMsg as any] : []),
				{
					role: "custom",
					customType: "pi-schematic-watchdog",
					content: nudge,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	// ── session_start: reset state + readonly rehydration + indicators ──
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		if (event.reason === "new") {
			resetState(state);
			// Clear any stale TUI indicators from the previous session
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
				ctx.ui.setStatus(STATUS_KEY_TOPIC, undefined);
				ctx.ui.setStatus(STATUS_KEY_READONLY, undefined);
				ctx.ui.setWidget(WIDGET_KEY_WARNING, undefined);
			}
		}

		registerModelGroupAutocomplete(ctx, state);
		const validation = refreshModelGroupsState(state, ctx);
		if (validation && ctx.hasUI) {
			for (const issue of validation.loadIssues) {
				const sourcePath = escapeDisplayLabel(issue.sourcePath);
				const backupPath = issue.backupPath ? escapeDisplayLabel(issue.backupPath) : undefined;
				const detail = escapeDisplayLabel(issue.message);
				const backupNote = issue.backupFailed ? `; backup failed${backupPath ? ` (${backupPath})` : ""}, original file left untouched` : "";
				ctx.ui.notify(`Model Groups config ${issue.kind} in ${issue.scope} scope (${sourcePath}); using empty config for that scope${backupNote}; ${detail}`, "warning");
			}
			const { unavailableCount, overrideCount, emptyModalityCount, staleModalityOverrideCount } = summarizeBootValidation(validation.groups);
			if (unavailableCount > 0 || overrideCount > 0 || emptyModalityCount > 0 || staleModalityOverrideCount > 0) {
				ctx.ui.notify(`Model Groups boot validation: ${unavailableCount} unavailable model references · ${overrideCount} project overrides · ${emptyModalityCount} groups with no common modalities · ${staleModalityOverrideCount} stale modality overrides`, "warning");
			}
		}

		rehydrateReadonlyState(ctx);
		updateIndicators(ctx, state);
	});

	// ── session_tree: invalidate branch-local handoff work, rehydrate the
	//    branch-scoped notebook state, then rehydrate readonly ──
	pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
		invalidateHandoffState(state);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY_HANDOFF, undefined);
		// Notebook persistence is branch-scoped: pages, the committed epoch, and
		// the discard watermark follow the branch the user navigated to. Reconstruction
		// runs immediately after invalidation, so the watermark derived from the new
		// branch replaces the in-memory value before any retry could reuse a staged
		// epoch from the abandoned branch.
		reconstructNotebook(state, ctx.sessionManager?.getBranch?.() ?? []);
		ensureNotebookToolsActive(pi);
		rehydrateReadonlyState(ctx);
		updateIndicators(ctx, state);
	});

	// ── update TUI indicators after each turn ───────────────────────
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		updateIndicators(ctx, state);
	});
}
