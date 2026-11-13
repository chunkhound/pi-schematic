/**
 * Frontmatter cache tests.
 *
 * Exercises populateFromSkills, populatePromptCacheFromResolvedCommandsAndDirs,
 * and cache lookups using real temp files with frontmatter — no mocks, same
 * pattern as readonly-bash-classifier.test.ts.
 */

import { beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertPresent } from "../assertions.js";
import { testWithDir, tmpDir, withTempAgentDir, withTempHome } from "./helpers.js";
import {
	cacheLookupCommand,
	cacheLookupCommandExplicitModel,
	cacheLookupCommandExplicitThinking,
	cacheLookupCommandIssue,
	cacheLookupCommandModelGroup,
	cacheLookupPrompt,
	cacheLookupSkill,
	cacheLookupSkillExplicitModel,
	cacheLookupSkillExplicitThinking,
	cacheLookupSkillIssue,
	cacheLookupSkillModelGroup,
	formatFrontmatterIssue,
	populateFromSkills,
	populatePromptCacheFromResolvedCommandsAndDirs,
} from "../../frontmatter-cache.js";
import { createState } from "../../state.js";
import { THINKING_LEVELS } from "../../thinking-levels.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

// pi's agent directory holds global prompts; an empty one keeps an exported
// PI_CODING_AGENT_DIR, or a populated ~/.pi/agent/prompts, out of every test.
let isolatedAgentDir: string;
beforeAll(async () => {
	isolatedAgentDir = await tmpDir();
	return () => rm(isolatedAgentDir, { recursive: true, force: true });
});
beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", isolatedAgentDir);
});

// ── Helpers ───────────────────────────────────────────────────────

