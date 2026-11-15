import { expect, test, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences, TuiMainScreen, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createModelGroupsComponent, type ModelGroupsComponentOptions, type ModelGroupsStoreOps } from "../../model-groups/tui.js";
import {
	ModelGroupsPersistenceError,
	type ModelGroupDef,
	type ModelGroupModel,
	type ModelGroupScope,
	type ModelGroupsAccess,
	type ResolvedModelGroup,
} from "../../model-groups/types.js";
import { assertPresent } from "../assertions.js";
import { createModelRegistry } from "../support/model-registry.js";
import { realTheme } from "../support/theme.js";
import { stubInstance } from "../support/guarded.js";
import { resolveGroups, testProvider, type ScopedGroupDefs, type TestChatModel } from "./model-groups-helpers.js";

const GPT5_THINKING_OPTIONS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

// One provider per auth state: `alpha` and `orange` are authenticated, `grape` and `keyless` are not.
function tuiRegistry(): Promise<ModelRegistry> {
	return createModelRegistry({
		alpha: testProvider([{ id: "claude" }], { auth: true }),
		grape: testProvider([{ id: "gemini-no-auth", reasoning: true }], { auth: false }),
		orange: testProvider([{ id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x", max: "m" } }], { auth: true }),
		keyless: testProvider([{ id: "gpt-no-auth", reasoning: true }], { auth: false }),
	});
}

/** A registry model as a test lists it; `auth: false` registers its provider without an API key. */
type CatalogEntry = TestChatModel & { provider: string; auth?: boolean };

function catalog(entries: readonly CatalogEntry[]): Promise<ModelRegistry> {
	const providers = new Map<string, { auth: boolean; models: TestChatModel[] }>();
	for (const { provider, auth = true, ...model } of entries) {
		const entry = providers.get(provider) ?? { auth, models: [] };
		if (entry.auth !== auth) {
			throw new Error(`catalog provider ${provider} mixes auth states; give each auth state its own provider id`);
		}
		entry.models.push(model);
		providers.set(provider, entry);
	}
	return createModelRegistry(Object.fromEntries([...providers].map(([provider, { auth, models }]) => [provider, testProvider(models, { auth })])));
}

// pi-tui has no virtual terminal to construct instead: a TUI whose `requestRender` calls `onRender`; the component uses no other member.
function renderCountingTui(onRender: () => void): TUI {
	return stubInstance(TuiMainScreen.prototype, { requestRender: onRender });
}

// The store's own copy of a def: the runtime fields the component carries on a resolved group are not stored.
function storedDef(def: ModelGroupDef & Partial<ResolvedModelGroup>): ModelGroupDef {
	const { name: _name, scope: _scope, sourcePath: _sourcePath, modalities: _modalities, validation: _validation, evaluations: _evaluations, ...stored } = def;
	return structuredClone(stored);
}

function withoutGroup(groups: Record<string, ModelGroupDef>, name: string): Record<string, ModelGroupDef> {
	return Object.fromEntries(Object.entries(groups).filter(([key]) => key !== name));
}

function withGroup(groups: Record<string, ModelGroupDef>, name: string, def: ModelGroupDef): Record<string, ModelGroupDef> {
	return Object.fromEntries([...Object.entries(withoutGroup(groups, name)), [name, storedDef(def)]]);
}

function otherScope(scope: ModelGroupScope): ModelGroupScope {
	return scope === "global" ? "project" : "global";
}

/** Store operations over in-memory configs; every listing resolves the groups through `validateModelGroups`. */
function memoryStore(initial: ScopedGroupDefs): ModelGroupsStoreOps {
	const defs: Record<ModelGroupScope, Record<string, ModelGroupDef>> = { global: { ...initial.global }, project: { ...initial.project } };
	return {
		listResolvedModelGroups: (access, modelRegistry) => ({
			groups: resolveGroups(modelRegistry, access.policy === "global-only" ? { global: defs.global } : defs),
			loadIssues: [],
		}),
		createGroup: (scope, _access, name, def) => {
			defs[scope] = withGroup(defs[scope], name, def);
		},
		updateGroup: (scope, _access, name, def) => {
			defs[scope] = withGroup(defs[scope], name, def);
		},
		renameGroup: (scope, _access, from, to) => {
			defs[scope] = withGroup(defs[scope], to, defs[scope][from]);
			defs[scope] = withoutGroup(defs[scope], from);
		},
		deleteGroup: (scope, _access, name) => {
			defs[scope] = withoutGroup(defs[scope], name);
			return { otherScopeHasOverride: Object.hasOwn(defs[otherScope(scope)], name) };
		},
		moveGroup: (_access, name, scope) => {
			defs[scope] = withGroup(defs[scope], name, defs[otherScope(scope)][name]);
			defs[otherScope(scope)] = withoutGroup(defs[otherScope(scope)], name);
		},
	};
}

function component(args: {
	registry: ModelRegistry;
	defs?: ScopedGroupDefs;
	store?: (memory: ModelGroupsStoreOps) => Partial<ModelGroupsStoreOps>;
	notify?: ModelGroupsComponentOptions["notify"];
	policy?: ModelGroupsAccess["policy"];
	/** Groups the component opens with, resolved from these defs whatever the access policy; by default the store's listing under that policy. */
	initialDefs?: ScopedGroupDefs;
}) {
	let renders = 0;
	const memory = memoryStore(args.defs ?? {});
	const access: ModelGroupsAccess = { cwd: "/tmp/project", policy: args.policy ?? "global-project" };
	const c = createModelGroupsComponent(
		renderCountingTui(() => {
			renders++;
		}),
		realTheme,
		args.registry,
		access,
		vi.fn(),
		{
			initialValidation:
				args.initialDefs === undefined
					? memory.listResolvedModelGroups(access, args.registry)
					: { groups: resolveGroups(args.registry, args.initialDefs), loadIssues: [] },
			store: { ...memory, ...args.store?.(memory) },
			notify: args.notify,
		},
	);
	return {
		c,
		get renders() {
			return renders;
		},
	};
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

// A focused Input draws its cursor cell between pi-tui's fake-cursor markers; the TUI turns them
// into reverse video only when it writes the frame, so a component render carries the markers.
const FAKE_CURSOR_PARTS = renderFakeCursor("\0").split("\0");
if (FAKE_CURSOR_PARTS.length !== 2 || FAKE_CURSOR_PARTS[0] === "") {
	throw new Error(`renderFakeCursor no longer wraps its text in a marker pair: ${JSON.stringify(FAKE_CURSOR_PARTS)}`);
}
const FAKE_CURSOR_START = FAKE_CURSOR_PARTS[0];

/** The rendered screen as the component returns it, colours and cursor markers included. */
function raw(c: { render: (width: number) => string[] }, width = 100): string {
	return c.render(width).join("\n");
}

/** The rendered screen's text, without terminal sequences. */
function rendered(c: { render: (width: number) => string[] }, width = 100): string {
	return stripTerminalSequences(raw(c, width));
}

function findSelectedRow(c: { render: (width: number) => string[] }): string | undefined {
	return rendered(c)
		.split("\n")
		.find((line) => line.includes("→"));
}

function selectedRow(c: { render: (width: number) => string[] }): string {
	const row = findSelectedRow(c);
	assertPresent(row, "the rendered screen has a selected row marked →");
	return row;
}

function selectRenderedLabel(c: { handleInput?: (data: string) => void; render: (width: number) => string[] }, label: string): void {
	for (let i = 0; i < 32; i++) {
		// A screen without a selected row is not this label yet: keep pressing DOWN.
		if (findSelectedRow(c)?.includes(label) === true) {
			return;
		}
		press(c, DOWN);
	}
	expect.unreachable(`did not select rendered label: ${label}`);
}

function openModelEdit(c: Parameters<typeof selectRenderedLabel>[0], modelLabel: string): void {
	press(c, ENTER); // LIST → open the selected group editor
	selectRenderedLabel(c, modelLabel); // EDITOR → put the cursor on the model row
	press(c, ENTER); // EDITOR → MODEL_EDIT
}

function openAddModelWizard(c: Parameters<typeof selectRenderedLabel>[0]): void {
	press(c, ENTER); // LIST → open the selected group editor
	selectRenderedLabel(c, "+ Add model"); // EDITOR → the add-model row
	press(c, ENTER); // EDITOR → WIZARD_PROVIDER
}

function pressAndRender(c: { handleInput?: (data: string) => void; render: (width: number) => string[] }, ...inputs: string[]): void {
	for (const input of inputs) {
		c.render(100);
		c.handleInput?.(input);
		c.render(100);
	}
}

async function atSearchableModel(models: readonly CatalogEntry[], store?: (memory: ModelGroupsStoreOps) => Partial<ModelGroupsStoreOps>) {
	const c = component({ registry: await catalog(models), defs: { project: { review: { models: [] } } }, store }).c;
	pressAndRender(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER, ENTER);
	expect(rendered(c)).toMatch(/Add model — Step 2\/3 Model/);
	return c;
}

test("model groups TUI list renders validation summary, health tags, add row, and confirmed D delete", async () => {
	const deleteCalls: string[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: {
			global: { review: { models: [] } },
			project: {
				review: { models: [] },
				spread: {
					models: [
						{ provider: "orange", modelId: "gpt-5" },
						{ provider: "missing", modelId: "nope" },
					],
				},
			},
		},
		store: (memory) => ({
			deleteGroup: (scope, access, name) => {
				deleteCalls.push(`${scope}:${name}`);
				return memory.deleteGroup(scope, access, name);
			},
		}),
	});
	let lines = rendered(c, 200);
	expect(lines).toMatch(/Boot validation: 1 unavailable model references · 1 project overrides/);
	expect(lines).toMatch(/project override/);
	expect(lines).toMatch(/⚠ degraded/);
	expect(lines).toMatch(/✗ unavailable/);
	expect(lines).toMatch(/\+ Add group/);
	c.handleInput?.("D");
	lines = rendered(c);
	expect(lines).toMatch(/Delete Model Group/);
	expect(lines).toMatch(/Same-name group in the other scope remains unaffected/);
	c.handleInput?.(DOWN);
	c.handleInput?.(ENTER);
	expect(deleteCalls).toStrictEqual(["global:review"]);
	expect(rendered(c)).not.toMatch(/Delete Model Group/);
});

test("model groups TUI renders modality labels, warnings, and stale override choices", async () => {
	// gpt-5 here accepts text and image without reasoning, so the reasoning entry of the override is stale;
	// the unresolved member leaves the group without common modalities.
	const registry = await catalog([{ provider: "orange", id: "gpt-5", input: ["text", "image"] }]);
	const { c } = component({
		registry,
		defs: {
			project: {
				review: {
					models: [
						{ provider: "orange", modelId: "gpt-5" },
						{ provider: "missing", modelId: "nope" },
					],
					constraints: { modalities: ["text", "image", "reasoning"] },
				},
			},
		},
	});
	const reviewRow = rendered(c, 200)
		.split("\n")
		.find((line) => line.includes("review"));
	assertPresent(reviewRow, "expected review row");
	expect(reviewRow).toMatch(/\bT\b/);
	expect(reviewRow).toMatch(/\bI\b/);
	expect(reviewRow).toMatch(/models .*?T I[\s]*/);
	expect(rendered(c, 200)).toMatch(/⚠ no common modalities/);
	expect(rendered(c, 200)).toMatch(/⚠ stale modality override: reasoning/);
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Supported by every model: none/);
	expect(rendered(c)).toMatch(/Modalities: Override \(text, image\)/);
	expect(rendered(c)).toMatch(/Capabilities/);
	expect(rendered(c)).toMatch(/Models/);
	press(c, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/T text {2}\[required\]/);
	expect(rendered(c)).toMatch(/I image {2}\[on\]/);
	// The group carries a persisted override (text, image, reasoning) → status reflects it.
	expect(rendered(c)).toMatch(/Override — media limited to text, image/);
	expect(rendered(c)).not.toMatch(/reasoning/);
});

test("model groups TUI Add-model picker shows capability chips per model", async () => {
	const registry = await catalog([
		{ provider: "orange", id: "gpt-text", input: ["text"] },
		{ provider: "orange", id: "gpt-vision", input: ["text", "image"] },
		{ provider: "keyless", id: "gpt-no-auth", input: ["text", "image"], auth: false },
	]);
	const { c } = component({ registry, defs: { project: { review: { models: [] } } } });
	pressAndRender(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Add model — Step 1\/3 Provider/);
	pressAndRender(c, DOWN, ENTER);
	const text = rendered(c);
	expect(text).toMatch(/Add model — Step 2\/3 Model/);
	// Capable members show colored T/I chips; the unauthenticated model is not selectable.
	expect(text).not.toMatch(/gpt-no-auth/);
	expect(text).toMatch(/orange\/gpt-text\s+T/);
	expect(text).toMatch(/orange\/gpt-vision\s+T I/);
});

async function textAndVisionGroup() {
	const registry = await catalog([
		{ provider: "orange", id: "gpt-text", input: ["text"] },
		{ provider: "orange", id: "gpt-vision", input: ["text", "image"] },
		{ provider: "orange", id: "gpt-missing", reasoning: true },
	]);
	return component({
		registry,
		defs: {
			project: {
				review: {
					models: [
						{ provider: "orange", modelId: "gpt-text" },
						{ provider: "orange", modelId: "gpt-vision" },
					],
				},
			},
		},
	}).c;
}

test("model groups TUI editor rows show per-model capability chips", async () => {
	const c = await textAndVisionGroup();
	press(c, ENTER);
	const editor = rendered(c);
	// Per-model capability chips mirror the Add-model picker; unresolved members carry none.
	expect(editor).toMatch(/orange\/gpt-text\s+T\s+\(available/);
	expect(editor).toMatch(/orange\/gpt-vision\s+T I\s+\(available/);
	expect(editor).not.toMatch(/gpt-missing/);
});

test("model groups TUI modalities screen shows Automatic status", async () => {
	const c = await textAndVisionGroup();
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const modalities = rendered(c);
	// Text is a non-toggleable required base; no Automatic selector row remains.
	expect(modalities).toMatch(/T text {2}\[required\]/);
	expect(modalities).toMatch(/Automatic — using every capability its members support/);
	expect(modalities).not.toMatch(/Automatic \(/);
	expect(modalities).not.toMatch(/required base/);
	// Single editable row: compact footer without arrow-nav; no per-row hint.
	expect(modalities).toMatch(/Enter\/Space toggle • Esc back/);
	expect(modalities).not.toMatch(/↑↓ navigate/);
	expect(modalities).not.toMatch(/Enter\/Space toggles/);
	expect(modalities).toMatch(/I image {2}\[on\]/);
});

test("model groups TUI modality editor commits override and Automatic through updateGroup", async () => {
	// Automatic groups open with their union capability set active; un-toggling a
	// supported capability writes a subtractive override excluding it.
	const review: ModelGroupDef & { opaqueTopLevel: { preserve: boolean } } = {
		models: [{ provider: "orange", modelId: "gpt-5" }],
		opaqueTopLevel: { preserve: true },
	};
	const calls: { scope: ModelGroupScope; name: string; def: ModelGroupDef }[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review } },
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				calls.push({ scope, name, def: structuredClone(def) });
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	});
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Modalities/);
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].def.constraints?.modalities).toStrictEqual(["text", "reasoning"]);
	const opaqueTopLevel: unknown = Reflect.get(calls[0].def, "opaqueTopLevel");
	expect(opaqueTopLevel, "TUI edits retain opaque top-level group keys").toStrictEqual({ preserve: true });
	expect(rendered(c), "toggle stays on the modalities screen").toMatch(/Modalities/);
	expect(rendered(c)).toMatch(/I image {2}\[off\]/);
	expect(rendered(c)).toMatch(/Override — media limited to text/);
	// Re-enabling the capability back to the full union returns the group to Automatic
	// (no stored override, so no spawn ceiling attaches to a non-limit).
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	expect(calls).toHaveLength(2);
	expect(calls[1].def.constraints?.modalities).toBeUndefined();
	expect(rendered(c), "re-enable also stays on the modalities screen").toMatch(/Modalities/);
	expect(rendered(c)).toMatch(/Automatic — using every capability its members support/);
	press(c, ESC);
	expect(rendered(c)).toMatch(/Modalities: Automatic \(text, image\)/);
});

