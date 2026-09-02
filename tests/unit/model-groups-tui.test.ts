import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, fuzzyFilter, visibleWidth } from "@earendil-works/pi-tui";
import { createModelGroupsComponent } from "../../model-groups/tui.js";
import { ModelGroupsPersistenceError, type ModelGroupsBootValidation, type ResolvedModelGroup } from "../../model-groups/types.js";
import { stripAnsi, theme } from "./helpers.js";
import { group } from "./model-groups-helpers.js";

function registry(): any {
	const models = [
		{ provider: "anthropic", id: "claude", reasoning: false },
		{ provider: "google", id: "gemini-no-auth", reasoning: true, configuredAuth: false },
		{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "x", max: "m" } },
		{ provider: "openai", id: "gpt-no-auth", reasoning: true, configuredAuth: false },
	];
	return {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: any) => model.provider !== "missing" && model.configuredAuth !== false,
	};
}

function boot(groups: ResolvedModelGroup[]): ModelGroupsBootValidation { return { groups, loadIssues: [] }; }

function component(args: { groups?: ResolvedModelGroup[]; store?: any; notify?: (m: string, t?: any) => void; renderTheme?: any; policy?: "global-project" | "global-only"; modelRegistry?: any } = {}) {
	let renders = 0;
	const c = createModelGroupsComponent(
		{ requestRender: () => { renders++; } } as any,
		args.renderTheme ?? theme,
		args.modelRegistry ?? registry(),
		{ cwd: "/tmp/project", policy: args.policy ?? "global-project" },
		() => {},
		{ initialValidation: boot(args.groups ?? []), store: args.store, notify: args.notify },
	);
	return { c, get renders() { return renders; } };
}

const ENTER = "\r";
const ESC = "\u001b";
const ESC_KITTY = "\u001b[27u";
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const LEFT = "\u001b[D";
const BACKSPACE = "\u007f";
const LEFT_SS3 = "\u001bOD";

function press(c: { handleInput?: (data: string) => void; render?: (width: number) => string[] }, ...inputs: string[]): void {
	for (const input of inputs) {
		c.render?.(100);
		c.handleInput?.(input);
		c.render?.(100);
	}
}

function rendered(c: { render: (width: number) => string[] }, width = 100): string {
	return c.render(width).join("\n");
}

function selectRenderedLabel(c: { handleInput?: (data: string) => void; render: (width: number) => string[] }, label: string): void {
	for (let i = 0; i < 32; i++) {
		const selected = stripAnsi(rendered(c)).split("\n").find((line) => line.includes("→"));
		if (selected?.includes(label)) return;
		press(c, DOWN);
	}
	assert.fail(`did not select rendered label: ${label}`);
}

function pressAndRender(c: { handleInput?: (data: string) => void; render: (width: number) => string[] }, ...inputs: string[]): void {
	for (const input of inputs) {
		c.render(100);
		c.handleInput?.(input);
		c.render(100);
	}
}

function catalog(models: any[]): any {
	return {
		getAll: () => models,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: (model: any) => model.configuredAuth !== false,
	};
}

function atSearchableModel(models: any[], store?: any) {
	const c = component({ groups: [group("review", { scope: "project" })], modelRegistry: catalog(models), store }).c;
	pressAndRender(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER, ENTER);
	assert.match(rendered(c), /Add model — Step 2\/3 Model/);
	return c;
}

test("model groups TUI list renders validation summary, health tags, add row, no Validate row, and confirmed D delete", () => {
	const override = group("review", { scope: "global" });
	override.validation.shadowedByProject = true;
	const degraded = group("mixed", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "missing", modelId: "nope" }] });
	degraded.validation.degraded = true;
	degraded.validation.unavailableRefs = [{ provider: "missing", modelId: "nope" }];
	let groups = [override, group("review", { scope: "project" }), degraded];
	const deleteCalls: string[] = [];
	const store = {
		deleteGroup: (scope: string, _cwd: string, name: string) => { deleteCalls.push(`${scope}:${name}`); groups = groups.filter((candidate) => !(candidate.scope === scope && candidate.name === name)); return { otherScopeHasOverride: true }; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	let lines = c.render(100).join("\n");
	assert.match(lines, /Boot validation: 1 unavailable model references · 1 project overrides/);
	assert.match(lines, /project override/);
	assert.match(lines, /⚠ degraded/);
	assert.match(lines, /✗ unavailable/);
	assert.match(lines, /\+ Add group/);
	assert.doesNotMatch(lines, /Validate/);
	c.handleInput?.("D");
	lines = c.render(100).join("\n");
	assert.match(lines, /Delete Model Group/);
	assert.match(lines, /Same-name group in the other scope remains unaffected/);
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r");
	assert.deepEqual(deleteCalls, ["global:review"]);
	assert.doesNotMatch(c.render(100).join("\n"), /Delete Model Group/);
});

test("model groups TUI renders modality labels, warnings, and stale override choices", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	review.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	review.constraints = { modalities: ["text", "image", "reasoning"] };
	review.validation.emptyCommonModalities = true;
	review.validation.unsupportedOverrideModalities = ["reasoning"];
	const { c } = component({ groups: [review] });
	const reviewRow = stripAnsi(rendered(c, 200)).split("\n").find((line) => line.includes("review"));
	assert.ok(reviewRow, "expected review row");
	assert.match(reviewRow, /\bT\b/);
	assert.match(reviewRow, /\bI\b/);
	assert.match(reviewRow, /models .*?T I[\s]*/);
	assert.match(rendered(c, 200), /⚠ no common modalities/);
	assert.match(rendered(c, 200), /⚠ stale modality override: reasoning/);
	press(c, ENTER);
	assert.match(rendered(c), /Supported by every model: text/);
	assert.match(rendered(c), /Modalities: Override \(text, image\)/);
	assert.match(rendered(c), /Capabilities/);
	assert.match(rendered(c), /Models/);
	press(c, DOWN, DOWN, DOWN, ENTER);
	assert.match(rendered(c), /T text  \[required\]/);
	assert.match(rendered(c), /I image  \[on\]/);
	// The group carries a persisted override (text, image, reasoning) → status reflects it.
	assert.match(rendered(c), /Override — media limited to text, image/);
	assert.doesNotMatch(rendered(c), /reasoning/);
});