async function writeMd(dir: string, name: string, frontmatter: Record<string, unknown>): Promise<string> {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\n${fm}\n---\n\nBody content.\n`);
	return filePath;
}

function makeSkill(name: string, filePath: string): Skill {
	return {
		name,
		description: `Test skill ${name}`,
		filePath,
		baseDir: "",
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: false,
	};
}

// ── Tests ─────────────────────────────────────────────────────────

test("cache lookups return null for unknown names", () => {
	const state = createState();
	expect(cacheLookupSkill(state, "nonexistent-skill")).toBeNull();
	expect(cacheLookupCommand(state, "nonexistent-command")).toBeNull();
});

const skillReadonlyCases = [
	{ title: "populateFromSkills caches a skill with readonly: true", name: "my-skill", fm: { readonly: true, description: "Test" }, expected: true },
	{ title: "populateFromSkills caches a skill with readonly: false", name: "safe-skill", fm: { readonly: false, description: "Test" }, expected: false },
	{ title: "populateFromSkills returns null for skill without readonly frontmatter", name: "no-readonly", fm: { description: "Test" }, expected: null },
];

for (const { title, name, fm, expected } of skillReadonlyCases) {
	testWithDir(title, async ({ dir }) => {
		const state = createState();
		const filePath = await writeMd(dir, name, fm);
		populateFromSkills(state, [makeSkill(name, filePath)]);

		expect(cacheLookupSkill(state, name)).toBe(expected);
		expect(cacheLookupCommand(state, name)).toBeNull();
	});
}

test("populateFromSkills silently skips missing file", () => {
	const state = createState();
	populateFromSkills(state, [makeSkill("missing", "/nonexistent/path/skill.md")]);
	expect(cacheLookupSkill(state, "missing")).toBeNull();
	expect(cacheLookupCommand(state, "missing")).toBeNull();
});

testWithDir("populateFromSkills caches multiple skills", async ({ dir }) => {
	const state = createState();
	const fp1 = await writeMd(dir, "alpha", { readonly: true, description: "A" });
	const fp2 = await writeMd(dir, "beta", { readonly: false, description: "B" });
	const fp3 = await writeMd(dir, "gamma", { description: "C" });
	populateFromSkills(state, [
		makeSkill("alpha", fp1),
		makeSkill("beta", fp2),
		makeSkill("gamma", fp3),
	]);

	expect(cacheLookupSkill(state, "alpha")).toBe(true);
	expect(cacheLookupSkill(state, "beta")).toBe(false);
	expect(cacheLookupSkill(state, "gamma")).toBeNull();
});

testWithDir("populateFromSkills returns null for non-boolean readonly frontmatter", async ({ dir }) => {
	const state = createState();
	const fp1 = await writeMd(dir, "string-ro", { readonly: "yes" });
	const fp2 = await writeMd(dir, "number-ro", { readonly: 1 });
	const fp3 = await writeMd(dir, "array-ro", { readonly: [true] });
	populateFromSkills(state, [
		makeSkill("string-ro", fp1),
		makeSkill("number-ro", fp2),
		makeSkill("array-ro", fp3),
	]);

	expect(cacheLookupSkill(state, "string-ro")).toBeNull();
	expect(cacheLookupSkillIssue(state, "string-ro")?.kind).toBe("invalid-readonly-value");
	expect(cacheLookupSkill(state, "number-ro")).toBeNull();
	expect(cacheLookupSkillIssue(state, "number-ro")?.kind).toBe("invalid-readonly-value");
	expect(cacheLookupSkill(state, "array-ro")).toBeNull();
	expect(cacheLookupSkillIssue(state, "array-ro")?.kind).toBe("invalid-readonly-value");
});

testWithDir("cacheLookupCommand falls back to prompts when no skill is loaded", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeMd(projectDir, "prompt-only", { readonly: true });

	populateFromSkills(state, []);
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

	expect(cacheLookupSkill(state, "prompt-only")).toBeNull();
	expect(cacheLookupCommand(state, "prompt-only")).toBe(true);
});

testWithDir("/name prompt lookup stays distinct from /skill:name lookup for the same name", async ({ dir }) => {
	const state = createState();
	const skillPath = await writeMd(dir, "shared-name", { readonly: false });
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeMd(projectDir, "shared-name", { readonly: true });

	populateFromSkills(state, [makeSkill("shared-name", skillPath)]);
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

	expect(cacheLookupSkill(state, "shared-name")).toBe(false);
	expect(cacheLookupPrompt(state, "shared-name")).toBe(true);
	expect(cacheLookupCommand(state, "shared-name")).toBe(true);
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs caches prompt commands", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "command-prompt", { readonly: false });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "command-prompt",
		source: "prompt",
		description: "Command prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
	}], dir, false);

	expect(cacheLookupCommand(state, "command-prompt")).toBe(false);
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs caches resolved prompt template file paths", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "resolved-prompt", { readonly: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "resolved-prompt",
		source: "prompt",
		description: "Resolved prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
	}], dir, false);

	expect(cacheLookupPrompt(state, "resolved-prompt")).toBe(true);
	expect(cacheLookupCommand(state, "resolved-prompt")).toBe(true);
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs caches .md files from project dir", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeMd(projectDir, "proj-prompt", { readonly: false });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

	expect(cacheLookupCommand(state, "proj-prompt")).toBe(false);
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs skips non-.md files", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, "readme.txt"), "not markdown");
	await writeMd(projectDir, "real-prompt", { readonly: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);

	expect(cacheLookupCommand(state, "real-prompt")).toBe(true);
	expect(cacheLookupCommand(state, "readme")).toBeNull();
});

test("populatePromptCacheFromResolvedCommandsAndDirs skips nonexistent dir silently", () => {
	const state = createState();
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], "/nonexistent/workspace", true);
	expect(cacheLookupCommand(state, "anything")).toBeNull();
});

testWithDir("project prompt overrides global prompt for the same name", async ({ dir: workspace }) => {
	await withTempHome(async (homeDir) => {
		const state = createState();
		const globalDir = join(homeDir, ".pi", "agent", "prompts");
		const projectDir = join(workspace, ".pi", "prompts");
		await mkdir(globalDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeMd(globalDir, "shared", { readonly: false });
		await writeMd(projectDir, "shared", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], workspace, true);
		expect(cacheLookupCommand(state, "shared")).toBe(true);
	});
});


testWithDir("resolved prompt command stays authoritative over directory fallback", async ({ dir: workspace }) => {
	await withTempHome(async (homeDir) => {
		const state = createState();
		const globalDir = join(homeDir, ".pi", "agent", "prompts");
		const projectDir = join(workspace, ".pi", "prompts");
		await mkdir(globalDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		const resolvedPath = await writeMd(workspace, "shared-resolved", { readonly: false });
		await writeMd(globalDir, "shared-resolved", { readonly: true });
		await writeMd(projectDir, "shared-resolved", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [{
			name: "shared-resolved",
			source: "prompt",
			description: "Resolved command",
			sourceInfo: { path: resolvedPath, source: "test", scope: "temporary", origin: "top-level" },
		}], workspace, true);
		expect(cacheLookupCommand(state, "shared-resolved")).toBe(false);
	});
});

testWithDir("resolved non-prompt command blocks prompt-dir fallback for the same name", async ({ dir: workspace }) => {
	const state = createState();
	const projectDir = join(workspace, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	const promptPath = await writeMd(projectDir, "shared-owned", { readonly: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "shared-owned",
		source: "extension",
		description: "Extension command",
		sourceInfo: { path: promptPath, source: "test", scope: "temporary", origin: "top-level" },
	}], workspace, true);
	expect(cacheLookupCommand(state, "shared-owned")).toBeNull();
	expect(cacheLookupCommandIssue(state, "shared-owned")).toBeNull();
});

testWithDir("resolved prompt command rebinding to a different file refreshes the cache", async ({ dir: workspace }) => {
	const state = createState();
	const pathA = await writeMd(workspace, "shared-a", { readonly: true });
	const pathB = await writeMd(workspace, "shared-b", { readonly: false });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "shared-rebound",
		source: "prompt",
		description: "Resolved command A",
		sourceInfo: { path: pathA, source: "test", scope: "temporary", origin: "top-level" },
	}], workspace, false);
	expect(cacheLookupCommand(state, "shared-rebound")).toBe(true);

	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "shared-rebound",
		source: "prompt",
		description: "Resolved command B",
		sourceInfo: { path: pathB, source: "test", scope: "temporary", origin: "top-level" },
	}], workspace, false);
	expect(cacheLookupCommand(state, "shared-rebound")).toBe(false);
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs does not scan project dir when projectTrusted is false", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeMd(projectDir, "proj-only", { readonly: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, false);

	expect(cacheLookupCommand(state, "proj-only")).toBeNull();
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs evicts deleted prompt entries on rebuild", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	const filePath = await writeMd(projectDir, "deleted-prompt", { readonly: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
	expect(cacheLookupCommand(state, "deleted-prompt")).toBe(true);

	await rm(filePath, { force: true });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
	expect(cacheLookupCommand(state, "deleted-prompt")).toBeNull();
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs records invalid readonly value issues", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeMd(projectDir, "broken-prompt", { readonly: "yes" });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
	expect(cacheLookupCommand(state, "broken-prompt")).toBeNull();
	expect(cacheLookupCommandIssue(state, "broken-prompt")?.kind).toBe("invalid-readonly-value");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs records unreadable prompt issues", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await mkdir(join(projectDir, "dir-prompt.md"), { recursive: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
	expect(cacheLookupCommand(state, "dir-prompt")).toBeNull();
	expect(cacheLookupCommandIssue(state, "dir-prompt")?.kind).toBe("unreadable-file");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs evicts untrusted project prompt entries on rebuild", async ({ dir }) => {
	const state = createState();
	const projectDir = join(dir, ".pi", "prompts");
	await mkdir(projectDir, { recursive: true });
	await writeMd(projectDir, "trusted-only", { readonly: true });

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, true);
	expect(cacheLookupCommand(state, "trusted-only")).toBe(true);

	populatePromptCacheFromResolvedCommandsAndDirs(state, [], dir, false);
	expect(cacheLookupCommand(state, "trusted-only")).toBeNull();
});

testWithDir("project/global precedence rebinding refreshes the cache for the same prompt name", async ({ dir: workspace }) => {
	await withTempHome(async (homeDir) => {
		const state = createState();
		const globalDir = join(homeDir, ".pi", "agent", "prompts");
		const projectDir = join(workspace, ".pi", "prompts");
		await mkdir(globalDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeMd(globalDir, "shared-priority", { readonly: false });
		await writeMd(projectDir, "shared-priority", { readonly: true });

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], workspace, true);
		expect(cacheLookupCommand(state, "shared-priority")).toBe(true);

		populatePromptCacheFromResolvedCommandsAndDirs(state, [], workspace, false);
		expect(cacheLookupCommand(state, "shared-priority")).toBe(false);
	});
});

test("global prompts are read from PI_CODING_AGENT_DIR when it is set", async () => {
	await withTempHome(async () => {
		await withTempAgentDir(async (agentDir) => {
			const state = createState();
			const promptsDir = join(agentDir, "prompts");
			await mkdir(promptsDir, { recursive: true });
			await writeMd(promptsDir, "relocated-prompt", { readonly: true });

			populatePromptCacheFromResolvedCommandsAndDirs(state, [], "/nonexistent/workspace", false);

			expect(cacheLookupCommand(state, "relocated-prompt")).toBe(true);
		});
	});
});

test("global prompts under the home agent dir are ignored when PI_CODING_AGENT_DIR is set", async () => {
	await withTempHome(async (homeDir) => {
		await withTempAgentDir(async () => {
			const state = createState();
			const homePromptsDir = join(homeDir, ".pi", "agent", "prompts");
			await mkdir(homePromptsDir, { recursive: true });
			await writeMd(homePromptsDir, "home-prompt", { readonly: true });

			populatePromptCacheFromResolvedCommandsAndDirs(state, [], "/nonexistent/workspace", false);

			expect(cacheLookupCommand(state, "home-prompt")).toBeNull();
		});
	});
});

test("global prompt scan follows a PI_CODING_AGENT_DIR change between rebuilds", async () => {
	const firstAgentDir = await tmpDir();
	onTestFinished(() => rm(firstAgentDir, { recursive: true, force: true }));
	const secondAgentDir = await tmpDir();
	onTestFinished(() => rm(secondAgentDir, { recursive: true, force: true }));
	await mkdir(join(firstAgentDir, "prompts"));
	await writeMd(join(firstAgentDir, "prompts"), "first-dir-prompt", { readonly: true });
	await mkdir(join(secondAgentDir, "prompts"));
	await writeMd(join(secondAgentDir, "prompts"), "second-dir-prompt", { readonly: true });
	const state = createState();
	vi.stubEnv("PI_CODING_AGENT_DIR", firstAgentDir);
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], "/nonexistent/workspace", false);

	vi.stubEnv("PI_CODING_AGENT_DIR", secondAgentDir);
	populatePromptCacheFromResolvedCommandsAndDirs(state, [], "/nonexistent/workspace", false);

	expect(cacheLookupCommand(state, "first-dir-prompt")).toBeNull();
	expect(cacheLookupCommand(state, "second-dir-prompt")).toBe(true);
});

testWithDir("populateFromSkills reuses the cached entry while mtime is unchanged", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "stable-skill", { readonly: true });
	populateFromSkills(state, [makeSkill("stable-skill", filePath)]);
	const firstEntry = state.frontmatterSkillCache.get("stable-skill");
	expect(firstEntry?.readonly).toBe(true);

	populateFromSkills(state, [makeSkill("stable-skill", filePath)]);
	const secondEntry = state.frontmatterSkillCache.get("stable-skill");
	expect(secondEntry).toBe(firstEntry);
});

testWithDir("cache rebuild preserves unchanged frontmatter issues", async ({ dir }) => {
	const state = createState();
	const skillPath = await writeMd(dir, "broken-skill", { readonly: "yes" });
	const promptPath = await writeMd(dir, "broken-prompt", { thinking: "turbo" });
	const commands = [{
		name: "broken-prompt",
		source: "prompt" as const,
		description: "Broken prompt",
		sourceInfo: { path: promptPath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}];

	populateFromSkills(state, [makeSkill("broken-skill", skillPath)]);
	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	populateFromSkills(state, [makeSkill("broken-skill", skillPath)]);
	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);

	expect(cacheLookupSkillIssue(state, "broken-skill")?.kind).toBe("invalid-readonly-value");
	expect(cacheLookupCommandIssue(state, "broken-prompt")?.kind).toBe("invalid-thinking-value");
});

testWithDir("populateFromSkills records malformed frontmatter issues", async ({ dir }) => {
	const state = createState();
	const filePath = join(dir, "broken-skill.md");
	await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
	populateFromSkills(state, [makeSkill("broken-skill", filePath)]);

	expect(cacheLookupSkill(state, "broken-skill")).toBeNull();
	expect(cacheLookupSkillIssue(state, "broken-skill")?.kind).toBe("malformed-frontmatter");
});

testWithDir("populateFromSkills refreshes changed frontmatter when mtime changes", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "mutable-skill", { readonly: true });
	populateFromSkills(state, [makeSkill("mutable-skill", filePath)]);
	expect(cacheLookupSkill(state, "mutable-skill")).toBe(true);

	await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("mutable-skill", filePath)]);
	expect(cacheLookupSkill(state, "mutable-skill")).toBe(false);
	expect(cacheLookupCommand(state, "mutable-skill")).toBeNull();
});

testWithDir("populateFromSkills clears an invalid issue after the skill is fixed", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "recover-skill", { readonly: "yes" });
	populateFromSkills(state, [makeSkill("recover-skill", filePath)]);
	expect(cacheLookupSkillIssue(state, "recover-skill")?.kind).toBe("invalid-readonly-value");

	await writeFile(filePath, `---\nreadonly: true\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("recover-skill", filePath)]);
	expect(cacheLookupSkill(state, "recover-skill")).toBe(true);
	expect(cacheLookupSkillIssue(state, "recover-skill")).toBeNull();
});