test("model groups TUI re-enabling a modality to Automatic keeps the group's other constraint keys", async () => {
	const persisted: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: {
			project: {
				review: { models: [{ provider: "orange", modelId: "gpt-5" }], constraints: { modalities: ["text", "reasoning"], futureLimit: { tokens: 4096 } } },
			},
		},
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				persisted.push(structuredClone(def));
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	});
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	selectRenderedLabel(c, "I image");
	press(c, ENTER);
	expect(persisted).toHaveLength(1);
	const [def] = persisted;
	assertPresent(def);
	expect(def.constraints).toStrictEqual({ futureLimit: { tokens: 4096 } });
});

function visionCatalog(): Promise<ModelRegistry> {
	return catalog([{ provider: "orange", id: "gpt-vision", input: ["text", "image"] }]);
}

test("model groups TUI Space also toggles a modality and stays on screen", async () => {
	const calls: { scope: ModelGroupScope; name: string; def: ModelGroupDef }[] = [];
	const { c } = component({
		registry: await visionCatalog(),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-vision" }] } } },
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				calls.push({ scope, name, def: structuredClone(def) });
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	});
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Modalities/);
	selectRenderedLabel(c, "I image");
	press(c, " ");
	expect(calls).toHaveLength(1);
	expect(calls[0].def.constraints?.modalities).toStrictEqual(["text"]);
	expect(rendered(c), "space toggle stays on the modalities screen").toMatch(/Modalities/);
	expect(rendered(c)).toMatch(/I image {2}\[off\]/);
});

