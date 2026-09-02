import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel, type Api } from "@earendil-works/pi-ai";
import { Container, fuzzyFilter, Input, Key, matchesKey, SelectList, sliceByColumn, truncateToWidth, visibleWidth, type Component, type Focusable, type SelectItem, type SelectListLayoutOptions, type SelectListTruncatePrimaryContext, type TUI } from "@earendil-works/pi-tui";
import {
	createGroup,
	deleteGroup,
	listResolvedModelGroups,
	moveGroup,
	renameGroup,
	summarizeBootValidation,
	updateGroup,
} from "./store.js";
import { MODEL_GROUP_MODALITIES, ModelGroupsPersistenceError, type ModelGroupDef, type ModelGroupModality, type ModelGroupScope, type ModelGroupsAccess, type ModelGroupsBootValidation, type ResolvedModelGroup } from "./types.js";
import { canonicalizeModelGroupName } from "./names.js";
import { decodeDisplayLabel, escapeDisplayLabel } from "./display.js";
import { MODALITY_FG, MODALITY_LETTER, modalityLetterRun as buildModalityLetterRun } from "./modality.js";
import { getModalitiesModelFact } from "./constraints/modalities.js";
import { constraintEditorRows, presentConstraintDiagnosticRecords, type ConstraintEditorRow } from "./constraints/presentation.js";
import { productionConstraintRegistry } from "./constraints/registry.js";
import type { AnyConstraintDescriptor, ErasedConstraintEvaluation } from "./constraints/types.js";

export type ModelGroupsScreen = "LIST" | "EDITOR" | "MODALITIES" | "MODEL_EDIT" | "WIZARD_PROVIDER" | "WIZARD_MODEL" | "WIZARD_THINKING" | "DELETE_CONFIRM";

export interface ModelGroupsStoreOps {
	listResolvedModelGroups: typeof listResolvedModelGroups;
	createGroup: typeof createGroup;
	updateGroup: typeof updateGroup;
	renameGroup: typeof renameGroup;
	deleteGroup: typeof deleteGroup;
	moveGroup: typeof moveGroup;
}

export interface ModelGroupsComponentOptions {
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	initialValidation?: ModelGroupsBootValidation | null;
	onRefresh?: (validation: ModelGroupsBootValidation) => void;
	store?: Partial<ModelGroupsStoreOps>;
}

const defaultStore: ModelGroupsStoreOps = { listResolvedModelGroups, createGroup, updateGroup, renameGroup, deleteGroup, moveGroup };

function isEnter(data: string): boolean { return matchesKey(data, Key.enter) || data === "\n"; }
function isEsc(data: string): boolean { return matchesKey(data, Key.escape); }
const isSpace = (data: string) => data === " ";
function isUp(data: string): boolean { return matchesKey(data, Key.up); }
function isDown(data: string): boolean { return matchesKey(data, Key.down); }
function isLeft(data: string): boolean { return matchesKey(data, Key.left); }
function isBackspace(data: string): boolean { return matchesKey(data, Key.backspace); }
function isDeleteChord(data: string): boolean { return data === "D" || matchesKey(data, Key.delete); }

function cloneDef(def: ModelGroupDef): ModelGroupDef {
	const constraints = def.constraints === undefined ? undefined : { ...def.constraints, ...(Array.isArray(def.constraints.modalities) ? { modalities: [...def.constraints.modalities] } : {}) };
	return { ...def, models: def.models.map((model) => ({ ...model })), ...(constraints === undefined ? {} : { constraints }) };
}

function groupKey(group: Pick<ResolvedModelGroup, "scope" | "name">): string {
	return `${group.scope}:${group.name}`;
}

function thinkingLabel(level: ModelThinkingLevel | undefined): string {
	return level ?? "inherit";
}

function modelAvailable(registry: ModelRegistry, provider: string, modelId: string): boolean {
	const model = registry.find(provider, modelId);
	return Boolean(model && registry.hasConfiguredAuth(model));
}

function modelDisplay(model: Model<Api>): string {
	return `${escapeDisplayLabel(model.provider)}/${escapeDisplayLabel(model.id)}`;
}

function toPersistenceMessage(error: unknown): string {
	if (error instanceof ModelGroupsPersistenceError) {
		const scope = error.scope ? ` for ${error.scope} scope` : "";
		const paths = [error.sourcePath ? `source: ${escapeDisplayLabel(error.sourcePath)}` : "", error.targetPath ? `target: ${escapeDisplayLabel(error.targetPath)}` : ""].filter(Boolean).join("; ");
		const pathDetails = paths ? ` (${paths})` : "";
		const cause = error.cause === undefined ? "" : `; cause: ${escapeDisplayLabel(error.cause instanceof Error ? error.cause.message : String(error.cause))}`;
		const partial = error.partialMove ? `; ${error.partialMove}` : "";
		return `${error.operation} failed at ${error.phase}${scope}${pathDetails}: ${escapeDisplayLabel(error.message)}${cause}${partial}`;
	}
	return escapeDisplayLabel(error instanceof Error ? error.message : String(error));
}

