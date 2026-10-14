/**
 * End-to-end test: spawn tool works correctly after handoff tool has been
 * loaded and initialized.
 *
 * Spawn operations work after the handoff tool module is loaded: the SDK
 * classes createAgentSession needs are defined, and executeSpawn reaches its
 * own model check instead of failing on an undefined SDK value.
 *
 * Tests use a sandboxed agent directory to avoid reading real ~/.pi/agent/
 * config. Real createAgentSession reads extensions, models, auth, and skills
 * from the agent dir; pointing it at a sandbox prevents hangs from network
 * timeouts (Path 1, ~27s) and filesystem I/O on real extensions (Path 2,
 * ~12s). PI_OFFLINE=1 prevents ModelRuntime.refresh from making outbound
 * fetch() calls that Node.js v24 does not cleanly abort.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";

// Shared sandbox agent directory for all tests in this describe block.
// createAgentSession reads extensions, models, auth, and skills from the
// agent dir; pointing at a temp sandbox keeps tests fast and isolated.
let sandboxAgentDir: string;
const previousPiOffline = process.env.PI_OFFLINE;
process.env.PI_OFFLINE = "1";

before(async () => {
	sandboxAgentDir = await mkdtemp(join(os.tmpdir(), "pi-test-agent-"));
});

after(async () => {
	if (sandboxAgentDir) {
		await rm(sandboxAgentDir, { recursive: true, force: true });
	}
	if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousPiOffline;
});

describe("spawn after handoff initialization", () => {
	it("creates a child session after loading handoff tool module", async () => {
		// Step 1: Load the handoff module first
		await import("../../handoff/tool.js");

		// Step 2: Now call createAgentSession as the spawn tool does, but
		// pointed at a sandbox agent dir instead of real ~/.pi/agent/
		const result = await createAgentSession({
			agentDir: sandboxAgentDir,
			sessionManager: SessionManager.inMemory("/tmp"),
			model: {
				id: "test-model",
				provider: "test-provider",
				name: "Test Model",
				api: "test",
				baseUrl: "http://localhost",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 4096,
			},
			thinkingLevel: "low",
			cwd: "/tmp",
			tools: ["read"],
		});

		// The session.prompt() will fail if invoked (test-provider has no
		// real stream implementation in the runtime), but the session object
		// itself should be constructed and have the expected method shape.
		assert.ok(result.session, "createAgentSession should return a session object");
		assert.ok(typeof result.session.prompt === "function", "session should have a prompt method");
		assert.ok(typeof result.session.abort === "function", "session should have an abort method");

		// Cleanup the session to release resources
		await result.session.abort();
	});

	it("spawn tool execute succeeds after handoff module initialization", async () => {
		// Step 1: Load handoff module
		await import("../../handoff/tool.js");

		// Step 2: Register spawn tool with a test context
		const { registerSpawnTool, executeSpawn } = await import("../../spawn/index.js");

		const state = createState();
		const pi = {
			getThinkingLevel: () => "low" as const,
			getActiveTools: () => ["read", "bash", "notebook_write", "notebook_read", "notebook_index"],
			getAllTools: () => [],
			registerTool: () => {},
		};

		// registerSpawnTool should not throw
		registerSpawnTool(pi as any, state);

		// executeSpawn should throw "No model configured" (no ctx.model in test),
		// not "Cannot read properties of undefined (reading 'create')"
		try {
			await executeSpawn(
				"test-call",
				pi as any,
				{ model: undefined, cwd: "/tmp" } as any,
				state as any,
				{ prompt: "test task" },
				undefined,
				undefined,
				"low",
			);
			assert.fail("Expected executeSpawn to throw about missing model");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			assert.ok(
				message.includes("No model configured"),
				`Expected model-config error, got: ${message}`,
			);
			assert.ok(
				!message.includes("Cannot read properties of undefined"),
				`Should not see SDK undefined error, got: ${message}`,
			);
		}
	});
});
