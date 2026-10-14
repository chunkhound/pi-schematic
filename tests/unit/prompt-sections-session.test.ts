/**
 * Runs schematic inside a real pi agent session and observes the system
 * messages pi sends to the provider between two user prompts.
 *
 * Isolation: every path pi and schematic read or write lives under one
 * mkdtemp directory. HOME points into it because schematic's
 * before_agent_start handler reads global model groups from
 * `homedir()/.pi/agent/pi-schematic/model-groups.json`. PI_OFFLINE=1 keeps
 * ModelRuntime from fetching over the network. The faux provider needs no
 * credentials.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
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
	type SystemMessage,
} from "@earendil-works/pi-ai";
import registerSchematic from "../../index.js";
import { setTempHome } from "./helpers.js";

let sandboxDir: string;
let restoreHome: () => void;
const previousPiOffline = process.env.PI_OFFLINE;

before(async () => {
	sandboxDir = await mkdtemp(join(os.tmpdir(), "pi-schematic-prompt-sections-"));
	restoreHome = setTempHome(sandboxDir);
	process.env.PI_OFFLINE = "1";
});

after(async () => {
	restoreHome();
	if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousPiOffline;
	await rm(sandboxDir, { recursive: true, force: true });
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

		assert.equal(systemMessagesPerRequest.length, 3);
		const firstRequestSectionNames = systemMessagesPerRequest[0].flatMap((message) => Object.keys(message.sections ?? {}));
		assert.ok(firstRequestSectionNames.includes("schematic"), `first request sections: ${firstRequestSectionNames.join(", ")}`);
		const secondRunPatches = systemMessagesPerRequest[2].slice(systemMessagesPerRequest[1].length);
		assert.ok(secondRunPatches.length > 0, "request 3 carried no new system messages");
		for (const message of secondRunPatches) {
			assert.deepEqual(Object.keys(message.sections ?? {}), ["schematic_topic"]);
			const topicBody = message.sections?.schematic_topic;
			assert.ok(typeof topicBody === "string" && topicBody.includes("oauth"), `schematic_topic patch: ${String(topicBody)}`);
		}
	});
});
