import { expect, onTestFinished, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type AutocompleteProviderFactory, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { __setModelGroupsFsForTests } from "../../model-groups/store.js";
import { assertPresent } from "../assertions.js";
import { createModelRegistry } from "../support/model-registry.js";
import { createRunner, type RunnerFixture, type RunnerOptions } from "../support/runner.js";
import { realTheme } from "../support/theme.js";
import { createExtensionContext, createModelRegistry as createHandModelRegistry, testModel } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost, getHandler } from "./test-host.js";
import { testProvider, withTemp } from "./model-groups-helpers.js";

// Escape on the Model Groups list closes the component, which resolves ctx.ui.custom.
const ESCAPE = "\u001b";

interface Dirs {
	/** The project directory, the fixture's cwd. */
	cwd: string;
	/** pi's agent directory, which holds the global Model Groups file. */
	agentDir: string;
}

/** A fresh project and agent directory, removed when the test finishes, with the store's filesystem seam reset. */
function tempDirs(): Dirs {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-groups-extension-"));
	onTestFinished(() => {
		__setModelGroupsFsForTests(null);
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { cwd: path.join(root, "project"), agentDir: path.join(root, "agent") };
}

function globalConfigPath({ agentDir }: Dirs): string {
	return path.join(agentDir, "pi-schematic", "model-groups.json");
}

function projectConfigPath({ cwd }: Dirs): string {
	return path.join(cwd, ".pi", "pi-schematic", "model-groups.json");
}

function writeConfig(file: string, content: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

/** The registry most tests share: one authenticated vision and reasoning model. */
function visionRegistry(): Promise<ModelRegistry> {
	return createModelRegistry({
		"mg-openai": testProvider([{ id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } }], { auth: true }),
	});
}

/** A runner over the shipped extension in TUI mode with the recording UI, a trusted project and `dirs` as cwd and agent directory. */
async function extensionRunner(dirs: Dirs, options: Partial<RunnerOptions> = {}): Promise<RunnerFixture> {
	return createRunner({
		cwd: dirs.cwd,
		agentDir: dirs.agentDir,
		mode: "tui",
		sessionManager: SessionManager.inMemory(dirs.cwd),
		modelRegistry: await visionRegistry(),
		context: { isProjectTrusted: () => true, getContextUsage: () => ({ tokens: null, contextWindow: 0, percent: 10 }) },
		ui: { theme: realTheme, addAutocompleteProvider: () => undefined },
		activeTools: [],
		...options,
	});
}

async function sessionStartNotifications(fixture: RunnerFixture): Promise<string[]> {
	await fixture.runner.emit({ type: "session_start", reason: "startup" });
	return fixture.ui.notifications.map(({ message }) => message);
}

/** The Model Groups section the extension wrote on one before_agent_start run. */
async function modelGroupsSection(fixture: RunnerFixture): Promise<string | undefined> {
	const result = await fixture.runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, fixture.systemPromptOptions());
	return result.systemPromptOptions.sections.schematic_model_groups;
}

/** Runs /model-groups and returns the list the component rendered first, as text; Escape closes it. */
async function renderModelGroupsList(
	dirs: Dirs,
	options: Partial<RunnerOptions> = {},
): Promise<{ fixture: RunnerFixture; rendered: () => string; opens: () => number }> {
	let rendered: string | undefined;
	let opens = 0;
	const fixture = await extensionRunner(dirs, {
		...options,
		ui: {
			theme: realTheme,
			addAutocompleteProvider: () => undefined,
			custom: (component) => {
				opens++;
				rendered = stripTerminalSequences(component.render(80).join("\n"));
				component.handleInput?.(ESCAPE);
			},
		},
	});
	return {
		fixture,
		rendered: () => {
			assertPresent(rendered, "the /model-groups component rendered");
			return rendered;
		},
		opens: () => opens,
	};
}

test("/model-groups command registers and opens ctx.ui.custom with live registry/cwd", async () => {
	const dirs = tempDirs();
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { "cwd-sentinel-group": { models: [{ provider: "mg-openai", modelId: "gpt-5" }] } } });
	const { fixture, rendered, opens } = await renderModelGroupsList(dirs);

	await fixture.command("model-groups").handler("", fixture.runner.createCommandContext());

	expect(opens()).toBe(1);
	expect(rendered()).toMatch(/Model Groups/);
	expect(rendered()).toMatch(/cwd-sentinel-group/);
	expect(rendered(), "the member resolves in the command context's registry").toMatch(/Boot validation: 0 unavailable model references · 0 project overrides/);
});