testWithDir("populateFromSkills clears an unreadable issue after the skill becomes readable", async ({ dir }) => {
	const state = createState();
	const filePath = join(dir, "recover-readable-skill.md");
	await mkdir(filePath, { recursive: true });
	populateFromSkills(state, [makeSkill("recover-readable-skill", filePath)]);
	expect(cacheLookupSkillIssue(state, "recover-readable-skill")?.kind).toBe("unreadable-file");

	await rm(filePath, { recursive: true, force: true });
	await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("recover-readable-skill", filePath)]);
	expect(cacheLookupSkill(state, "recover-readable-skill")).toBe(false);
	expect(cacheLookupSkillIssue(state, "recover-readable-skill")).toBeNull();
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs refreshes a prompt when the same path changes", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "mutable-prompt", { readonly: true });
	const commands = [{
		name: "mutable-prompt",
		source: "prompt" as const,
		description: "Mutable prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}];

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommand(state, "mutable-prompt")).toBe(true);

	await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommand(state, "mutable-prompt")).toBe(false);
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs clears an invalid issue after the prompt is fixed", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "recover-prompt", { readonly: "yes" });
	const commands = [{
		name: "recover-prompt",
		source: "prompt" as const,
		description: "Recover prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}];

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommandIssue(state, "recover-prompt")?.kind).toBe("invalid-readonly-value");

	await writeFile(filePath, `---\nreadonly: true\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommand(state, "recover-prompt")).toBe(true);
	expect(cacheLookupCommandIssue(state, "recover-prompt")).toBeNull();
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs records malformed frontmatter issues", async ({ dir }) => {
	const state = createState();
	const filePath = join(dir, "broken-yaml.md");
	await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
	const commands = [{
		name: "broken-yaml",
		source: "prompt" as const,
		description: "Broken yaml prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}];

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommand(state, "broken-yaml")).toBeNull();
	expect(cacheLookupCommandIssue(state, "broken-yaml")?.kind).toBe("malformed-frontmatter");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs clears an unreadable issue after the prompt becomes readable", async ({ dir }) => {
	const state = createState();
	const filePath = join(dir, "recover-readable.md");
	await mkdir(filePath, { recursive: true });
	const commands = [{
		name: "recover-readable",
		source: "prompt" as const,
		description: "Recover readable prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}];

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommandIssue(state, "recover-readable")?.kind).toBe("unreadable-file");

	await rm(filePath, { recursive: true, force: true });
	await writeFile(filePath, `---\nreadonly: false\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populatePromptCacheFromResolvedCommandsAndDirs(state, commands, dir, false);
	expect(cacheLookupCommand(state, "recover-readable")).toBe(false);
	expect(cacheLookupCommandIssue(state, "recover-readable")).toBeNull();
});

