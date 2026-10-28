/**
 * real-host-child-probe.ts — Provider for the child sessions that spawn creates
 * inside the real pi CLI.
 *
 * A child session builds its own model runtime, so the provider the parent's
 * probe registers is not visible to it. The harness installs this file in the
 * agent directory's extensions folder: the parent runs with `--no-extensions`
 * and ignores it, while every child session loads it and registers the same
 * provider and model the parent selected. Each child call answers
 * `CHILD_REPLY_TEXT` with `CHILD_USAGE`, or no content with `CHILD_USAGE` when the
 * child's prompt contains `CHILD_EMPTY_REPLY_MARKER`.
 *
 * Runs inside the pi process: never write to stdout or stderr here.
 */

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CHILD_EMPTY_REPLY_MARKER,
	CHILD_REPLY_TEXT,
	CHILD_USAGE,
	PROBE_MODEL_FIELDS,
	PROBE_PROVIDER,
	PROBE_PROVIDER_FIELDS,
} from "./real-host-protocol.js";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROBE_PROVIDER, {
		...PROBE_PROVIDER_FIELDS,
		models: [{ ...PROBE_MODEL_FIELDS, name: "Schematic E2E Child Model" }],
		streamSimple(model, context) {
			const emptyReply = context.messages.some((message) =>
				message.role === "user" && JSON.stringify(message.content).includes(CHILD_EMPTY_REPLY_MARKER));
			const message: AssistantMessage = {
				api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				role: "assistant", content: emptyReply ? [] : [{ type: "text", text: CHILD_REPLY_TEXT }],
				usage: { ...CHILD_USAGE, cost: { ...CHILD_USAGE.cost } }, stopReason: "stop",
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
