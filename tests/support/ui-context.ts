// A stand-in for pi's `ExtensionUIContext` that throws on every member the test did not provide.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** The UI members a test may leave out: every member but `theme`. */
type UIFunctionMember = Exclude<keyof ExtensionUIContext, "theme">;

/**
 * A plain object with an own property for every `ExtensionUIContext` member: the `members` given,
 * and for each other member a function that throws `failure(member)` when called. pi copies the UI
 * context with an object spread before extensions see it, so the guards are own function
 * properties, which the copy keeps. `theme` is required: the copy reads it, so it cannot be a
 * getter that throws.
 */
export function guardedUIContext(
	members: Partial<Pick<ExtensionUIContext, UIFunctionMember>> & Pick<ExtensionUIContext, "theme">,
	failure: (member: UIFunctionMember) => Error,
): ExtensionUIContext {
	return { ...unavailableUI(failure), ...members };
}

/**
 * Every function member of `ExtensionUIContext`, throwing. The return type makes this literal fail
 * to compile when pi adds a member to the interface or removes one from it.
 */
function unavailableUI(failure: (member: UIFunctionMember) => Error): Pick<ExtensionUIContext, UIFunctionMember> {
	const unavailable = (member: UIFunctionMember) => (): never => {
		throw failure(member);
	};
	return {
		select: unavailable("select"),
		confirm: unavailable("confirm"),
		input: unavailable("input"),
		notify: unavailable("notify"),
		onTerminalInput: unavailable("onTerminalInput"),
		setStatus: unavailable("setStatus"),
		setWorkingMessage: unavailable("setWorkingMessage"),
		setWorkingVisible: unavailable("setWorkingVisible"),
		setWorkingIndicator: unavailable("setWorkingIndicator"),
		setHiddenThinkingLabel: unavailable("setHiddenThinkingLabel"),
		setWidget: unavailable("setWidget"),
		setFooter: unavailable("setFooter"),
		setHeader: unavailable("setHeader"),
		setTitle: unavailable("setTitle"),
		custom: unavailable("custom"),
		pasteToEditor: unavailable("pasteToEditor"),
		setEditorText: unavailable("setEditorText"),
		getEditorText: unavailable("getEditorText"),
		editor: unavailable("editor"),
		addAutocompleteProvider: unavailable("addAutocompleteProvider"),
		setEditorComponent: unavailable("setEditorComponent"),
		getEditorComponent: unavailable("getEditorComponent"),
		getAllThemes: unavailable("getAllThemes"),
		getTheme: unavailable("getTheme"),
		setTheme: unavailable("setTheme"),
		getToolsExpanded: unavailable("getToolsExpanded"),
		setToolsExpanded: unavailable("setToolsExpanded"),
	};
}