// ── Model-group / model / thinking frontmatter cache tests ────────

testWithDir("populateFromSkills caches model-group frontmatter", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "grouped", { "model-group": "reviewer" });
	populateFromSkills(state, [makeSkill("grouped", filePath)]);

	expect(cacheLookupSkillModelGroup(state, "grouped")).toBe("reviewer");
	expect(cacheLookupSkillExplicitModel(state, "grouped")).toBeNull();
	expect(cacheLookupSkillExplicitThinking(state, "grouped")).toBeNull();
});

testWithDir("populateFromSkills caches explicit model frontmatter", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "explicit", { model: "openai/gpt-4o" });
	populateFromSkills(state, [makeSkill("explicit", filePath)]);

	expect(cacheLookupSkillExplicitModel(state, "explicit")).toBe("openai/gpt-4o");
	expect(cacheLookupSkillModelGroup(state, "explicit")).toBeNull();
});

testWithDir("populateFromSkills caches thinking frontmatter", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "thinker", { thinking: "high" });
	populateFromSkills(state, [makeSkill("thinker", filePath)]);

	expect(cacheLookupSkillExplicitThinking(state, "thinker")).toBe("high");
	expect(cacheLookupSkillExplicitModel(state, "thinker")).toBeNull();
	expect(cacheLookupSkillModelGroup(state, "thinker")).toBeNull();
});

