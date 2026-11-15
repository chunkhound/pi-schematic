// Session helpers over pi's SessionManager.inMemory: entries go in through pi's append methods and
// keep the ids pi generates. A test addresses an entry by the id its appender returned.

import { AgentSession, SessionManager, type AgentSessionEvent, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { vi, type Mock } from "vitest";

/**
 * Append the entries a boundary handler drafted, in order, with pi's append method for each kind,
 * as pi commits them, except that a compaction records 0 tokens before it where pi estimates them
 * from the branch. Returns the ids pi generated.
 */
export function appendDrafts(session: SessionManager, drafts: readonly SessionBoundaryDraft[]): string[] {
	return drafts.map((draft) => {
		switch (draft.type) {
			case "custom":
				return session.appendCustomEntry(draft.customType, draft.data);
			case "custom_message":
				return session.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
			case "compaction":
				return session.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true, draft.usage);
			case "context_edit":
				return session.appendContextEdit(draft.targetId, draft.replacement);
		}
	});
}

/** Append an assistant text message with `usage`, from a fixed test provider and time. Returns its entry id. */
export function appendAssistantMessage(session: SessionManager, text: string, usage: Usage): string {
	return session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 1_767_225_600_000,
	});
}

export interface SubscribableSession {
	session: AgentSession;
	/** Deliver `event` to every current subscriber; throws when none is subscribed. */
	emit(event: AgentSessionEvent): void;
	abort: Mock<() => Promise<void>>;
}

type SessionMembers = Pick<AgentSession, "messages" | "subscribe" | "sessionManager" | "getToolDefinition" | "abort">;

// An object whose prototype is AgentSession's and whose own members are `members`; reading any other
// member AgentSession declares on its prototype or as an instance field throws, naming it.
function guardedSession(members: SessionMembers): AgentSession {
	const descriptors = Object.fromEntries(Object.entries(members).map(([name, value]): [string, PropertyDescriptor] => [name, { value }]));
	const target: unknown = Object.create(AgentSession.prototype, descriptors);
	if (!(target instanceof AgentSession)) {
		throw new Error("Object.create did not produce an AgentSession instance.");
	}
	const declared = new Set([...Object.getOwnPropertyNames(AgentSession.prototype).filter((name) => name !== "constructor"), "agent", "settingsManager"]);
	return new Proxy(target, {
		get(object, property, receiver) {
			if (typeof property === "string" && declared.has(property) && !Object.hasOwn(members, property)) {
				throw new Error(`session.${property} is not available on the subscribable test session.`);
			}
			const value: unknown = Reflect.get(object, property, receiver);
			return value;
		},
	});
}

/**
 * A child session whose events the test scripts. It stays custom because a real AgentSession
 * cannot emit a scripted event sequence (interleaved sessions, a partial update series): its
 * `_emit` is private. It has `messages`, `subscribe`, an in-memory `sessionManager` for `cwd`,
 * a resolving `abort` mock and no tool definitions of its own; reading any other AgentSession
 * member throws.
 */
export function createSubscribableSession(cwd: string, messages: AgentSession["messages"] = []): SubscribableSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const abort = vi.fn(() => Promise.resolve());
	const session = guardedSession({
		messages,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		sessionManager: SessionManager.inMemory(cwd),
		getToolDefinition: () => undefined,
		abort,
	});
	return {
		session,
		emit: (event) => {
			if (listeners.size === 0) {
				throw new Error(`Nothing is subscribed to the test session; the ${event.type} event would be lost.`);
			}
			for (const listener of listeners) {
				listener(event);
			}
		},
		abort,
	};
}
