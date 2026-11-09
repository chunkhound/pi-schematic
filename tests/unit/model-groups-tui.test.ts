import { expect, test } from "vitest";
import { CURSOR_MARKER, fuzzyFilter, visibleWidth } from "@earendil-works/pi-tui";
import { createModelGroupsComponent } from "../../model-groups/tui.js";
import { ModelGroupsPersistenceError, type ModelGroupsBootValidation, type ResolvedModelGroup } from "../../model-groups/types.js";
import { assertPresent } from "../assertions.js";
import { stripAnsi, theme } from "./helpers.js";
import { group } from "./model-groups-helpers.js";

const GPT5_THINKING_OPTIONS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
	expect.unreachable(`did not select rendered label: ${label}`);
}

function openModelEdit(c: Parameters<typeof selectRenderedLabel>[0], modelLabel: string): void {
	press(c, ENTER);                       // LIST → open the selected group editor
	selectRenderedLabel(c, modelLabel);    // EDITOR → put the cursor on the model row
	press(c, ENTER);                       // EDITOR → MODEL_EDIT
}

function openAddModelWizard(c: Parameters<typeof selectRenderedLabel>[0]): void {
	press(c, ENTER);                       // LIST → open the selected group editor
	selectRenderedLabel(c, "+ Add model"); // EDITOR → the add-model row
	press(c, ENTER);                       // EDITOR → WIZARD_PROVIDER
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
	expect(rendered(c)).toMatch(/Add model — Step 2\/3 Model/);
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
	expect(lines).toMatch(/Boot validation: 1 unavailable model references · 1 project overrides/);
	expect(lines).toMatch(/project override/);
	expect(lines).toMatch(/⚠ degraded/);
	expect(lines).toMatch(/✗ unavailable/);
	expect(lines).toMatch(/\+ Add group/);
	expect(lines).not.toMatch(/Validate/);
	c.handleInput?.("D");
	lines = c.render(100).join("\n");
	expect(lines).toMatch(/Delete Model Group/);
	expect(lines).toMatch(/Same-name group in the other scope remains unaffected/);
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\r");
	expect(deleteCalls).toStrictEqual(["global:review"]);
	expect(c.render(100).join("\n")).not.toMatch(/Delete Model Group/);
});

test("model groups TUI renders modality labels, warnings, and stale override choices", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	review.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	review.constraints = { modalities: ["text", "image", "reasoning"] };
	review.validation.emptyCommonModalities = true;
	review.validation.unsupportedOverrideModalities = ["reasoning"];
	const { c } = component({ groups: [review] });
	const reviewRow = stripAnsi(rendered(c, 200)).split("\n").find((line) => line.includes("review"));
	assertPresent(reviewRow, "expected review row");
	expect(reviewRow).toMatch(/\bT\b/);
	expect(reviewRow).toMatch(/\bI\b/);
	expect(reviewRow).toMatch(/models .*?T I[\s]*/);
	expect(rendered(c, 200)).toMatch(/⚠ no common modalities/);
	expect(rendered(c, 200)).toMatch(/⚠ stale modality override: reasoning/);
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Supported by every model: text/);
	expect(rendered(c)).toMatch(/Modalities: Override \(text, image\)/);
	expect(rendered(c)).toMatch(/Capabilities/);
	expect(rendered(c)).toMatch(/Models/);
	press(c, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/T text  \[required\]/);
	expect(rendered(c)).toMatch(/I image  \[on\]/);
	// The group carries a persisted override (text, image, reasoning) → status reflects it.
	expect(rendered(c)).toMatch(/Override — media limited to text, image/);
	expect(rendered(c)).not.toMatch(/reasoning/);
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
	expect(rendered(c)).toMatch(/Add model — Step 1\/3 Provider/);
	pressAndRender(c, DOWN, ENTER);
	const text = rendered(c);
	expect(text).toMatch(/Add model — Step 2\/3 Model/);
	// Capable members show colored T/I chips; the unauthenticated model is not selectable.
	expect(text).not.toMatch(/gpt-no-auth/);
	const stripped = stripAnsi(text);
	expect(stripped).toMatch(/openai\/gpt-text\s+T/);
	expect(stripped).toMatch(/openai\/gpt-vision\s+T I/);
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
	expect(editor).toMatch(/openai\/gpt-text\s+T\s+\(available/);
	expect(editor).toMatch(/openai\/gpt-vision\s+T I\s+\(available/);
	expect(editor).not.toMatch(/gpt-missing/);
	// Hand-editing modalities surfaces a dynamic status for Automatic vs Override.
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const modalities = stripAnsi(rendered(c));
	// Text is a non-toggleable required base; no Automatic selector row remains.
	expect(modalities).toMatch(/T text  \[required\]/);
	expect(modalities).toMatch(/Automatic — using every capability its members support/);
	expect(modalities).not.toMatch(/Automatic \(/);
	expect(modalities).not.toMatch(/required base/);
	// Single editable row: compact footer without arrow-nav; no per-row hint.
	expect(modalities).toMatch(/Enter\/Space toggle • Esc back/);
	expect(modalities).not.toMatch(/↑↓ navigate/);
	expect(modalities).not.toMatch(/Enter\/Space toggles/);
	expect(modalities).toMatch(/I image  \[on\]/);
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	const afterOverride = stripAnsi(rendered(c));
	expect(afterOverride).toMatch(/Override — media limited to text/);
	expect(afterOverride).toMatch(/I image  \[off\]/);
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
	expect(rendered(c)).toMatch(/Modalities/);
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].def.constraints.modalities).toStrictEqual(["text", "reasoning"]);
	expect(calls[0].def.opaqueTopLevel, "TUI edits retain opaque top-level group keys").toStrictEqual({ preserve: true });
	expect(rendered(c), "toggle stays on the modalities screen").toMatch(/Modalities/);
	expect(rendered(c)).toMatch(/I image  \[off\]/);
	expect(rendered(c)).toMatch(/Override — media limited to text/);
	// Re-enabling the capability back to the full union returns the group to Automatic
	// (no stored override, so no spawn ceiling attaches to a non-limit).
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	expect(calls.length).toBe(2);
	expect(calls[1].def.constraints?.modalities).toBeUndefined();
	expect(rendered(c), "re-enable also stays on the modalities screen").toMatch(/Modalities/);
	expect(rendered(c)).toMatch(/Automatic — using every capability its members support/);
	press(c, ESC);
	expect(rendered(c)).toMatch(/Modalities: Automatic \(text, image\)/);
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
	expect(rendered(c)).toMatch(/Modalities/);
	selectRenderedLabel(c, "I image");
	press(c, " ");
	expect(calls.length).toBe(1);
	expect(calls[0].def.constraints.modalities).toStrictEqual(["text"]);
	expect(rendered(c), "space toggle stays on the modalities screen").toMatch(/Modalities/);
	expect(rendered(c)).toMatch(/I image  \[off\]/);
});

