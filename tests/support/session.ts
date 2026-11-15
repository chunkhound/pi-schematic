// Session helpers over pi's SessionManager.inMemory: entries go in through pi's append methods and
// keep the ids pi generates. A test addresses an entry by the id its appender returned.

import { AgentSession, SessionManager, type AgentSessionEvent, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { vi, type Mock } from "vitest";
import { guardedInstance } from "./guarded.js";

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

// A fixed time for every message these helpers build.
const MESSAGE_TIME = 1_767_225_600_000;

/**
 * An assistant message with `content` from a fixed test provider and time, ending with `fields.stopReason`
 * (`"stop"` when omitted) and carrying `fields.usage` (zero usage when omitted).
 */
export function assistantMessage(
	content: AssistantMessage["content"],
	fields: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage" | "usage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: MESSAGE_TIME,
		...fields,
	};
}

/** A user message with `text`, at a fixed time. */
export function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: MESSAGE_TIME };
}

/** A successful, empty result of the tool call `toolCallId` to `toolName`, at a fixed time, with the tool's own `usage` when given. */
export function toolResultMessage(toolCallId: string, toolName: string, usage?: Usage): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [], isError: false, timestamp: MESSAGE_TIME, ...(usage === undefined ? {} : { usage }) };
}

/** Append an assistant text message with `usage`, from a fixed test provider and time. Returns its entry id. */
export function appendAssistantMessage(session: SessionManager, text: string, usage: Usage): string {
	return session.appendMessage(assistantMessage([{ type: "text", text }], { usage }));
}

// The fake child sessions below stay custom because a real AgentSession runs its own agent loop: it
// emits only the events and produces only the transcripts its run produces, at its own timing
// (`_emit` is private), so it cannot replay a scripted sequence or make a prompt, an abort or a
// dispose fail with a chosen error. Each reads and writes pi's published types only.

export interface SubscribableSession {
	session: AgentSession;
	/** Deliver `event` to every current subscriber; throws when none is subscribed. */
	emit(event: AgentSessionEvent): void;
	abort: Mock<() => Promise<void>>;
}

type SessionMembers = Pick<AgentSession, "messages" | "subscribe" | "sessionManager" | "getToolDefinition" | "abort">;

// An AgentSession whose own members are `members`; reading any other member AgentSession declares,
// or its instance fields `agent` and `settingsManager`, throws, naming it.
function guardedSession(members: SessionMembers): AgentSession {
	return guardedInstance<AgentSession>(
		AgentSession.prototype,
		members,
		["agent", "settingsManager"],
		(member) => new Error(`session.${member} is not available on the subscribable test session.`),
	);
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

export interface ChildSessionOptions {
	/** What `session.thinkingLevel` reports: the level pi settled on when it created the session. */
	thinkingLevel: AgentSession["thinkingLevel"];
	/** What `session.prompt` does; it resolves and leaves the transcript unchanged when omitted. */
	prompt?: (text: string) => Promise<void>;
	/** What `session.abort` does; it resolves when omitted. */
	abort?: () => Promise<void>;
	/** What `session.dispose` does; nothing when omitted. */
	dispose?: () => void;
}

export interface ChildSession {
	session: AgentSession;
	/** The transcript `session.messages` returns; a test changes it in place. */
	messages: AgentSession["messages"];
	/** The session's in-memory manager, for the entries the child records. */
	sessionManager: SessionManager;
	prompt: Mock<(text: string) => Promise<void>>;
	abort: Mock<() => Promise<void>>;
	dispose: Mock<() => void>;
}

/**
 * A child session for spawn to run: `messages`, `thinkingLevel`, `prompt`, `abort`, `dispose` and an
 * in-memory `sessionManager` for `cwd`, each call recorded by a mock; reading any other AgentSession
 * member throws, naming it.
 */
export function createChildSession(cwd: string, options: ChildSessionOptions): ChildSession {
	const messages: AgentSession["messages"] = [];
	const sessionManager = SessionManager.inMemory(cwd);
	const prompt = vi.fn(options.prompt ?? (() => Promise.resolve()));
	const abort = vi.fn(options.abort ?? (() => Promise.resolve()));
	const dispose = vi.fn(options.dispose ?? (() => undefined));
	const session = guardedInstance<AgentSession>(
		AgentSession.prototype,
		{ messages, thinkingLevel: options.thinkingLevel, prompt, abort, dispose, sessionManager },
		["agent", "settingsManager"],
		(member) => new Error(`session.${member} is not available on the test child session.`),
	);
	return { session, messages, sessionManager, prompt, abort, dispose };
}
