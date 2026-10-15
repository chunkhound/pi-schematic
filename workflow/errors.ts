// WHY: shared low-level reporting helpers for command, host, and limits-dialog — a leaf
// module so all three use them without an import cycle (command imports host).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One shared error-to-message mapping. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Advisory transcript append: returns false on failure instead of throwing. Use ONLY
 * where the entry is visibility-only and another surface already carries the outcome;
 * append-first contracts (the `workflow-exit` record via `host.recordExit`) must call
 * `pi.appendEntry` directly so their rethrow/abort behavior stays explicit. */
export function safeAppendEntry(pi: ExtensionAPI, customType: string, data?: unknown): boolean {
	try {
		pi.appendEntry(customType, data);
		return true;
	} catch {
		return false;
	}
}

/** Notice text for an advisory record: a failed append is named, so the transcript gap is visible. */
export function withRecordStatus(message: string, recorded: boolean): string {
	return recorded ? message : `${message} (transcript record not persisted)`;
}
