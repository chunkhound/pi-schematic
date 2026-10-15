/**
 * Workflow-run frontmatter bridge tests.
 *
 * `workflow.run` dispatches extension-sourced turns, so the `input` hook cannot
 * resolve frontmatter for them. The workflow host calls `prepareWorkflowRunFrontmatter`
 * before dispatch instead. These tests pin the bridge's external contract:
 * model routing is applied, readonly is queued for `before_agent_start`, plain
 * prompts stay a no-op, and blocked model routing fails loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelGroupsPath } from "../../model-groups/store.js";
import { prepareWorkflowRunFrontmatter } from "../../index.js";
import { releaseWorkflow, reserveWorkflow } from "../../workflow/coordinator.js";
import { createState } from "../../state.js";
import { createBeforeAgentStartEvent, createTestHost } from "./test-host.js";
import { makeReadonlyUICtx, tmpDir } from "./helpers.js";
import { withTemp } from "./model-groups-helpers.js";

function mockModel(provider: string, id: string): any {
	return { provider, id, reasoning: true };
}

function mockRegistry(
	models: any[] = [mockModel("openai", "gpt-4o")],
	authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`)),
): any {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: any) => authenticated.has(`${m.provider}:${m.id}`),
	};
}

async function writeSkillMd(dir: string, name: string, frontmatter: Record<string, unknown>): Promise<string> {
	const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\n${fm}\n---\n\nBody content.\n`);
	return filePath;
}

function makeSkillCommand(name: string, filePath: string) {
	return {
		name: `skill:${name}`,
		source: "skill",
		description: "Test skill",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	};
}

// Skill metadata shape pi passes in `systemPromptOptions.skills`; the deferred
// readonly resolution reads this list, not the registered commands.
function makeSkill(name: string, filePath: string) {
	return {
		name,
		description: "Test skill",
		filePath,
		baseDir: "",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
		disableModelInvocation: false,
	};
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		...makeReadonlyUICtx({
			ui: {
				notify: () => {},
				theme: { fg: (_name: string, text: string) => text },
				setStatus: () => {},
				setWidget: () => {},
				addAutocompleteProvider: () => {},
			},
		}),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		...overrides,
	};
}

async function trackedPI(behavior: "success" | "false" = "success") {
	const pi = await createTestHost();
	const modelCalls: any[] = [];
	const thinkingCalls: string[] = [];
	pi.setModel = async (model: any) => {
		modelCalls.push(model);
		return behavior !== "false";
	};
	pi.setThinkingLevel = (level: any) => {
		thinkingCalls.push(level);
	};
	pi.getThinkingLevel = () => "medium";
	return { pi, modelCalls, thinkingCalls };
}

function writeModelGroupsConfig(dir: string, groups: Record<string, { models: Array<{ provider: string; modelId: string }> }>): void {
	const configDir = path.dirname(modelGroupsPath("project", dir));
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", dir), JSON.stringify({ version: 1, groups }), "utf8");
}

test("workflow.run frontmatter routes an explicit model and queues readonly", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", readonly: true });
		const { pi, modelCalls } = await trackedPI();
		const state = createState();
		pi.setCommands([makeSkillCommand("review", filePath)]);

		await prepareWorkflowRunFrontmatter(
			state,
			makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() }) as any,
			pi,
			"/skill:review",
		);

		assert.equal(modelCalls.length, 1, "model frontmatter routes the workflow turn");
		assert.equal(modelCalls[0].id, "gpt-4o");
		assert.deepEqual(
			state.pendingReadonlyCommands,
			[{ type: "skill", name: "review" }],
			"readonly is queued for before_agent_start, which owns the final skill metadata",
		);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("workflow.run frontmatter routes a Model Group to its concrete model", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
		const { pi, modelCalls } = await trackedPI();
		const state = createState();
		pi.setCommands([makeSkillCommand("review", filePath)]);

		await prepareWorkflowRunFrontmatter(
			state,
			makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() }) as any,
			pi,
			"/skill:review",
		);

		assert.equal(modelCalls.length, 1, "model-group frontmatter routes the workflow turn");
		assert.equal(modelCalls[0].id, "gpt-4o");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("workflow.run frontmatter applies a thinking-only selection", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { thinking: "high" });
		const { pi, modelCalls, thinkingCalls } = await trackedPI();
		const state = createState();
		pi.setCommands([makeSkillCommand("review", filePath)]);

		await prepareWorkflowRunFrontmatter(
			state,
			makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() }) as any,
			pi,
			"/skill:review",
		);

		assert.equal(modelCalls.length, 0, "no model switch for a thinking-only selection");
		assert.deepEqual(thinkingCalls, ["high"]);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

/**
 * Idle-input invariant: the interactive `/skill:`/`/` path still preflights the
 * frontmatter model and defers the readonly decision without any workflow
 * involvement. Pins the index.ts refactor boundary the workflow bridge must not move.
 */