test("model groups TUI modality editor preserves state and notifies on updateGroup failure", async () => {
	const messages: string[] = [];
	const { c } = component({
		registry: await visionCatalog(),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-vision" }] } } },
		store: () => ({
			updateGroup: () => {
				throw new ModelGroupsPersistenceError({
					operation: "save",
					scope: "project",
					sourcePath: "/tmp/.pi/pi-schematic/model-groups.json",
					phase: "rename",
					message: "modality write denied",
				});
			},
		}),
		notify: (message) => messages.push(message),
	});
	press(c, ENTER, DOWN, DOWN, DOWN, ENTER); // open Modalities
	press(c, ENTER); // toggle the single media row → updateGroup throws
	expect(messages).toContainEqual(expect.stringMatching(/modality write denied/));
	expect(rendered(c), "screen retained after failure").toMatch(/Modalities/);
});

test("model groups TUI text-only modalities screen is inert and states Automatic", async () => {
	const updateGroup = vi.fn();
	const { c } = component({
		registry: await catalog([{ provider: "orange", id: "gpt-text", input: ["text"] }]),
		defs: { project: { "text-only": { models: [{ provider: "orange", modelId: "gpt-text" }] } } },
		store: () => ({ updateGroup }),
	});
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const screen = rendered(c);
	// No toggleable media rows: only the required text row, no toggle nav, no selection.
	expect(screen).toMatch(/T text {2}\[required\]/);
	expect(screen).toMatch(/No optional media capabilities available/);
	expect(screen).toMatch(/Automatic — using every capability its members support/);
	expect(screen).toMatch(/Esc back/);
	expect(screen).not.toMatch(/Enter\/Space toggle/);
	expect(screen).not.toMatch(/Enter\/Space toggles/);
	expect(screen).not.toMatch(/→/);
	// Enter/Space on the inert row must not persist anything.
	press(c, ENTER, " ", ENTER);
	expect(updateGroup).not.toHaveBeenCalled();
});

test("model groups TUI empty-group modalities screen claims no capabilities", async () => {
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { empty: { models: [] } } }, // no member-derived capabilities
		store: () => ({
			updateGroup: () => {
				throw new Error("empty group must not commit edits");
			},
		}),
	});
	press(c, ENTER);
	selectRenderedLabel(c, "Modalities:");
	press(c, ENTER);
	const screen = rendered(c);
	// The engine derives no supported/effective modalities for zero members, so the
	// editor must not claim the text base capability — the empty state is the truth.
	expect(screen).toMatch(/Modalities — empty/);
	expect(screen, "empty groups must not claim the text base capability").not.toMatch(/text {2}\[required\]/);
	expect(screen).toMatch(/No optional media capabilities available/);
	expect(screen).toMatch(/Automatic — using every capability its members support/);
	expect(screen).toMatch(/Esc back/);
});

test("model groups TUI computes unique new-group names and opens editor after create", async () => {
	const calls: string[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { "new-group": { models: [] } } },
		store: (memory) => ({
			createGroup: (scope, access, name, def, modelRegistry) => {
				calls.push(`${scope}:${name}:${String(def.models.length)}`);
				memory.createGroup(scope, access, name, def, modelRegistry);
			},
		}),
	});
	c.handleInput?.(DOWN); // + Add group
	c.handleInput?.(ENTER);
	expect(calls).toStrictEqual(["project:new-group-2:0"]);
	expect(rendered(c)).toMatch(/Model Group: new-group-2/);
});

test("model groups TUI wizard renders provider/model/thinking steps and preserves state on add failure", async () => {
	const messages: string[] = [];
	const updateGroup = vi.fn(() => {
		throw new ModelGroupsPersistenceError({
			operation: "save",
			scope: "project",
			sourcePath: "/tmp/project/.pi/pi-schematic/model-groups.json",
			phase: "rename",
			message: "add failed",
		});
	});
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [] } } },
		store: () => ({ updateGroup }),
		notify: (message) => messages.push(message),
	});
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	expect(text).toMatch(/Add model — Step 1\/3 Provider/);
	expect(text).toMatch(/alpha/);
	expect(text).toMatch(/orange/);
	expect(text).not.toMatch(/grape/);
	expect(text).not.toMatch(/Step 4/);

	press(c, DOWN, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Add model — Step 2\/3 Model/);
	expect(text).toMatch(/orange\/gpt-5/);
	expect(text).not.toMatch(/gpt-no-auth/);
	expect(text).not.toMatch(/alpha\/claude/);
	expect(text).not.toMatch(/Step 4/);

	press(c, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Add model — Step 3\/3 Thinking/);
	for (const option of GPT5_THINKING_OPTIONS) {
		expect(text).toMatch(new RegExp(`\\b${option}\\b`));
	}
	expect(text).not.toMatch(/Step 4/);

	press(c, ENTER);
	expect(updateGroup).toHaveBeenCalledOnce();
	expect(messages).toHaveLength(1);
	expect(messages[0]).toMatch(/save failed at rename for project scope/);
	expect(messages[0]).toMatch(/add failed/);
	text = rendered(c);
	expect(text).toMatch(/Add model — Step 3\/3 Thinking/);
	expect(text).not.toMatch(/Model Group: review/);
});

test("model groups TUI Esc and left-arrow share wizard back-step behavior", async () => {
	const registry = await tuiRegistry();
	function atProvider() {
		const { c } = component({ registry, defs: { project: { review: { models: [] } } } });
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
	expect(raw(providerEsc)).toBe(raw(providerLeft));
	expect(raw(providerEscKitty)).toBe(raw(providerLeft));
	expect(rendered(providerEsc)).toMatch(/Model Group: review/);

	const modelEsc = atModel();
	const modelLeft = atModel();
	press(modelEsc, ESC);
	press(modelLeft, LEFT);
	expect(raw(modelEsc)).toBe(raw(modelLeft));
	expect(rendered(modelEsc)).toMatch(/Add model — Step 1\/3 Provider/);

	const thinkingEsc = atThinking();
	const thinkingLeft = atThinking();
	const thinkingLeftSs3 = atThinking();
	press(thinkingEsc, ESC);
	press(thinkingLeft, LEFT);
	press(thinkingLeftSs3, LEFT_SS3);
	expect(raw(thinkingEsc)).toBe(raw(thinkingLeft));
	expect(raw(thinkingLeftSs3)).toBe(raw(thinkingLeft));
	expect(rendered(thinkingEsc)).toMatch(/Add model — Step 2\/3 Model/);
});

test("model groups TUI selected markers and primary labels use accent token", async () => {
	const registry = await tuiRegistry();
	const defs: ScopedGroupDefs = { project: { review: { models: [{ provider: "orange", modelId: "gpt-5" }] } } };
	const accent = (text: string) => realTheme.fg("accent", text);
	// A selected row's label is accent up to the next colour sequence, where its description or capability chips start.
	const [accentStart] = accent("\0").split("\0");
	const list = component({ registry, defs }).c;

	expect(raw(list)).toContain(`${accentStart}→ review${" ".repeat(26)}\u001b[`);
	expect(rendered(list)).toMatch(/→ review\s+\[project\] 1 models T I inherit/);
	press(list, DOWN);
	expect(raw(list)).toContain(accent("→ + Add group"));

	const editor = component({ registry, defs }).c;
	press(editor, ENTER);
	expect(raw(editor)).toContain(`${accent("→")} ${accent("Location: project")} ✓`);
	press(editor, DOWN, DOWN, DOWN, DOWN);
	expect(raw(editor)).toContain(`${accent("→")} ${accentStart}orange/gpt-5 \u001b[`);
	expect(rendered(editor)).toMatch(/→ orange\/gpt-5 T I \(available/);
	press(editor, DOWN);
	expect(raw(editor)).toContain(`${accent("→")} ${accent("+ Add model…")}`);

	press(editor, ENTER);
	expect(raw(editor)).toContain(accent("→ alpha"));

	const modelEdit = component({ registry, defs }).c;
	press(modelEdit, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(raw(modelEdit)).toContain(`${accent("→")} ${accent("Thinking: inherit")}`);

	const modalities = component({ registry, defs }).c;
	press(modalities, ENTER, DOWN, DOWN, DOWN, ENTER);
	// The selected capability row is accent-highlighted; the modality letter keeps its own color.
	expect(raw(modalities)).toContain(`${accent("→")} ${realTheme.fg("success", "I")}${accent(" image  [on]")}`);
	expect(rendered(modalities)).toMatch(/Enter\/Space toggle • Esc back/);

	const deleteConfirm = component({ registry, defs: { project: { review: { models: [] } } } }).c;
	press(deleteConfirm, "D");
	expect(raw(deleteConfirm)).toContain(`${accent("→")} ${accent("Keep group")}`);
	press(deleteConfirm, DOWN);
	expect(raw(deleteConfirm)).toContain(`${accent("→")} ${accent("Delete group")}`);
});

test("model groups TUI model edit renders identity/status and filters thinking options", async () => {
	const { c } = component({
		registry: await tuiRegistry(),
		defs: {
			project: {
				review: {
					models: [
						{ provider: "alpha", modelId: "claude" },
						{ provider: "orange", modelId: "gpt-5" },
						{ provider: "missing", modelId: "nope" },
					],
				},
			},
		},
	});

	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	let text = rendered(c);
	expect(text).toMatch(/Provider: alpha/);
	expect(text).toMatch(/Model ID: claude/);
	expect(text).toMatch(/Status: available/);
	expect(text).toMatch(/Thinking: inherit/);
	expect(text.match(/Thinking:/g) ?? []).toHaveLength(1);

	press(c, ESC, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	text = rendered(c);
	expect(text).toMatch(/Provider: orange/);
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
	expect(text.match(/Thinking:/g) ?? []).toHaveLength(1);
});

test("model groups TUI notifies and preserves location on move collision", async () => {
	const messages: string[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [] } } },
		store: () => ({
			moveGroup: () => {
				throw new Error("target scope already contains review");
			},
		}),
		notify: (message) => messages.push(message),
	});
	press(c, ENTER, DOWN, ENTER);
	expect(messages).toStrictEqual(["target scope already contains review"]);
	const text = rendered(c);
	expect(text).toMatch(/Model Group: review/);
	expect(text).toMatch(/Location: project ✓/);
	expect(text).not.toMatch(/Location: global ✓/);
});