test("model groups TUI modality editor preserves state and notifies on updateGroup failure", () => {
	const review = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	review.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text"] };
	const messages: string[] = [];
	let failing = true;
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => {
			if (failing) throw new ModelGroupsPersistenceError({ operation: "save", scope: "project", sourcePath: "/tmp/.pi/pi-schematic/model-groups.json", phase: "rename", message: "modality write denied" });
			review.constraints = def.constraints ? { ...def.constraints, ...(Array.isArray(def.constraints.modalities) ? { modalities: [...def.constraints.modalities] } : {}) } : undefined;
		},
		listResolvedModelGroups: () => boot([review]),
	};
	const { c } = component({ groups: [review], store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, ENTER); // open Modalities
	press(c, ENTER); // toggle the single media row → updateGroup throws
	expect(messages).toContainEqual(expect.stringMatching(/modality write denied/));
	expect(rendered(c), "screen retained after failure").toMatch(/Modalities/);
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
	expect(screen).toMatch(/T text  \[required\]/);
	expect(screen).toMatch(/No optional media capabilities available/);
	expect(screen).toMatch(/Automatic — using every capability its members support/);
	expect(screen).toMatch(/Esc back/);
	expect(screen).not.toMatch(/Enter\/Space toggle/);
	expect(screen).not.toMatch(/Enter\/Space toggles/);
	expect(screen).not.toMatch(/→/);
	// Enter/Space on the inert row must not persist anything.
	press(c, ENTER, " ", ENTER);
	expect(updateCalls).toBe(0);
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
	expect(screen).toMatch(/Modalities — empty/);
	expect(screen, "empty groups must not claim the text base capability").not.toMatch(/text  \[required\]/);
	expect(screen).toMatch(/No optional media capabilities available/);
	expect(screen).toMatch(/Automatic — using every capability its members support/);
	expect(screen).toMatch(/Esc back/);
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
	expect(calls).toStrictEqual(["project:new-group-2:0"]);
	expect(c.render(100).join("\n")).toMatch(/Model Group: new-group-2/);
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
				sourcePath: "/tmp/project/.pi/pi-schematic/model-groups.json",
				phase: "rename",
				message: "add failed",
			});
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	expect(text).toMatch(/Add model — Step 1\/3 Provider/);
	expect(text).toMatch(/anthropic/);
	expect(text).toMatch(/openai/);
	expect(text).not.toMatch(/google/);
	expect(text).not.toMatch(/Step 4/);

	press(c, DOWN, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Add model — Step 2\/3 Model/);
	expect(text).toMatch(/openai\/gpt-5/);
	expect(text).not.toMatch(/openai\/gpt-no-auth/);
	expect(text).not.toMatch(/anthropic\/claude/);
	expect(text).not.toMatch(/Step 4/);

	press(c, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Add model — Step 3\/3 Thinking/);
	for (const option of GPT5_THINKING_OPTIONS) {
		expect(text).toMatch(new RegExp(`\\b${option}\\b`));
	}
	expect(text).not.toMatch(/Step 4/);

	press(c, ENTER);
	expect(updateCalls).toBe(1);
	expect(messages.length).toBe(1);
	expect(messages[0]).toMatch(/save failed at rename for project scope/);
	expect(messages[0]).toMatch(/add failed/);
	text = rendered(c);
	expect(text).toMatch(/Add model — Step 3\/3 Thinking/);
	expect(text).not.toMatch(/Model Group: review/);
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
	expect(rendered(providerEsc)).toBe(rendered(providerLeft));
	expect(rendered(providerEscKitty)).toBe(rendered(providerLeft));
	expect(rendered(providerEsc)).toMatch(/Model Group: review/);

	const modelEsc = atModel();
	const modelLeft = atModel();
	press(modelEsc, ESC);
	press(modelLeft, LEFT);
	expect(rendered(modelEsc)).toBe(rendered(modelLeft));
	expect(rendered(modelEsc)).toMatch(/Add model — Step 1\/3 Provider/);

	const thinkingEsc = atThinking();
	const thinkingLeft = atThinking();
	const thinkingLeftSs3 = atThinking();
	press(thinkingEsc, ESC);
	press(thinkingLeft, LEFT);
	press(thinkingLeftSs3, LEFT_SS3);
	expect(rendered(thinkingEsc)).toBe(rendered(thinkingLeft));
	expect(rendered(thinkingLeftSs3)).toBe(rendered(thinkingLeft));
	expect(rendered(thinkingEsc)).toMatch(/Add model — Step 2\/3 Model/);
});