export function createModelGroupsComponent(
	tui: TUI,
	theme: Theme,
	modelRegistry: ModelRegistry,
	access: ModelGroupsAccess,
	done: (result: void) => void,
	options: ModelGroupsComponentOptions = {},
): Component & Focusable {
	const store = { ...defaultStore, ...options.store };
	const notify = options.notify ?? (() => {});
	const state = {
		screen: "LIST" as ModelGroupsScreen,
		row: 0,
		groups: [] as ResolvedModelGroup[],
		loadIssues: [] as ModelGroupsBootValidation["loadIssues"],
		editKey: null as string | null,
		editName: "",
		editScope: (access.policy === "global-project" ? "project" : "global") as ModelGroupScope,
		editDraft: null as ModelGroupDef | null,
		activeTextInput: null as null | "group-name",
		modelEditIndex: 0,
		wizardProvider: "",
		wizardModelId: "",
		deleteKey: null as string | null,
		finished: false,
	};
	const groupNameInput = new Input();
	let modelSearchInput = new Input();
	let rootFocused = false;
	let activeSelect: SelectList | null = null;
	const nameRow = () => access.policy === "global-project" ? 2 : 1;
	const modalityRow = () => nameRow() + 1;
	const modelStartRow = () => modalityRow() + 1;
	function syncInputFocus(): void {
		groupNameInput.focused = rootFocused && state.screen === "EDITOR" && state.row === nameRow() && state.activeTextInput === "group-name";
		modelSearchInput.focused = rootFocused && state.screen === "WIZARD_MODEL";
	}
	function resetModelSearch(): void {
		modelSearchInput = new Input();
		state.row = 0;
		activeSelect = null;
		syncInputFocus();
	}
	function setGroupNameInputValue(value: string): void {
		groupNameInput.setValue(value);
		groupNameInput.handleInput("\u001b[F");
	}

	function refresh(): void {
		const boot = store.listResolvedModelGroups(access, modelRegistry);
		state.groups = boot.groups;
		state.loadIssues = boot.loadIssues;
		options.onRefresh?.(boot);
		for (const issue of boot.loadIssues) {
			const backupPath = issue.backupPath ? escapeDisplayLabel(issue.backupPath) : "";
			const backup = issue.backupFailed ? `; backup failed${backupPath ? ` (${backupPath})` : ""}, original file left untouched` : "";
			notify(`Model Groups config ${issue.kind} in ${issue.scope} scope (${escapeDisplayLabel(issue.sourcePath)}); using empty config for that scope${backup}; ${escapeDisplayLabel(issue.message)}`, "warning");
		}
	}

	if (options.initialValidation) {
		state.groups = options.initialValidation.groups
			.filter((group) => access.policy === "global-project" || group.scope === "global")
			.map((group) => access.policy === "global-project" ? group : { ...group, validation: { ...group.validation, shadowedByProject: false } });
		state.loadIssues = options.initialValidation.loadIssues.filter((issue) => access.policy === "global-project" || issue.scope === "global");
	} else {
		refresh();
	}

	function selectedGroup(): ResolvedModelGroup | undefined {
		return state.groups[state.row];
	}

	function openEditor(group: ResolvedModelGroup): void {
		state.screen = "EDITOR";
		state.row = 0;
		state.editKey = groupKey(group);
		state.editName = escapeDisplayLabel(group.name);
		setGroupNameInputValue(state.editName);
		state.editScope = group.scope;
		state.editDraft = cloneDef(group);
		state.activeTextInput = null;
		syncInputFocus();
	}

	function currentEditGroup(): ResolvedModelGroup | undefined {
		return state.groups.find((group) => groupKey(group) === state.editKey) ?? state.groups.find((group) => group.name === state.editName && group.scope === state.editScope);
	}

	function uniqueNewGroupName(): string {
		const existing = new Set(state.groups.map((group) => group.name));
		if (!existing.has("new-group")) return "new-group";
		let index = 2;
		while (existing.has(`new-group-${index}`)) index++;
		return `new-group-${index}`;
	}

	function notifyError(error: unknown): void {
		notify(toPersistenceMessage(error), "error");
	}

	function commitName(): boolean {
		const group = currentEditGroup();
		if (!group) return false;
		state.editName = groupNameInput.getValue();
		const decoded = decodeDisplayLabel(state.editName);
		if (!decoded.ok) {
			notify(escapeDisplayLabel(decoded.message), "error");
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			return false;
		}
		const nextName = canonicalizeModelGroupName(decoded.value);
		if (!nextName) {
			notify("Model group name is required", "error");
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			return false;
		}
		if (nextName === group.name) {
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			return true;
		}
		try {
			store.renameGroup(group.scope, access, group.name, nextName);
			refresh();
			const renamed = state.groups.find((candidate) => candidate.name === nextName && candidate.scope === group.scope);
			if (renamed) openEditor(renamed);
			return true;
		} catch (error) {
			notifyError(error);
			state.editName = escapeDisplayLabel(group.name);
			setGroupNameInputValue(state.editName);
			state.activeTextInput = null;
			syncInputFocus();
			return false;
		}
	}

	function switchScope(newScope: ModelGroupScope): void {
		const group = currentEditGroup();
		if (!group || newScope === group.scope) return;
		if (!commitName()) return;
		const confirmed = currentEditGroup();
		if (!confirmed) return;
		try {
			store.moveGroup(access, confirmed.name, newScope);
			refresh();
			const moved = state.groups.find((candidate) => candidate.name === confirmed.name && candidate.scope === newScope);
			if (moved) openEditor(moved);
		} catch (error) {
			notifyError(error);
		}
	}

	/** Persist the draft, refresh state, and re-resolve the updated group. No navigation. */
	function persistDraft(def: ModelGroupDef): ResolvedModelGroup | undefined {
		const group = currentEditGroup();
		if (!group) return undefined;
		try {
			store.updateGroup(group.scope, access, group.name, def, modelRegistry);
			refresh();
			return state.groups.find((candidate) => candidate.name === group.name && candidate.scope === group.scope);
		} catch (error) {
			notifyError(error);
			return undefined;
		}
	}

	function updateDraft(def: ModelGroupDef, afterSuccess: () => void): void {
		const updated = persistDraft(def);
		if (!updated) return; // error already notified; do not navigate
		openEditor(updated);
		afterSuccess();
	}

	function availableModels(): Model<Api>[] {
		return modelRegistry.getAvailable()
			.filter((model) => modelRegistry.hasConfiguredAuth(model));
	}

	function allProviders(): string[] {
		return [...new Set(availableModels().map((model) => model.provider))].sort();
	}

	function modelsForProvider(provider: string): Model<Api>[] {
		return availableModels()
			.filter((model) => model.provider === provider)
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	function filteredModelsForProvider(provider: string): Model<Api>[] {
		const eligible = modelsForProvider(provider);
		return fuzzyFilter(eligible, modelSearchInput.getValue(), (model) => [
			model.id,
			model.provider,
			`${model.provider}/${model.id}`,
			model.name ?? "",
		].join(" "));
	}

	function currentWizardModel(): Model<Api> | undefined {
		return modelRegistry.find(state.wizardProvider, state.wizardModelId) as Model<Api> | undefined;
	}

	function thinkingOptionsFor(model: Model<Api> | undefined): Array<ModelThinkingLevel | undefined> {
		if (!model) return [undefined];
		const supported = getSupportedThinkingLevels(model).filter((level) => model.reasoning || level !== "off");
		return [undefined, ...supported];
	}

	function activeConstraintEditor(): { descriptor: AnyConstraintDescriptor; evaluation: ErasedConstraintEvaluation } | undefined {
		const group = currentEditGroup();
		const evaluation = group?.evaluations?.find((candidate) => productionConstraintRegistry.get(candidate.key)?.editor.kind === "multi-select");
		const descriptor = evaluation && productionConstraintRegistry.get(evaluation.key);
		if (descriptor && evaluation) return { descriptor, evaluation };
		// Test/store adapters that predate generic evaluations retain the production descriptor's compatibility projection.
		const compatibilityDescriptor = productionConstraintRegistry.descriptors.find((candidate) => candidate.editor.kind === "multi-select");
		if (!group || !compatibilityDescriptor) return undefined;
		const reconciled = compatibilityDescriptor.reconcile({ aggregate: group.modalities, override: state.editDraft?.constraints?.modalities });
		return { descriptor: compatibilityDescriptor, evaluation: { key: compatibilityDescriptor.key, aggregate: group.modalities, effective: reconciled.effective, diagnostics: reconciled.diagnostics } };
	}

	function modalityEditorRows(): readonly ConstraintEditorRow[] {
		const editor = activeConstraintEditor();
		if (!editor) return [];
		// The modalities hand-edit screen is rebuilt around disabling capabilities
		// from the union: only the toggleable media rows remain (no Automatic
		// selector row). Text is the required base when the group's members support
		// it and reasoning is handled per-model (thinkingLevel), so both are
		// excluded from toggles.
		return constraintEditorRows(editor.descriptor, editor.evaluation, state.editDraft?.constraints?.[editor.descriptor.key]).filter(
			(row) => row.kind === "toggle" && row.value !== "reasoning" && row.value !== "text",
		);
	}

	function maxRow(): number {
		switch (state.screen) {
			case "LIST": return state.groups.length;
			case "EDITOR": return modelStartRow() + (state.editDraft?.models.length ?? 0);
			case "MODALITIES": return Math.max(0, modalityEditorRows().length - 1);
			case "MODEL_EDIT": {
				const reference = state.editDraft?.models[state.modelEditIndex];
				const model = modelRegistry.find(reference?.provider ?? "", reference?.modelId ?? "") as Model<Api> | undefined;
				const options = thinkingOptionsFor(model);
				return options.length;
			}
			case "WIZARD_PROVIDER": return Math.max(0, allProviders().length - 1);
			case "WIZARD_MODEL": return Math.max(0, filteredModelsForProvider(state.wizardProvider).length - 1);
			case "WIZARD_THINKING": return Math.max(0, thinkingOptionsFor(currentWizardModel()).length - 1);
			case "DELETE_CONFIRM": return 1;
		}
	}

	function clampRow(): void {
		state.row = Math.max(0, Math.min(state.row, maxRow()));
	}

	function activate(): void {
		switch (state.screen) {
			case "LIST": {
				if (state.row === state.groups.length) {
					const name = uniqueNewGroupName();
					try {
						const scope = access.policy === "global-project" ? "project" : "global";
						store.createGroup(scope, access, name, { models: [] }, modelRegistry);
						refresh();
						const created = state.groups.find((group) => group.name === name && group.scope === scope);
						if (created) openEditor(created);
					} catch (error) { notifyError(error); }
					return;
				}
				const group = selectedGroup();
				if (group) openEditor(group);
				return;
			}
			case "EDITOR": {
				if (access.policy === "global-project" && state.row === 0) { switchScope("project"); return; }
				if ((access.policy === "global-project" && state.row === 1) || (access.policy === "global-only" && state.row === 0)) { switchScope("global"); return; }
				if (state.row === nameRow()) { state.activeTextInput = "group-name"; syncInputFocus(); return; }
				if (state.row === modalityRow()) { state.screen = "MODALITIES"; state.row = 0; return; }
				if (!commitName()) return;
				const modelIndex = state.row - modelStartRow();
				if (state.editDraft && modelIndex < state.editDraft.models.length) {
					state.modelEditIndex = modelIndex;
					state.screen = "MODEL_EDIT";
					state.row = 0;
				} else {
					resetModelSearch();
					state.screen = "WIZARD_PROVIDER";
					state.row = 0;
				}
				return;
			}
			case "MODALITIES": {
				if (!state.editDraft) return;
				const editor = activeConstraintEditor();
				const selected = modalityEditorRows()[state.row];
				// No toggle rows (text-only / unresolvable) → Enter/Space are inert.
				if (!editor || !selected || selected.kind !== "toggle") return;
				const next = cloneDef(state.editDraft);
				const base = [...(editor.evaluation.effective as ModelGroupModality[])];
				const pressed = selected.value as ModelGroupModality;
				// Disable a capability by subtracting it from the current effective
				// (preserving hidden reasoning); re-enable by adding it back.
				const toggled = base.includes(pressed)
					? base.filter((modality) => modality !== pressed)
					: orderedModalities([...base, pressed]);
				const supported = orderedModalities((editor.evaluation.aggregate as { supported?: ModelGroupModality[] }).supported ?? []);
				if (orderedModalities(toggled).join(",") === supported.join(",")) {
					// Re-enabling back to the full union returns the group to Automatic:
					// no override is stored, so no spawn ceiling attaches to a non-limit.
					if (next.constraints) delete next.constraints[editor.descriptor.key];
					if (next.constraints && Object.keys(next.constraints).length === 0) delete next.constraints;
				} else {
					(next.constraints ??= {})[editor.descriptor.key] = toggled;
				}
				const updated = persistDraft(next);
				if (updated) {
					// Re-bind the draft to the toggled override while staying on this screen.
					state.editKey = groupKey(updated);
					state.editName = escapeDisplayLabel(updated.name);
					setGroupNameInputValue(state.editName);
					state.editScope = updated.scope;
					state.editDraft = next;
					state.activeTextInput = null;
					syncInputFocus();
				}
				return;
			}
			case "MODEL_EDIT": {
				const model = state.editDraft?.models[state.modelEditIndex];
				if (!state.editDraft || !model) return;
				const found = modelRegistry.find(model.provider, model.modelId) as Model<Api> | undefined;
				const options = thinkingOptionsFor(found);
				if (state.row >= options.length) {
					const next = cloneDef(state.editDraft);
					next.models.splice(state.modelEditIndex, 1);
					updateDraft(next, () => { state.screen = "EDITOR"; state.row = 0; });
					return;
				}
				const next = cloneDef(state.editDraft);
				const level = options[state.row];
				if (level === undefined) delete next.models[state.modelEditIndex].thinkingLevel;
				else next.models[state.modelEditIndex].thinkingLevel = level;
				updateDraft(next, () => { state.screen = "EDITOR"; state.row = 0; });
				return;
			}
			case "WIZARD_PROVIDER": {
				const provider = allProviders()[state.row];
				if (!provider) return;
				state.wizardProvider = provider;
				resetModelSearch();
				state.screen = "WIZARD_MODEL";
				state.row = 0;
				installModelSelect();
				return;
			}
			case "WIZARD_MODEL": return; // Model activation is owned by the same-build filtered SelectList callback.
			case "WIZARD_THINKING": {
				if (!state.editDraft) return;
				const level = thinkingOptionsFor(currentWizardModel())[state.row];
				const next = cloneDef(state.editDraft);
				const entry = { provider: state.wizardProvider, modelId: state.wizardModelId } as { provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel };
				if (level !== undefined) entry.thinkingLevel = level;
				next.models.push(entry);
				updateDraft(next, () => { resetModelSearch(); state.screen = "EDITOR"; state.row = 0; });
				return;
			}
			case "DELETE_CONFIRM": {
				if (state.row === 0) { state.screen = "LIST"; state.row = 0; return; }
				const group = state.groups.find((candidate) => groupKey(candidate) === state.deleteKey);
				if (!group) { state.screen = "LIST"; return; }
				try {
					store.deleteGroup(group.scope, access, group.name);
					refresh();
					state.screen = "LIST";
					state.row = 0;
				} catch (error) { notifyError(error); }
				return;
			}
		}
	}

	function goBack(): void {
		if (state.activeTextInput === "group-name") { commitName(); state.activeTextInput = null; return; }
		switch (state.screen) {
			case "LIST": state.finished = true; done(); return;
			case "EDITOR": commitName(); state.screen = "LIST"; state.row = 0; return;
			case "MODALITIES": state.screen = "EDITOR"; state.row = modalityRow(); return;
			case "MODEL_EDIT": state.screen = "EDITOR"; state.row = 0; return;
			case "WIZARD_PROVIDER": resetModelSearch(); state.screen = "EDITOR"; state.row = 0; return;
			case "WIZARD_MODEL": resetModelSearch(); state.screen = "WIZARD_PROVIDER"; state.row = 0; return;
			case "WIZARD_THINKING": state.screen = "WIZARD_MODEL"; state.row = 0; installModelSelect(); return;
			case "DELETE_CONFIRM": state.screen = "LIST"; state.row = 0; return;
		}
	}

	function deleteAction(): void {
		if (state.screen === "LIST") {
			const group = selectedGroup();
			if (!group) return;
			state.deleteKey = groupKey(group);
			state.screen = "DELETE_CONFIRM";
			state.row = 0;
		} else if (state.screen === "MODEL_EDIT") {
			state.row = maxRow();
			activate();
		}
	}

	function selectableLine(selected: boolean, primary: string, suffix = ""): string {
		if (!selected) return `  ${primary}${suffix}`;
		return `${theme.fg("accent", "→")} ${theme.fg("accent", primary)}${suffix}`;
	}

	function textLine(value: string): Component {
		return { render: () => [value], invalidate: () => {} };
	}

	function groupNameLineComponent(): Component {
		return {
			render: (width: number) => {
				if (width <= 0) return [""];
				const selected = state.row === nameRow();
				const prefix = selectableLine(selected, "Name:", " ");
				if (state.activeTextInput !== "group-name") {
					return [truncateToWidth(`${prefix}${groupNameInput.getValue()}`, width, "")];
				}

				const clippedPrefix = truncateToWidth(prefix, Math.max(0, width - 1), "");
				const remainingWidth = width - visibleWidth(clippedPrefix);
				const inputLine = groupNameInput.render(remainingWidth + 2)[0] ?? "";
				const inputWithoutPrompt = inputLine.startsWith("> ") ? inputLine.slice(2) : inputLine;
				return [truncateToWidth(`${clippedPrefix}${inputWithoutPrompt}`, width, "")];
			},
			invalidate: () => groupNameInput.invalidate(),
		};
	}

	// Media modalities editable in the modalities screen. Reasoning is a distinct
	// capability (per-member thinkingLevel / routing gate) and is not exposed here.
	const VISIBLE_MODALITIES = MODEL_GROUP_MODALITIES.filter((modality) => modality !== "reasoning") as ModelGroupModality[];

	/** Vocab-order the given modalities per MODEL_GROUP_MODALITIES. */
	function orderedModalities(values: Iterable<ModelGroupModality>): ModelGroupModality[] {
		const set = new Set(values);
		return MODEL_GROUP_MODALITIES.filter((modality) => set.has(modality));
	}

	/** Dim wrap, so each description run re-asserts dim after an inner colored span's \x1b[39m. */
	function dim(s: string): string {
		return theme.fg("dim", s);
	}

	/** A non-selectable section bar: dim rule, accent label, dim rule. */
	function sectionBar(label: string): string {
		return `${dim("── ")}${theme.fg("accent", label)}${dim(" ──")}`;
	}

	/** Colored single-letter run for a group's effective media modalities + dimmed padding. Empty set -> "". */
	function modalityLetterRun(effective: readonly ModelGroupModality[] | null | undefined): string {
		return buildModalityLetterRun(effective, {
			render: (modality, letter) => theme.fg(MODALITY_FG[modality], letter),
			separator: dim(" "),
		});
	}

	/** Build a modality-tagged description whose dim segments re-assert dim after each colored letter. */
	function modalityDescription(
		scope: ModelGroupScope,
		count: number,
		thinking: string,
		tags: string,
		effective: readonly ModelGroupModality[] | null | undefined,
	): string {
		const head = dim(`[${scope}] ${count} models`);
		const letters = modalityLetterRun(effective);
		return `${head}${letters ? `${dim(" ")}${letters}${dim(" ")}` : dim(" ")}${dim(thinking)}${tags ? dim(` — ${tags}`) : ""}`;
	}

	const selectTheme = {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("dim", text),
	};

	function buildSelect(items: SelectItem[]): SelectList {
		const select = new SelectList(items, Math.max(1, items.length), selectTheme);
		select.setSelectedIndex(Math.min(state.row, Math.max(0, items.length - 1)));
		select.onSelectionChange = (item) => { state.row = Number(item.value); syncInputFocus(); };
		select.onSelect = (item) => { state.row = Number(item.value); activate(); syncInputFocus(); };
		select.onCancel = () => { goBack(); syncInputFocus(); };
		activeSelect = select;
		return select;
	}

	function installModelSelect(): void {
		const models = filteredModelsForProvider(state.wizardProvider);
		activeSelect = models.length > 0 ? buildModelSelect(models) : null;
	}

	// Model rows are "provider/id" labels; the library's default truncation cuts the
	// tail silently (no marker). Instead, keep the distinguishing id tail behind a
	// visible ellipsis and dim the provider prefix on non-selected rows.
	const MODEL_ROW_ELLIPSIS = "…";

	function tailOfWidth(text: string, maxWidth: number): string {
		const width = visibleWidth(text);
		if (width <= maxWidth) return text;
		return sliceByColumn(text, Math.max(0, width - maxWidth), maxWidth, true);
	}

	function truncateModelRow(context: SelectListTruncatePrimaryContext): string {
		const { text, maxWidth, isSelected } = context;
		if (maxWidth <= 0) return "";
		if (visibleWidth(text) <= maxWidth) {
			const slash = text.lastIndexOf("/");
			if (isSelected || slash < 0) return text;
			return `${dim(text.slice(0, slash + 1))}${text.slice(slash + 1)}`;
		}
		const slash = text.lastIndexOf("/");
		const provider = slash >= 0 ? text.slice(0, slash + 1) : "";
		const id = slash >= 0 ? text.slice(slash + 1) : text;
		const providerWidth = visibleWidth(provider);
		const ellipsisWidth = visibleWidth(MODEL_ROW_ELLIPSIS);
		let keptProvider = "";
		let tailBudget = maxWidth - ellipsisWidth;
		if (providerWidth > 0 && providerWidth + ellipsisWidth < maxWidth) {
			keptProvider = isSelected ? provider : dim(provider);
			tailBudget = maxWidth - providerWidth - ellipsisWidth;
		}
		const tail = tailOfWidth(id, tailBudget);
		return tail ? `${keptProvider}${MODEL_ROW_ELLIPSIS}${tail}` : `${keptProvider}${MODEL_ROW_ELLIPSIS}`;
	}

	function buildModelSelect(models: Model<Api>[]): SelectList {
		const items = models.map((model, index) => ({
			value: String(index),
			label: modelDisplay(model),
			description: modalityLetterRun(getModalitiesModelFact(model)),
		}));
		const select = new SelectList(items, 10, selectTheme, {
			// A wider primary column keeps common ids visible; rows still truncate
			// tail-first through truncateModelRow when the terminal is narrow.
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 48,
			truncatePrimary: truncateModelRow,
		});
		select.setSelectedIndex(Math.min(state.row, Math.max(0, items.length - 1)));
		select.onSelectionChange = (item) => { state.row = Number(item.value); syncInputFocus(); };
		select.onSelect = (item) => {
			const model = models[Number(item.value)];
			if (!model) return;
			state.row = Number(item.value);
			state.wizardModelId = model.id;
			state.screen = "WIZARD_THINKING";
			state.row = 0;
			syncInputFocus();
		};
		select.onCancel = () => { goBack(); syncInputFocus(); };
		activeSelect = select;
		return select;
	}

	function renderListComponent(): Component {
		const summary = summarizeBootValidation(state.groups);
		const container = new Container();
		container.addChild(textLine(theme.fg("accent", "Model Groups")));
		container.addChild(textLine(theme.fg("dim", `Boot validation: ${summary.unavailableCount} unavailable model references · ${summary.overrideCount} project overrides`)));
		const legend = `${theme.fg("dim", "modalities: ")}${VISIBLE_MODALITIES.map((modality) => `${theme.fg(MODALITY_FG[modality], MODALITY_LETTER[modality])}${dim(" " + modality)}`).join(dim(" · "))}`;
		container.addChild(textLine(legend));
		const items: SelectItem[] = state.groups.map((group, index) => {
			const tags: string[] = [];
			if (group.validation.degraded) tags.push("⚠ degraded");
			if (group.validation.unavailableRefs.length > 0) tags.push("✗ unavailable");
			if (group.validation.shadowedByProject) tags.push("project override");
			const models = group.models.map((model) => thinkingLabel(model.thinkingLevel)).join(", ") || "empty";
			if (group.evaluations) tags.push(...presentConstraintDiagnosticRecords(group.evaluations, productionConstraintRegistry).map((diagnostic) => diagnostic.text));
			else {
				if (group.validation.emptyCommonModalities) tags.push("⚠ no common modalities");
				if (group.validation.unsupportedOverrideModalities.length > 0) tags.push(`⚠ stale modality override: ${group.validation.unsupportedOverrideModalities.join(", ")}`);
			}
			const description = modalityDescription(group.scope, group.models.length, models, tags.join(" · "), group.modalities?.effective);
			return { value: String(index), label: escapeDisplayLabel(group.name), description };
		});
		items.push({ value: String(state.groups.length), label: "+ Add group" });
		container.addChild(buildSelect(items));
		container.addChild(textLine(theme.fg("dim", "↑↓ navigate • Enter open/add • D delete • Esc close")));
		return container;
	}

	function renderEditorComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const current = currentEditGroup();
		const title = theme.fg("accent", `Model Group: ${escapeDisplayLabel(current?.name ?? "")}`);
		container.addChild(textLine(title));

		if (access.policy === "global-project") {
			const projectLocation = selectableLine(state.row === 0, "Location: project", state.editScope === "project" ? " ✓" : "");
			container.addChild(textLine(projectLocation));
		}
		const globalLocationRow = access.policy === "global-project" ? 1 : 0;
		const globalLocation = selectableLine(state.row === globalLocationRow, "Location: global", state.editScope === "global" ? " ✓" : "");
		container.addChild(textLine(globalLocation));
		container.addChild(groupNameLineComponent());

		const modalities = current?.modalities;
		const capabilitiesBar = sectionBar("Capabilities");
		container.addChild(textLine(capabilitiesBar));
		const commonModalities = modalities?.common.filter((modality) => modality !== "reasoning").join(", ") || "none";
		const commonCapabilities = theme.fg("dim", `  Supported by every model: ${commonModalities}`);
		container.addChild(textLine(commonCapabilities));
		const modalityState = state.editDraft?.constraints?.modalities === undefined ? "Automatic" : "Override";
		const effectiveModalities = modalities?.effective.filter((modality) => modality !== "reasoning").join(", ") || "none";
		const modalityLine = selectableLine(state.row === modalityRow(), `Modalities: ${modalityState} (${effectiveModalities})`);
		container.addChild(textLine(modalityLine));
		const modelsBar = sectionBar("Models");
		container.addChild(textLine(modelsBar));

		state.editDraft?.models.forEach((model, index) => {
			const available = modelAvailable(modelRegistry, model.provider, model.modelId) ? "available" : "unavailable";
			const found = modelRegistry.find(model.provider, model.modelId) as Model<Api> | undefined;
			// Per-model capability chip, mirroring the Add-model picker (D2). Unresolved
			// members have no fact, so they render without a chip.
			const chip = found ? modalityLetterRun(getModalitiesModelFact(found)) : "";
			const id = `${escapeDisplayLabel(model.provider)}/${escapeDisplayLabel(model.modelId)}`;
			const selected = state.row === index + modelStartRow();
			const label = chip ? `${id} ${chip}` : id;
			const suffix = ` (${available}, thinking ${thinkingLabel(model.thinkingLevel)})`;
			const modelLine = selectableLine(selected, label, suffix);
			container.addChild(textLine(modelLine));
		});
		const addRow = modelStartRow() + (state.editDraft?.models.length ?? 0);
		const addModelLine = selectableLine(state.row === addRow, "+ Add model…");
		container.addChild(textLine(addModelLine));
		return container;
	}

	function renderModalitiesComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const editor = activeConstraintEditor();
		const current = currentEditGroup();
		const key = editor?.descriptor.key ?? "modalities";
		const isAutomatic = state.editDraft?.constraints?.[key] === undefined;
		const effective = (editor?.evaluation.effective ?? []) as ModelGroupModality[];
		const rows = modalityEditorRows();
		container.addChild(textLine(theme.fg("accent", `Modalities — ${escapeDisplayLabel(current?.name ?? "")}`)));
		// Text is the required base capability — not toggleable — but only when the
		// group's members actually support it: empty groups derive no supported
		// modalities, so they must not claim text (the empty state below speaks).
		const supportedModalities = (editor?.evaluation.aggregate as { supported?: readonly string[] } | undefined)?.supported;
		if (supportedModalities?.includes("text")) {
			container.addChild(textLine(`  ${theme.fg(MODALITY_FG.text, MODALITY_LETTER.text)}${dim(" text  [required]")}`));
		}
		for (const [index, row] of rows.entries()) {
			if (row.kind !== "toggle") continue;
			const modality = row.value as ModelGroupModality;
			const letter = theme.fg(MODALITY_FG[modality], MODALITY_LETTER[modality]);
			const stateText = row.active ? "[on]" : "[off]";
			// The selected row is accent-highlighted (arrow + label) while the modality
			// letter keeps its own color; [on]/[off] read as live toggle state.
			const selected = state.row === index;
			const label = selected
				? `${theme.fg("accent", "→")} ${letter}${theme.fg("accent", ` ${row.label}  ${stateText}`)}`
				: `  ${letter}${dim(` ${row.label}  ${stateText}`)}`;
			container.addChild(textLine(label));
		}
		if (rows.length === 0) container.addChild(textLine(theme.fg("dim", "  No optional media capabilities available.")));
		// Single editable row screens drop arrow navigation — toggling + Esc is the whole flow.
		container.addChild(textLine(theme.fg("dim", rows.length > 1 ? "↑↓ navigate • Enter/Space toggle • Esc back" : rows.length === 1 ? "Enter/Space toggle • Esc back" : "Esc back")));
		// Single dynamic status: Automatic uses the union; an override limits the media set.
		container.addChild(textLine(theme.fg("dim", isAutomatic
			? "Automatic — using every capability its members support."
			: `Override — media limited to ${effective.filter((modality) => modality !== "reasoning").join(", ") || "none"}.`)));
		return container;
	}

	function renderModelEditComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const model = state.editDraft?.models[state.modelEditIndex];
		if (!model) { container.addChild(textLine("Model not found")); return container; }
		const found = modelRegistry.find(model.provider, model.modelId) as Model<Api> | undefined;
		container.addChild(textLine(theme.fg("accent", "Edit model")));
		container.addChild(textLine(`Provider: ${escapeDisplayLabel(model.provider)}`));
		container.addChild(textLine(`Model ID: ${escapeDisplayLabel(model.modelId)}`));
		container.addChild(textLine(`Status: ${found && modelRegistry.hasConfiguredAuth(found) ? "available" : "unavailable"}`));
		thinkingOptionsFor(found).forEach((level, index) => container.addChild(textLine(selectableLine(state.row === index, `Thinking: ${thinkingLabel(level)}`))));
		container.addChild(textLine(selectableLine(state.row === thinkingOptionsFor(found).length, "Remove model")));
		return container;
	}

	function selectedModelDetailComponent(model: Model<Api>): Component {
		return {
			render: (width: number) => {
				const full = `${escapeDisplayLabel(model.provider)}/${escapeDisplayLabel(model.id)}`;
				const name = model.name ? escapeDisplayLabel(model.name) : undefined;
				const lines = [dim("Selected:")];
				if (width > 2) {
					lines.push(truncateToWidth(`  ${theme.fg("accent", full)}`, width, MODEL_ROW_ELLIPSIS));
					if (name !== undefined) lines.push(truncateToWidth(`  ${dim(name)}`, width, MODEL_ROW_ELLIPSIS));
				} else {
					lines.push(theme.fg("accent", full));
					if (name !== undefined) lines.push(dim(name));
				}
				return lines;
			},
			invalidate: () => {},
		};
	}

	function renderWizardComponent(): Component {
		const container = new Container();
		let title: string;
		let items: SelectItem[];
		if (state.screen === "WIZARD_PROVIDER") {
			title = "Add model — Step 1/3 Provider";
			items = allProviders().map((provider, index) => ({ value: String(index), label: escapeDisplayLabel(provider) }));
		} else if (state.screen === "WIZARD_MODEL") {
			title = "Add model — Step 2/3 Model";
			container.addChild(textLine(theme.fg("accent", title)));
			container.addChild(modelSearchInput);
			const models = filteredModelsForProvider(state.wizardProvider);
			if (models.length === 0) {
				activeSelect = null;
				container.addChild(textLine(theme.fg("dim", "  No matching models")));
			} else {
				container.addChild(buildModelSelect(models));
				container.addChild(selectedModelDetailComponent(models[Math.min(state.row, models.length - 1)]));
			}
			return container;
		} else {
			title = "Add model — Step 3/3 Thinking";
			items = thinkingOptionsFor(currentWizardModel()).map((level, index) => ({ value: String(index), label: thinkingLabel(level) }));
		}
		container.addChild(textLine(theme.fg("accent", title)));
		container.addChild(buildSelect(items));
		return container;
	}

	function renderDeleteComponent(): Component {
		activeSelect = null;
		const container = new Container();
		const group = state.groups.find((candidate) => groupKey(candidate) === state.deleteKey);
		const otherScope = group ? state.groups.some((candidate) => candidate.name === group.name && candidate.scope !== group.scope) : false;
		container.addChild(textLine(theme.fg("warning", "Delete Model Group?")));
		container.addChild(textLine(group ? `${escapeDisplayLabel(group.name)} [${group.scope}] with ${group.models.length} models` : "Missing group"));
		if (otherScope) container.addChild(textLine("Same-name group in the other scope remains unaffected."));
		container.addChild(textLine(selectableLine(state.row === 0, "Keep group")));
		container.addChild(textLine(selectableLine(state.row === 1, "Delete group")));
		return container;
	}

	function activeComponent(): Component {
		if (state.screen === "LIST") return renderListComponent();
		if (state.screen === "EDITOR") return renderEditorComponent();
		if (state.screen === "MODALITIES") return renderModalitiesComponent();
		if (state.screen === "MODEL_EDIT") return renderModelEditComponent();
		if (state.screen === "DELETE_CONFIRM") return renderDeleteComponent();
		return renderWizardComponent();
	}

	return {
		get focused() { return rootFocused; },
		set focused(value: boolean) { rootFocused = value; syncInputFocus(); },
		render: (width: number) => {
			syncInputFocus();
			return activeComponent().render(width).map((line) => truncateToWidth(line, width));
		},
		invalidate: () => { groupNameInput.invalidate(); modelSearchInput.invalidate(); },
		handleInput: (data: string) => {
			if (state.finished) return;
			if (state.screen === "WIZARD_MODEL") {
				const queryBefore = modelSearchInput.getValue();
				if (isEsc(data)) {
					goBack();
				} else if (isUp(data) || isDown(data) || isEnter(data)) {
					activeSelect?.handleInput(data);
				} else if (!queryBefore && (isLeft(data) || isBackspace(data))) {
					goBack();
				} else {
					modelSearchInput.handleInput(data);
					if (modelSearchInput.getValue() !== queryBefore) {
						state.row = 0;
						installModelSelect();
					}
				}
				syncInputFocus();
				tui.requestRender();
				return;
			}
			if (state.activeTextInput === "group-name") {
				if (isUp(data) || isDown(data)) {
					const previousRow = state.row;
					if (commitName()) {
						state.activeTextInput = null;
						state.row = previousRow + (isDown(data) ? 1 : -1);
						clampRow();
					}
				} else if (isEnter(data) || isEsc(data)) {
					commitName();
					state.activeTextInput = null;
				} else {
					groupNameInput.handleInput(data);
					state.editName = groupNameInput.getValue();
				}
				syncInputFocus();
				tui.requestRender();
				return;
			}
			if (isDeleteChord(data) && (state.screen === "LIST" || state.screen === "MODEL_EDIT")) deleteAction();
			else if (activeSelect && (state.screen === "LIST" || state.screen.startsWith("WIZARD_")) && (isUp(data) || isDown(data))) {
				const previousRow = state.row;
				activeSelect.handleInput(data);
				state.row = previousRow + (isDown(data) ? 1 : -1);
				clampRow();
				activeSelect.setSelectedIndex(state.row);
			}
			else if (activeSelect && (state.screen === "LIST" || state.screen.startsWith("WIZARD_")) && isEnter(data)) activate();
			else if (isUp(data)) { state.row--; clampRow(); }
			else if (isDown(data)) { state.row++; clampRow(); }
			else if (state.screen === "MODALITIES" && isSpace(data)) activate();
			else if (isLeft(data) || isEsc(data)) goBack();
			else if (isEnter(data)) activate();
			syncInputFocus();
			tui.requestRender();
		},
	};
}