test("model groups TUI notifies and preserves model edit state when updateGroup fails", async () => {
	const messages: string[] = [];
	const attemptedModels: string[][] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-5" }] } } },
		store: () => ({
			updateGroup: (_scope, _access, _name, def) => {
				attemptedModels.push(def.models.map((model) => `${model.provider}/${model.modelId}/${model.thinkingLevel ?? "inherit"}`));
				throw new ModelGroupsPersistenceError({
					operation: "save",
					scope: "project",
					sourcePath: "/tmp/project/.pi/pi-schematic/model-groups.json",
					phase: "temp-write",
					message: `update failed ${String(attemptedModels.length)}`,
				});
			},
		}),
		notify: (message) => messages.push(message),
	});
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER, DOWN, ENTER);
	expect(attemptedModels[0]).toStrictEqual(["orange/gpt-5/off"]);
	expect(messages[0]).toMatch(/update failed 1/);
	let text = rendered(c);
	expect(text).toMatch(/Edit model/);
	expect(text).toMatch(/Provider: orange/);
	expect(text).toMatch(/Model ID: gpt-5/);
	expect(text).not.toMatch(/Model Group: review/);

	press(c, "D");
	expect(attemptedModels[1]).toStrictEqual([]);
	expect(messages[1]).toMatch(/update failed 2/);
	text = rendered(c);
	expect(text).toMatch(/Edit model/);
	expect(text).toMatch(/Provider: orange/);
	expect(text).toMatch(/Remove model/);
});

test("model groups TUI renders name editing inline and preserves edit/commit transitions", async () => {
	const calls: string[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { abc: { models: [] } } },
		store: (memory) => ({
			renameGroup: (scope, access, oldName, newName) => {
				calls.push(`${oldName}->${newName}`);
				memory.renameGroup(scope, access, oldName, newName);
			},
		}),
	});
	c.focused = true;
	press(c, ENTER, DOWN, DOWN); // selected, inactive name row
	expect(rendered(c)).toMatch(/→ Name: abc/);
	expect(rendered(c)).not.toMatch(/(?:^|\n)> /);
	expect(raw(c)).not.toContain(FAKE_CURSOR_START);
	expect(raw(c)).not.toContain(CURSOR_MARKER);

	press(c, ENTER, "d"); // D remains literal while the input is active
	expect(rendered(c)).toMatch(/→ Name: abcd/);
	expect(rendered(c)).not.toMatch(/(?:^|\n)> /);
	expect(raw(c)).toContain(`abcd${CURSOR_MARKER}${renderFakeCursor(" ")}`);
	expect(raw(c).split(CURSOR_MARKER)).toHaveLength(2);

	press(c, LEFT, BACKSPACE);
	expect(rendered(c)).toMatch(/→ Name: abd/);
	press(c, "c", ESC); // Escape commits and exits edit mode
	expect(calls).toStrictEqual(["abc->abcd"]);
	expect(rendered(c)).toMatch(/Model Group: abcd/);
	expect(rendered(c)).toMatch(/ {2}Name: abcd/);
	expect(raw(c)).not.toContain(FAKE_CURSOR_START);
	expect(raw(c)).not.toContain(CURSOR_MARKER);

	press(c, DOWN, DOWN, ENTER, "e", ENTER); // Enter also commits and exits edit mode
	expect(calls).toStrictEqual(["abc->abcd", "abcd->abcde"]);
	expect(rendered(c)).toMatch(/ {2}Name: abcde/);
	expect(raw(c)).not.toContain(CURSOR_MARKER);

	press(c, DOWN, DOWN, ENTER, "f", DOWN, DOWN); // row-change flushes the pending rename before moving
	expect(calls).toStrictEqual(["abc->abcd", "abcd->abcde", "abcde->abcdef"]);
	const text = rendered(c);
	expect(text).toMatch(/Model Group: abcdef/);
	expect(text).toMatch(/→ \+ Add model/);
	expect(text).toMatch(/Name: abcdef/);
	expect(raw(c)).not.toContain(FAKE_CURSOR_START);
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	expect(text).not.toMatch(/Delete Model Group/);
});

test("model groups TUI move to global persists through moveGroup and reopens the editor on the global group", async () => {
	const calls: string[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-5" }] } } },
		store: (memory) => ({
			moveGroup: (access, name, scope) => {
				calls.push(`move:${name}:${scope}`);
				memory.moveGroup(access, name, scope);
			},
		}),
	});
	press(c, ENTER, DOWN, ENTER); // editor → switch to global
	expect(calls).toStrictEqual(["move:review:global"]);
	expect(rendered(c)).toMatch(/Model Group: review/);
	expect(rendered(c)).toMatch(/Location: global ✓/);
});

test("model groups TUI notifies and keeps visible state on persistence errors", async () => {
	const messages: string[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [] } } },
		notify: (message) => messages.push(message),
		store: () => ({
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
		}),
	});
	c.handleInput?.(ENTER);
	c.handleInput?.(DOWN);
	c.handleInput?.(DOWN);
	c.handleInput?.(ENTER);
	c.handleInput?.("2");
	c.handleInput?.(ESC); // Escape preserves persistence-error handling and exits name input
	expect(messages).toHaveLength(1);
	expect(messages[0]).toMatch(/save failed at temp-write for project scope/);
	expect(messages[0]).toMatch(/source: \/tmp\/project\/\.pi\/pi-schematic\/model-groups\.json/);
	expect(messages[0]).toMatch(/target: \/tmp\/project\/\.pi\/pi-schematic\/model-groups\.json\.123\.tmp/);
	expect(messages[0]).toMatch(/collision/);
	expect(rendered(c)).toMatch(/Model Group: review/);
	expect(rendered(c)).toMatch(/→ Name: review/);
	expect(raw(c)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI Esc in MODEL_EDIT returns to the group editor", async () => {
	const c = component({ registry: await tuiRegistry(), defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-5" }] } } } }).c;
	press(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Edit model/);
	press(c, ESC);
	expect(rendered(c)).toMatch(/Location: project/);
	expect(rendered(c)).not.toMatch(/Edit model/);
});

test("model groups TUI clamps the cursor to the final add row", async () => {
	const calls: { scope: ModelGroupScope; access: ModelGroupsAccess; name: string; def: ModelGroupDef }[] = [];
	const c = component({
		registry: await tuiRegistry(),
		defs: { global: { "global-name": { models: [] } } },
		store: (memory) => ({
			createGroup: (scope, access, name, def, modelRegistry) => {
				calls.push({ scope, access, name, def });
				memory.createGroup(scope, access, name, def, modelRegistry);
			},
		}),
		policy: "global-only",
	}).c;
	press(c, DOWN, DOWN);
	expect(rendered(c)).toMatch(/→ \+ Add group/);
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].scope).toBe("global");
	expect(calls[0].access).toStrictEqual({ cwd: "/tmp/project", policy: "global-only" });
	expect(calls[0].def).toStrictEqual({ models: [] });
	const text = rendered(c);
	expect(text).toMatch(/Location: global/);
	expect(text).not.toMatch(/Location: project/);
});

