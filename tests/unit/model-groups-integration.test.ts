import { expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ModelRegistry, AutocompleteProviderFactory, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { escapeDisplayLabel } from "../../model-groups/display.js";
import { __setModelGroupsFsForTests, modelGroupsPath } from "../../model-groups/store.js";
import { assertPresent } from "../assertions.js";
import { createCommandContext, createCustomUI, createExtensionContext, createModelRegistry, createUIContext, testModel, theme } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost, getCommand, getHandler, getHandlers, type HostEvent, type HostHandler, type TestPI } from "./test-host.js";
import { withTemp } from "./model-groups-helpers.js";

type RegistryFields = Pick<ModelRegistry, "getAll" | "getAvailable" | "find" | "hasConfiguredAuth">;

function registryFields(available = new Set(["openai:gpt-5"])): RegistryFields {
	const models = [testModel({ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } })];
	return {
		getAll: () => models,
		getAvailable: () => models.filter((m) => available.has(`${m.provider}:${m.id}`)),
		find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (entry) => available.has(`${entry.provider}:${entry.id}`),
	};
}

function registry(available?: Set<string>): ModelRegistry {
	return createModelRegistry(registryFields(available));
}

// Escape on the Model Groups list closes the component, which resolves ctx.ui.custom.
const ESCAPE = "\u001b";

const SESSION_START: HostEvent<"session_start"> = { type: "session_start", reason: "startup" };

// The last of the extension's two session_start handlers: the one that refreshes the model groups (the first rehydrates the notebook).
function sessionStartHandler(pi: TestPI): HostHandler<"session_start"> {
	const handler = getHandlers(pi, "session_start").at(-1);
	assertPresent(handler);
	return handler;
}

function sessionStartContext(cwd: string, ui: Partial<ExtensionUIContext>, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return createExtensionContext({
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ tokens: null, contextWindow: 0, percent: 10 }),
		ui: createUIContext({ setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: () => {}, ...ui }),
		...overrides,
	});
}

test("/model-groups command registers and opens ctx.ui.custom with live registry/cwd", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { "cwd-sentinel-group": { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = await createTestHost();
	const findCalls: string[] = [];
	const registrySentinel = createModelRegistry({
		...registryFields(),
		find: (provider, id) => {
			findCalls.push(`${provider}:${id}`);
			return testModel({ provider, id, input: [], reasoning: true, thinkingLevelMap: { xhigh: "x" } });
		},
		hasConfiguredAuth: () => true,
	});

	expect([...pi.commands.keys()]).toContain("model-groups");
	let customCalled = 0;
	let rendered = "";
	await getCommand(pi, "model-groups").handler("", createCommandContext({
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registrySentinel,
		ui: createUIContext({
			notify: () => {},
			custom: createCustomUI(theme, (component) => {
				customCalled++;
				rendered = component.render(80).join("\n");
				component.handleInput?.(ESCAPE);
			}),
		}),
	}));
	expect(customCalled).toBe(1);
	expect(rendered).toMatch(/Model Groups/);
	expect(rendered).toMatch(/cwd-sentinel-group/);
	expect(findCalls).toStrictEqual(["openai:gpt-5", "openai:gpt-5"]);
}));

test("index session_start stores model group validation and notifies load and validation issues", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), JSON.stringify({ version: 1, groups: { bad: { models: [{ provider: "missing", modelId: "nope" }] }, shadow: { models: [] } } }), "utf8");
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { shadow: { models: [] } } }), "utf8");
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = sessionStartContext(cwd, { notify: (message) => { notifications.push(message); } });
	await sessionStartHandler(pi)(SESSION_START, ctx);
	expect(notifications).toContainEqual(expect.stringMatching(/1 unavailable model references · 1 project overrides/));
}));

test("index session_start notifies empty-common and stale-override boot counts", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	// claude is NOT in the registry, so claude-only is unavailable with empty common modalities; its override is stale.
	// The registry has only gpt-5 (text+image); an empty group also has empty common modalities.
	fs.writeFileSync(modelGroupsPath("global", cwd), JSON.stringify({ version: 2, groups: {
		empty: { models: [] },
		"claude-only": { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["text", "image"] } },
	} }), "utf8");
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = sessionStartContext(cwd, { notify: (message) => { notifications.push(message); } });
	await sessionStartHandler(pi)(SESSION_START, ctx);
	expect(notifications, JSON.stringify(notifications, null, 2)).toContainEqual(expect.stringMatching(/1 unavailable model references · 0 project overrides · 2 groups with no common modalities · 1 stale modality overrides/));
}));