test("interactive skill input preflights the model and defers readonly with no workflow", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", readonly: true });
		const { pi, modelCalls } = await trackedPI();
		pi.setCommands([makeSkillCommand("review", filePath)]);
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeAgentStart] = pi.handlers.get("before_agent_start")!;
		const ctx = makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() });

		const result = await inputHandler({ text: "/skill:review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "continue" }, "a routable turn keeps flowing to the agent");
		assert.equal(modelCalls.length, 1, "idle input preflights the frontmatter model");
		assert.equal(modelCalls[0].id, "gpt-4o");
		// The readonly decision stays deferred: before_agent_start owns it, as in the
		// workflow bridge (prepareWorkflowRunFrontmatter queues the same entry).
		ctx.ui.theme = { fg: (_name: string, text: string) => text };
		await beforeAgentStart(createBeforeAgentStartEvent({ skills: [makeSkill("review", filePath)] }), ctx);
		const toggles = pi.appendedEntries.filter((entry: { customType: string }) => entry.customType === "pi-schematic-readonly");
		assert.deepEqual(toggles.map((entry: { data: unknown }) => entry.data), [{ enabled: true }], "the deferred queue resolves at before_agent_start");
		assert.equal(reserveWorkflow(), true, "the idle path never reserves a workflow");
		releaseWorkflow();
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("workflow.run frontmatter ignores a plain prompt", async () => withTemp(async ({ cwd }) => {
	const { pi, modelCalls, thinkingCalls } = await trackedPI();
	const state = createState();

	await prepareWorkflowRunFrontmatter(
		state,
		makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() }) as any,
		pi,
		"continue the work",
	);

	assert.equal(modelCalls.length, 0);
	assert.equal(thinkingCalls.length, 0);
	assert.equal(state.pendingReadonlyCommands.length, 0);
}));

test("workflow.run frontmatter fails loudly when model routing is blocked", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/unknown" });
		const { pi, modelCalls } = await trackedPI();
		const state = createState();
		pi.setCommands([makeSkillCommand("review", filePath)]);

		await assert.rejects(
			() => prepareWorkflowRunFrontmatter(
				state,
				makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() }) as any,
				pi,
				"/skill:review",
			),
			/frontmatter model selection failed/,
		);
		assert.equal(modelCalls.length, 0, "a blocked route never switches the model");
		assert.equal(state.pendingReadonlyCommands.length, 0, "a blocked route does not leak a readonly decision");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));
// Run-model contract, bridge half (docs/workflows.md, Model): frontmatter resolves BEFORE
// the run's explicit overrides — the bridge applies the model/thinking switch itself, and
// the host's run path calls prepareRunFrontmatter before applyOverrides (workflow/host.ts
// primeRunTurn), so an explicit option wins for the turn and the restore lands on the
// frontmatter model as the post-run session model. The override ordering and restore live
// behind the host's run path; no public seam in this harness observes them, so this suite
// pins the observable half: the frontmatter switch is applied at frontmatter time.
test("workflow.run frontmatter resolves before the run's explicit overrides", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "high" });
		const { pi, modelCalls, thinkingCalls } = await trackedPI();
		const state = createState();
		pi.setCommands([makeSkillCommand("review", filePath)]);

		await prepareWorkflowRunFrontmatter(
			state,
			makeCtx({ cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry() }) as any,
			pi,
			"/skill:review",
		);

		assert.equal(modelCalls.length, 1, "the frontmatter model is applied at frontmatter time, before any override");
		assert.equal(modelCalls[0].id, "gpt-4o");
		assert.deepEqual(thinkingCalls, ["high"], "frontmatter thinking is applied in the same pre-override step");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));