test("model groups TUI under global-only access lists only global groups", async () => {
	// The session's groups were resolved while the project was trusted, so the component opens with project groups it must not list.
	const defs: ScopedGroupDefs = { global: { "global-name": { models: [] } }, project: { "project-secret": { models: [] } } };
	const c = component({ registry: await tuiRegistry(), defs, initialDefs: defs, policy: "global-only" }).c;
	expect(rendered(c)).toMatch(/global-name/);
	expect(rendered(c)).not.toMatch(/project-secret/);
});

test("model groups TUI under global-only access the name and Modalities rows open their editors", async () => {
	const c = component({ registry: await tuiRegistry(), defs: { global: { review: { models: [] } } }, policy: "global-only" }).c;
	c.focused = true;
	press(c, ENTER, DOWN, ENTER);
	expect(raw(c)).toContain(CURSOR_MARKER);
	expect(rendered(c)).toMatch(/→ Name: review/);
	press(c, ESC, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Modalities — review/);
});

test("model groups TUI escapes controlled labels", async () => {
	const hostile = "group\n\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007";
	const c = component({
		registry: await tuiRegistry(),
		defs: { project: { [hostile]: { models: [{ provider: "orange\u001b[31m", modelId: "model\nlong" }] } } },
	}).c;
	expect(rendered(c)).toMatch(/group\\n\\x1B/);
	expect(raw(c)).not.toMatch(/\u001b\]8;;/);
});

test("model groups TUI offers and persists native max", async () => {
	let selectedThinking: string | undefined;
	const max = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [] } } },
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				selectedThinking = def.models.at(-1)?.thinkingLevel;
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	}).c;
	press(max, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	press(max, DOWN, ENTER, ENTER);
	expect(rendered(max)).toMatch(/Add model — Step 3\/3 Thinking/);
	expect(rendered(max)).toMatch(/max/);
	press(max, ...Array<string>(20).fill(DOWN), ENTER);
	expect(selectedThinking).toBe("max");
});

test.for(["__proto__", "constructor", "toString"])("model groups TUI decodes then canonicalizes prototype-sensitive names: %s", async (nextName) => {
	const calls: string[] = [];
	const notifications: string[] = [];
	const c = component({
		registry: await tuiRegistry(),
		defs: { project: { abc: { models: [] } } },
		store: (memory) => ({
			renameGroup: (scope, access, oldName, renamed) => {
				calls.push(`${oldName}->${renamed}`);
				memory.renameGroup(scope, access, oldName, renamed);
			},
		}),
		notify: (message) => notifications.push(message),
	}).c;
	press(c, ENTER, DOWN, DOWN, ENTER, BACKSPACE, BACKSPACE, BACKSPACE, ...Array.from(` ${nextName} `), DOWN);
	expect(calls).toStrictEqual([`abc->${nextName}`]);
	expect(rendered(c)).toMatch(new RegExp(nextName.replaceAll("_", "\\_")));
	expect(notifications).toStrictEqual([]);
});

test("model groups TUI rejects malformed escapes in a rename", async () => {
	const malformedCalls: string[] = [];
	const notifications: string[] = [];
	const malformed = component({
		registry: await tuiRegistry(),
		defs: { project: { abc: { models: [] } } },
		store: () => ({ renameGroup: () => malformedCalls.push("called") }),
		notify: (message) => notifications.push(message),
	}).c;
	press(malformed, ENTER, DOWN, DOWN, ENTER, "\\", ESC);
	expect(malformedCalls).toStrictEqual([]);
	expect(notifications).toHaveLength(1);
	expect(rendered(malformed)).toMatch(/→ Name: abc/);
	expect(raw(malformed)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI keeps every screen width-bounded without wrapping logical rows", async () => {
	const registry = await tuiRegistry();
	const assertScreen = (c: ReturnType<typeof component>["c"]) => {
		const wideCount = c.render(200).length;
		const narrow = c.render(12);
		expect(narrow).toHaveLength(wideCount);
		expect(narrow.filter((line) => !(visibleWidth(line) <= 12))).toStrictEqual([]);
	};
	const longModel: ModelGroupModel = { provider: "orange", modelId: "gpt-5", thinkingLevel: "max" };
	const c = component({ registry, defs: { project: { "界é界-a-very-long-group-name": { models: [longModel] } } } }).c;
	assertScreen(c); // LIST
	press(c, ENTER);
	assertScreen(c); // EDITOR
	c.focused = true;
	press(c, DOWN, DOWN); // inactive group-name row
	const inactiveWideCount = c.render(200).length;
	for (const width of [1, 2, 12]) {
		const lines = c.render(width);
		expect(lines).toHaveLength(inactiveWideCount);
		expect(lines.filter((line) => !(visibleWidth(line) <= width))).toStrictEqual([]);
		expect(lines.join("\n")).not.toContain(CURSOR_MARKER);
		if (width === 12) {
			expect(stripTerminalSequences(lines.join("\n"))).toMatch(/界é/);
		}
	}
	press(c, ENTER, "\u0001"); // active group-name input with cursor at line start
	const activeWideCount = c.render(200).length;
	for (const width of [1, 2, 12]) {
		const lines = c.render(width);
		expect(lines).toHaveLength(activeWideCount);
		expect(lines.filter((line) => !(visibleWidth(line) <= width))).toStrictEqual([]);
		expect(lines.join("\n")).toContain(CURSOR_MARKER);
		if (width === 12) {
			expect(stripTerminalSequences(lines.join("\n"))).toMatch(/界é/);
		}
	}
	press(c, DOWN, ENTER);
	assertScreen(c); // MODALITIES (from the name row, Down lands on the Modalities row)
	press(c, ESC, DOWN, DOWN, DOWN, DOWN, ENTER);
	assertScreen(c); // WIZARD_PROVIDER
	press(c, DOWN, DOWN, ENTER);
	assertScreen(c); // WIZARD_MODEL
	press(c, ENTER);
	assertScreen(c); // WIZARD_THINKING
	const deletion = component({ registry, defs: { project: { "a-very-long-group-name": { models: [longModel] } } } }).c;
	press(deletion, "D");
	assertScreen(deletion); // DELETE_CONFIRM
});

test("model groups TUI searchable Model step filters raw fields and handles no matches safely", async () => {
	const models: CatalogEntry[] = [
		{ provider: "orange", id: "alpha-id", name: "Friendly Name", reasoning: true },
		{ provider: "orange", id: "beta-id", name: "Other", reasoning: true },
		{ provider: "orange-keyless", id: "hidden", name: "Unauthorized", reasoning: true, auth: false },
		{ provider: "other", id: "foreign", name: "Friendly Name", reasoning: true },
	];
	const c = await atSearchableModel(models);
	expect(rendered(c)).toMatch(/→ orange\/alpha-id/);
	expect(rendered(c)).toMatch(/beta-id/);
	expect(rendered(c)).not.toMatch(/hidden|foreign/);

	for (const query of ["alpha-id", "orange/alpha-id", "Friendly"]) {
		const queried = await atSearchableModel(models);
		pressAndRender(queried, ...Array.from(query));
		expect(rendered(queried)).toMatch(/alpha-id/);
		expect(rendered(queried)).not.toMatch(/beta-id/);
	}
	const providerQuery = await atSearchableModel(models);
	pressAndRender(providerQuery, ...Array.from("orange"));
	expect(rendered(providerQuery)).toMatch(/alpha-id/);
	expect(rendered(providerQuery)).toMatch(/beta-id/);

	pressAndRender(c, ...Array.from("Friendly impossible"));
	expect(rendered(c)).toMatch(/No matching models/);
	const before = raw(c);
	pressAndRender(c, UP, DOWN, ENTER);
	expect(raw(c)).toBe(before);
});

test("model groups TUI fuzzy search excludes synthetic provider-space-id matches", async () => {
	const c = await atSearchableModel([{ provider: "abc", id: "xyz", reasoning: true }]);
	pressAndRender(c, ...Array.from("azaz"));
	expect(rendered(c)).toMatch(/No matching models/);
	expect(rendered(c)).not.toMatch(/→ abc\/xyz/);
});

test("model groups TUI handles Model activation immediately after Provider transition without rendering", async () => {
	const persisted: (ModelGroupModel | undefined)[] = [];
	const models = Array.from({ length: 2 }, (_, index) => ({ provider: "orange", id: `model-${index}` }));
	const c = component({
		registry: await catalog(models),
		defs: { project: { review: { models: [] } } },
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				persisted.push(def.models.at(-1));
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	}).c;
	pressAndRender(c, ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Add model — Step 1\/3 Provider/);

	for (const input of [ENTER, ENTER]) {
		c.handleInput?.(input);
	}
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "orange", modelId: "model-0" }]);
});

