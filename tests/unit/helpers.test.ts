/**
 * Environment restore semantics of the temp-directory helpers, and the guards of
 * the typed extension contexts.
 *
 * pi reads PI_CODING_AGENT_DIR before HOME when it resolves its agent
 * directory, so each helper must leave the variable as it found it: the prior
 * value when one was set, and absent (not the string "undefined") when it was
 * unset.
 */

import { expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
	createCommandContext,
	createExtensionContext,
	createToolRenderContext,
	createToolContext,
	createUIContext,
	setTempHome,
	tmpDir,
	withTempAgentDir,
	withTempHome,
} from "./helpers.js";

const KEY = "PI_CODING_AGENT_DIR";

async function withPriorAgentDir(prior: string | undefined, body: () => Promise<void>): Promise<void> {
	const ambient = process.env[KEY];
	if (prior === undefined) {delete process.env[KEY];}
	else {process.env[KEY] = prior;}
	try {
		await body();
	} finally {
		if (ambient === undefined) {delete process.env[KEY];}
		else {process.env[KEY] = ambient;}
	}
}

function assertAgentDirRestored(prior: string | undefined): void {
	if (prior === undefined) {expect(process.env[KEY]).toBeUndefined();}
	else {expect(process.env[KEY]).toBe(prior);}
}

const priors = [
	{ label: "a previously set", prior: "/prior/agent-dir" },
	{ label: "a previously unset", prior: undefined },
];

for (const { label, prior } of priors) {
	test(`withTempAgentDir points PI_CODING_AGENT_DIR at its temp dir and restores ${label} value`, async () => {
		await withPriorAgentDir(prior, async () => {
			let seen: string | undefined;
			let created: string | undefined;
			await withTempAgentDir(async (agentDir) => {
				seen = process.env[KEY];
				created = agentDir;
			});
			expect(seen).toBe(created);
			assertAgentDirRestored(prior);
		});
	});

	test(`withTempAgentDir restores ${label} PI_CODING_AGENT_DIR when the run throws`, async () => {
		await withPriorAgentDir(prior, async () => {
			await expect(withTempAgentDir(async () => { throw new Error("run failed"); })).rejects.toThrow(/run failed/);
			assertAgentDirRestored(prior);
		});
	});

	test(`withTempHome clears PI_CODING_AGENT_DIR during the run and restores ${label} value`, async () => {
		await withPriorAgentDir(prior, async () => {
			let during: { value: string | undefined } | undefined;
			await withTempHome(async () => {
				during = { value: process.env[KEY] };
			});
			expect(during).toStrictEqual({ value: undefined });
			assertAgentDirRestored(prior);
		});
	});

	test(`withTempHome restores ${label} PI_CODING_AGENT_DIR when the run throws`, async () => {
		await withPriorAgentDir(prior, async () => {
			await expect(withTempHome(async () => { throw new Error("run failed"); })).rejects.toThrow(/run failed/);
			assertAgentDirRestored(prior);
		});
	});

	test(`setTempHome clears PI_CODING_AGENT_DIR until its restore function restores ${label} value`, async () => {
		await withPriorAgentDir(prior, async () => {
			const restoreHome = setTempHome("/temp/home");
			const whileSet = { value: process.env[KEY] };
			restoreHome();
			expect(whileSet).toStrictEqual({ value: undefined });
			assertAgentDirRestored(prior);
		});
	});
}

test("a context member the test did not stub throws naming it", () => {
	const ctx = createExtensionContext();

	expect(() => ctx.getContextUsage()).toThrow("ctx.getContextUsage is not stubbed in this test context; pass it in the overrides.");
});

test("a UI member the test did not stub throws naming it and where to pass it", () => {
	const ctx = createExtensionContext();

	expect(() => { ctx.ui.notify("probe"); }).toThrow(
		"ctx.ui.notify is not stubbed in this test context; pass it to createUIContext and that context as `ui`.",
	);
});