test("model groups TUI selected markers and primary labels use accent token", () => {
	const accentTheme = {
		fg: (name: string, text: string) => name === "accent" ? `<accent>${text}</accent>` : text,
		bold: (text: string) => text,
	};
	const list = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;

	let text = rendered(list);
	expect(text).toMatch(/<accent>→ review\s+\[project\] 1 models inherit<\/accent>/);
	press(list, DOWN);
	expect(rendered(list)).toMatch(/<accent>→ \+ Add group<\/accent>/);

	const editor = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;
	press(editor, ENTER);
	text = rendered(editor);
	expect(text).toMatch(/<accent>→<\/accent> <accent>Location: project<\/accent> ✓/);
	press(editor, DOWN, DOWN, DOWN, DOWN);
	expect(rendered(editor)).toMatch(/<accent>→<\/accent> <accent>openai\/gpt-5<\/accent> \(available/);
	press(editor, DOWN);
	expect(rendered(editor)).toMatch(/<accent>→<\/accent> <accent>\+ Add model…<\/accent>/);

	press(editor, ENTER);
	expect(rendered(editor)).toMatch(/<accent>→ anthropic<\/accent>/);

	const modelEdit = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })], renderTheme: accentTheme }).c;
	press(modelEdit, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(modelEdit)).toMatch(/<accent>→<\/accent> <accent>Thinking: inherit<\/accent>/);

	const g = group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] });
	g.modalities = { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] };
	const modalitiesC = component({ groups: [g], renderTheme: accentTheme }).c;
	press(modalitiesC, ENTER, DOWN, DOWN, DOWN, ENTER);
	// The selected capability row is accent-highlighted; the modality letter keeps its own color.
	expect(rendered(modalitiesC)).toMatch(/<accent>→<\/accent> I<accent> image  \[on\]<\/accent>/);
	expect(rendered(modalitiesC)).toMatch(/Enter\/Space toggle • Esc back/);

	const deleteConfirm = component({ groups: [group("review", { scope: "project" })], renderTheme: accentTheme }).c;
	press(deleteConfirm, "D");
	expect(rendered(deleteConfirm)).toMatch(/<accent>→<\/accent> <accent>Keep group<\/accent>/);
	press(deleteConfirm, DOWN);
	expect(rendered(deleteConfirm)).toMatch(/<accent>→<\/accent> <accent>Delete group<\/accent>/);
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
	expect(text).toMatch(/Provider: anthropic/);
	expect(text).toMatch(/Model ID: claude/);
	expect(text).toMatch(/Status: available/);
	expect(text).toMatch(/Thinking: inherit/);
	expect(text.match(/Thinking:/g)?.length).toBe(1);

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Provider: openai/);
	expect(text).toMatch(/Model ID: gpt-5/);
	expect(text).toMatch(/Status: available/);
	for (const option of GPT5_THINKING_OPTIONS) {
		expect(text).toMatch(new RegExp(`Thinking: ${option}`));
	}

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Provider: missing/);
	expect(text).toMatch(/Model ID: nope/);
	expect(text).toMatch(/Status: unavailable/);
	expect(text).toMatch(/Thinking: inherit/);
	expect(text.match(/Thinking:/g)?.length).toBe(1);
});