test("index session_start notifies load and validation issues", async () => {
	const dirs = tempDirs();
	writeConfig(globalConfigPath(dirs), { version: 2, groups: { bad: { models: [{ provider: "mg-missing", modelId: "nope" }] }, shadow: { models: [] } } });
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { shadow: { models: [] } } });

	const notifications = await sessionStartNotifications(await extensionRunner(dirs));

	expect(notifications).toContainEqual(expect.stringMatching(/1 unavailable model references · 1 project overrides/));
});

test("index session_start notifies empty-common and stale-override boot counts", async () => {
	const dirs = tempDirs();
	// claude is NOT in the registry, so claude-only is unavailable with empty common modalities; its override is stale.
	// The registry has only gpt-5 (text+image); an empty group also has empty common modalities.
	writeConfig(globalConfigPath(dirs), {
		version: 2,
		groups: {
			empty: { models: [] },
			"claude-only": { models: [{ provider: "mg-anthropic", modelId: "claude" }], constraints: { modalities: ["text", "image"] } },
		},
	});

	const notifications = await sessionStartNotifications(await extensionRunner(dirs));

	expect(notifications, JSON.stringify(notifications, null, 2)).toContainEqual(
		expect.stringMatching(/1 unavailable model references · 0 project overrides · 2 groups with no common modalities · 1 stale modality overrides/),
	);
});

test("index session_start notifies corrupt/schema/unsupported load issues", async () => {
	const dirs = tempDirs();
	writeConfig(globalConfigPath(dirs), "{bad");
	writeConfig(projectConfigPath(dirs), { version: 99, groups: {} });

	const notifications = await sessionStartNotifications(await extensionRunner(dirs));

	expect(notifications).toContainEqual(expect.stringMatching(/corrupt-json/));
	expect(notifications).toContainEqual(expect.stringMatching(/unsupported-version/));
});

test("index session_start notifies schema-invalid load issues", async () => {
	const dirs = tempDirs();
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { broken: { models: [{ provider: 1 }] } } });

	const notifications = await sessionStartNotifications(await extensionRunner(dirs));

	expect(notifications).toContainEqual(expect.stringMatching(/schema-invalid/));
	expect(notifications).toContainEqual(expect.stringMatching(/project scope/));
	expect(notifications).toContainEqual(expect.stringContaining(`${dirs.cwd}/.pi/pi-schematic/model-groups.json`));
});

test("before_agent_start writes fresh names-and-effective-modalities guidance", async () => {
	const dirs = tempDirs();
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { review: { models: [{ provider: "mg-openai", modelId: "gpt-5" }] } } });

	const section = await modelGroupsSection(await extensionRunner(dirs, { ui: undefined }));

	expect(section).toMatch(/## Model Groups for spawn/);
	expect(section).toMatch(/Available Model Groups: review \(text, image, reasoning\)/);
	expect(section).not.toMatch(/gpt-5/);
	expect(section).not.toMatch(/model-groups\.json/);
});