testWithDir("populateFromSkills returns null for all new fields when frontmatter is absent", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "bare", { description: "Test" });
	populateFromSkills(state, [makeSkill("bare", filePath)]);

	expect(cacheLookupSkillModelGroup(state, "bare")).toBeNull();
	expect(cacheLookupSkillExplicitModel(state, "bare")).toBeNull();
	expect(cacheLookupSkillExplicitThinking(state, "bare")).toBeNull();
});

testWithDir("populateFromSkills preserves readonly alongside new fields", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "all-fields", {
		readonly: true,
		"model-group": "fast",
		model: "anthropic/claude-sonnet",
		thinking: "low",
	});
	populateFromSkills(state, [makeSkill("all-fields", filePath)]);

	expect(cacheLookupSkill(state, "all-fields")).toBe(true);
	expect(cacheLookupSkillModelGroup(state, "all-fields")).toBe("fast");
	expect(cacheLookupSkillExplicitModel(state, "all-fields")).toBe("anthropic/claude-sonnet");
	expect(cacheLookupSkillExplicitThinking(state, "all-fields")).toBe("low");
});

testWithDir("populateFromSkills returns null and records issue for invalid model-group value", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "bad-group", { "model-group": "" });
	populateFromSkills(state, [makeSkill("bad-group", filePath)]);

	expect(cacheLookupSkillModelGroup(state, "bad-group")).toBeNull();
	expect(cacheLookupSkillIssue(state, "bad-group")?.kind).toBe("invalid-model-group-value");
});

