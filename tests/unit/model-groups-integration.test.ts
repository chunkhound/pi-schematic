import { expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import { escapeDisplayLabel } from "../../model-groups/display.js";
import { __setModelGroupsFsForTests, modelGroupsPath } from "../../model-groups/store.js";
import { theme } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost } from "./test-host.js";
import { withTemp } from "./model-groups-helpers.js";

function registry(available = new Set(["openai:gpt-5"])): any {
	const models = [{ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } }];
	return {
		getAll: () => models,
		getAvailable: () => models.filter((m) => available.has(`${m.provider}:${m.id}`)),
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: any) => available.has(`${model.provider}:${model.id}`),
	};
}

test("/model-groups command registers and opens ctx.ui.custom with live registry/cwd", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { "cwd-sentinel-group": { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = await createTestHost();
	const findCalls: string[] = [];
	const registrySentinel = {
		...registry(),
		find: (provider: string, id: string) => {
			findCalls.push(`${provider}:${id}`);
			return { provider, id, reasoning: true, thinkingLevelMap: { xhigh: "x" } };
		},
		hasConfiguredAuth: () => true,
	};

	expect([...pi.commands.keys()]).toContain("model-groups");
	let customCalled = 0;
	let rendered = "";
	await pi.commands.get("model-groups")!.handler("", {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registrySentinel,
		ui: {
			notify: () => {},
			custom: async (factory: any) => {
				customCalled++;
				const component = factory({ requestRender: () => {} }, theme, {}, () => {});
				rendered = component.render(80).join("\n");
			},
		},
	});
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
	const ctx = {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: {
			theme,
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
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
	const ctx = {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	expect(notifications, JSON.stringify(notifications, null, 2)).toContainEqual(expect.stringMatching(/1 unavailable model references · 0 project overrides · 2 groups with no common modalities · 1 stale modality overrides/));
}));

test("index session_start notifies corrupt/schema/unsupported load issues", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{bad", "utf8");
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	expect(notifications).toContainEqual(expect.stringMatching(/corrupt-json/));
	expect(notifications).toContainEqual(expect.stringMatching(/unsupported-version/));
}));

test("index session_start notifies schema-invalid load issues", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { broken: { models: [{ provider: 1 }] } } }), "utf8");
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
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
	const ctx = {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	expect(notifications).toSatisfy((all: string[]) => all.some((m) => /corrupt-json/.test(m) && /backup failed.*original file left untouched/.test(m) && m.includes(escapeDisplayLabel(modelGroupsPath("project", cwd)))));
}));

test("before_agent_start writes fresh names-and-effective-modalities guidance", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 1, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	const pi = await createTestHost();
	const handler = pi.handlers.get("before_agent_start")![0];
	const event = createBeforeAgentStartEvent();
	await handler(event, { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry: registry(), getContextUsage: () => null });
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
	const handler = pi.handlers.get("before_agent_start")![0];
	const models = [
		{ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } },
		{ provider: "google", id: "gemini-text", input: ["text"], reasoning: false },
	];
	const reg = { getAll: () => models, getAvailable: () => models, find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id), hasConfiguredAuth: () => true };
	// Automatic mixed group: guidance lists the union — image/reasoning present via the capable member.
	const event = createBeforeAgentStartEvent();
	await handler(event, { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry: reg, getContextUsage: () => null });
	expect(event.systemPromptOptions.sections.schematic_model_groups).toMatch(/Available Model Groups: mixed \(text, image, reasoning\)/);
}));

test("before_agent_start labels empty effective modalities unambiguously", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { foo: { models: [] }, "foo (none)": { models: [] } } }), "utf8");
	const pi = await createTestHost();
	const handler = pi.handlers.get("before_agent_start")![0];
	const event = createBeforeAgentStartEvent();
	await handler(event, { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry: registry(), getContextUsage: () => null });
	const section = event.systemPromptOptions.sections.schematic_model_groups;
	expect(section).toMatch(/foo \(no common modalities\)/);
	expect(section).toMatch(/foo \(none\) \(no common modalities\)/);
	expect(section).not.toMatch(/foo \(none\),/);
}));

