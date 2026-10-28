/**
 * Cache for skill/prompt-template frontmatter.
 *
 * Populated on-demand:
 *   - In the `input` handler from resolved commands (`pi.getCommands()`) for model preflight.
 *   - In `before_agent_start` from loaded skills (`systemPromptOptions.skills`) for readonly resolution.
 *   - Also from standard prompt directories as a partial fallback:
 *      `prompts/` under pi's agent directory (`getAgentDir()`) and, when the
 *      project is trusted, `prompts/` under `cwd/<CONFIG_DIR_NAME>/`.
 *
 * All production prompt-resolution happens through
 * `populatePromptCacheFromResolvedCommandsAndDirs`. The narrower
 * `populateFromPromptDirs`, `populateFromPromptCommands`, and
 * `populateFromPromptTemplates` have been removed as dead code —
 * they duplicated the logic of the production path. Any test that
 * needs to exercise prompt caching should go through the production
 * function with an empty command list.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { isThinkingLevel, THINKING_LEVELS } from "./thinking-levels.js";

export interface FrontmatterEntry {
	readonly: boolean | null;
	modelGroup: string | null;
	explicitModel: string | null;
	explicitThinking: ModelThinkingLevel | null;
	mtimeMs: number;
	filePath: string;
}

export interface FrontmatterIssue {
	kind: "invalid-readonly-value" | "invalid-model-group-value" | "invalid-explicit-model-value" | "invalid-thinking-value" | "malformed-frontmatter" | "unreadable-file";
	filePath: string;
}

export interface FrontmatterCache {
	frontmatterSkillCache: Map<string, FrontmatterEntry>;
	frontmatterPromptCache: Map<string, FrontmatterEntry>;
	frontmatterSkillIssues: Map<string, FrontmatterIssue>;
	frontmatterPromptIssues: Map<string, FrontmatterIssue>;
}

interface CacheReadResult {
	entry: FrontmatterEntry | null;
	issue: FrontmatterIssue | null;
}

function parseExplicitModel(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	const trimmed = raw.trim();
	// The first slash separates provider; the model ID may contain slashes.
	const slashIdx = trimmed.indexOf("/");
	if (slashIdx === -1 || slashIdx === 0 || slashIdx === trimmed.length - 1) return null;
	return trimmed;
}

function parseExplicitThinking(raw: unknown): ModelThinkingLevel | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim().toLowerCase();
	return isThinkingLevel(trimmed) ? trimmed : null;
}

function readCacheEntry(
	filePath: string,
	previous?: FrontmatterEntry,
	previousIssue?: FrontmatterIssue,
): CacheReadResult {
	let st;
	try {
		st = statSync(filePath);
	} catch (error: any) {
		return error?.code === "ENOENT" || error?.code === "ENOTDIR"
			? { entry: null, issue: null }
			: { entry: null, issue: { kind: "unreadable-file", filePath } };
	}

	if (previous && previous.filePath === filePath && st.mtimeMs === previous.mtimeMs) {
		return { entry: previous, issue: previousIssue ?? null };
	}

	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return { entry: null, issue: { kind: "unreadable-file", filePath } };
	}

	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		const readonly = frontmatter["readonly"];
		const modelGroupRaw = frontmatter["model-group"];
		const modelRaw = frontmatter["model"];
		const thinkingRaw = frontmatter["thinking"];

		const validReadonly = readonly === undefined || typeof readonly === "boolean";
		const validModelGroup = modelGroupRaw === undefined || (typeof modelGroupRaw === "string" && modelGroupRaw.trim().length > 0);
		const explicitModel = modelRaw !== undefined ? parseExplicitModel(modelRaw) : null;
		const explicitThinking = thinkingRaw !== undefined ? parseExplicitThinking(thinkingRaw) : null;
		const issue = !validReadonly
			? "invalid-readonly-value"
			: !validModelGroup
				? "invalid-model-group-value"
				: modelRaw !== undefined && explicitModel === null
					? "invalid-explicit-model-value"
					: thinkingRaw !== undefined && explicitThinking === null
						? "invalid-thinking-value"
						: null;

		return {
			entry: {
				readonly: validReadonly ? readonly ?? null : null,
				modelGroup: validModelGroup && typeof modelGroupRaw === "string" ? modelGroupRaw.trim() : null,
				explicitModel,
				explicitThinking,
				mtimeMs: st.mtimeMs,
				filePath,
			},
			issue: issue ? { kind: issue, filePath } : null,
		};
	} catch {
		return {
			entry: null,
			issue: { kind: "malformed-frontmatter", filePath },
		};
	}
}

function replaceCache(target: Map<string, FrontmatterEntry>, next: Map<string, FrontmatterEntry>): void {
	target.clear();
	for (const [name, entry] of next) target.set(name, entry);
}

function replaceIssues(target: Map<string, FrontmatterIssue>, next: Map<string, FrontmatterIssue>): void {
	target.clear();
	for (const [name, issue] of next) target.set(name, issue);
}

function setEntry(
	nextCache: Map<string, FrontmatterEntry>,
	nextIssues: Map<string, FrontmatterIssue>,
	name: string,
	result: CacheReadResult,
): void {
	if (result.entry) nextCache.set(name, result.entry);
	if (result.issue) nextIssues.set(name, result.issue);
}

export function cacheLookupSkill(store: FrontmatterCache, name: string): boolean | null {
	return store.frontmatterSkillCache.get(name)?.readonly ?? null;
}

export function cacheLookupPrompt(store: FrontmatterCache, name: string): boolean | null {
	return store.frontmatterPromptCache.get(name)?.readonly ?? null;
}

export function cacheLookupCommand(store: FrontmatterCache, name: string): boolean | null {
	return cacheLookupPrompt(store, name);
}

export function cacheLookupSkillModelGroup(store: FrontmatterCache, name: string): string | null {
	return store.frontmatterSkillCache.get(name)?.modelGroup ?? null;
}

export function cacheLookupCommandModelGroup(store: FrontmatterCache, name: string): string | null {
	return store.frontmatterPromptCache.get(name)?.modelGroup ?? null;
}

export function cacheLookupSkillExplicitModel(store: FrontmatterCache, name: string): string | null {
	return store.frontmatterSkillCache.get(name)?.explicitModel ?? null;
}

export function cacheLookupCommandExplicitModel(store: FrontmatterCache, name: string): string | null {
	return store.frontmatterPromptCache.get(name)?.explicitModel ?? null;
}

export function cacheLookupSkillExplicitThinking(store: FrontmatterCache, name: string): ModelThinkingLevel | null {
	return store.frontmatterSkillCache.get(name)?.explicitThinking ?? null;
}

export function cacheLookupCommandExplicitThinking(store: FrontmatterCache, name: string): ModelThinkingLevel | null {
	return store.frontmatterPromptCache.get(name)?.explicitThinking ?? null;
}

export function cacheLookupSkillIssue(store: FrontmatterCache, name: string): FrontmatterIssue | null {
	return store.frontmatterSkillIssues.get(name) ?? null;
}

export function cacheLookupCommandIssue(store: FrontmatterCache, name: string): FrontmatterIssue | null {
	return store.frontmatterPromptIssues.get(name) ?? null;
}

/**
 * Format a user-facing warning message for a frontmatter issue.
 * Covers invalid `readonly`, `model-group`, `model`, `thinking`,
 * malformed YAML, and unreadable source files. Missing fields are normal no-ops.
 */
