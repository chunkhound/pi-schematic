/**
 * Module evaluation order regression guard.
 *
 * Each assertion runs in a fresh Node process: the test runner itself imports
 * the extension graph, so in-process imports cannot prove loader order.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnNode } from "../support/spawn-node.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = new URL("../../register-loader.mjs", import.meta.url).href;

function evaluate(code: string): { status: number | null; output: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-schematic-module-order-"));
	try {
		const result = spawnNode(["--input-type=module", "--eval", code], {
			cwd: root,
			env: { PI_CODING_AGENT_DIR: agentDir },
			loader,
		});
		return { status: result.status, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

describe("module evaluation order", () => {
	it("creates and uses a deterministic session after handoff-first imports", () => {
		const { status, output } = evaluate(`
			await import('./handoff/tool.ts');
			await import('./spawn/index.ts');
			const [{ createAssistantMessageEventStream }, sdk] = await Promise.all([
				import('@earendil-works/pi-ai'),
				import('@earendil-works/pi-coding-agent'),
			]);

			const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null });
			const usage = {
				input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			modelRuntime.registerProvider('module-order-test', {
				api: 'module-order-test-api', apiKey: 'deterministic-test-key',
				baseUrl: 'http://module-order-test.invalid',
				models: [{
					id: 'deterministic', name: 'Deterministic', reasoning: false,
					input: ['text'], cost: usage.cost, contextWindow: 128000, maxTokens: 1024,
				}],
				streamSimple(model) {
					const message = {
						role: 'assistant', content: [{ type: 'text', text: 'MODULE_ORDER_OK' }],
						api: model.api, provider: model.provider, model: model.id,
						usage, stopReason: 'stop', timestamp: Date.now(),
					};
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
					return stream;
				},
			});

			const model = modelRuntime.getModel('module-order-test', 'deterministic');
			if (!model) throw new Error('deterministic model missing');
			const { session } = await sdk.createAgentSession({
				model, modelRuntime, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
				sessionManager: sdk.SessionManager.inMemory(),
				settingsManager: sdk.SettingsManager.inMemory(),
			});
			try {
				await session.prompt('prove the session is usable');
				if (session.getLastAssistantText() !== 'MODULE_ORDER_OK') {
					throw new Error('deterministic session did not produce the expected response');
				}
			} finally {
				session.dispose();
			}
		`);
		expect(status, output).toBe(0);
	});
});
