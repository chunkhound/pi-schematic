/**
 * Queue-safe user-message delivery.
 *
 * Pi rejects plain sends while a run is active; follow-up delivery queues the
 * message and drains it as the next turn, so post-compaction and enforcement
 * sends never throw "already processing".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a user message that queues behind an active run instead of being rejected. */
export function sendFollowUp(pi: ExtensionAPI, content: string): void {
	pi.sendUserMessage(content, { deliverAs: "followUp" });
}
