/**
 * Runs schematic inside a real pi agent session and observes the system
 * messages pi sends to the provider between two user prompts.
 *
 * Isolation: every path pi and schematic read or write lives under one
 * mkdtemp directory. HOME points into it because schematic's
 * before_agent_start handler reads global model groups from
 * `pi-schematic/model-groups.json` under pi's `getAgentDir()`, whose default
 * is `join(homedir(), CONFIG_DIR_NAME, "agent")`; HOME isolates that default
 * while PI_CODING_AGENT_DIR is unset, which setTempHome ensures. vitest.config.ts sets
 * PI_OFFLINE=1, which keeps ModelRuntime from fetching over the network. The faux provider needs no
 * credentials.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
	type Message,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import registerSchematic from "../../index.js";
import { MIN_HANDOFF_TOKENS } from "../../handoff/eligibility.js";
import { buildNudge } from "../../watchdog.js";
import { createDeferred, setTempHome } from "./helpers.js";

let sandboxDir: string;

beforeAll(async () => {
	sandboxDir = await mkdtemp(join(os.tmpdir(), "pi-schematic-prompt-sections-"));
	const restoreHome = setTempHome(sandboxDir);
	return async () => {
		restoreHome();
		await rm(sandboxDir, { recursive: true, force: true });
	};
});

describe("prompt sections in a real agent session", () => {
	it("re-sends only the changed section when the topic changes between prompts", async () => {
		const systemMessagesPerRequest: SystemMessage[][] = [];
		const recording = (respond: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory =>
			(context) => {
				systemMessagesPerRequest.push(
					context.messages.filter((message): message is SystemMessage => message.role === "system"),
				);
				return respond();
			};
		const callTopic = recording(() => fauxAssistantMessage(fauxToolCall("notebook_topic_set", { topic: "oauth" })));
		const reply = recording(() => fauxAssistantMessage("ok"));

		const faux = fauxProvider();
		faux.setResponses([callTopic, reply, reply]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(sandboxDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const resourceLoader = new DefaultResourceLoader({
			cwd: sandboxDir,
			agentDir: sandboxDir,
			extensionFactories: [registerSchematic],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: sandboxDir,
			agentDir: sandboxDir,
			model: faux.getModel(),
			modelRuntime,
			sessionManager: SessionManager.inMemory(sandboxDir),
			resourceLoader,
		});

		try {
			await session.prompt("first");
			await session.prompt("second");
		} finally {
			session.dispose();
		}

		expect(systemMessagesPerRequest).toHaveLength(3);
		const firstRequestSectionNames = systemMessagesPerRequest[0].flatMap((message) => Object.keys(message.sections ?? {}));
		expect(firstRequestSectionNames, `first request sections: ${firstRequestSectionNames.join(", ")}`).toContain("schematic");
		const secondRunPatches = systemMessagesPerRequest[2].slice(systemMessagesPerRequest[1].length);
		expect(secondRunPatches.length, "request 3 carried no new system messages").toBeGreaterThan(0);
		for (const message of secondRunPatches) {
			expect(Object.keys(message.sections ?? {})).toStrictEqual(["schematic_topic"]);
			const topicBody = message.sections?.schematic_topic;
			expect(topicBody, `schematic_topic patch: ${String(topicBody)}`).toEqual(expect.stringContaining("oauth"));
		}
	});

	it("sends the eligible handoff nudge in the same request as the schematic sections", async () => {
		const requests: Message[][] = [];
		const recording = (respond: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory =>
			(context) => {
				requests.push(context.messages);
				return respond();
			};
		const handoffRunRequested = createDeferred();
		const callTopic = recording(() => fauxAssistantMessage(fauxToolCall("notebook_topic_set", { topic: "oauth" })));
		const reply = recording(() => fauxAssistantMessage("ok"));
		const handoffRunReply = recording(() => {
			handoffRunRequested.resolve();
			return fauxAssistantMessage("ok");
		});

		const faux = fauxProvider();
		faux.setResponses([callTopic, reply, handoffRunReply]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(sandboxDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const resourceLoader = new DefaultResourceLoader({
			cwd: sandboxDir,
			agentDir: sandboxDir,
			extensionFactories: [registerSchematic],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: sandboxDir,
			agentDir: sandboxDir,
			model: faux.getModel(),
			modelRuntime,
			sessionManager: SessionManager.inMemory(sandboxDir),
			resourceLoader,
		});

		try {
			// The faux provider reports usage as chars / 4 of the prompt, so this first run leaves the session above the handoff threshold.
			await session.prompt(`first ${"x".repeat(MIN_HANDOFF_TOKENS * 4)}`);
			// The command queues the handoff request as a user message; that run starts after prompt() returns.
			await session.prompt("/handoff finish the report");
			await Promise.race([
				handoffRunRequested.promise,
				new Promise<never>((_, reject) => setTimeout(() => { reject(new Error("the /handoff run sent no provider request")); }, 5_000).unref()),
			]);
			await session.waitForIdle();
		} finally {
			session.dispose();
		}

		expect(requests).toHaveLength(3);
		const handoffRunRequest = requests[2];
		const nudgeFirstLine = buildNudge({
			activeNotebookTopic: null,
			pendingTopicBoundaryHint: null,
			readonlyEnabled: false,
			pendingRequestedHandoff: { toolCalled: false, enforcementAttempts: 0, eligibleNudgeDelivered: false, nextInstruction: "x" },
		}, null, true).split("\n")[0];
		const nonSystemText = handoffRunRequest
			.filter((message) => message.role !== "system")
			.map((message) => JSON.stringify(message.content))
			.join("\n");
		expect(nonSystemText, "the handoff run's request carries the eligible handoff nudge").toContain(JSON.stringify(nudgeFirstLine).slice(1, -1));
		const sections: Record<string, string> = {};
		for (const message of handoffRunRequest.filter((candidate): candidate is SystemMessage => candidate.role === "system")) {
			for (const [name, body] of Object.entries(message.sections ?? {})) {
				if (body === null) {delete sections[name];}
				else {sections[name] = body;}
			}
		}
		expect(sections.schematic, `schematic section missing; sections: ${Object.keys(sections).join(", ")}`).toBeDefined();
		expect(sections.schematic_topic, `schematic_topic: ${String(sections.schematic_topic)}`).toContain("Current topic: `oauth`");
	});
});