test("index session_start notifies corrupt/schema/unsupported load issues", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{bad", "utf8");
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = sessionStartContext(cwd, { notify: (message) => { notifications.push(message); } });
	await sessionStartHandler(pi)(SESSION_START, ctx);
	expect(notifications).toContainEqual(expect.stringMatching(/corrupt-json/));
	expect(notifications).toContainEqual(expect.stringMatching(/unsupported-version/));
}));

test("index session_start notifies schema-invalid load issues", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { broken: { models: [{ provider: 1 }] } } }), "utf8");
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = sessionStartContext(cwd, { notify: (message) => { notifications.push(message); } });
	await sessionStartHandler(pi)(SESSION_START, ctx);
	expect(notifications).toContainEqual(expect.stringMatching(/schema-invalid/));
	expect(notifications).toContainEqual(expect.stringMatching(/project scope/));
	expect(notifications).toContainEqual(expect.stringContaining(escapeDisplayLabel(modelGroupsPath("project", cwd))));
}));

test("index session_start includes backup-failure detail in load issue notifications", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
	__setModelGroupsFsForTests({ copyFileSync: () => { throw new Error("backup denied"); } });
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = sessionStartContext(cwd, { notify: (message) => { notifications.push(message); } });
	await sessionStartHandler(pi)(SESSION_START, ctx);
	const notification = notifications.find((m) => m.includes("corrupt-json"));
	expect(notification, "notifications: " + notifications.join(" / ")).toMatch(/backup failed.*original file left untouched/);
	expect(notification).toContain(escapeDisplayLabel(modelGroupsPath("project", cwd)));
}));

test("before_agent_start writes fresh names-and-effective-modalities guidance", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const event = createBeforeAgentStartEvent();
	await handler(event, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: registry() }));
	const section = event.systemPromptOptions.sections.schematic_model_groups;
	expect(section).toMatch(/## Model Groups for spawn/);
	expect(section).toMatch(/Available Model Groups: review \(text, image, reasoning\)/);
	expect(section).toMatch(/constraints/);
	expect(section).toMatch(/exact group name/);
	expect(section).toMatch(/known and confident/);
	expect(section).toMatch(/omit group and inherit/);
	expect(section).not.toMatch(/gpt-5/);
	expect(section).not.toMatch(/model-groups\.json/);
}));

test("before_agent_start exposes union-effective modalities for automatic mixed groups", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { mixed: { models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "google", modelId: "gemini-text" }] } } }), "utf8");
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const models = [
		testModel({ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } }),
		testModel({ provider: "google", id: "gemini-text", input: ["text"], reasoning: false }),
	];
	const reg = createModelRegistry({ getAll: () => models, getAvailable: () => models, find: (provider, id) => models.find((m) => m.provider === provider && m.id === id), hasConfiguredAuth: () => true });
	// Automatic mixed group: guidance lists the union — image/reasoning present via the capable member.
	const event = createBeforeAgentStartEvent();
	await handler(event, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: reg }));
	expect(event.systemPromptOptions.sections.schematic_model_groups).toMatch(/Available Model Groups: mixed \(text, image, reasoning\)/);
}));

test("before_agent_start labels empty effective modalities unambiguously", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { foo: { models: [] }, "foo (none)": { models: [] } } }), "utf8");
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const event = createBeforeAgentStartEvent();
	await handler(event, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: registry() }));
	const section = event.systemPromptOptions.sections.schematic_model_groups;
	expect(section).toMatch(/foo \(no common modalities\)/);
	expect(section).toMatch(/foo \(none\) \(no common modalities\)/);
	expect(section).not.toMatch(/foo \(none\),/);
}));

test("before_agent_start rewrites updated effective modalities after registry changes", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	let current = testModel({ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: false, thinkingLevelMap: { xhigh: "x" } });
	const changingRegistry = createModelRegistry({
		getAll: () => [current],
		getAvailable: () => [current],
		find: () => current,
		hasConfiguredAuth: () => true,
	});
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const ctx = createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: changingRegistry });
	const initial = createBeforeAgentStartEvent();
	await handler(initial, ctx);
	expect(initial.systemPromptOptions.sections.schematic_model_groups).toMatch(/review \(text, image\)/);

	current = { ...current, input: ["text"], reasoning: true };
	const refreshed = createBeforeAgentStartEvent();
	await handler(refreshed, ctx);
	const refreshedSection = refreshed.systemPromptOptions.sections.schematic_model_groups;
	expect(refreshedSection).toMatch(/review \(text, reasoning\)/);
	expect(refreshedSection).not.toMatch(/review \(text, image\)/);
}));