testWithDir("populateFromSkills returns null and records issue for invalid explicit model format", async ({ dir }) => {
	const state = createState();
	const cases = [
		{ model: "no-slash", desc: "missing slash" },
		{ model: "/missing-provider", desc: "empty provider" },
		{ model: "missing-id/", desc: "empty model-id" },
	];
	for (const { model, desc } of cases) {
		const name = `bad-model-${desc.replace(/[^a-z]/g, "")}`;
		const filePath = await writeMd(dir, name, { model });
		populateFromSkills(state, [makeSkill(name, filePath)]);

		expect(cacheLookupSkillExplicitModel(state, name), `${desc}: model should be null`).toBeNull();
		expect(cacheLookupSkillIssue(state, name)?.kind, `${desc}: issue kind`).toBe("invalid-explicit-model-value");
	}
});

testWithDir("populateFromSkills returns null and records issue for invalid thinking value", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "bad-thinking", { thinking: "ultra" });
	populateFromSkills(state, [makeSkill("bad-thinking", filePath)]);

	expect(cacheLookupSkillExplicitThinking(state, "bad-thinking")).toBeNull();
	expect(cacheLookupSkillIssue(state, "bad-thinking")?.kind).toBe("invalid-thinking-value");
});

testWithDir("populateFromSkills accepts all valid thinking levels", async ({ dir }) => {
	const state = createState();
	for (const level of THINKING_LEVELS) {
		const name = `think-${level}`;
		const filePath = await writeMd(dir, name, { thinking: level });
		populateFromSkills(state, [makeSkill(name, filePath)]);

		expect(cacheLookupSkillExplicitThinking(state, name), `thinking level ${level} should be cached`).toBe(level);
		expect(cacheLookupSkillIssue(state, name), `thinking level ${level} should have no issue`).toBeNull();
	}
});

test("invalid thinking frontmatter warning lists every thinking level", () => {
	const message = formatFrontmatterIssue("/plan", { kind: "invalid-thinking-value", filePath: "/prompts/plan.md" });

	expect(message).toBe("Frontmatter ignored for `/plan`: `thinking` frontmatter must be one of: off, minimal, low, medium, high, xhigh, max at `/prompts/plan.md`.");
});

testWithDir("populateFromSkills normalizes thinking level case", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "case-think", { thinking: "HIGH" });
	populateFromSkills(state, [makeSkill("case-think", filePath)]);

	expect(cacheLookupSkillExplicitThinking(state, "case-think")).toBe("high");
});