test("model groups TUI Add-model picker shows capability chips per model", () => {
	const review = group("review", { scope: "project" });
	const models = [
		{ provider: "openai", id: "gpt-text", reasoning: false, input: ["text"] },
		{ provider: "openai", id: "gpt-vision", reasoning: false, input: ["text", "image"] },
		{ provider: "openai", id: "gpt-no-auth", reasoning: false, input: ["text", "image"], configuredAuth: false },
	];
	const { c } = component({ groups: [review], modelRegistry: catalog(models) });
	pressAndRender(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	assert.match(rendered(c), /Add model — Step 1\/3 Provider/);
	pressAndRender(c, DOWN, ENTER);
	const text = rendered(c);
	assert.match(text, /Add model — Step 2\/3 Model/);
	// Capable members show colored T/I chips; the unauthenticated model is not selectable.
	assert.doesNotMatch(text, /gpt-no-auth/);
	const stripped = stripAnsi(text);
	assert.match(stripped, /openai\/gpt-text\s+T/);
	assert.match(stripped, /openai\/gpt-vision\s+T I/);
});

test("model groups TUI editor rows show per-model capability chips and modalities screen shows dynamic Automatic/Override status", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-text" }, { provider: "openai", modelId: "gpt-vision" }] });
	review.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	const models = [
		{ provider: "openai", id: "gpt-text", reasoning: false, input: ["text"] },
		{ provider: "openai", id: "gpt-vision", reasoning: false, input: ["text", "image"] },
		{ provider: "openai", id: "gpt-missing", reasoning: true },
	];
	// Mock store mirrors production reconciliation so the toggle can persist.
	let groups = [review];
	const reconciledEffective = (def: any, supported: string[]) => {
		const base = Array.isArray(def.constraints?.modalities) ? def.constraints.modalities.filter((m: string) => supported.includes(m)) : [...supported];
		return ["text", ...base.filter((m: string) => m !== "text")];
	};
	const store = {
		updateGroup: (scope: string, _cwd: string, name: string, def: any) => {
			groups = [group(name, { scope: scope as "project", models: def.models, constraints: def.constraints })];
			groups[0].modalities = { common: ["text"], supported: ["text", "image"], effective: reconciledEffective(def, ["text", "image"]) };
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups: [review], store, modelRegistry: catalog(models) });
	press(c, ENTER);
	const editor = stripAnsi(rendered(c));
	// Per-model capability chips mirror the Add-model picker; unresolved members carry none.
	assert.match(editor, /openai\/gpt-text\s+T\s+\(available/);
	assert.match(editor, /openai\/gpt-vision\s+T I\s+\(available/);
	assert.doesNotMatch(editor, /gpt-missing/);
	// Hand-editing modalities surfaces a dynamic status for Automatic vs Override.
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const modalities = stripAnsi(rendered(c));
	// Text is a non-toggleable required base; no Automatic selector row remains.
	assert.match(modalities, /T text  \[required\]/);
	assert.match(modalities, /Automatic — using every capability its members support/);
	assert.doesNotMatch(modalities, /Automatic \(/);
	assert.doesNotMatch(modalities, /required base/);
	// Single editable row: compact footer without arrow-nav; no per-row hint.
	assert.match(modalities, /Enter\/Space toggle • Esc back/);
	assert.doesNotMatch(modalities, /↑↓ navigate/);
	assert.doesNotMatch(modalities, /Enter\/Space toggles/);
	assert.match(modalities, /I image  \[on\]/);
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	const afterOverride = stripAnsi(rendered(c));
	assert.match(afterOverride, /Override — media limited to text/);
	assert.match(afterOverride, /I image  \[off\]/);
});

test("model groups TUI modality editor commits override and Automatic through updateGroup", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	(review as any).opaqueTopLevel = { preserve: true };
	// Automatic groups open with their union capability set active; un-toggling a
	// supported capability writes a subtractive override excluding it.
	review.modalities = { common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text", "image", "reasoning"] };
	const calls: Array<{ scope: string; name: string; def: any }> = [];
	let groups = [review];
	// Mock mirrors production reconciliation: an override narrows effective to its
	// supported list; automatic stays at the union.
	const reconciledEffective = (def: any, supported: string[]) => {
		const base = Array.isArray(def.constraints?.modalities) ? def.constraints.modalities.filter((m: string) => supported.includes(m)) : [...supported];
		return ["text", ...base.filter((m: string) => m !== "text")];
	};
	const store = {
		updateGroup: (scope: string, _cwd: string, name: string, def: any) => {
			calls.push({ scope, name, def: { ...def, constraints: def.constraints ? { ...def.constraints, ...(Array.isArray(def.constraints.modalities) ? { modalities: [...def.constraints.modalities] } : {}) } : undefined } });
			groups = [group(name, { scope: scope as "project", models: def.models, constraints: def.constraints })];
			groups[0].modalities = { common: ["text"], supported: ["text", "image", "reasoning"], effective: reconciledEffective(def, ["text", "image", "reasoning"]) };
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	assert.match(rendered(c), /Modalities/);
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].def.constraints.modalities, ["text", "reasoning"]);
	assert.deepEqual(calls[0].def.opaqueTopLevel, { preserve: true }, "TUI edits retain opaque top-level group keys");
	assert.match(rendered(c), /Modalities/, "toggle stays on the modalities screen");
	assert.match(rendered(c), /I image  \[off\]/);
	assert.match(rendered(c), /Override — media limited to text/);
	// Re-enabling the capability back to the full union returns the group to Automatic
	// (no stored override, so no spawn ceiling attaches to a non-limit).
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].def.constraints?.modalities, undefined);
	assert.match(rendered(c), /Modalities/, "re-enable also stays on the modalities screen");
	assert.match(rendered(c), /Automatic — using every capability its members support/);
	press(c, ESC);
	assert.match(rendered(c), /Modalities: Automatic \(text, image\)/);
});

test("model groups TUI Space also toggles a modality and stays on screen", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	review.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	const calls: Array<{ scope: string; name: string; def: any }> = [];
	let groups = [review];
	const reconciledEffective = (def: any, supported: string[]) => {
		const base = Array.isArray(def.constraints?.modalities) ? def.constraints.modalities.filter((m: string) => supported.includes(m)) : [...supported];
		return ["text", ...base.filter((m: string) => m !== "text")];
	};
	const store = {
		updateGroup: (scope: string, _cwd: string, name: string, def: any) => {
			calls.push({ scope, name, def: { ...def, constraints: def.constraints ? { ...def.constraints, ...(Array.isArray(def.constraints.modalities) ? { modalities: [...def.constraints.modalities] } : {}) } : undefined } });
			groups = [group(name, { scope: scope as "project", models: def.models, constraints: def.constraints })];
			groups[0].modalities = { common: ["text"], supported: ["text", "image"], effective: reconciledEffective(def, ["text", "image"]) };
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	assert.match(rendered(c), /Modalities/);
	selectRenderedLabel(c, "I image");
	press(c, " ");
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].def.constraints.modalities, ["text"]);
	assert.match(rendered(c), /Modalities/, "space toggle stays on the modalities screen");
	assert.match(rendered(c), /I image  \[off\]/);
});

test("model groups TUI modality editor preserves state and notifies on updateGroup failure", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	review.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text"] };
	const messages: string[] = [];
	let failing = true;
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => {
			if (failing) throw new ModelGroupsPersistenceError({ operation: "save", scope: "project", sourcePath: "/tmp/.pi/pi-agenticoding/model-groups.json", phase: "rename", message: "modality write denied" });
			review.constraints = def.constraints ? { ...def.constraints, ...(Array.isArray(def.constraints.modalities) ? { modalities: [...def.constraints.modalities] } : {}) } : undefined;
		},
		listResolvedModelGroups: () => boot([review]),
	};
	const { c } = component({ groups: [review], store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, ENTER); // open Modalities
	press(c, ENTER); // toggle the single media row → updateGroup throws
	assert.ok(messages.some((m) => /modality write denied/.test(m)));
	assert.match(rendered(c), /Modalities/, "screen retained after failure");
});