test("model groups TUI MODEL_EDIT opens on the configured thinking level and preserves it on Enter", () => {
	let groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" }] })];
	const calls: string[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { calls.push(def.models.map((model: any) => `${model.provider}/${model.modelId}/${model.thinkingLevel ?? "inherit"}`).join(",")); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	// EDITOR → first model row → MODEL_EDIT.
	openModelEdit(c, "gpt-5");
	const text = rendered(c);
	expect(text).toMatch(/→ Thinking: high/);
	expect(text).toMatch(/Thinking: high ✓ current/);
	// Enter on the current row must write the same value — never silently reset to inherit.
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Model Group: review/);
	expect(calls).toStrictEqual(["openai/gpt-5/high"]);
});

test("model groups TUI MODEL_EDIT shows an unsupported/unavailable current level as current, unavailable and preserves it", () => {
	// Available model whose configured level is no longer supported (claude has no
	// thinking levels at all) and an unavailable model both keep their value.
	let groups = [group("review", { scope: "project", models: [
		{ provider: "anthropic", modelId: "claude", thinkingLevel: "high" },
		{ provider: "missing", modelId: "nope", thinkingLevel: "max" },
	] })];
	const calls: string[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { calls.push(def.models.map((model: any) => `${model.provider}/${model.modelId}/${model.thinkingLevel ?? "inherit"}`).join(",")); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "claude");
	let text = rendered(c);
	expect(text).toMatch(/→ Thinking: high/);
	expect(text).toMatch(/Thinking: high ⚠ current, unavailable/);
	expect(text).toMatch(/Thinking: inherit/);
	press(c, ENTER);
	expect(calls).toStrictEqual(["anthropic/claude/high,missing/nope/max"]);

	// Second model: unavailable, configured max → still current, unavailable.
	press(c, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Provider: missing/);
	expect(text).toMatch(/→ Thinking: max/);
	expect(text).toMatch(/Thinking: max ⚠ current, unavailable/);
	press(c, ENTER);
	// Assert a NEW persist happened; `calls.at(-1)` alone would also pass if the
	// second Enter did nothing and simply re-read the first call's value.
	expect(calls.length).toBe(2);
	expect(calls.at(-1)).toStrictEqual("anthropic/claude/high,missing/nope/max");
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
	expect(messages).toStrictEqual(["target scope already contains review"]);
	const text = rendered(c);
	expect(text).toMatch(/Model Group: review/);
	expect(text).toMatch(/Location: project ✓/);
	expect(text).not.toMatch(/Location: global ✓/);
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
				sourcePath: "/tmp/project/.pi/pi-schematic/model-groups.json",
				phase: "temp-write",
				message: `update failed ${attemptedModels.length}`,
			});
		},
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, notify: (message) => messages.push(message) });
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER, DOWN, ENTER);
	expect(attemptedModels[0]).toStrictEqual(["openai/gpt-5/off"]);
	expect(messages[0]).toMatch(/update failed 1/);
	let text = rendered(c);
	expect(text).toMatch(/Edit model/);
	expect(text).toMatch(/Provider: openai/);
	expect(text).toMatch(/Model ID: gpt-5/);
	expect(text).not.toMatch(/Model Group: review/);

	press(c, "D");
	expect(attemptedModels[1]).toStrictEqual([]);
	expect(messages[1]).toMatch(/update failed 2/);
	text = rendered(c);
	expect(text).toMatch(/Edit model/);
	expect(text).toMatch(/Provider: openai/);
	expect(text).toMatch(/Remove model/);
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
	expect(text).toMatch(/→ Name: abc/);
	expect(text).not.toMatch(/(?:^|\n)> /);
	expect(text).not.toMatch(/\u001b\[7m/);
	expect(text).not.toContain(CURSOR_MARKER);

	press(c, ENTER, "d"); // D remains literal while the input is active
	text = rendered(c);
	expect(text).toMatch(/→ Name: abcd/);
	expect(text).not.toMatch(/(?:^|\n)> /);
	expect(text).toMatch(/\u001b\[7m/);
	expect(text.split(CURSOR_MARKER).length - 1).toBe(1);

	press(c, LEFT, BACKSPACE);
	expect(stripAnsi(rendered(c)).replaceAll(CURSOR_MARKER, "")).toMatch(/→ Name: abd/);
	press(c, "c", ESC); // Escape commits and exits edit mode
	expect(calls).toStrictEqual(["abc->abcd"]);
	text = rendered(c);
	expect(text).toMatch(/Model Group: abcd/);
	expect(text).toMatch(/  Name: abcd/);
	expect(text).not.toMatch(/\u001b\[7m/);
	expect(text).not.toContain(CURSOR_MARKER);

	press(c, DOWN, DOWN, ENTER, "e", ENTER); // Enter also commits and exits edit mode
	expect(calls).toStrictEqual(["abc->abcd", "abcd->abcde"]);
	expect(rendered(c)).toMatch(/  Name: abcde/);
	expect(rendered(c)).not.toContain(CURSOR_MARKER);

	press(c, DOWN, DOWN, ENTER, "f", DOWN, DOWN); // row-change flushes the pending rename before moving
	expect(calls).toStrictEqual(["abc->abcd", "abcd->abcde", "abcde->abcdef"]);
	text = rendered(c);
	expect(text).toMatch(/Model Group: abcdef/);
	expect(text).toMatch(/→ \+ Add model/);
	expect(text).toMatch(/Name: abcdef/);
	expect(text).not.toMatch(/\u001b\[7m/);
	expect(text).not.toContain(CURSOR_MARKER);
	expect(text).not.toMatch(/Delete Model Group/);
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
	expect(calls[0]).toBe("move:review:global");

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // first model row
	c.handleInput?.("\r"); // model edit
	c.handleInput?.("\u001b[B"); // off
	c.handleInput?.("\r");
	expect(calls.at(-1)!).toMatch(/update:global:review:openai\/gpt-5\/off/);

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // + add model
	press(c, ENTER); // provider step
	expect(rendered(c)).toMatch(/Step 1\/3 Provider/);
	press(c, ENTER); // anthropic provider (sorted first)
	expect(rendered(c)).toMatch(/Step 2\/3 Model/);
	press(c, ENTER); // claude model
	expect(rendered(c)).toMatch(/Step 3\/3 Thinking/);
	press(c, ENTER); // inherit thinking
	expect(calls.at(-1)!).toMatch(/anthropic\/claude\/inherit/);

	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B");
	c.handleInput?.("\u001b[B"); // first model row after refresh
	c.handleInput?.("\r");
	c.handleInput?.("D");
	expect(calls.at(-1)).toMatch(/^update:global:review:/);
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
					sourcePath: "/tmp/project/.pi/pi-schematic/model-groups.json",
					targetPath: "/tmp/project/.pi/pi-schematic/model-groups.json.123.tmp",
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
	expect(messages.length).toBe(1);
	expect(messages[0]).toMatch(/save failed at temp-write for project scope/);
	expect(messages[0]).toMatch(/source: \/tmp\/project\/\.pi\/pi-schematic\/model-groups\.json/);
	expect(messages[0]).toMatch(/target: \/tmp\/project\/\.pi\/pi-schematic\/model-groups\.json\.123\.tmp/);
	expect(messages[0]).toMatch(/collision/);
	const text = c.render(100).join("\n");
	expect(text).toMatch(/Model Group: review/);
	expect(text).toMatch(/→ Name: review/);
	expect(text).not.toContain(CURSOR_MARKER);
});

test("model groups TUI uses root Focusable propagation and MODEL_EDIT parent navigation", () => {
	const c = component({ groups: [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })] }).c;
	c.focused = true;
	press(c, ENTER, DOWN, DOWN, ENTER);
	expect(c.render(80).join("\n")).toContain(CURSOR_MARKER);
	press(c, ENTER);
	expect(c.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	press(c, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Edit model/);
	press(c, ESC);
	expect(rendered(c)).toMatch(/Location: project/);
	expect(rendered(c)).not.toMatch(/Edit model/);
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
	expect(rendered(c)).not.toMatch(/project-secret/);
	press(c, DOWN, DOWN);
	expect(rendered(c)).toMatch(/→ \+ Add group/);
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].scope).toBe("global");
	expect(calls[0].access).toStrictEqual({ cwd: "/tmp/project", policy: "global-only" });
	expect(calls[0].def).toStrictEqual({ models: [] });
	const text = rendered(c);
	expect(text).toMatch(/Location: global/);
	expect(text).not.toMatch(/Location: project/);
});