testWithDir("populateFromSkills trims whitespace from model-group and model", async ({ dir }) => {
	const state = createState();
	const fp1 = await writeMd(dir, "trim-group", { "model-group": "  reviewer  " });
	const fp2 = await writeMd(dir, "trim-model", { model: "  openai/gpt-4o  " });
	populateFromSkills(state, [makeSkill("trim-group", fp1), makeSkill("trim-model", fp2)]);

	expect(cacheLookupSkillModelGroup(state, "trim-group")).toBe("reviewer");
	expect(cacheLookupSkillExplicitModel(state, "trim-model")).toBe("openai/gpt-4o");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs caches model-group for prompt commands", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "cmd-group", { "model-group": "fast" });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "cmd-group",
		source: "prompt",
		description: "Test",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}], dir, false);

	expect(cacheLookupCommandModelGroup(state, "cmd-group")).toBe("fast");
	expect(cacheLookupCommandExplicitModel(state, "cmd-group")).toBeNull();
	expect(cacheLookupCommandExplicitThinking(state, "cmd-group")).toBeNull();
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs caches explicit model for prompt commands", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "cmd-model", { model: "anthropic/claude-sonnet" });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "cmd-model",
		source: "prompt",
		description: "Test",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}], dir, false);

	expect(cacheLookupCommandExplicitModel(state, "cmd-model")).toBe("anthropic/claude-sonnet");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs caches thinking for prompt commands", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "cmd-think", { thinking: "xhigh" });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "cmd-think",
		source: "prompt",
		description: "Test",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}], dir, false);

	expect(cacheLookupCommandExplicitThinking(state, "cmd-think")).toBe("xhigh");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs records invalid model-group issue for prompts", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "bad-cmd-group", { "model-group": "" });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "bad-cmd-group",
		source: "prompt",
		description: "Test",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}], dir, false);

	expect(cacheLookupCommandModelGroup(state, "bad-cmd-group")).toBeNull();
	expect(cacheLookupCommandIssue(state, "bad-cmd-group")?.kind).toBe("invalid-model-group-value");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs records invalid explicit model issue for prompts", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "bad-cmd-model", { model: "no-slash" });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "bad-cmd-model",
		source: "prompt",
		description: "Test",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}], dir, false);

	expect(cacheLookupCommandExplicitModel(state, "bad-cmd-model")).toBeNull();
	expect(cacheLookupCommandIssue(state, "bad-cmd-model")?.kind).toBe("invalid-explicit-model-value");
});

testWithDir("populatePromptCacheFromResolvedCommandsAndDirs records invalid thinking issue for prompts", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "bad-cmd-think", { thinking: "turbo" });
	populatePromptCacheFromResolvedCommandsAndDirs(state, [{
		name: "bad-cmd-think",
		source: "prompt",
		description: "Test",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	}], dir, false);

	expect(cacheLookupCommandExplicitThinking(state, "bad-cmd-think")).toBeNull();
	expect(cacheLookupCommandIssue(state, "bad-cmd-think")?.kind).toBe("invalid-thinking-value");
});

testWithDir("cache refresh updates model-group when mtime changes", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "mutable-group", { "model-group": "reviewer" });
	populateFromSkills(state, [makeSkill("mutable-group", filePath)]);
	expect(cacheLookupSkillModelGroup(state, "mutable-group")).toBe("reviewer");

	await writeFile(filePath, `---\nmodel-group: "fast"\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("mutable-group", filePath)]);
	expect(cacheLookupSkillModelGroup(state, "mutable-group")).toBe("fast");
});

testWithDir("cache refresh updates explicit model when mtime changes", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "mutable-model", { model: "openai/gpt-4o" });
	populateFromSkills(state, [makeSkill("mutable-model", filePath)]);
	expect(cacheLookupSkillExplicitModel(state, "mutable-model")).toBe("openai/gpt-4o");

	await writeFile(filePath, `---\nmodel: "anthropic/claude-sonnet"\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("mutable-model", filePath)]);
	expect(cacheLookupSkillExplicitModel(state, "mutable-model")).toBe("anthropic/claude-sonnet");
});

testWithDir("populateFromSkills caches all frontmatter fields together", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "all-fields", {
		readonly: true,
		"model-group": "reviewer",
		model: "openai/gpt-4o",
		thinking: "high",
	});
	populateFromSkills(state, [makeSkill("all-fields", filePath)]);

	expect(cacheLookupSkill(state, "all-fields")).toBe(true);
	expect(cacheLookupSkillModelGroup(state, "all-fields")).toBe("reviewer");
	expect(cacheLookupSkillExplicitModel(state, "all-fields")).toBe("openai/gpt-4o");
	expect(cacheLookupSkillExplicitThinking(state, "all-fields")).toBe("high");
	expect(cacheLookupSkillIssue(state, "all-fields")).toBeNull();
});

testWithDir("populateFromSkills accepts slashes inside model IDs", async ({ dir }) => {
	const state = createState();
	const models = ["openrouter/anthropic/claude-sonnet", "provider/a/b/c"];
	const skills = await Promise.all(models.map(async (model, index) => {
		const name = `nested-model-${index}`;
		return makeSkill(name, await writeMd(dir, name, { model }));
	}));
	populateFromSkills(state, skills);
	models.forEach((model, index) => {
		expect(cacheLookupSkillExplicitModel(state, `nested-model-${index}`)).toBe(model);
		expect(cacheLookupSkillIssue(state, `nested-model-${index}`)).toBeNull();
	});
});

testWithDir("populateFromSkills handles very long model name without crashing", async ({ dir }) => {
	const state = createState();
	const longModel = "provider/" + "a".repeat(1000);
	const filePath = await writeMd(dir, "long-model", { model: longModel });
	populateFromSkills(state, [makeSkill("long-model", filePath)]);

	expect(cacheLookupSkillExplicitModel(state, "long-model")).toBe(longModel);
	expect(cacheLookupSkillIssue(state, "long-model")).toBeNull();
});