test("model groups TUI text-only modalities screen is inert and states Automatic", () => {
	const textOnly = group("text-only", { scope: "project", models: [{ provider: "openai", modelId: "gpt-text" }] });
	textOnly.modalities = { common: ["text"], supported: ["text"], effective: ["text"] };
	let updateCalls = 0;
	const store = {
		updateGroup: () => { updateCalls++; },
		listResolvedModelGroups: () => boot([textOnly]),
	};
	const { c } = component({ groups: [textOnly], store });
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const screen = stripAnsi(rendered(c));
	// No toggleable media rows: only the required text row, no toggle nav, no selection.
	assert.match(screen, /T text  \[required\]/);
	assert.match(screen, /No optional media capabilities available/);
	assert.match(screen, /Automatic — using every capability its members support/);
	assert.match(screen, /Esc back/);
	assert.doesNotMatch(screen, /Enter\/Space toggle/);
	assert.doesNotMatch(screen, /Enter\/Space toggles/);
	assert.doesNotMatch(screen, /→/);
	// Enter/Space on the inert row must not persist anything.
	press(c, ENTER, " ", ENTER);
	assert.equal(updateCalls, 0);
});

test("model groups TUI empty-group modalities screen claims no capabilities", () => {
	const empty = group("empty", { scope: "project" }); // models: [] — no member-derived capabilities
	const store = {
		updateGroup: () => { throw new Error("empty group must not commit edits"); },
		listResolvedModelGroups: () => boot([empty]),
	};
	const { c } = component({ groups: [empty], store });
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const screen = stripAnsi(rendered(c));
	// The engine derives no supported/effective modalities for zero members, so the
	// editor must not claim the text base capability — the empty state is the truth.
	assert.match(screen, /Modalities — empty/);
	assert.doesNotMatch(screen, /text  \[required\]/, "empty groups must not claim the text base capability");
	assert.match(screen, /No optional media capabilities available/);
	assert.match(screen, /Automatic — using every capability its members support/);
	assert.match(screen, /Esc back/);
});