test("before_agent_start rewrites updated effective modalities after registry changes", async () => withTemp(async ({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { review: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }), "utf8");
	let model = { provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: false, thinkingLevelMap: { xhigh: "x" } };
	const changingRegistry = {
		getAll: () => [model],
		getAvailable: () => [model],
		find: () => model,
		hasConfiguredAuth: () => true,
	};
	const pi = await createTestHost();
	const handler = pi.handlers.get("before_agent_start")![0];
	const ctx = { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry: changingRegistry, getContextUsage: () => null };
	const initial = createBeforeAgentStartEvent();
	await handler(initial, ctx);
	expect(initial.systemPromptOptions.sections.schematic_model_groups).toMatch(/review \(text, image\)/);

	model = { ...model, input: ["text"], reasoning: true };
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
	const handler = pi.handlers.get("before_agent_start")![0];
	const loaded = createBeforeAgentStartEvent();
	await handler(loaded, { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry: registry(), getContextUsage: () => null });
	expect(loaded.systemPromptOptions.sections.schematic_model_groups).toMatch(/Available Model Groups: review/);

	const unavailable = createBeforeAgentStartEvent();
	await handler(unavailable, { hasUI: false, isProjectTrusted: () => true, cwd, modelRegistry: undefined, getContextUsage: () => null });
	expect(unavailable.systemPromptOptions.sections.schematic_model_groups).toBeUndefined();
}));

test("session_start registers Model Groups autocomplete provider when UI supports it", async () => withTemp(async ({ cwd }) => {
	const pi = await createTestHost();
	const providers: AutocompleteProviderFactory[] = [];
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: () => {}, setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: (factory: AutocompleteProviderFactory) => providers.push(factory) },
	});
	expect(providers).toHaveLength(1);
}));

test("index session_start does not notify when load and validation issues are absent", async () => withTemp(async ({ cwd }) => {
	const pi = await createTestHost();
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		cwd,
		modelRegistry: registry(),
		getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	};
	const handler = pi.handlers.get("session_start")!.at(-1)!;
	await handler({ reason: "load" }, ctx);
	expect(notifications).toStrictEqual([]);
}));

test("root-recorded /model-groups rejects RPC and skips JSON/print before custom UI", async () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const pi = await createTestHost();
		const notifications: string[] = [];
		let customCalls = 0;
		await pi.commands.get("model-groups")!.handler("", {
			mode,
			hasUI: mode === "rpc",
			cwd: "/must-not-load",
			modelRegistry: registry(),
			isProjectTrusted: () => true,
			ui: { notify: (message: string) => notifications.push(message), custom: async () => { customCalls++; } },
		});
		expect(customCalls, mode).toBe(0);
		expect(notifications, mode).toStrictEqual(mode === "rpc" ? ["/model-groups requires TUI mode"] : []);
	}
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
	const baseUi = { theme, notify: () => {}, setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: () => {} };
	await pi.handlers.get("session_start")!.at(-1)!({ reason: "load" }, {
		mode: "tui", hasUI: true, isProjectTrusted: () => false, cwd, modelRegistry: registry(), getContextUsage: () => ({ percent: 10 }), ui: baseUi,
	});
	expect(projectProbe).toBe(false);
	let rendered = "";
	await pi.commands.get("model-groups")!.handler("", {
		mode: "tui", hasUI: true, isProjectTrusted: () => false, cwd, modelRegistry: registry(),
		ui: { ...baseUi, custom: async (factory: any) => { rendered = factory({ requestRender: () => {} }, theme, {}, () => {}).render(80).join("\n"); } },
	});
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
	await pi.handlers.get("session_start")!.at(-1)!({ reason: "load" }, {
		mode: "tui", hasUI: true, isProjectTrusted: () => true, cwd: hostileCwd, modelRegistry: registry(), getContextUsage: () => ({ percent: 10 }),
		ui: { theme, notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: () => {} },
	});
	const notification = notifications.find((message) => message.includes("corrupt-json"))!;
	expect(notification).toContain(`project scope (${escapeDisplayLabel(projectPath)})`);
	expect(notification).toContain(`backup failed (${escapeDisplayLabel(`${projectPath}.bak`)}), original file left untouched`);
	expect(notification).toMatch(/backup\\n\\x1B\[31mfailed\\x07/);
	expect(notification).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
}));