testWithDir("populateFromSkills handles model name with special characters", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "special-model", { model: "my-provider/model-v2.5_beta" });
	populateFromSkills(state, [makeSkill("special-model", filePath)]);

	expect(cacheLookupSkillExplicitModel(state, "special-model")).toBe("my-provider/model-v2.5_beta");
	expect(cacheLookupSkillIssue(state, "special-model")).toBeNull();
});

testWithDir("populateFromSkills treats whitespace-only model-group as empty/invalid", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "ws-group", { "model-group": "   " });
	populateFromSkills(state, [makeSkill("ws-group", filePath)]);

	expect(cacheLookupSkillModelGroup(state, "ws-group")).toBeNull();
	expect(cacheLookupSkillIssue(state, "ws-group")?.kind).toBe("invalid-model-group-value");
});

testWithDir("cache refresh updates thinking when mtime changes", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "mutable-think", { thinking: "high" });
	populateFromSkills(state, [makeSkill("mutable-think", filePath)]);
	expect(cacheLookupSkillExplicitThinking(state, "mutable-think")).toBe("high");

	await writeFile(filePath, `---\nthinking: "low"\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("mutable-think", filePath)]);
	expect(cacheLookupSkillExplicitThinking(state, "mutable-think")).toBe("low");
});

testWithDir("cache clears invalid model issue after file is fixed", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "recover-model", { model: "no-slash" });
	populateFromSkills(state, [makeSkill("recover-model", filePath)]);
	expect(cacheLookupSkillIssue(state, "recover-model")?.kind).toBe("invalid-explicit-model-value");

	await writeFile(filePath, `---\nmodel: "openai/gpt-4o"\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("recover-model", filePath)]);
	expect(cacheLookupSkillExplicitModel(state, "recover-model")).toBe("openai/gpt-4o");
	expect(cacheLookupSkillIssue(state, "recover-model")).toBeNull();
});

testWithDir("cache clears invalid thinking issue after file is fixed", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "recover-think", { thinking: "ultra" });
	populateFromSkills(state, [makeSkill("recover-think", filePath)]);
	expect(cacheLookupSkillIssue(state, "recover-think")?.kind).toBe("invalid-thinking-value");

	await writeFile(filePath, `---\nthinking: "high"\n---\n\nBody content.\n`);
	const future = new Date(Date.now() + 2_000);
	await utimes(filePath, future, future);

	populateFromSkills(state, [makeSkill("recover-think", filePath)]);
	expect(cacheLookupSkillExplicitThinking(state, "recover-think")).toBe("high");
	expect(cacheLookupSkillIssue(state, "recover-think")).toBeNull();
});

testWithDir("validation reports the first issue when every field is invalid", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "multi-invalid", {
		readonly: "yes",      // invalid: not boolean
		"model-group": "",    // invalid: empty string
		model: "no-slash",    // invalid: no slash
		thinking: "ultra",    // invalid: not a valid level
	});
	populateFromSkills(state, [makeSkill("multi-invalid", filePath)]);

	const issue = cacheLookupSkillIssue(state, "multi-invalid");
	assertPresent(issue, "should have an issue");
	expect(issue.kind, "should report the first issue").toBe("invalid-readonly-value");
	expect(cacheLookupSkillModelGroup(state, "multi-invalid")).toBeNull();
	expect(cacheLookupSkillExplicitModel(state, "multi-invalid")).toBeNull();
	expect(cacheLookupSkillExplicitThinking(state, "multi-invalid")).toBeNull();
});

testWithDir("invalid model-group does not suppress valid model and thinking", async ({ dir }) => {
	const state = createState();
	const filePath = await writeMd(dir, "second-invalid", {
		readonly: true,
		"model-group": "",    // invalid: empty string
		model: "openai/gpt-4",
		thinking: "high",
	});
	populateFromSkills(state, [makeSkill("second-invalid", filePath)]);

	const issue = cacheLookupSkillIssue(state, "second-invalid");
	assertPresent(issue, "should have an issue");
	expect(issue.kind).toBe("invalid-model-group-value");
	expect(cacheLookupSkill(state, "second-invalid")).toBe(true);
	expect(cacheLookupSkillExplicitModel(state, "second-invalid")).toBe("openai/gpt-4");
	expect(cacheLookupSkillExplicitThinking(state, "second-invalid")).toBe("high");
});