test("before_agent_start exposes union-effective modalities for automatic mixed groups", async () => {
	const dirs = tempDirs();
	writeConfig(projectConfigPath(dirs), {
		version: 2,
		groups: {
			mixed: {
				models: [
					{ provider: "mg-openai", modelId: "gpt-5" },
					{ provider: "mg-google", modelId: "gemini-text" },
				],
			},
		},
	});
	const modelRegistry = await createModelRegistry({
		"mg-openai": testProvider([{ id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } }], { auth: true }),
		"mg-google": testProvider([{ id: "gemini-text", input: ["text"], reasoning: false }], { auth: true }),
	});

	// Automatic mixed group: guidance lists the union — image/reasoning present via the capable member.
	const section = await modelGroupsSection(await extensionRunner(dirs, { ui: undefined, modelRegistry }));

	expect(section).toMatch(/Available Model Groups: mixed \(text, image, reasoning\)/);
});

test("before_agent_start labels empty effective modalities unambiguously", async () => {
	const dirs = tempDirs();
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { foo: { models: [] }, "foo (none)": { models: [] } } });

	const section = await modelGroupsSection(await extensionRunner(dirs, { ui: undefined }));

	expect(section).toMatch(/foo \(no common modalities\)/);
	expect(section).toMatch(/foo \(none\) \(no common modalities\)/);
	expect(section).not.toMatch(/foo \(none\),/);
});

test("before_agent_start rewrites updated effective modalities after registry changes", async () => {
	const dirs = tempDirs();
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { review: { models: [{ provider: "mg-openai", modelId: "gpt-5" }] } } });
	const modelRegistry = await createModelRegistry({
		"mg-openai": testProvider([{ id: "gpt-5", input: ["text", "image"], reasoning: false, thinkingLevelMap: { xhigh: "x" } }], { auth: true }),
	});
	const fixture = await extensionRunner(dirs, { ui: undefined, modelRegistry });
	expect(await modelGroupsSection(fixture)).toMatch(/review \(text, image\)/);

	modelRegistry.registerProvider(
		"mg-openai",
		testProvider([{ id: "gpt-5", input: ["text"], reasoning: true, thinkingLevelMap: { xhigh: "x" } }], { auth: true }),
	);

	const refreshedSection = await modelGroupsSection(fixture);
	expect(refreshedSection).toMatch(/review \(text, reasoning\)/);
	expect(refreshedSection).not.toMatch(/review \(text, image\)/);
});

// The extension's model-group refresh skips loading when the context carries no model registry.
// pi always supplies one, so only a hand-built context reaches that branch.
test("before_agent_start clears stale Model Groups guidance when registry becomes unavailable", async () =>
	withTemp(async ({ cwd }) => {
		fs.mkdirSync(path.dirname(path.join(cwd, ".pi", "pi-schematic", "model-groups.json")), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "pi-schematic", "model-groups.json"),
			JSON.stringify({ version: 2, groups: { review: { models: [{ provider: "mg-openai", modelId: "gpt-5" }] } } }),
			"utf8",
		);
		const models = [testModel({ provider: "mg-openai", id: "gpt-5", input: ["text", "image"], reasoning: true })];
		const registry = createHandModelRegistry({
			getAll: () => models,
			getAvailable: () => models,
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: () => true,
		});
		const pi = await createTestHost();
		const handler = getHandler(pi, "before_agent_start");
		const loaded = createBeforeAgentStartEvent();
		await handler(loaded, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: registry }));
		expect(loaded.systemPromptOptions.sections.schematic_model_groups).toMatch(/Available Model Groups: review/);

		const unavailable = createBeforeAgentStartEvent();
		await handler(unavailable, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: undefined }));
		expect(unavailable.systemPromptOptions.sections.schematic_model_groups).toBeUndefined();
	}));

test("session_start registers Model Groups autocomplete provider when UI supports it", async () => {
	const providers: AutocompleteProviderFactory[] = [];
	const fixture = await extensionRunner(tempDirs(), {
		ui: {
			theme: realTheme,
			addAutocompleteProvider: (factory) => {
				providers.push(factory);
			},
		},
	});

	await fixture.runner.emit({ type: "session_start", reason: "startup" });

	expect(providers).toHaveLength(1);
});