test("before_agent_start clears stale Model Groups guidance when registry becomes unavailable", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = await createTestHost();
	const handler = getHandler(pi, "before_agent_start");
	const loaded = createBeforeAgentStartEvent();
	await handler(loaded, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: registry() }));
	expect(loaded.systemPromptOptions.sections.schematic_model_groups).toMatch(/Available Model Groups: review/);

	const unavailable = createBeforeAgentStartEvent();
	await handler(unavailable, createExtensionContext({ isProjectTrusted: () => true, cwd, modelRegistry: undefined }));
	expect(unavailable.systemPromptOptions.sections.schematic_model_groups).toBeUndefined();
}));

test("session_start registers Model Groups autocomplete provider when UI supports it", async () => withTemp(async ({ cwd }) => {
	const pi = await createTestHost();
	const providers: AutocompleteProviderFactory[] = [];
	await sessionStartHandler(pi)(SESSION_START, sessionStartContext(cwd, { notify: () => {}, addAutocompleteProvider: (factory) => { providers.push(factory); } }));
	expect(providers).toHaveLength(1);
}));

test("index session_start does not notify when load and validation issues are absent", async () => withTemp(async ({ cwd }) => {
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = sessionStartContext(cwd, { notify: (message) => { notifications.push(message); } });
	await sessionStartHandler(pi)(SESSION_START, ctx);
	expect(notifications).toStrictEqual([]);
}));

test.for(["rpc", "json", "print"] as const)("root-recorded /model-groups rejects RPC and skips JSON/print before custom UI (%s)", async (mode) => {
	const pi = await createTestHost();
	const notifications: string[] = [];
	let customCalls = 0;
	await getCommand(pi, "model-groups").handler("", createCommandContext({
		mode,
		hasUI: mode === "rpc",
		cwd: "/must-not-load",
		modelRegistry: registry(),
		isProjectTrusted: () => true,
		ui: createUIContext({ notify: (message) => { notifications.push(message); }, custom: () => { customCalls++; return Promise.reject(new Error("/model-groups must not open custom UI outside TUI mode")); } }),
	}));
	expect(customCalls, mode).toBe(0);
	expect(notifications, mode).toStrictEqual(mode === "rpc" ? ["/model-groups requires TUI mode"] : []);
});

test("model groups untrusted root flow never probes project data and publishes global-only state to TUI", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), JSON.stringify({ version: 1, groups: { globalOnly: { models: [] } } }), "utf8");
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { projectSecret: { models: [] } } }), "utf8");
	let projectProbe = false;
	__setModelGroupsFsForTests({ existsSync: (candidate) => {
		if (String(candidate).startsWith(cwd)) { projectProbe = true; throw new Error("project probe"); }
		return fs.existsSync(candidate);
	} });
	const pi = await createTestHost();
	await sessionStartHandler(pi)(SESSION_START, sessionStartContext(cwd, { notify: () => {} }, { isProjectTrusted: () => false }));
	expect(projectProbe).toBe(false);
	let rendered = "";
	await getCommand(pi, "model-groups").handler("", createCommandContext({
		mode: "tui", hasUI: true, isProjectTrusted: () => false, cwd, modelRegistry: registry(),
		ui: createUIContext({
			notify: () => {}, setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: () => {},
			custom: createCustomUI(theme, (component) => {
				rendered = component.render(80).join("\n");
				component.handleInput?.(ESCAPE);
			}),
		}),
	}));
	expect(rendered).toMatch(/globalOnly/);
	expect(rendered).not.toMatch(/projectSecret|\[project\]/);
	expect(projectProbe).toBe(false);
}));

test("model groups boot load-issue notifications escape hostile source, backup, and error detail fields", async () => withTemp(async ({ cwd }) => {
	const hostileCwd = `${cwd}\n\u001b]8;;https://example.test\u0007path`;
	const projectPath = modelGroupsPath("project", hostileCwd);
	__setModelGroupsFsForTests({
		existsSync: (candidate) => String(candidate) === projectPath,
		readFileSync: () => { throw new Error("invalid JSON"); },
		copyFileSync: () => { throw new Error("backup\n\u001b[31mfailed\u0007"); },
	});
	const pi = await createTestHost();
	const notifications: string[] = [];
	await sessionStartHandler(pi)(SESSION_START, sessionStartContext(hostileCwd, { notify: (message) => { notifications.push(message); } }));
	const notification = notifications.find((message) => message.includes("corrupt-json"))!;
	expect(notification).toContain(`project scope (${escapeDisplayLabel(projectPath)})`);
	expect(notification).toContain(`backup failed (${escapeDisplayLabel(`${projectPath}.bak`)}), original file left untouched`);
	expect(notification).toMatch(/backup\\n\\x1B\[31mfailed\\x07/);
	expect(notification).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
}));