test("model groups TUI escapes controlled labels, bounds width, and offers native max", () => {
	const hostile = "group\n\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007";
	const c = component({ groups: [group(hostile, { scope: "project", models: [{ provider: "openai\u001b[31m", modelId: "model\nlong" }] })] }).c;
	const lines = c.render(20);
	expect(lines.filter((line) => !(visibleWidth(line) <= 20))).toStrictEqual([]);
	const text = lines.join("\n");
	expect(text).toMatch(/group\\n\\x1B/);
	expect(text).not.toMatch(/\u001b\]8;;/);

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
	expect(rendered(max)).toMatch(/Add model — Step 3\/3 Thinking/);
	expect(rendered(max)).toMatch(/max/);
	press(max, ...Array(20).fill(DOWN), ENTER);
	expect(selectedThinking).toBe("max");
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
		expect(calls).toStrictEqual([`abc->${nextName}`]);
		expect(rendered(c)).toMatch(new RegExp(nextName.replaceAll("_", "\\_")));
		expect(notifications).toStrictEqual([]);
	}

	const malformedCalls: string[] = [];
	const notifications: string[] = [];
	const malformed = component({
		groups: [group("abc", { scope: "project" })],
		store: { renameGroup: () => malformedCalls.push("called"), listResolvedModelGroups: () => boot([group("abc", { scope: "project" })]) },
		notify: (message) => notifications.push(message),
	}).c;
	press(malformed, ENTER, DOWN, DOWN, ENTER, "\\", ESC);
	expect(malformedCalls).toStrictEqual([]);
	expect(notifications.length).toBe(1);
	expect(rendered(malformed)).toMatch(/→ Name: abc/);
	expect(rendered(malformed)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI keeps every screen width-bounded without wrapping logical rows", () => {
	const assertScreen = (c: ReturnType<typeof component>["c"]) => {
		const wideCount = c.render(200).length;
		const narrow = c.render(12);
		expect(narrow.length).toBe(wideCount);
		expect(narrow.filter((line) => !(visibleWidth(line) <= 12))).toStrictEqual([]);
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
		expect(lines.length).toBe(inactiveWideCount);
		expect(lines.filter((line) => !(visibleWidth(line) <= width))).toStrictEqual([]);
		expect(lines.join("\n")).not.toContain(CURSOR_MARKER);
		if (width === 12) expect(stripAnsi(lines.join("\n"))).toMatch(/界e\u0301/);
	}
	press(c, ENTER, "\u0001"); // active group-name input with cursor at line start
	const activeWideCount = c.render(200).length;
	for (const width of [1, 2, 12]) {
		const lines = c.render(width);
		expect(lines.length).toBe(activeWideCount);
		expect(lines.filter((line) => !(visibleWidth(line) <= width))).toStrictEqual([]);
		expect(lines.join("\n")).toContain(CURSOR_MARKER);
		if (width === 12) expect(stripAnsi(lines.join("\n")).replaceAll(CURSOR_MARKER, "")).toMatch(/界e\u0301/);
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
	expect(rendered(c)).toMatch(/→ openai\/alpha-id/);
	expect(rendered(c)).toMatch(/beta-id/);
	expect(rendered(c)).not.toMatch(/hidden|foreign/);

	for (const query of ["alpha-id", "openai/alpha-id", "Friendly"]) {
		const queried = atSearchableModel(models);
		pressAndRender(queried, ...query);
		expect(rendered(queried)).toMatch(/alpha-id/);
		expect(rendered(queried)).not.toMatch(/beta-id/);
	}
	const providerQuery = atSearchableModel(models);
	pressAndRender(providerQuery, ..."openai");
	expect(rendered(providerQuery)).toMatch(/alpha-id/);
	expect(rendered(providerQuery)).toMatch(/beta-id/);

	pressAndRender(c, ..."Friendly impossible");
	expect(rendered(c)).toMatch(/No matching models/);
	const before = rendered(c);
	pressAndRender(c, UP, DOWN, ENTER);
	expect(rendered(c)).toBe(before);
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
	expect(approvedFields.length).toBe(0);
	expect(withSyntheticProviderSpaceId.length).toBe(1);

	const c = atSearchableModel([model]);
	pressAndRender(c, ...query);
	expect(rendered(c)).toMatch(/No matching models/);
	expect(rendered(c)).not.toMatch(/→ abc\/xyz/);
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
	expect(rendered(c)).toMatch(/Add model — Step 1\/3 Provider/);

	for (const input of [ENTER, ENTER]) c.handleInput?.(input);
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "openai", modelId: "model-0" }]);
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
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);

	for (const input of [LEFT, DOWN, ENTER]) c.handleInput?.(input);
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "openai", modelId: "model-1" }]);
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
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "openai", modelId: "model-1" }]);
});

test("model groups TUI Model SelectList keeps all results behind a ten-row viewport and owns wrapping", () => {
	const models = Array.from({ length: 12 }, (_, index) => ({ provider: "openai", id: `model-${String(index).padStart(2, "0")}`, reasoning: true }));
	const c = atSearchableModel(models);
	let text = rendered(c);
	expect(text).toMatch(/model-00/);
	expect(text).toMatch(/model-09/);
	expect(text).not.toMatch(/model-10|model-11/);
	expect(text).toMatch(/\(1\/12\)/);

	pressAndRender(c, UP);
	text = rendered(c);
	expect(text).toMatch(/→ openai\/model-11/);
	expect(text).toMatch(/\(12\/12\)/);
	pressAndRender(c, DOWN);
	expect(rendered(c)).toMatch(/→ openai\/model-00/);
	pressAndRender(c, ...Array(10).fill(DOWN));
	expect(rendered(c)).toMatch(/→ openai\/model-10/);
});