/** Store ops over `memory` whose updateGroup records the last model of each def it applies. */
function recordingLastModel(persisted: (ModelGroupModel | undefined)[]): (memory: ModelGroupsStoreOps) => Partial<ModelGroupsStoreOps> {
	return (memory) => ({
		updateGroup: (scope, access, name, def, modelRegistry) => {
			persisted.push(def.models.at(-1));
			memory.updateGroup(scope, access, name, def, modelRegistry);
		},
	});
}

test("model groups TUI replaces Thinking control with Model control before rendering the back-step", async () => {
	const persisted: (ModelGroupModel | undefined)[] = [];
	const models = Array.from({ length: 3 }, (_, index) => ({ provider: "orange", id: `model-${index}` }));
	const c = await atSearchableModel(models, recordingLastModel(persisted));
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);

	for (const input of [LEFT, DOWN, ENTER]) {
		c.handleInput?.(input);
	}
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "orange", modelId: "model-1" }]);
});

test("model groups TUI keeps Model selection live across rapid query, navigation, and selection before render", async () => {
	const persisted: (ModelGroupModel | undefined)[] = [];
	// The query drops the unfiltered first row, so a selection read from the stale list would persist alpha-0 or beta-1.
	const models = ["alpha-0", "beta-1", "beta-2"].map((id) => ({ provider: "orange", id }));
	const c = await atSearchableModel(models, recordingLastModel(persisted));

	for (const input of ["b", "e", "t", "a", DOWN, ENTER]) {
		c.handleInput?.(input);
	}
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	pressAndRender(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "orange", modelId: "beta-2" }]);
});

test("model groups TUI Model SelectList keeps all results behind a ten-row viewport and owns wrapping", async () => {
	const models = Array.from({ length: 12 }, (_, index) => ({ provider: "orange", id: `model-${String(index).padStart(2, "0")}`, reasoning: true }));
	const c = await atSearchableModel(models);
	let text = rendered(c);
	expect(text).toMatch(/model-00/);
	expect(text).toMatch(/model-09/);
	expect(text).not.toMatch(/model-10|model-11/);
	expect(text).toMatch(/\(1\/12\)/);

	pressAndRender(c, UP);
	text = rendered(c);
	expect(text).toMatch(/→ orange\/model-11/);
	expect(text).toMatch(/\(12\/12\)/);
	pressAndRender(c, DOWN);
	expect(rendered(c)).toMatch(/→ orange\/model-00/);
	pressAndRender(c, ...Array<string>(10).fill(DOWN));
	expect(rendered(c)).toMatch(/→ orange\/model-10/);
});

test("model groups TUI Model Input directly proves every nonempty, cursor-start, empty, and Esc branch", async () => {
	const models = Array.from({ length: 4 }, (_, index) => ({ provider: "orange", id: `model-${index}`, reasoning: true }));

	const cursorMiddle = await atSearchableModel(models);
	pressAndRender(cursorMiddle, ...Array.from("model"), DOWN, DOWN, LEFT);
	expect(rendered(cursorMiddle)).toMatch(/Add model — Step 2\/3 Model/);
	expect(rendered(cursorMiddle)).toMatch(/→ orange\/model-2/); // Left moved only the Input cursor.
	pressAndRender(cursorMiddle, BACKSPACE);
	expect(rendered(cursorMiddle)).toMatch(/→ orange\/model-0/); // A real middle-of-query mutation resets selection.

	for (const key of [LEFT, BACKSPACE]) {
		const cursorStart = await atSearchableModel(models);
		pressAndRender(cursorStart, ...Array.from("model"), ...Array<string>(5).fill(LEFT), DOWN, DOWN, key);
		expect(rendered(cursorStart)).toMatch(/→ orange\/model-2/); // Cursor-start key left query and selection unchanged.
		expect(rendered(cursorStart)).toMatch(/Add model — Step 2\/3 Model/);
	}

	const oneCharacter = await atSearchableModel(models);
	pressAndRender(oneCharacter, "m", BACKSPACE);
	expect(rendered(oneCharacter)).toMatch(/Add model — Step 2\/3 Model/);
	expect(rendered(oneCharacter)).toMatch(/orange\/model-3/); // The now-empty query exposes the full set.
	pressAndRender(oneCharacter, BACKSPACE);
	expect(rendered(oneCharacter)).toMatch(/Step 1\/3 Provider/);

	for (const key of [LEFT, BACKSPACE]) {
		const emptyQuery = await atSearchableModel(models);
		pressAndRender(emptyQuery, key);
		expect(rendered(emptyQuery)).toMatch(/Step 1\/3 Provider/);
	}
	for (const query of ["", "m"]) {
		const escaped = await atSearchableModel(models);
		pressAndRender(escaped, ...Array.from(query), ESC);
		expect(rendered(escaped)).toMatch(/Step 1\/3 Provider/);
	}
});

test("model groups TUI directly proves query preservation and every abandonment, completion, exit, and reopen clear boundary", async () => {
	const models = [{ provider: "orange", id: "search-target", reasoning: true }];

	const thinkingBack = await atSearchableModel(models);
	pressAndRender(thinkingBack, ...Array.from("target"), ENTER, LEFT);
	expect(rendered(thinkingBack)).toMatch(/Step 2\/3 Model/);
	expect(rendered(thinkingBack)).toMatch(/> target/);

	const abandonedAndExited = await atSearchableModel(models);
	pressAndRender(abandonedAndExited, ...Array.from("target"), ESC);
	expect(rendered(abandonedAndExited)).toMatch(/Step 1\/3 Provider/);
	pressAndRender(abandonedAndExited, ESC);
	expect(rendered(abandonedAndExited)).toMatch(/Model Group: review/);
	pressAndRender(abandonedAndExited, ...Array<string>(5).fill(DOWN), ENTER, ENTER);
	expect(rendered(abandonedAndExited)).toMatch(/Step 2\/3 Model/);
	expect(rendered(abandonedAndExited)).not.toMatch(/> target/);

	const completedAndReopened = await atSearchableModel(models);
	pressAndRender(completedAndReopened, ...Array.from("target"), ENTER, ENTER);
	expect(rendered(completedAndReopened)).toMatch(/Model Group: review/);
	pressAndRender(completedAndReopened, ...Array<string>(5).fill(DOWN), ENTER, ENTER);
	expect(rendered(completedAndReopened)).toMatch(/Step 2\/3 Model/);
	expect(rendered(completedAndReopened)).not.toMatch(/> target/);
});

test("model groups TUI persists exact raw identity from both filtered/reordered and offscreen selections", async () => {
	const persisted: (ModelGroupModel | undefined)[] = [];

	const filteredModels = [
		{ provider: "raw-provider", id: "z-last\u001b", name: "needle exact" },
		{ provider: "raw-provider", id: "a-first", name: "unrelated" },
	];
	const filtered = await atSearchableModel(filteredModels, recordingLastModel(persisted));
	pressAndRender(filtered, ...Array.from("needle"), ENTER, ENTER);
	expect(persisted[0]).toStrictEqual({ provider: "raw-provider", modelId: "z-last\u001b" });

	const offscreenModels = Array.from({ length: 12 }, (_, index) => ({
		provider: "raw-provider",
		id: `raw/${String(index).padStart(2, "0")}\u001b`,
		name: `match ${index}`,
	}));
	const offscreen = await atSearchableModel(offscreenModels, recordingLastModel(persisted));
	pressAndRender(offscreen, ...Array.from("match"), ...Array<string>(11).fill(DOWN), ENTER, ENTER);
	expect(persisted[1]).toStrictEqual({ provider: "raw-provider", modelId: "raw/11\u001b" });
});