export function formatFrontmatterIssue(commandRef: string, issue: FrontmatterIssue): string {
	const detail = issue.kind === "invalid-readonly-value"
		? "`readonly` frontmatter must be `true` or `false`"
		: issue.kind === "invalid-model-group-value"
			? "`model-group` frontmatter must be a non-empty string"
		: issue.kind === "invalid-explicit-model-value"
			? "`model` frontmatter must be in `<provider>/<model-id>` format"
		: issue.kind === "invalid-thinking-value"
			? `\`thinking\` frontmatter must be one of: ${THINKING_LEVELS.join(", ")}`
		: issue.kind === "malformed-frontmatter"
			? "frontmatter could not be parsed"
			: "prompt/skill file could not be read";
	return `Frontmatter ignored for \`${commandRef}\`: ${detail} at \`${issue.filePath}\`.`;
}

export function populateFromSkills(store: FrontmatterCache, skills: Array<Pick<Skill, "name" | "filePath">>): void {
	const nextCache = new Map<string, FrontmatterEntry>();
	const nextIssues = new Map<string, FrontmatterIssue>();
	for (const skill of skills) {
		const result = readCacheEntry(
			skill.filePath,
			store.frontmatterSkillCache.get(skill.name),
			store.frontmatterSkillIssues.get(skill.name),
		);
		setEntry(nextCache, nextIssues, skill.name, result);
	}
	replaceCache(store.frontmatterSkillCache, nextCache);
	replaceIssues(store.frontmatterSkillIssues, nextIssues);
}