test("index session_start does not notify when load and validation issues are absent", async () => {
	const notifications = await sessionStartNotifications(await extensionRunner(tempDirs()));

	expect(notifications).toStrictEqual([]);
});

test("root-recorded /model-groups rejects RPC and skips JSON/print before custom UI (rpc)", async () => {
	const fixture = await extensionRunner(tempDirs(), {
		mode: "rpc",
		ui: {
			custom: () => {
				throw new Error("/model-groups must not open custom UI outside TUI mode");
			},
		},
	});

	await fixture.command("model-groups").handler("", fixture.runner.createCommandContext());

	expect(fixture.ui.notifications.map(({ message }) => message)).toStrictEqual(["/model-groups requires TUI mode"]);
});

test.for(["json", "print"] as const)("root-recorded /model-groups rejects RPC and skips JSON/print before custom UI (%s)", async (mode) => {
	const fixture = await extensionRunner(tempDirs(), { mode, ui: undefined });
	// Without a bound UI pi hands every context its shared no-op UI.
	const { ui } = fixture.runner.createContext();
	const custom = vi.spyOn(ui, "custom");
	const notify = vi.spyOn(ui, "notify");

	await fixture.command("model-groups").handler("", fixture.runner.createCommandContext());

	expect(custom).not.toHaveBeenCalled();
	expect(notify).not.toHaveBeenCalled();
});

test("model groups untrusted root flow never probes project data and publishes global-only state to TUI", async () => {
	const dirs = tempDirs();
	writeConfig(globalConfigPath(dirs), { version: 2, groups: { globalOnly: { models: [] } } });
	writeConfig(projectConfigPath(dirs), { version: 2, groups: { projectSecret: { models: [] } } });
	let projectProbe = false;
	__setModelGroupsFsForTests({
		existsSync: (candidate) => {
			if (String(candidate).startsWith(dirs.cwd)) {
				projectProbe = true;
				throw new Error("project probe");
			}
			return fs.existsSync(candidate);
		},
	});
	const { fixture, rendered } = await renderModelGroupsList(dirs, {
		context: { isProjectTrusted: () => false, getContextUsage: () => ({ tokens: null, contextWindow: 0, percent: 10 }) },
	});

	await fixture.runner.emit({ type: "session_start", reason: "startup" });
	expect(projectProbe).toBe(false);
	await fixture.command("model-groups").handler("", fixture.runner.createCommandContext());

	expect(rendered()).toMatch(/globalOnly/);
	expect(rendered()).not.toMatch(/projectSecret|\[project\]/);
	expect(projectProbe).toBe(false);
});

test("model groups boot load-issue notifications escape hostile source, backup, and error detail fields", async () => {
	const dirs = tempDirs();
	const hostile = { ...dirs, cwd: `${dirs.cwd}\n\u001b]8;;https://example.test\u0007path` };
	const projectPath = projectConfigPath(hostile);
	__setModelGroupsFsForTests({
		existsSync: (candidate) => String(candidate) === projectPath,
		readFileSync: () => {
			throw new Error("invalid JSON");
		},
		copyFileSync: () => {
			throw new Error("backup\n\u001b[31mfailed\u0007");
		},
	});

	const notifications = await sessionStartNotifications(await extensionRunner(hostile));

	const notification = notifications.find((message) => message.includes("corrupt-json"));
	assertPresent(notification, "a corrupt-json notification is shown");
	// The path is joined, which collapses the double slash after "https:".
	const escapedPath = `${dirs.cwd}\\n\\x1B]8;;https:/example.test\\x07path/.pi/pi-schematic/model-groups.json`;
	expect(notification).toContain(`project scope (${escapedPath})`);
	expect(notification).toContain(`backup failed (${escapedPath}.bak), original file left untouched`);
	expect(notification).toMatch(/backup\\n\\x1B\[31mfailed\\x07/);
	expect(Array.from(notification).filter((char) => /\p{Cc}|\u2028|\u2029/u.test(char))).toStrictEqual([]);
});