test("model groups TUI directly proves every non-Model screen remains search-free and uncapped", async () => {
	const models = Array.from({ length: 12 }, (_, index) => ({ provider: `provider-${String(index).padStart(2, "0")}`, id: "only-model", reasoning: true }));
	const registry = await catalog(models);
	const existingModels = models.map((model) => ({ provider: model.provider, modelId: model.id }));
	const groups = Object.fromEntries(
		Array.from({ length: 12 }, (_, index) => [`group-${String(index).padStart(2, "0")}`, { models: index === 0 ? existingModels : [] }]),
	);
	const c = component({ registry, defs: { project: groups } }).c;
	c.focused = true;
	expect(rendered(c)).toMatch(/group-11/); // LIST retains its full native viewport.
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/provider-11\/only-model/); // EDITOR remains uncapped.
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, DOWN, DOWN, DOWN, DOWN, ENTER);
	expect(rendered(c)).toMatch(/Edit model/); // MODEL_EDIT.
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, ESC, ...Array<string>(20).fill(DOWN), ENTER);
	expect(rendered(c)).toMatch(/Step 1\/3 Provider/); // WIZARD_PROVIDER remains uncapped.
	expect(rendered(c)).toMatch(/provider-11/);
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, ENTER);
	expect(raw(c)).toContain(CURSOR_MARKER); // Search exists only on WIZARD_MODEL.
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/Step 3\/3 Thinking/); // WIZARD_THINKING.
	expect(raw(c)).not.toContain(CURSOR_MARKER);

	const deletion = component({ registry, defs: { project: { "group-00": { models: existingModels } } } }).c;
	deletion.focused = true;
	pressAndRender(deletion, "D");
	expect(rendered(deletion)).toMatch(/Delete Model Group/); // DELETE_CONFIRM.
	expect(raw(deletion)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI focus follows root loss and Model, Thinking, Provider screen transitions", async () => {
	const c = await atSearchableModel([{ provider: "orange", id: "model", reasoning: true }]);
	c.focused = true;
	expect(raw(c)).toContain(CURSOR_MARKER);
	c.focused = false;
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	c.focused = true;
	expect(raw(c)).toContain(CURSOR_MARKER);
	pressAndRender(c, ENTER);
	expect(rendered(c)).toMatch(/Step 3\/3 Thinking/);
	expect(raw(c)).not.toContain(CURSOR_MARKER);
	pressAndRender(c, LEFT);
	expect(raw(c)).toContain(CURSOR_MARKER);
	pressAndRender(c, ESC);
	expect(rendered(c)).toMatch(/Step 1\/3 Provider/);
	expect(raw(c)).not.toContain(CURSOR_MARKER);
});

test("model groups TUI model picker preserves the id tail behind an ellipsis and shows the full id in the Selected detail", async () => {
	const c = await atSearchableModel([
		{ provider: "orange", id: "gpt-5.2-codex-2025-07-01-rc1", name: "GPT-5.2 Codex", reasoning: true },
		{ provider: "orange", id: "o3-pro-2025-04-16-nightly-build", name: "O3 Pro", reasoning: true },
		{ provider: "orange", id: "gpt-4o", reasoning: true },
	]);
	pressAndRender(c, DOWN); // select the long-id row so the detail shows it
	// Narrow terminal: rows keep the provider and the distinguishing id tail, cut head-first with a visible ellipsis.
	const narrow = rendered(c, 36);
	expect(narrow, "truncation is marked with a visible ellipsis").toMatch(/…/);
	expect(narrow, "provider stays on truncated rows").toMatch(/orange\/…/);
	expect(narrow, "the distinguishing id suffix survives truncation").toMatch(/orange\/…5\.2-codex-2025-07-01-rc1/);
	expect(narrow, "second row keeps its own tail").toMatch(/orange\/…2025-04-16-nightly-build/);
	expect(narrow, "short ids stay untouched").toMatch(/orange\/gpt-4o/);
	expect(narrow).toMatch(/Selected:/);
	// The detail block shows the full id whenever it fits the terminal (width 44 here).
	const mid = rendered(c, 44);
	expect(mid, "detail shows the full id even when the row truncates").toMatch(/orange\/gpt-5\.2-codex-2025-07-01-rc1/);
	// Wide terminal: rows and the detail show the full identity.
	const wide = rendered(c, 100);
	expect(wide, "no ellipsis when everything fits").not.toMatch(/…/);
	expect(wide).toMatch(/orange\/gpt-5\.2-codex-2025-07-01-rc1/);
	expect(wide).toMatch(/orange\/o3-pro-2025-04-16-nightly-build/);
	expect(wide, "detail shows the display name").toMatch(/GPT-5\.2 Codex/);
});

test("model groups TUI model picker hides the Selected detail when no model matches", async () => {
	const c = await atSearchableModel([
		{ provider: "orange", id: "gpt-5.2-codex-2025-07-01-rc1", name: "GPT-5.2 Codex", reasoning: true },
		{ provider: "orange", id: "o3-pro-2025-04-16-nightly-build", name: "O3 Pro", reasoning: true },
	]);
	expect(rendered(c)).toMatch(/Selected:/);
	pressAndRender(c, ...Array.from("zzz"));
	expect(rendered(c)).toMatch(/No matching models/);
	expect(rendered(c)).not.toMatch(/Selected:/);
});

test("model groups TUI persistence notifications escape each hostile dynamic field", async () => {
	const notifications: string[] = [];
	const hostile = "\n\u001b]8;;https://example.test\u0007field";
	const c = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [] } } },
		store: () => ({
			renameGroup: () => {
				throw new ModelGroupsPersistenceError({
					operation: "save",
					scope: "project",
					sourcePath: `source${hostile}`,
					targetPath: `target${hostile}`,
					phase: "rename",
					message: `message${hostile}`,
					cause: new Error(`cause${hostile}`),
				});
			},
		}),
		notify: (message) => notifications.push(message),
	}).c;
	press(c, ENTER, DOWN, DOWN, ENTER, "x", ENTER);
	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toMatch(/source\\n\\x1B/);
	expect(notifications[0]).toMatch(/target\\n\\x1B/);
	expect(notifications[0]).toMatch(/message\\n\\x1B/);
	expect(notifications[0]).toMatch(/cause\\n\\x1B/);
	expect(notifications[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
});

test("model groups TUI refresh notifies an escaped load-issue warning", async () => {
	const notifications: [string, string | undefined][] = [];
	const c = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [] } } },
		store: (memory) => ({
			listResolvedModelGroups: (access, modelRegistry) => ({
				groups: memory.listResolvedModelGroups(access, modelRegistry).groups,
				loadIssues: [
					{
						scope: "project",
						sourcePath: "source\n\u001b",
						kind: "corrupt-json",
						message: "message\n\u001b",
						backupPath: "backup\n\u001b",
						backupFailed: true,
					},
				],
			}),
		}),
		notify: (message, type) => notifications.push([message, type]),
	}).c;
	press(c, ENTER, DOWN, DOWN, ENTER, "x", ENTER); // a rename refreshes the groups
	expect(notifications).toStrictEqual([
		[
			"Model Groups config corrupt-json in project scope (source\\n\\x1B); using empty config for that scope; backup failed (backup\\n\\x1B), original file left untouched; message\\n\\x1B",
			"warning",
		],
	]);
});

test("model groups TUI delete confirmation keeps the group on Keep group and on Esc", async () => {
	const registry = await tuiRegistry();
	const deleteGroup = vi.fn(() => ({ otherScopeHasOverride: false }));
	const keep = component({ registry, defs: { project: { review: { models: [] } } }, store: () => ({ deleteGroup }) }).c;
	const escape = component({ registry, defs: { project: { review: { models: [] } } }, store: () => ({ deleteGroup }) }).c;
	press(keep, "D");
	press(escape, "D");
	expect(rendered(keep)).toMatch(/Delete Model Group/);
	press(keep, ENTER); // Enter on the first row, Keep group
	press(escape, ESC);
	expect(deleteGroup).not.toHaveBeenCalled();
	expect([rendered(keep), rendered(escape)]).toStrictEqual([rendered(escape), expect.stringMatching(/→ review/)]);
	expect(rendered(keep)).not.toMatch(/Delete Model Group/);
});