/** Populate skill frontmatter before command expansion from Pi's command registry. */
export function populateSkillCacheFromResolvedCommands(store: FrontmatterCache, commands: SlashCommandInfo[]): void {
	populateFromSkills(store, commands.flatMap((command) => {
		if (command.source !== "skill" || !command.name.startsWith("skill:")) return [];
		return [{ name: command.name.slice("skill:".length), filePath: command.sourceInfo.path }];
	}));
}

function collectPromptFilesFromDir(
	store: FrontmatterCache,
	dir: string,
	nextCache: Map<string, FrontmatterEntry>,
	nextIssues: Map<string, FrontmatterIssue>,
	blockedNames: Set<string>,
): void {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		if (extname(file) !== ".md") continue;
		const name = basename(file, ".md");
		if (!name || blockedNames.has(name) || nextCache.has(name) || nextIssues.has(name)) continue;
		const result = readCacheEntry(
			join(dir, file),
			store.frontmatterPromptCache.get(name),
			store.frontmatterPromptIssues.get(name),
		);
		setEntry(nextCache, nextIssues, name, result);
	}
}

/**
 * Populate the prompt cache from resolved prompt commands plus the standard
 * prompt directories that Pi also uses on disk.
 *
 * Priority for duplicate names:
 *   1. Resolved prompt commands from `pi.getCommands()`.
 *   2. Trusted project prompts in `join(cwd, CONFIG_DIR_NAME, "prompts")`.
 *   3. Global prompts in `join(getAgentDir(), "prompts")`, resolved on every call.
 *
 * This is intentionally not a full prompt-source resolver. Anything outside
 * those standard dirs must already be surfaced by `pi.getCommands()`.
 */
export function populatePromptCacheFromResolvedCommandsAndDirs(
	store: FrontmatterCache,
	commands: SlashCommandInfo[],
	cwd: string,
	projectTrusted: boolean,
): void {
	const nextCache = new Map<string, FrontmatterEntry>();
	const nextIssues = new Map<string, FrontmatterIssue>();
	const blockedNames = new Set<string>();

	for (const command of commands) {
		if (!command.name) continue;
		if (command.source !== "prompt") {
			blockedNames.add(command.name);
			continue;
		}
		if (nextCache.has(command.name) || nextIssues.has(command.name)) continue;
		const result = readCacheEntry(
			command.sourceInfo.path,
			store.frontmatterPromptCache.get(command.name),
			store.frontmatterPromptIssues.get(command.name),
		);
		setEntry(nextCache, nextIssues, command.name, result);
	}

	if (projectTrusted) {
		collectPromptFilesFromDir(store, join(cwd, CONFIG_DIR_NAME, "prompts"), nextCache, nextIssues, blockedNames);
	}
	collectPromptFilesFromDir(store, join(getAgentDir(), "prompts"), nextCache, nextIssues, blockedNames);

	replaceCache(store.frontmatterPromptCache, nextCache);
	replaceIssues(store.frontmatterPromptIssues, nextIssues);
}