test("model groups TUI Model Input directly proves every nonempty, cursor-start, empty, and Esc branch", () => {
	const models = Array.from({ length: 4 }, (_, index) => ({ provider: "openai", id: `model-${index}`, reasoning: true }));

	const cursorMiddle = atSearchableModel(models);
	pressAndRender(cursorMiddle, ..."model", DOWN, DOWN, LEFT);
	expect(rendered(cursorMiddle)).toMatch(/Add model — Step 2\/3 Model/);
	expect(rendered(cursorMiddle)).toMatch(/→ openai\/model-2/); // Left moved only the Input cursor.
	pressAndRender(cursorMiddle, BACKSPACE);
	expect(rendered(cursorMiddle)).toMatch(/→ openai\/model-0/); // A real middle-of-query mutation resets selection.

	for (const key of [LEFT, BACKSPACE]) {
		const cursorStart = atSearchableModel(models);
		pressAndRender(cursorStart, ..."model", ...Array(5).fill(LEFT), DOWN, DOWN, key);
		expect(rendered(cursorStart)).toMatch(/→ openai\/model-2/); // Cursor-start key left query and selection unchanged.
		expect(rendered(cursorStart)).toMatch(/Add model — Step 2\/3 Model/);
	}

	const oneCharacter = atSearchableModel(models);
	pressAndRender(oneCharacter, "m", BACKSPACE);
	expect(rendered(oneCharacter)).toMatch(/Add model — Step 2\/3 Model/);
	expect(rendered(oneCharacter)).toMatch(/openai\/model-3/); // The now-empty query exposes the full set.
	pressAndRender(oneCharacter, BACKSPACE);
	expect(rendered(oneCharacter)).toMatch(/Step 1\/3 Provider/);

	for (const key of [LEFT, BACKSPACE]) {
		const emptyQuery = atSearchableModel(models);
		pressAndRender(emptyQuery, key);
		expect(rendered(emptyQuery)).toMatch(/Step 1\/3 Provider/);
	}
	for (const query of ["", "m"]) {
		const escaped = atSearchableModel(models);
		pressAndRender(escaped, ...query, ESC);
		expect(rendered(escaped)).toMatch(/Step 1\/3 Provider/);
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
	expect(rendered(thinkingBack)).toMatch(/Step 2\/3 Model/);
	expect(rendered(thinkingBack)).toMatch(/> target/);

	const abandonedAndExited = atSearchableModel(models, store);
	pressAndRender(abandonedAndExited, ..."target", ESC);
	expect(rendered(abandonedAndExited)).toMatch(/Step 1\/3 Provider/);
	pressAndRender(abandonedAndExited, ESC);
	expect(rendered(abandonedAndExited)).toMatch(/Model Group: review/);
	pressAndRender(abandonedAndExited, ...Array(5).fill(DOWN), ENTER, ENTER);
	expect(rendered(abandonedAndExited)).toMatch(/Step 2\/3 Model/);
	expect(rendered(abandonedAndExited)).not.toMatch(/> target/);

	const completedAndReopened = atSearchableModel(models, store);
	pressAndRender(completedAndReopened, ..."target", ENTER, ENTER);
	expect(rendered(completedAndReopened)).toMatch(/Model Group: review/);
	pressAndRender(completedAndReopened, ...Array(5).fill(DOWN), ENTER, ENTER);
	expect(rendered(completedAndReopened)).toMatch(/Step 2\/3 Model/);
	expect(rendered(completedAndReopened)).not.toMatch(/> target/);
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
	expect(persisted[0]).toStrictEqual({ provider: "raw-provider", modelId: "z-last\u001b" });

	const offscreenModels = Array.from({ length: 12 }, (_, index) => ({ provider: "raw-provider", id: `raw/${String(index).padStart(2, "0")}\u001b`, name: `match ${index}`, reasoning: false }));
	const offscreen = atSearchableModel(offscreenModels, store);
	pressAndRender(offscreen, ..."match", ...Array(11).fill(DOWN), ENTER, ENTER);
	expect(persisted[1]).toStrictEqual({ provider: "raw-provider", modelId: "raw/11\u001b" });
});

test("model groups TUI directly proves every non-Model screen remains search-free and uncapped", () => {
	const models = Array.from({ length: 12 }, (_, index) => ({ provider: `provider-${String(index).padStart(2, "0")}`, id: "only-model", reasoning: true }));
	const existingModels = models.map((model) => ({ provider: model.provider, modelId: model.id }));
	const groups = Array.from({ length: 12 }, (_, index) => group(`group-${String(index).padStart(2, "0")}`, { scope: "project", models: index === 0 ? existingModels : [] }));
	const c = component({ groups, modelRegistry: catalog(models) }).c;
	c.focused = true;
	expect(rendered(c)).toMatch(/group-11/); // LIST retains its full native viewport.
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/provider-11\/only-model/); // EDITOR remains uncapped.
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Edit model/); // MODEL_EDIT.
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, ESC, ...Array(20).fill(DOWN), ENTER);
	let text = rendered(c);
	expect(text).toMatch(/Step 1\/3 Provider/); // WIZARD_PROVIDER remains uncapped.
	expect(text).toMatch(/provider-11/);
	expect(text).not.toContain(CURSOR_MARKER);
	pressAndRender(c, ENTER);
	expect(rendered(c)).toContain(CURSOR_MARKER); // Search exists only on WIZARD_MODEL.
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/Step 3\/3 Thinking/); // WIZARD_THINKING.
	expect(rendered(c)).not.toContain(CURSOR_MARKER);

	const deletion = component({ groups: [groups[0]], modelRegistry: catalog(models) }).c;
	deletion.focused = true;
	pressAndRender(deletion, "D");
	expect(rendered(deletion)).toMatch(/Delete Model Group/); // DELETE_CONFIRM.
	expect(rendered(deletion)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI focus follows root loss and Model, Thinking, Provider screen transitions", () => {
	const models = [{ provider: "openai", id: "model", reasoning: true }];
	const c = atSearchableModel(models);
	c.focused = true;
	expect(rendered(c)).toContain(CURSOR_MARKER);
	c.focused = false;
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
	c.focused = true;
	expect(rendered(c)).toContain(CURSOR_MARKER);
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/Step 3\/3 Thinking/);
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, LEFT);
	expect(rendered(c)).toContain(CURSOR_MARKER);
	pressAndRender(c, ESC);
	expect(rendered(c)).toMatch(/Step 1\/3 Provider/);
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI focuses the searchable Model Input only on the focused Model screen and keeps rendering safe", () => {
	const models = [{ provider: "openai\u001b[31m", id: "a-very-long-model-id\nline", name: "find-me", reasoning: true }];
	const c = atSearchableModel(models);
	c.focused = true;
	let text = rendered(c, 18);
	expect(text).toContain(CURSOR_MARKER);
	expect(c.render(18).filter((line) => !(visibleWidth(line) <= 18))).toStrictEqual([]);
	expect(text).not.toMatch(/\u001b\[31m.*a-very/);
	pressAndRender(c, ESC);
	expect(rendered(c)).not.toContain(CURSOR_MARKER);
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
	expect(narrow, "truncation is marked with a visible ellipsis").toMatch(/…/);
	expect(narrow, "provider stays on truncated rows").toMatch(/openai\/…/);
	expect(narrow, "the distinguishing id suffix survives truncation").toMatch(/openai\/…5\.2-codex-2025-07-01-rc1/);
	expect(narrow, "second row keeps its own tail").toMatch(/openai\/…2025-04-16-nightly-build/);
	expect(narrow, "short ids stay untouched").toMatch(/openai\/gpt-4o/);
	expect(narrow).toMatch(/Selected:/);
	// The detail block shows the full id whenever it fits the terminal (width 44 here).
	const mid = stripAnsi(rendered(c, 44));
	expect(mid, "detail shows the full id even when the row truncates").toMatch(/openai\/gpt-5\.2-codex-2025-07-01-rc1/);
	// Wide terminal: rows and the detail show the full identity.
	const wide = stripAnsi(rendered(c, 100));
	expect(wide, "no ellipsis when everything fits").not.toMatch(/…/);
	expect(wide).toMatch(/openai\/gpt-5\.2-codex-2025-07-01-rc1/);
	expect(wide).toMatch(/openai\/o3-pro-2025-04-16-nightly-build/);
	expect(wide, "detail shows the display name").toMatch(/GPT-5\.2 Codex/);
});

