// The render context pi passes a tool's renderCall and renderResult.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The render context pi passes a tool's `renderCall` and `renderResult` (not exported from pi's package root). */
type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

function unstubbed(member: string): () => never {
	return () => {
		throw new Error(`${member} is not stubbed in this test context; assign it to the context createToolRenderContext returned.`);
	};
}

// The overrides without the members whose value is `undefined`, so spreading them
// over the defaults keeps a default instead of replacing it with `undefined`.
function definedOverrides<T extends object>(overrides: Partial<T>): Partial<T> {
	const defined: Partial<T> = {};
	for (const key in overrides) {
		if (Object.hasOwn(overrides, key) && overrides[key] !== undefined) {
			defined[key] = overrides[key];
		}
	}
	return defined;
}

/**
 * A `RenderContext` for a finished, collapsed call `tool-call-1`: arguments and
 * state empty, no error, no previous component, `invalidate` a no-op. Members
 * whose override is `undefined` keep these defaults.
 */
export function createToolRenderContext(overrides: Partial<RenderContext> = {}): RenderContext {
	// Newer pi versions add the keybinding formatters `keyText` and `keyHint` to the
	// render context. Spreading them from a variable keeps the literal valid against
	// versions without them; calling one throws naming it.
	const keybindingHints = {
		keyText: unstubbed("context.keyText"),
		keyHint: unstubbed("context.keyHint"),
	};
	return {
		...keybindingHints,
		args: {},
		toolCallId: "tool-call-1",
		invalidate: () => undefined,
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		...definedOverrides(overrides),
	};
}