test("model groups TUI MODEL_EDIT opens on a mid-list configured level and marks only that row current", async () => {
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-5", thinkingLevel: "medium" }] } } },
		store: () => ({
			updateGroup: (_scope, _access, _name, def) => {
				calls.push(def);
			},
		}),
	});
	// EDITOR → first model row → MODEL_EDIT.
	openModelEdit(c, "gpt-5");
	const text = rendered(c);
	// Cursor lands on the configured mid-list level, not on the first (inherit) row.
	expect(text).toMatch(/→ Thinking: medium/);
	expect(text).not.toMatch(/→ Thinking: inherit/);
	// Exactly one row carries the current marker, and it is the configured supported level.
	expect(text.match(/✓ current/g) ?? []).toHaveLength(1);
	expect(text).toMatch(/Thinking: medium ✓ current/);
	expect(text).toMatch(/^ {2}Thinking: inherit$/m);
	expect(text).not.toMatch(/Thinking: inherit ✓ current/);
	// Enter on the current row must write the same value — never silently reset to inherit.
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0].thinkingLevel).toBe("medium");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

/** Opens MODEL_EDIT for a project group whose only member keeps the `high` level the model no longer offers. */
async function openStaleLevelModelEdit(): Promise<{ c: ReturnType<typeof component>["c"]; calls: ModelGroupDef[] }> {
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "alpha", modelId: "claude", thinkingLevel: "high" }] } } },
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				calls.push(def);
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	});
	openModelEdit(c, "claude");
	return { c, calls };
}

test("model groups TUI MODEL_EDIT shows a stale level on an available model once, selected and flagged", async () => {
	const { c } = await openStaleLevelModelEdit();
	const text = rendered(c);
	// The configured-but-unsupported value is on screen exactly once, owns the cursor, and is flagged.
	expect(text.match(/Thinking: high/g) ?? []).toHaveLength(1);
	expect(text).toMatch(/→ Thinking: high/);
	expect(text).toMatch(/Thinking: high ⚠ current, unavailable/);
	expect(text).toMatch(/^ {2}Thinking: inherit$/m);
	expect(text).not.toMatch(/Thinking: inherit ⚠ current, unavailable/);
});

test("model groups TUI MODEL_EDIT Remove model removes a member whose level is stale", async () => {
	const { c, calls } = await openStaleLevelModelEdit();
	selectRenderedLabel(c, "Remove model");
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models).toStrictEqual([]);
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT keeps an unsupported level after inherit when the model has other supported rows", async () => {
	// The ordering clause only bites when the model offers supported levels besides
	// inherit: with a bare [inherit, stale] list an append-at-end regression renders
	// the identical screen. `thinkingLevelMap` nulls drop specific levels, so this
	// model supports off/minimal/high while the configured `medium` is unsupported.
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await catalog([{ provider: "orange", id: "gpt-partial", reasoning: true, thinkingLevelMap: { low: null, medium: null } }]),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-partial", thinkingLevel: "medium" }] } } },
		store: (memory) => ({
			updateGroup: (scope, access, name, def, modelRegistry) => {
				calls.push(def);
				memory.updateGroup(scope, access, name, def, modelRegistry);
			},
		}),
	});
	openModelEdit(c, "gpt-partial");
	const text = rendered(c);
	expect(text.match(/Thinking: medium/g) ?? []).toHaveLength(1);
	expect(text).toMatch(/→ Thinking: medium ⚠ current, unavailable/);
	const lines = text.split("\n");
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
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0].thinkingLevel).toBe("medium");
});

test("model groups TUI MODEL_EDIT stale level on an unavailable model keeps Status unavailable and preserves the value", async () => {
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "missing", modelId: "nope", thinkingLevel: "max" }] } } },
		store: () => ({
			updateGroup: (_scope, _access, _name, def) => {
				calls.push(def);
			},
		}),
	});
	openModelEdit(c, "nope");
	const text = rendered(c);
	expect(text).toMatch(/Status: unavailable/);
	expect(text.match(/Thinking: max/g) ?? []).toHaveLength(1);
	expect(text).toMatch(/→ Thinking: max/);
	expect(text).toMatch(/Thinking: max ⚠ current, unavailable/);
	expect(text).toMatch(/^ {2}Thinking: inherit$/m);
	expect(text).not.toMatch(/Thinking: inherit ⚠ current, unavailable/);
	// Enter from the stale row writes the same configured value back.
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0].thinkingLevel).toBe("max");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI WIZARD thinking step still starts on inherit and persists a chosen supported level", async () => {
	const persisted: (ModelGroupModel | undefined)[] = [];
	const { c } = component({ registry: await tuiRegistry(), defs: { project: { review: { models: [] } } }, store: recordingLastModel(persisted) });
	// EDITOR → + Add model → WIZARD_PROVIDER → orange → WIZARD_MODEL (gpt-5) → WIZARD_THINKING.
	openAddModelWizard(c);
	press(c, DOWN, ENTER);
	press(c, ENTER);
	expect(rendered(c)).toMatch(/Add model — Step 3\/3 Thinking/);
	expect(rendered(c)).toMatch(/→ inherit/);
	press(c, DOWN);
	expect(rendered(c)).toMatch(/→ off/);
	press(c, ENTER);
	expect(persisted).toStrictEqual([{ provider: "orange", modelId: "gpt-5", thinkingLevel: "off" }]);
});

test("model groups TUI MODEL_EDIT clamps DOWN on Remove model and D removes a stale-valued member", async () => {
	const { c, calls } = await openStaleLevelModelEdit();
	// DOWN clamps on the final row regardless of how many thinking rows exist.
	press(c, DOWN, DOWN, DOWN, DOWN, DOWN);
	expect(rendered(c)).toMatch(/→ Remove model/);
	expect(rendered(c)).not.toMatch(/→ Thinking: inherit/);
	press(c, "D");
	expect(calls).toHaveLength(1);
	expect(calls[0].models).toStrictEqual([]);
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT dropping a stale level back to inherit deliberately persists inherit", async () => {
	const { c, calls } = await openStaleLevelModelEdit();
	// Explicitly choosing inherit drops the stale value.
	press(c, UP);
	expect(selectedRow(c)).toMatch(/Thinking: inherit/);
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0]).not.toHaveProperty("thinkingLevel");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT marks the default inherit row current when no level is configured", async () => {
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "orange", modelId: "gpt-5" }] } } },
		store: () => ({
			updateGroup: (_scope, _access, _name, def) => {
				calls.push(def);
			},
		}),
	});
	openModelEdit(c, "gpt-5");
	const text = rendered(c);
	// With no configured level, inherit is the current value and the only marked row.
	expect(text).toMatch(/→ Thinking: inherit ✓ current/);
	expect(text.match(/✓ current/g) ?? []).toHaveLength(1);
	expect(text).not.toMatch(/⚠ current, unavailable/);
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0]).not.toHaveProperty("thinkingLevel");
	expect(rendered(c)).toMatch(/Model Group: review/);
});

test("model groups TUI MODEL_EDIT opens on a supported level for a registered-but-unauthenticated model", async () => {
	// The model resolves (so its levels are known) but has no configured auth, so
	// Status is unavailable while the configured supportable level is still current.
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "keyless", modelId: "gpt-no-auth", thinkingLevel: "high" }] } } },
		store: () => ({
			updateGroup: (_scope, _access, _name, def) => {
				calls.push(def);
			},
		}),
	});
	openModelEdit(c, "gpt-no-auth");
	const text = rendered(c);
	expect(text).toMatch(/Status: unavailable/);
	expect(text).toMatch(/→ Thinking: high/);
	expect(text.match(/✓ current/g) ?? []).toHaveLength(1);
	expect(text).toMatch(/Thinking: high ✓ current/);
	expect(text).not.toMatch(/⚠ current, unavailable/);
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0].thinkingLevel).toBe("high");
});

test("model groups TUI MODEL_EDIT treats a stale off level on a non-reasoning model as current, unavailable", async () => {
	// claude is reasoning:false, so `off` is filtered out of its offered options;
	// the configured value must still be shown and preserved.
	const calls: ModelGroupDef[] = [];
	const { c } = component({
		registry: await tuiRegistry(),
		defs: { project: { review: { models: [{ provider: "alpha", modelId: "claude", thinkingLevel: "off" }] } } },
		store: () => ({
			updateGroup: (_scope, _access, _name, def) => {
				calls.push(def);
			},
		}),
	});
	openModelEdit(c, "claude");
	const text = rendered(c);
	expect(text).toMatch(/→ Thinking: off/);
	expect(text).toMatch(/Thinking: off ⚠ current, unavailable/);
	expect(text).toMatch(/^ {2}Thinking: inherit$/m);
	press(c, ENTER);
	expect(calls).toHaveLength(1);
	expect(calls[0].models[0].thinkingLevel).toBe("off");
	expect(rendered(c)).toMatch(/Model Group: review/);
});