test("model groups TUI model picker detail keeps a width-bounded fixed line count and hides with no matches", () => {
	const models = [
		{ provider: "openai", id: "gpt-5.2-codex-2025-07-01-rc1", name: "GPT-5.2 Codex", reasoning: true },
		{ provider: "openai", id: "o3-pro-2025-04-16-nightly-build", name: "O3 Pro", reasoning: true },
	];
	const c = atSearchableModel(models);
	const wideLines = c.render(200);
	const narrowLines = c.render(12);
	expect(narrowLines.length, "detail block must not wrap: same line count at any width").toBe(wideLines.length);
	expect(narrowLines.filter((line) => !(visibleWidth(line) <= 12)), "every line bounded at 12 cols").toStrictEqual([]);
	expect(stripAnsi(narrowLines.join("\n"))).toMatch(/…/);
	expect(stripAnsi(wideLines.join("\n"))).toMatch(/openai\/gpt-5\.2-codex-2025-07-01-rc1/);
	// No matches: the detail block disappears.
	pressAndRender(c, ..."zzz");
	expect(rendered(c)).toMatch(/No matching models/);
	expect(rendered(c)).not.toMatch(/Selected:/);
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
	expect(notifications.length).toBe(1);
	expect(notifications[0]).toMatch(/source\\n\\x1B/);
	expect(notifications[0]).toMatch(/target\\n\\x1B/);
	expect(notifications[0]).toMatch(/message\\n\\x1B/);
	expect(notifications[0]).toMatch(/cause\\n\\x1B/);
	expect(notifications[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
});

// ── #29 red-first: MODEL_EDIT opens on the current thinking level ──────────────

test("model groups TUI MODEL_EDIT opens on a mid-list configured level and marks only that row current", () => {
	const groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => { calls.push(def); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	// EDITOR → first model row → MODEL_EDIT.
	openModelEdit(c, "gpt-5");
	const text = rendered(c);
	// Cursor lands on the configured mid-list level, not on the first (inherit) row.
	expect(text).toMatch(/→ Thinking: medium/);
	expect(text).not.toMatch(/→ Thinking: inherit/);
	// Exactly one row carries the current marker, and it is the configured supported level.
	expect(text.match(/✓ current/g)?.length).toBe(1);
	expect(text).toMatch(/Thinking: medium ✓ current/);
	expect(text).toMatch(/^  Thinking: inherit$/m);
	expect(text).not.toMatch(/Thinking: inherit ✓ current/);
	// Enter on the current row must write the same value — never silently reset to inherit.
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0].thinkingLevel).toBe("medium");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT stale level on an available model keeps its row after inherit and Remove model last", () => {
	let groups = [group("review", { scope: "project", models: [{ provider: "anthropic", modelId: "claude", thinkingLevel: "high" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { calls.push(def); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "claude");
	const text = rendered(c);
	// The configured-but-unsupported value is on screen exactly once, owns the cursor, and is flagged.
	expect(text.match(/Thinking: high/g)?.length).toBe(1);
	expect(text).toMatch(/→ Thinking: high/);
	expect(text).toMatch(/Thinking: high ⚠ current, unavailable/);
	expect(text).toMatch(/^  Thinking: inherit$/m);
	expect(text).not.toMatch(/Thinking: inherit ⚠ current, unavailable/);
	// Row layout: the stale row sits directly after inherit and directly before Remove model.
	const lines = stripAnsi(text).split("\n");
	const inheritRow = lines.findIndex((line) => line.includes("Thinking: inherit"));
	const staleRow = lines.findIndex((line) => line.includes("Thinking: high"));
	const removeRow = lines.findIndex((line) => line.includes("Remove model"));
	expect(staleRow).toBe(inheritRow + 1);
	expect(removeRow).toBe(staleRow + 1);
	const selectedLine = () => stripAnsi(rendered(c)).split("\n").find((line) => line.includes("→"))!;
	// UP → inherit, DOWN walks back through the stale row to Remove model.
	press(c, UP);
	expect(selectedLine()).toMatch(/Thinking: inherit/);
	press(c, DOWN);
	expect(selectedLine()).toMatch(/Thinking: high ⚠ current, unavailable/);
	press(c, DOWN);
	expect(selectedLine()).toMatch(/Remove model/);
	press(c, ENTER);
	// Enter on the final row removes the member in the stale-value case.
	expect(calls.length).toBe(1);
	expect(calls[0].models).toStrictEqual([]);
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT keeps an unsupported level after inherit when the model has other supported rows", () => {
	// The ordering clause only bites when the model offers supported levels besides
	// inherit: with a bare [inherit, stale] list an append-at-end regression renders
	// the identical screen. `thinkingLevelMap` nulls drop specific levels, so this
	// model supports off/minimal/high while the configured `medium` is unsupported.
	const models = [{ provider: "openai", id: "gpt-partial", reasoning: true, thinkingLevelMap: { low: null, medium: null } }];
	let groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-partial", thinkingLevel: "medium" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { calls.push(def); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store, modelRegistry: catalog(models) });
	openModelEdit(c, "gpt-partial");
	const text = rendered(c);
	expect(text.match(/Thinking: medium/g)?.length).toBe(1);
	expect(text).toMatch(/→ Thinking: medium ⚠ current, unavailable/);
	const lines = stripAnsi(text).split("\n");
	const inheritRow = lines.findIndex((line) => line.includes("Thinking: inherit"));
	const staleRow = lines.findIndex((line) => line.includes("Thinking: medium"));
	const supportedRow = lines.findIndex((line) => line.includes("Thinking: high"));
	const removeRow = lines.findIndex((line) => line.includes("Remove model"));
	// The stale row is pinned directly after inherit; supported rows intervene before Remove.
	expect(staleRow).toBe(inheritRow + 1);
	expect(supportedRow, "a supported row must sit between the stale row and Remove model").toBeGreaterThan(staleRow);
	// Regression guard: append-at-end would move the stale row next to Remove model.
	expect(removeRow).not.toBe(staleRow + 1);
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0].thinkingLevel).toBe("medium");
});

test("model groups TUI MODEL_EDIT stale level on an unavailable model keeps Status unavailable and preserves the value", () => {
	const groups = [group("review", { scope: "project", models: [{ provider: "missing", modelId: "nope", thinkingLevel: "max" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => { calls.push(def); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "nope");
	const text = rendered(c);
	expect(text).toMatch(/Status: unavailable/);
	expect(text.match(/Thinking: max/g)?.length).toBe(1);
	expect(text).toMatch(/→ Thinking: max/);
	expect(text).toMatch(/Thinking: max ⚠ current, unavailable/);
	expect(text).toMatch(/^  Thinking: inherit$/m);
	expect(text).not.toMatch(/Thinking: inherit ⚠ current, unavailable/);
	// Enter from the stale row writes the same configured value back.
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0].thinkingLevel).toBe("max");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

// ── #29 green-seal: unchanged wizard / removal / clamp contracts ──────────────

test("model groups TUI WIZARD thinking step still starts on inherit and persists a chosen supported level", () => {
	let groups = [group("review", { scope: "project" })];
	const persisted: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { persisted.push(def.models.at(-1)); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	// EDITOR → + Add model → WIZARD_PROVIDER → openai → WIZARD_MODEL (gpt-5) → WIZARD_THINKING.
	openAddModelWizard(c);
	press(c, DOWN, ENTER);
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	expect(rendered(c)).toMatch(/→ inherit/);
	press(c, DOWN);
	expect(rendered(c)).toMatch(/→ off/);
	press(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "openai", modelId: "gpt-5", thinkingLevel: "off" }]);
});

test("model groups TUI MODEL_EDIT clamps DOWN on Remove model and D removes a stale-valued member", () => {
	let groups = [group("review", { scope: "project", models: [{ provider: "anthropic", modelId: "claude", thinkingLevel: "high" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { calls.push(def); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "claude");
	// DOWN clamps on the final row regardless of how many thinking rows exist.
	press(c, DOWN, DOWN, DOWN, DOWN, DOWN);
	expect(rendered(c)).toMatch(/→ Remove model/);
	expect(rendered(c)).not.toMatch(/→ Thinking: inherit/);
	press(c, "D");
	expect(calls.length).toBe(1);
	expect(calls[0].models).toStrictEqual([]);
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT dropping a stale level back to inherit deliberately persists inherit", () => {
	let groups = [group("review", { scope: "project", models: [{ provider: "anthropic", modelId: "claude", thinkingLevel: "high" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, name: string, def: any) => { calls.push(def); groups = [group(name, { scope: "project", models: def.models })]; },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "claude");
	// Explicitly choosing inherit drops the stale value; this path is already green on
	// the pre-fix baseline, so it is sealed rather than claimed as red-first.
	press(c, UP);
	expect(stripAnsi(rendered(c)).split("\n").find((line) => line.includes("→"))!).toMatch(/Thinking: inherit/);
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0]).not.toHaveProperty("thinkingLevel");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT marks the default inherit row current when no level is configured", () => {
	const groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-5" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => { calls.push(def); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "gpt-5");
	const text = rendered(c);
	// With no configured level, inherit is the current value and the only marked row.
	expect(text).toMatch(/→ Thinking: inherit ✓ current/);
	expect(text.match(/✓ current/g)?.length).toBe(1);
	expect(text).not.toMatch(/⚠ current, unavailable/);
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0]).not.toHaveProperty("thinkingLevel");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT opens on a supported level for a registered-but-unauthenticated model", () => {
	// The model resolves (so its levels are known) but has no configured auth, so
	// Status is unavailable while the configured supportable level is still current.
	const groups = [group("review", { scope: "project", models: [{ provider: "openai", modelId: "gpt-no-auth", thinkingLevel: "high" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => { calls.push(def); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "gpt-no-auth");
	const text = rendered(c);
	expect(text).toMatch(/Status: unavailable/);
	expect(text).toMatch(/→ Thinking: high/);
	expect(text.match(/✓ current/g)?.length).toBe(1);
	expect(text).toMatch(/Thinking: high ✓ current/);
	expect(text).not.toMatch(/⚠ current, unavailable/);
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0].thinkingLevel).toBe("high");
});

test("model groups TUI MODEL_EDIT treats a stale off level on a non-reasoning model as current, unavailable", () => {
	// claude is reasoning:false, so `off` is filtered out of its offered options;
	// the configured value must still be shown and preserved.
	const groups = [group("review", { scope: "project", models: [{ provider: "anthropic", modelId: "claude", thinkingLevel: "off" }] })];
	const calls: any[] = [];
	const store = {
		updateGroup: (_scope: string, _cwd: string, _name: string, def: any) => { calls.push(def); },
		listResolvedModelGroups: () => boot(groups),
	};
	const { c } = component({ groups, store });
	openModelEdit(c, "claude");
	const text = rendered(c);
	expect(text).toMatch(/→ Thinking: off/);
	expect(text).toMatch(/Thinking: off ⚠ current, unavailable/);
	expect(text).toMatch(/^  Thinking: inherit$/m);
	press(c, ENTER);
	expect(calls.length).toBe(1);
	expect(calls[0].models[0].thinkingLevel).toBe("off");
	expect(rendered(c)).toMatch(/Model Group: review/);
});