test("model groups TUI computes unique new-group names and opens editor after create", () => {
	let groups = [group("new-group", { scope: "project" })];
	const calls: string[] = [];
	const store = {
		createGroup: (scope: string, _cwd: string, name: string, def: any) => {
			calls.push(`${scope}:${name}:${def.models.length}`);
			groups = [...groups, group(name, { scope: "project" })];
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	c.handleInput?.("\u001b[B"); // + Add group
	c.handleInput?.("\r");
	assert.deepEqual(calls, ["project:new-group-2:0"]);
	assert.match(c.render(100).join("\n"), /Model Group: new-group-2/);
});

test("model groups TUI wizard renders provider/model/thinking steps and preserves state on add failure", () => {
	const messages: string[] = [];
	let updateCalls = 0;
	const groups = [group("review", { scope: "project" })];
	const store = {
		updateGroup: () => {
			updateCalls++;
			throw new ModelGroupsPersistenceError({
				operation: "save",
				scope: "project",
				sourcePath: "/tmp/project/.pi/pi-agenticoding/model-groups.json",
				phase: "rename",
				message: "add failed",
			});
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	assert.match(text, /Add model — Step 1\/3 Provider/);
	assert.match(text, /anthropic/);
	assert.match(text, /openai/);
	assert.doesNotMatch(text, /google/);
	assert.doesNotMatch(text, /Step 4/);

	press(c, DOWN, ENTER);
	text = rendered(c);
	assert.match(text, /Add model — Step 2\/3 Model/);
	assert.match(text, /openai\/gpt-5/);
	assert.doesNotMatch(text, /openai\/gpt-no-auth/);
	assert.doesNotMatch(text, /anthropic\/claude/);
	assert.doesNotMatch(text, /Step 4/);

	press(c, ENTER);
	text = rendered(c);
	assert.match(text, /Add model — Step 3\/3 Thinking/);
	for (const option of ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]) {
		assert.match(text, new RegExp(`\\b${option}\\b`));
	}
	assert.doesNotMatch(text, /Step 4/);

	press(c, ENTER);
	assert.equal(updateCalls, 1);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /save failed at rename for project scope/);
	assert.match(messages[0], /add failed/);
	text = rendered(c);
	assert.match(text, /Add model — Step 3\/3 Thinking/);
	assert.doesNotMatch(text, /Model Group: review/);
});

test("model groups TUI Esc and left-arrow share wizard back-step behavior", () => {
	function atProvider() {
		const { c } = component({ groups: [group("review", { scope: "project" })] });
		press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
		return c;
	}
	function atModel() {
		const c = atProvider();
		press(c, DOWN, ENTER);
		return c;
	}
	function atThinking() {
		const c = atModel();
		press(c, ENTER);
		return c;
	}

	const providerEsc = atProvider();
	const providerEscKitty = atProvider();
	const providerLeft = atProvider();
	press(providerEsc, ESC);
	press(providerEscKitty, ESC_KITTY);
	press(providerLeft, LEFT);
	assert.equal(rendered(providerEsc), rendered(providerLeft));
	assert.equal(rendered(providerEscKitty), rendered(providerLeft));
	assert.match(rendered(providerEsc), /Model Group: review/);

	const modelEsc = atModel();
	const modelLeft = atModel();
	press(modelEsc, ESC);
	press(modelLeft, LEFT);
	assert.equal(rendered(modelEsc), rendered(modelLeft));
	assert.match(rendered(modelEsc), /Add model — Step 1\/3 Provider/);

	const thinkingEsc = atThinking();
	const thinkingLeft = atThinking();
	const thinkingLeftSs3 = atThinking();
	press(thinkingEsc, ESC);
	press(thinkingLeft, LEFT);
	press(thinkingLeftSs3, LEFT_SS3);
	assert.equal(rendered(thinkingEsc), rendered(thinkingLeft));
	assert.equal(rendered(thinkingLeftSs3), rendered(thinkingLeft));
	assert.match(rendered(thinkingEsc), /Add model — Step 2\/3 Model/);
});

test("model groups TUI selected markers and primary labels use accent token", () => {
	const accentTheme = {
		fg: (name: string, text: string) => name === "accent" ? `<accent>${text}</accent>` : text,
		bold: (text: string) => text,
	};
	const list = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;

	let text = rendered(list);
	assert.match(text, /<accent>→ review\s+\[project\] 1 models inherit<\/accent>/);
	press(list, DOWN);
	assert.match(rendered(list), /<accent>→ \+ Add group<\/accent>/);

	const editor = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;
	press(editor, ENTER);
	text = rendered(editor);
	assert.match(text, /<accent>→<\/accent> <accent>Location: project<\/accent> ✓/);
	press(editor, DOWN, DOWN, DOWN, DOWN);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>openai\/gpt-5<\/accent> \(available/);
	press(editor, DOWN);
	assert.match(rendered(editor), /<accent>→<\/accent> <accent>\+ Add model…<\/accent>/);

	press(editor, ENTER);
	assert.match(rendered(editor), /<accent>→ anthropic<\/accent>/);

	const modelEdit = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;
	press(modelEdit, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	assert.match(rendered(modelEdit), /<accent>→<\/accent> <accent>Thinking: inherit<\/accent>/);

	const g = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	g.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	const modalitiesC = component({ groups: [g], renderTheme: accentTheme }).c;
	press(modalitiesC, ENTER, DOWN, DOWN, DOWN, ENTER);
	// The selected capability row is accent-highlighted; the modality letter keeps its own color.
	assert.match(rendered(modalitiesC), /<accent>→<\/accent> I<accent> image  \[on\]<\/accent>/);
	assert.match(rendered(modalitiesC), /Enter\/Space toggle • Esc back/);

	const deleteConfirm = component({ groups: [group("review", { scope: "project" })], renderTheme: accentTheme }).c;
	press(deleteConfirm, "D");
	assert.match(rendered(deleteConfirm), /<accent>→<\/accent> <accent>Keep group<\/accent>/);
	press(deleteConfirm, DOWN);
	assert.match(rendered(deleteConfirm), /<accent>→<\/accent> <accent>Delete group<\/accent>/);
});

test("model groups TUI model edit renders identity/status and filters thinking options", () => {
	const groups = [group("review", { scope: "project", models: [
		{ provider: "anthropic", modelId: "claude" },
		{ provider: "openai", modelId: "gpt-5" },
		{ provider: "missing", modelId: "nope" },
	] })];
	const { c } = component({ groups });

	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	assert.match(text, /Provider: anthropic/);
	assert.match(text, /Model ID: claude/);
	assert.match(text, /Status: available/);
	assert.match(text, /Thinking: inherit/);
	assert.equal(text.match(/Thinking:/g)?.length, 1);
	assert.doesNotMatch(text, /Thinking: off/);
	assert.doesNotMatch(text, /Thinking: (minimal|low|medium|high|xhigh)/);

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	assert.match(text, /Provider: openai/);
	assert.match(text, /Model ID: gpt-5/);
	assert.match(text, /Status: available/);
	for (const option of ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]) {
		assert.match(text, new RegExp(`Thinking: ${option}`));
	}

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	assert.match(text, /Provider: missing/);
	assert.match(text, /Model ID: nope/);
	assert.match(text, /Status: unavailable/);
	assert.match(text, /Thinking: inherit/);
	assert.equal(text.match(/Thinking:/g)?.length, 1);
});

test("model groups TUI notifies and preserves location on move collision", () => {
	const messages: string[] = [];
	const groups = [group("review", { scope: "project" })];
	const store = {
		moveGroup: () => { throw new Error("target scope already contains review"); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, ENTER);
	assert.deepEqual(messages, ["target scope already contains review"]);
	const text = rendered(c);
	assert.match(text, /Model Group: review/);
	assert.match(text, /Location: project ✓/);
	assert.doesNotMatch(text, /Location: global ✓/);
});

test("model groups TUI notifies and preserves model edit state when updateGroup fails", () => {
	const messages: string[] = [];
	const attemptedModels: string[][] = [];
	const groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => {
			attemptedModels.push(def.models.map((model: any) => `${model.provider}/${model.modelId}/${model.thinkingLevel ?? "inherit"}`));
			throw new ModelGroupsPersistenceError({
				operation: "save",
				scope: "project",
				sourcePath: "/tmp/project/.pi/pi-agenticoding/model-groups.json",
				phase: "temp-write",
				message: `update failed ${attemptedModels.length}`,
			});
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER, DOWN, ENTER);
	assert.deepEqual(attemptedModels[0], ["openai/gpt-5/off"]);
	assert.match(messages[0], /update failed 1/);
	let text = rendered(c);
	assert.match(text, /Edit model/);
	assert.match(text, /Provider: openai/);
	assert.match(text, /Model ID: gpt-5/);
	assert.doesNotMatch(text, /Model Group: review/);

	press(c, "D");
	assert.deepEqual(attemptedModels[1], []);
	assert.match(messages[1], /update failed 2/);
	text = rendered(c);
	assert.match(text, /Edit model/);
	assert.match(text, /Provider: openai/);
	assert.match(text, /Remove model/);
});

test("model groups TUI renders name editing inline and preserves edit/commit transitions", () => {
	let groups = [group("abc", { scope: "project" })];
	const calls: string[] = [];
	const store = {
		renameGroup: (_scope: string, _cwd: string, oldName: string, newName: string) => { calls.push(`${oldName}->${newName}`); groups = [group(newName, { scope: "project" })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	c.focused = true;
	press(c, ENTER, DOWN, DOWN); // selected, inactive name row
	let text = rendered(c);
	assert.match(text, /→ Name: abc/);
	assert.doesNotMatch(text, /(?:^|\n)> /);
	assert.doesNotMatch(text, /\u001b\[7m/);
	assert.equal(text.includes(CURSOR_MARKER), false);

	press(c, ENTER, "d"); // D remains literal while the input is active
	text = rendered(c);
	assert.match(text, /→ Name: abcd/);
	assert.doesNotMatch(text, /(?:^|\n)> /);
	assert.match(text, /\u001b\[7m/);
	assert.equal(text.split(CURSOR_MARKER).length - 1, 1);

	press(c, LEFT, BACKSPACE);
	assert.match(stripAnsi(rendered(c)).replaceAll(CURSOR_MARKER, ""), /→ Name: abd/);
	press(c, "c", ESC); // Escape commits and exits edit mode
	assert.deepEqual(calls, ["abc->abcd"]);
	text = rendered(c);
	assert.match(text, /Model Group: abcd/);
	assert.match(text, /  Name: abcd/);
	assert.doesNotMatch(text, /\u001b\[7m/);
	assert.equal(text.includes(CURSOR_MARKER), false);

	press(c, DOWN, DOWN, ENTER, "e", ENTER); // Enter also commits and exits edit mode
	assert.deepEqual(calls, ["abc->abcd", "abcd->abcde"]);
	assert.match(rendered(c), /  Name: abcde/);
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);

	press(c, DOWN, DOWN, ENTER, "f", DOWN, DOWN); // row-change flushes the pending rename before moving
	assert.deepEqual(calls, ["abc->abcd", "abcd->abcde", "abcde->abcdef"]);
	text = rendered(c);
	assert.match(text, /Model Group: abcdef/);
	assert.match(text, /→ \+ Add model/);
	assert.match(text, /Name: abcdef/);
	assert.doesNotMatch(text, /\u001b\[7m/);
	assert.equal(text.includes(CURSOR_MARKER), false);
	assert.doesNotMatch(text, /Delete Model Group/);
});

test("model groups TUI move, wizard add, model thinking, and remove persist through store calls", () => {
	let groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })];
	const calls: string[] = [];
	const store = {
		moveGroup: (_cwd: string, name: string, scope: string) => { calls.push(`move:${name}:${scope}`); groups = [group(name, { scope: "global", models: groups[0].models })]; },
		updateGroup: (scope: string, _cwd: string, name: string, def: any) => { calls.push(`update:${scope}:${name}:${def.models.map((m: any) => `${m.provider}/${m.modelId}/${m.thinkingLevel ?? "inherit"}`).join(",")}`); groups = [group(name, { scope: scope as "project" | "global", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	c.handleInput?.("\r"); // editor
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r"); // switch global
	assert.equal(calls[0], "move:review:global");

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // first model row
	c.handleInput?.("\r"); // model edit
	c.handleInput?.("\u001b[B"); // off
	c.handleInput?.("\r");
	assert.match(calls.at(-1)!, /update:global:review:openai\/gpt-5\/off/);

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // + add model
	press(c, ENTER); // provider step
	assert.match(rendered(c), /Step 1\/3 Provider/);
	press(c, ENTER); // anthropic provider (sorted first)
	assert.match(rendered(c), /Step 2\/3 Model/);
	press(c, ENTER); // claude model
	assert.match(rendered(c), /Step 3\/3 Thinking/);
	press(c, ENTER); // inherit thinking
	assert.match(calls.at(-1)!, /anthropic\/claude\/inherit/);

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // first model row after refresh
	c.handleInput?.("\r");
	c.handleInput?.("D");
	assert.ok(calls.at(-1)!.startsWith("update:global:review:"));
});

test("model groups TUI notifies and keeps visible state on persistence errors", () => {
	const messages: string[] = [];
	const { c } = component({
		groups: [group("review", { scope: "project" })],
		notify: (message) => messages.push(message),
		store: {
			renameGroup: () => {
				throw new ModelGroupsPersistenceError({
					operation: "save",
					scope: "project",
					sourcePath: "/tmp/project/.pi/pi-agenticoding/model-groups.json",
					targetPath: "/tmp/project/.pi/pi-agenticoding/model-groups.json.123.tmp",
					phase: "temp-write",
					message: "collision",
				});
			},
			listResolvedModelGroups: () => boot([group("review", { scope: "project" })]),
		},
	});
	c.handleInput?.("\r");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r");
	c.handleInput?.("2");
	c.handleInput?.("\u001b"); // Escape preserves persistence-error handling and exits name input
	assert.equal(messages.length, 1);
	assert.match(messages[0], /save failed at temp-write for project scope/);
	assert.match(messages[0], /source: \/tmp\/project\/\.pi\/pi-agenticoding\/model-groups\.json/);
	assert.match(messages[0], /target: \/tmp\/project\/\.pi\/pi-agenticoding\/model-groups\.json\.123\.tmp/);
	assert.match(messages[0], /collision/);
	const text = c.render(100).join("\n");
	assert.match(text, /Model Group: review/);
	assert.match(text, /→ Name: review/);
	assert.equal(text.includes(CURSOR_MARKER), false);
});

test("model groups TUI uses root Focusable propagation and MODEL_EDIT parent navigation", () => {
	const c = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })] }).c;
	c.focused = true;
	press(c, ENTER, DOWN, DOWN, ENTER);
	assert.ok(c.render(80).join("\n").includes(CURSOR_MARKER));
	press(c, ENTER);
	assert.equal(c.render(80).join("\n").includes(CURSOR_MARKER), false);
	press(c, DOWN, DOWN, ENTER);
	assert.match(rendered(c), /Edit model/);
	press(c, ESC);
	assert.match(rendered(c), /Location: project/);
	assert.doesNotMatch(rendered(c), /Edit model/);
});

test("model groups TUI clamps final add row and enforces global-only access", () => {
	let groups = [group("global-name", { scope: "global" }), group("project-secret", { scope: "project" })];
	const calls: any[] = [];
	const store = {
		createGroup: (scope: string, access: any, name: string, def: any) => {
			calls.push({ scope, access, name, def });
			groups = [group("global-name", { scope: "global" }), group(name, { scope: "global" })];
		},
		listResolvedModelGroups: () => boot(groups.filter((candidate) => candidate.scope === "global")),
	};
	const c = component({ groups, store, policy: "global-only" }).c;
	assert.doesNotMatch(rendered(c), /project-secret/);
	press(c, DOWN, DOWN);
	assert.match(rendered(c), /→ \+ Add group/);
	press(c, ENTER);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].scope, "global");
	assert.deepEqual(calls[0].access, { cwd: "/tmp/project", policy: "global-only" });
	assert.deepEqual(calls[0].def, { models: [] });
	const text = rendered(c);
	assert.match(text, /Location: global/);
	assert.doesNotMatch(text, /Location: project/);
});

test("model groups TUI escapes controlled labels, bounds width, and offers native max", () => {
	const hostile = "group\n\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007";
	const c = component({ groups: [group(hostile, { scope: "project", models: [{ provider: "openai\u001b[31m", modelId: "model\nlong" }] })] }).c;
	const lines = c.render(20);
	assert.equal(lines.every((line) => visibleWidth(line) <= 20), true);
	const text = lines.join("\n");
	assert.match(text, /group\\n\\x1B/);
	assert.doesNotMatch(text, /\u001b\]8;;/);

	let maxGroups = [group("review", { scope: "project" })];
	let selectedThinking: string | undefined;
	const max = component({
		groups: maxGroups,
		store: {
			updateGroup: (_scope: string, _access: any, name: string, def: any) => { selectedThinking = def.models.at(-1)?.thinkingLevel; maxGroups = [group(name, { scope: "project", models: def.models })]; },
			listResolvedModelGroups: () => boot(maxGroups),
		},
	}).c;
	press(max, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	press(max, DOWN, ENTER, ENTER);
	assert.match(rendered(max), /Add model — Step 3\/3 Thinking/);
	assert.match(rendered(max), /max/);
	press(max, ...Array(20).fill(DOWN), ENTER);
	assert.equal(selectedThinking, "max");
});

test("model groups TUI decodes then canonicalizes prototype-sensitive names and rejects malformed escapes", () => {
	for (const nextName of ["__proto__", "constructor", "toString"]) {
		let groups = [group("abc", { scope: "project" })];
		const calls: string[] = [];
		const notifications: string[] = [];
		const store = {
			renameGroup: (_scope: string, _access: any, oldName: string, renamed: string) => { calls.push(`${oldName}->${renamed}`); groups = [group(renamed, { scope: "project" })]; },
			listResolvedModelGroups: () => boot(groups),
		};
		const c = component({ groups, store, notify: (message) => notifications.push(message) }).c;
		press(c, ENTER, DOWN, DOWN, ENTER, "\u007f", "\u007f", "\u007f", ...[...` ${nextName} `], DOWN);
		assert.deepEqual(calls, [`abc->${nextName}`]);
		assert.match(rendered(c), new RegExp(nextName.replaceAll("_", "\\_")));
		assert.deepEqual(notifications, []);
	}

	const malformedCalls: string[] = [];
	const notifications: string[] = [];
	const malformed = component({
		groups: [group("abc", { scope: "project" })],
		store: { renameGroup: () => malformedCalls.push("called"), listResolvedModelGroups: () => boot([group("abc", { scope: "project" })]) },
		notify: (message) => notifications.push(message),
	}).c;
	press(malformed, ENTER, DOWN, DOWN, ENTER, "\\", ESC);
	assert.deepEqual(malformedCalls, []);
	assert.equal(notifications.length, 1);
	assert.match(rendered(malformed), /→ Name: abc/);
	assert.equal(rendered(malformed).includes(CURSOR_MARKER), false);
});

test("model groups TUI keeps every screen width-bounded without wrapping logical rows", () => {
	const assertScreen = (c: ReturnType<typeof component>["c"]) => {
		const wideCount = c.render(200).length;
		const narrow = c.render(12);
		assert.equal(narrow.length, wideCount);
		assert.equal(narrow.every((line) => visibleWidth(line) <= 12), true);
	};
	const longModel = { provider: "openai", modelId: "gpt-5", thinkingLevel: "max" as const };
	const c = component({ groups: [group("界e\u0301界-a-very-long-group-name", { scope: "project", models: [longModel] })] }).c;
	assertScreen(c); // LIST
	press(c, ENTER);
	assertScreen(c); // EDITOR
	c.focused = true;
	press(c, DOWN, DOWN); // inactive group-name row
	const inactiveWideCount = c.render(200).length;
	for (const width of [1, 2, 12]) {
		const lines = c.render(width);
		assert.equal(lines.length, inactiveWideCount);
		assert.equal(lines.every((line) => visibleWidth(line) <= width), true);
		assert.equal(lines.join("\n").includes(CURSOR_MARKER), false);
		if (width === 12) assert.match(stripAnsi(lines.join("\n")), /界e\u0301/);
	}
	press(c, ENTER, "\u0001"); // active group-name input with cursor at line start
	const activeWideCount = c.render(200).length;
	for (const width of [1, 2, 12]) {
		const lines = c.render(width);
		assert.equal(lines.length, activeWideCount);
		assert.equal(lines.every((line) => visibleWidth(line) <= width), true);
		assert.equal(lines.join("\n").includes(CURSOR_MARKER), true);
		if (width === 12) assert.match(stripAnsi(lines.join("\n")).replaceAll(CURSOR_MARKER, ""), /界e\u0301/);
	}
	press(c, DOWN, ENTER);
	assertScreen(c); // MODALITIES (from the name row, Down lands on the Modalities row)
	press(c, ESC, DOWN, DOWN, DOWN, DOWN, ENTER);
	assertScreen(c); // WIZARD_PROVIDER
	press(c, DOWN, DOWN, ENTER);
	assertScreen(c); // WIZARD_MODEL
	press(c, ENTER);
	assertScreen(c); // WIZARD_THINKING
	const deletion = component({ groups: [group("a-very-long-group-name", { scope: "project", models: [longModel] })] }).c;
	press(deletion, "D");
	assertScreen(deletion); // DELETE_CONFIRM
});

test("model groups TUI searchable Model step filters raw fields and handles no matches safely", () => {
	const models = [
		{ provider: "openai", id: "alpha-id", name: "Friendly Name", reasoning: true },
		{ provider: "openai", id: "beta-id", name: "Other", reasoning: true },
		{ provider: "openai", id: "hidden", name: "Unauthorized", reasoning: true, configuredAuth: false },
		{ provider: "other", id: "foreign", name: "Friendly Name", reasoning: true },
	];
	const c = atSearchableModel(models);
	assert.match(rendered(c), /→ openai\/alpha-id/);
	assert.match(rendered(c), /beta-id/);
	assert.doesNotMatch(rendered(c), /hidden|foreign/);

	for (const query of ["alpha-id", "openai/alpha-id", "Friendly"]) {
		const queried = atSearchableModel(models);
		pressAndRender(queried, ...query);
		assert.match(rendered(queried), /alpha-id/);
		assert.doesNotMatch(rendered(queried), /beta-id/);
	}
	const providerQuery = atSearchableModel(models);
	pressAndRender(providerQuery, ..."openai");
	assert.match(rendered(providerQuery), /alpha-id/);
	assert.match(rendered(providerQuery), /beta-id/);

	pressAndRender(c, ..."Friendly impossible");
	assert.match(rendered(c), /No matching models/);
	const before = rendered(c);
	pressAndRender(c, UP, DOWN, ENTER);
	assert.equal(rendered(c), before);
});

test("model groups TUI fuzzy search excludes synthetic provider-space-id matches", () => {
	const model = { provider: "abc", id: "xyz", name: "", reasoning: true };
	const query = "azaz";
	const approvedFields = fuzzyFilter([model], query, (candidate) => [
		candidate.id,
		candidate.provider,
		`${candidate.provider}/${candidate.id}`,
		candidate.name,
	].join(" "));
	const withSyntheticProviderSpaceId = fuzzyFilter([model], query, (candidate) => [
		candidate.id,
		candidate.provider,
		`${candidate.provider}/${candidate.id}`,
		`${candidate.provider} ${candidate.id}`,
		candidate.name,
	].join(" "));
	assert.equal(approvedFields.length, 0);
	assert.equal(withSyntheticProviderSpaceId.length, 1);

	const c = atSearchableModel([model]);
	pressAndRender(c, ...query);
	assert.match(rendered(c), /No matching models/);
	assert.doesNotMatch(rendered(c), /→ abc\/xyz/);
});

test("model groups TUI handles Model activation immediately after Provider transition without rendering", () => {
	let groups = [group("review", { scope: "project" })];
	const persisted: any[] = [];
	const store = {
		updateGroup: (_scope: string, _access: any, name: string, def: any) => {
			persisted.push(def.models.at(-1));
			groups = [group(name, { scope: "project", models: def.models })];
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const models = Array.from({ length: 2 }, (_, index) => ({ provider: "openai", id: `model-${index}`, reasoning: false }));
	const c = component({ groups, modelRegistry: catalog(models), store }).c;
	pressAndRender(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	assert.match(rendered(c), /Add model — Step 1\/3 Provider/);

	for (const input of [ENTER, ENTER]) c.handleInput?.(input);
	assert.match(rendered(c), /Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	assert.deepEqual(persisted, [{ provider: "openai", modelId: "model-0" }]);
});

test("model groups TUI replaces Thinking control with Model control before rendering the back-step", () => {
	let groups = [group("review", { scope: "project" })];
	const persisted: any[] = [];
	const store = {
		updateGroup: (_scope: string, _access: any, name: string, def: any) => {
			persisted.push(def.models.at(-1));
			groups = [group(name, { scope: "project", models: def.models })];
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const models = Array.from({ length: 3 }, (_, index) => ({ provider: "openai", id: `model-${index}`, reasoning: false }));
	const c = atSearchableModel(models, store);
	pressAndRender(c, ENTER);
	assert.match(rendered(c), /Add model — Step 3\/3 Thinking/);

	for (const input of [LEFT, DOWN, ENTER]) c.handleInput?.(input);
	assert.match(rendered(c), /Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	assert.deepEqual(persisted, [{ provider: "openai", modelId: "model-1" }]);
});

test("model groups TUI keeps Model selection live across rapid query, navigation, and selection before render", () => {
	let groups = [group("review", { scope: "project" })];
	const persisted: any[] = [];
	const store = {
		updateGroup: (_scope: string, _access: any, name: string, def: any) => {
			persisted.push(def.models.at(-1));
			groups = [group(name, { scope: "project", models: def.models })];
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const models = Array.from({ length: 3 }, (_, index) => ({ provider: "openai", id: `model-${index}`, reasoning: false }));
	const c = atSearchableModel(models, store);

	for (const input of ["m", "o", "d", "e", "l", DOWN, ENTER]) c.handleInput?.(input);
	assert.match(rendered(c), /Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	assert.deepEqual(persisted, [{ provider: "openai", modelId: "model-1" }]);
});

test("model groups TUI Model SelectList keeps all results behind a ten-row viewport and owns wrapping", () => {
	const models = Array.from({ length: 12 }, (_, index) => ({ provider: "openai", id: `model-${String(index).padStart(2, "0")}`, reasoning: true }));
	const c = atSearchableModel(models);
	let text = rendered(c);
	assert.match(text, /model-00/);
	assert.match(text, /model-09/);
	assert.doesNotMatch(text, /model-10|model-11/);
	assert.match(text, /\(1\/12\)/);

	pressAndRender(c, UP);
	text = rendered(c);
	assert.match(text, /→ openai\/model-11/);
	assert.match(text, /\(12\/12\)/);
	pressAndRender(c, DOWN);
	assert.match(rendered(c), /→ openai\/model-00/);
	pressAndRender(c, ...Array(10).fill(DOWN));
	assert.match(rendered(c), /→ openai\/model-10/);
});

test("model groups TUI Model Input directly proves every nonempty, cursor-start, empty, and Esc branch", () => {
	const models = Array.from({ length: 4 }, (_, index) => ({ provider: "openai", id: `model-${index}`, reasoning: true }));

	const cursorMiddle = atSearchableModel(models);
	pressAndRender(cursorMiddle, ..."model", DOWN, DOWN, LEFT);
	assert.match(rendered(cursorMiddle), /Add model — Step 2\/3 Model/);
	assert.match(rendered(cursorMiddle), /→ openai\/model-2/); // Left moved only the Input cursor.
	pressAndRender(cursorMiddle, BACKSPACE);
	assert.match(rendered(cursorMiddle), /→ openai\/model-0/); // A real middle-of-query mutation resets selection.

	for (const key of [LEFT, BACKSPACE]) {
		const cursorStart = atSearchableModel(models);
		pressAndRender(cursorStart, ..."model", ...Array(5).fill(LEFT), DOWN, DOWN, key);
		assert.match(rendered(cursorStart), /→ openai\/model-2/); // Cursor-start key left query and selection unchanged.
		assert.match(rendered(cursorStart), /Add model — Step 2\/3 Model/);
	}

	const oneCharacter = atSearchableModel(models);
	pressAndRender(oneCharacter, "m", BACKSPACE);
	assert.match(rendered(oneCharacter), /Add model — Step 2\/3 Model/);
	assert.match(rendered(oneCharacter), /openai\/model-3/); // The now-empty query exposes the full set.
	pressAndRender(oneCharacter, BACKSPACE);
	assert.match(rendered(oneCharacter), /Step 1\/3 Provider/);

	for (const key of [LEFT, BACKSPACE]) {
		const emptyQuery = atSearchableModel(models);
		pressAndRender(emptyQuery, key);
		assert.match(rendered(emptyQuery), /Step 1\/3 Provider/);
	}
	for (const query of ["", "m"]) {
		const escaped = atSearchableModel(models);
		pressAndRender(escaped, ...query, ESC);
		assert.match(rendered(escaped), /Step 1\/3 Provider/);
	}
});

test("model groups TUI directly proves query preservation and every abandonment, completion, exit, and reopen clear boundary", () => {
	let groups = [group("review", { scope: "project" })];
	const models = [{ provider: "openai", id: "search-target", reasoning: true }];
	const store = {
		updateGroup: (_scope: string, _access: any, name: string, def: any) => { groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};

	const thinkingBack = atSearchableModel(models, store);
	pressAndRender(thinkingBack, ..."target", ENTER, LEFT);
	assert.match(rendered(thinkingBack), /Step 2\/3 Model/);
	assert.match(rendered(thinkingBack), /> target/);

	const abandonedAndExited = atSearchableModel(models, store);
	pressAndRender(abandonedAndExited, ..."target", ESC);
	assert.match(rendered(abandonedAndExited), /Step 1\/3 Provider/);
	pressAndRender(abandonedAndExited, ESC);
	assert.match(rendered(abandonedAndExited), /Model Group: review/);
	pressAndRender(abandonedAndExited, ...Array(5).fill(DOWN), ENTER, ENTER);
	assert.match(rendered(abandonedAndExited), /Step 2\/3 Model/);
	assert.doesNotMatch(rendered(abandonedAndExited), /> target/);

	const completedAndReopened = atSearchableModel(models, store);
	pressAndRender(completedAndReopened, ..."target", ENTER, ENTER);
	assert.match(rendered(completedAndReopened), /Model Group: review/);
	pressAndRender(completedAndReopened, ...Array(5).fill(DOWN), ENTER, ENTER);
	assert.match(rendered(completedAndReopened), /Step 2\/3 Model/);
	assert.doesNotMatch(rendered(completedAndReopened), /> target/);
});

test("model groups TUI persists exact raw identity from both filtered/reordered and offscreen selections", () => {
	let groups = [group("review", { scope: "project" })];
	const persisted: any[] = [];
	const store = {
		updateGroup: (_scope: string, _access: any, name: string, def: any) => { persisted.push(def.models.at(-1)); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};

	const filteredModels = [
		{ provider: "raw-provider", id: "z-last\u001b", name: "needle exact", reasoning: false },
		{ provider: "raw-provider", id: "a-first", name: "unrelated", reasoning: false },
	];
	const filtered = atSearchableModel(filteredModels, store);
	pressAndRender(filtered, ..."needle", ENTER, ENTER);
	assert.deepEqual(persisted[0], { provider: "raw-provider", modelId: "z-last\u001b" });

	const offscreenModels = Array.from({ length: 12 }, (_, index) => ({ provider: "raw-provider", id: `raw/${String(index).padStart(2, "0")}\u001b`, name: `match ${index}`, reasoning: false }));
	const offscreen = atSearchableModel(offscreenModels, store);
	pressAndRender(offscreen, ..."match", ...Array(11).fill(DOWN), ENTER, ENTER);
	assert.deepEqual(persisted[1], { provider: "raw-provider", modelId: "raw/11\u001b" });
});

test("model groups TUI directly proves every non-Model screen remains search-free and uncapped", () => {
	const models = Array.from({ length: 12 }, (_, index) => ({ provider: `provider-${String(index).padStart(2, "0")}`, id: "only-model", reasoning: true }));
	const existingModels = models.map((model) => ({ provider: model.provider, modelId: model.id }));
	const groups = Array.from({ length: 12 }, (_, index) => group(`group-${String(index).padStart(2, "0")}`, { scope: "project", models: index === 0 ? existingModels : [] }));
	const c = component({ groups, modelRegistry: catalog(models) }).c;
	c.focused = true;
	assert.match(rendered(c), /group-11/); // LIST retains its full native viewport.
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
	pressAndRender(c, ENTER);
	assert.match(rendered(c), /provider-11\/only-model/); // EDITOR remains uncapped.
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
	pressAndRender(c, DOWN, DOWN, DOWN, DOWN, ENTER);
	assert.match(rendered(c), /Edit model/); // MODEL_EDIT.
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
	pressAndRender(c, ESC, ...Array(20).fill(DOWN), ENTER);
	let text = rendered(c);
	assert.match(text, /Step 1\/3 Provider/); // WIZARD_PROVIDER remains uncapped.
	assert.match(text, /provider-11/);
	assert.equal(text.includes(CURSOR_MARKER), false);
	pressAndRender(c, ENTER);
	assert.equal(rendered(c).includes(CURSOR_MARKER), true); // Search exists only on WIZARD_MODEL.
	pressAndRender(c, ENTER);
	assert.match(rendered(c), /Step 3\/3 Thinking/); // WIZARD_THINKING.
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);

	const deletion = component({ groups: [groups[0]], modelRegistry: catalog(models) }).c;
	deletion.focused = true;
	pressAndRender(deletion, "D");
	assert.match(rendered(deletion), /Delete Model Group/); // DELETE_CONFIRM.
	assert.equal(rendered(deletion).includes(CURSOR_MARKER), false);
});

test("model groups TUI focus follows root loss and Model, Thinking, Provider screen transitions", () => {
	const models = [{ provider: "openai", id: "model", reasoning: true }];
	const c = atSearchableModel(models);
	c.focused = true;
	assert.equal(rendered(c).includes(CURSOR_MARKER), true);
	c.focused = false;
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
	c.focused = true;
	assert.equal(rendered(c).includes(CURSOR_MARKER), true);
	pressAndRender(c, ENTER);
	assert.match(rendered(c), /Step 3\/3 Thinking/);
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
	pressAndRender(c, LEFT);
	assert.equal(rendered(c).includes(CURSOR_MARKER), true);
	pressAndRender(c, ESC);
	assert.match(rendered(c), /Step 1\/3 Provider/);
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
});

test("model groups TUI focuses the searchable Model Input only on the focused Model screen and keeps rendering safe", () => {
	const models = [{ provider: "openai\u001b[31m", id: "a-very-long-model-id\nline", name: "find-me", reasoning: true }];
	const c = atSearchableModel(models);
	c.focused = true;
	let text = rendered(c, 18);
	assert.equal(text.includes(CURSOR_MARKER), true);
	assert.equal(c.render(18).every((line) => visibleWidth(line) <= 18), true);
	assert.doesNotMatch(text, /\u001b\[31m.*a-very/);
	pressAndRender(c, ESC);
	assert.equal(rendered(c).includes(CURSOR_MARKER), false);
});

test("model groups TUI model picker preserves the id tail behind an ellipsis and shows the full id in the Selected detail", () => {
	const models = [
		{ provider: "openai", id: "gpt-5.2-codex-2025-07-01-rc1", name: "GPT-5.2 Codex", reasoning: true },
		{ provider: "openai", id: "o3-pro-2025-04-16-nightly-build", name: "O3 Pro", reasoning: true },
		{ provider: "openai", id: "gpt-4o", reasoning: true },
	];
	const c = atSearchableModel(models);
	pressAndRender(c, DOWN); // select the long-id row so the detail shows it
	// Narrow terminal: rows keep the provider and the distinguishing id tail, cut head-first with a visible ellipsis.
	const narrow = stripAnsi(rendered(c, 36));
	assert.match(narrow, /…/, "truncation is marked with a visible ellipsis");
	assert.match(narrow, /openai\/…/, "provider stays on truncated rows");
	assert.match(narrow, /openai\/…5\.2-codex-2025-07-01-rc1/, "the distinguishing id suffix survives truncation");
	assert.match(narrow, /openai\/…2025-04-16-nightly-build/, "second row keeps its own tail");
	assert.match(narrow, /openai\/gpt-4o/, "short ids stay untouched");
	assert.match(narrow, /Selected:/);
	// The detail block shows the full id whenever it fits the terminal (width 44 here).
	const mid = stripAnsi(rendered(c, 44));
	assert.match(mid, /openai\/gpt-5\.2-codex-2025-07-01-rc1/, "detail shows the full id even when the row truncates");
	// Wide terminal: rows and the detail show the full identity.
	const wide = stripAnsi(rendered(c, 100));
	assert.doesNotMatch(wide, /…/, "no ellipsis when everything fits");
	assert.match(wide, /openai\/gpt-5\.2-codex-2025-07-01-rc1/);
	assert.match(wide, /openai\/o3-pro-2025-04-16-nightly-build/);
	assert.match(wide, /GPT-5\.2 Codex/, "detail shows the display name");
});

test("model groups TUI model picker detail keeps a width-bounded fixed line count and hides with no matches", () => {
	const models = [
		{ provider: "openai", id: "gpt-5.2-codex-2025-07-01-rc1", name: "GPT-5.2 Codex", reasoning: true },
		{ provider: "openai", id: "o3-pro-2025-04-16-nightly-build", name: "O3 Pro", reasoning: true },
	];
	const c = atSearchableModel(models);
	const wideLines = c.render(200);
	const narrowLines = c.render(12);
	assert.equal(narrowLines.length, wideLines.length, "detail block must not wrap: same line count at any width");
	assert.ok(narrowLines.every((line) => visibleWidth(line) <= 12), "every line bounded at 12 cols");
	assert.match(stripAnsi(narrowLines.join("\n")), /…/);
	assert.match(stripAnsi(wideLines.join("\n")), /openai\/gpt-5\.2-codex-2025-07-01-rc1/);
	// No matches: the detail block disappears.
	pressAndRender(c, ..."zzz");
	assert.match(rendered(c), /No matching models/);
	assert.doesNotMatch(rendered(c), /Selected:/);
});

test("model groups TUI persistence notifications escape each hostile dynamic field", () => {
	const notifications: string[] = [];
	const raw = "\n\u001b]8;;https://example.test\u0007field";
	const c = component({
		groups: [group("review", { scope: "project" })],
		store: {
			renameGroup: () => { throw new ModelGroupsPersistenceError({ operation: "save", scope: "project", sourcePath: `source${raw}`, targetPath: `target${raw}`, phase: "rename", message: `message${raw}`, cause: new Error(`cause${raw}`) }); },
			listResolvedModelGroups: () => boot([group("review", { scope: "project" })]),
		},
		notify: (message) => notifications.push(message),
	}).c;
	press(c, ENTER, DOWN, DOWN, ENTER, "x", ENTER);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /source\\n\\x1B/);
	assert.match(notifications[0], /target\\n\\x1B/);
	assert.match(notifications[0], /message\\n\\x1B/);
	assert.match(notifications[0], /cause\\n\\x1B/);
	assert.doesNotMatch(notifications[0], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
});