test("a command context member the test did not stub throws naming it", () => {
	const ctx = createCommandContext();

	expect(() => ctx.waitForIdle()).toThrow("ctx.waitForIdle is not stubbed in this test context; pass it in the overrides.");
});

test("a command context passes its command and context overrides through", async () => {
	const ctx = createCommandContext({ waitForIdle: async () => { await Promise.resolve(); }, cwd: "/probe/cwd" });

	await expect(ctx.waitForIdle()).resolves.toBeUndefined();
	expect(ctx.cwd).toBe("/probe/cwd");
});

test("a tool context has no callable tools and an executeTool that throws naming it", () => {
	const ctx = createToolContext();

	expect(ctx.tools).toStrictEqual([]);
	expect(() => ctx.executeTool("read", {})).toThrow("ctx.executeTool is not stubbed in this test context; pass it in the overrides.");
});

test("a tool context passes its tool and context overrides through", () => {
	const tools: ExtensionToolContext["tools"] = [];
	const ctx = createToolContext({ tools, cwd: "/probe/cwd" });

	expect(ctx.tools).toBe(tools);
	expect(ctx.cwd).toBe("/probe/cwd");
});

test("using a model registry the test did not stub throws naming it", () => {
	const ctx = createExtensionContext();

	expect(() => ctx.modelRegistry.getAll()).toThrow("ctx.modelRegistry is not stubbed in this test context; pass it in the overrides.");
});

test("a model registry passed in the overrides is the context's registry", async () => {
	const dir = await tmpDir();
	try {
		const registry = new ModelRegistry(await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false }));

		expect(createExtensionContext({ modelRegistry: registry }).modelRegistry).toBe(registry);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("copying a context or composing it into another does not throw", () => {
	const ctx = createExtensionContext();

	expect(() => {
		const { cwd: _cwd, ...rest } = ctx;
		createExtensionContext({ ...ctx });
		createCommandContext(Object.assign({}, rest));
	}).not.toThrow();
});

test("the unstubbed model registry still throws on a copied or composed context", () => {
	const ctx = createExtensionContext();
	const { cwd: _cwd, ...rest } = ctx;

	for (const copy of [{ ...ctx }, Object.assign({}, ctx), rest, createExtensionContext(ctx), createToolContext(ctx)]) {
		expect(() => copy.modelRegistry.getAll()).toThrow("ctx.modelRegistry is not stubbed");
	}
});

test("a model registry assigned to a built context replaces the unstubbed one", () => {
	const ctx = createExtensionContext();
	const other = createExtensionContext();

	ctx.modelRegistry = other.modelRegistry;

	expect(ctx.modelRegistry).toBe(other.modelRegistry);
});

test("an override set to undefined keeps the default cwd and its session manager", () => {
	const ctx = createExtensionContext({ cwd: undefined });

	expect(ctx.cwd).toBe(process.cwd());
	expect(ctx.sessionManager.getCwd()).toBe(process.cwd());
});

test("a UI override set to undefined keeps the throwing stub", () => {
	const ui = createUIContext({ notify: undefined });

	expect(() => { ui.notify("probe"); }).toThrow("ctx.ui.notify is not stubbed");
});

// Read reflectively: the pinned pi's render context type has no keybinding formatters.
test.for(["keyText", "keyHint"])("an unstubbed render context %s throws naming itself", (member) => {
	const formatter: unknown = Reflect.get(createToolRenderContext(), member);
	if (typeof formatter !== "function") {throw new Error(`createToolRenderContext built no ${member} function.`);}

	expect(() => { Reflect.apply(formatter, undefined, ["app.tools.expand", "to expand"]); }).toThrow(`context.${member} is not stubbed`);
});

test("a render context override set to undefined keeps the default", () => {
	const context = createToolRenderContext({ toolCallId: undefined, expanded: true });

	expect(context.toolCallId).toBe("tool-call-1");
	expect(context.expanded).toBe(true);
});
