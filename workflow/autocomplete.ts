// WHY: `/workflow` name completion is filesystem-backed, so it cannot live in the command's
// static metadata. A provider wrapper (the pi extension point model-groups uses for `#group`
// mentions) intercepts the workflow token, reads the live workflow dirs on demand, and
// delegates every other line to the built-in provider. It replaces the token itself because
// the built-in slash branch expects a bare command name and would prepend a second slash.
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPathLike, listWorkflows, type WorkflowFileEntry } from "./file.js";
import { installAutocompleteProviderOnce } from "../autocomplete-install.js";

const MAX_SUGGESTIONS = 20;
const WORKFLOW_COMMAND = "/workflow";
const WORKFLOW_VALUE_PREFIX = `${WORKFLOW_COMMAND} `;
// `/workflow`, `/workflow:`, `/workflow <partial>`, `/workflow:<partial>`. The lookahead
// keeps `/workflows` out, and the group rejects a second token so args are never hijacked.
const WORKFLOW_TOKEN = /^\/workflow(?=$|:|\s)(?::|\s)?([^\s:]*)$/;

// The live session cwd, refreshed on every `session_start` and read by the installed provider.
let currentCwd = process.cwd();

/** Where the cursor sits in the `/workflow` command. */
interface WorkflowContext {
	/** Exact text to replace on accept. */
	prefix: string;
	/** Name characters typed so far (empty while still typing the command). */
	partial: string;
	/** True while the text is only a prefix of the command name, before any name is typed. */
	commandNameOnly: boolean;
}

/**
 * `/`, `/w` … `/workflo` complete the command itself; `/workflow`, `/workflow:rev`, and
 * `/workflow rev` complete a name. A lone `/` stays with the built-in command menu.
 */
function workflowContext(beforeCursor: string): WorkflowContext | null {
	const trimmed = beforeCursor.trimStart();
	if (trimmed.length >= 2 && WORKFLOW_COMMAND.startsWith(trimmed)) return { prefix: trimmed, partial: "", commandNameOnly: true };
	const match = trimmed.match(WORKFLOW_TOKEN);
	if (!match) return null;
	return { prefix: trimmed, partial: match[1] ?? "", commandNameOnly: false };
}

/** The provider factory. `value` rewrites the whole token so every prefix form completes alike. */
export function createWorkflowAutocompleteProvider(
	getEntries: () => Promise<WorkflowFileEntry[]>,
): (current: AutocompleteProvider) => AutocompleteProvider {
	return (current) => ({
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const context = workflowContext(beforeCursor);
			if (!context) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			// A path is a file, not a bare name; let the built-in provider complete it.
			if (isPathLike(context.partial)) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			// A discovery failure (e.g. EACCES) must not reject the whole completion; fall back.
			let discovered: WorkflowFileEntry[];
			try {
				discovered = await getEntries();
			} catch {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const entries = fuzzyFilter(discovered, context.partial, (entry) => entry.name).slice(0, MAX_SUGGESTIONS);
			// No workflows at all: still offer the command itself. Inside the name slot,
			// return null so a miss never falls through to file completion.
			if (entries.length === 0) {
				return context.commandNameOnly ? current.getSuggestions(lines, cursorLine, cursorCol, options) : null;
			}
			return { prefix: context.prefix, items: entries.map(workflowItem) };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			// Built-in slash handling would prepend another slash to our `/workflow ...` value,
			// so replace the token ourselves. Delegated items keep the built-in behavior.
			if (!item.value.startsWith(WORKFLOW_VALUE_PREFIX)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			// WHY: re-derive the context from the actual text. The provider matched a prefix that may
			// reach before the cursor (`/workflow review` @col5 matched `/workf`), so the caller's
			// prefix cannot be trusted for the splice start.
			const context = workflowContext(line.slice(0, cursorCol));
			const start = Math.max(0, cursorCol - (context?.prefix.length ?? prefix.length));
			// The command name with no name typed yet: replace the whole typed command and args, since
			// item.value already ends with a space and a leftover tail would run as spurious args.
			let end = line.length;
			if (!context?.commandNameOnly) {
				// A name accept replaces from the token start and drops the overlapped tail up to the
				// token end (next whitespace), then the whitespace run itself: item.value already ends
				// with a space, so a mid-token accept cannot duplicate the suffix
				// (`/workflow rev|iew` -> `/workflow review `).
				const nextWs = line.slice(cursorCol).search(/\s/);
				end = nextWs === -1 ? line.length : cursorCol + nextWs;
				while (end < line.length && /\s/.test(line[end]!)) end++;
			}
			const next = [...lines];
			next[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(end)}`;
			return { lines: next, cursorLine, cursorCol: start + item.value.length };
		},
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
			current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
	});
}

function workflowItem(entry: WorkflowFileEntry): AutocompleteItem {
	return {
		value: `${WORKFLOW_VALUE_PREFIX}${entry.name} `,
		label: `${WORKFLOW_COMMAND} ${entry.name}`,
		description: entry.label,
	};
}

/** Install the workflow name provider once per UI; later sessions refresh {@link currentCwd}. */
export function registerWorkflowAutocomplete(ctx: ExtensionContext): void {
	if (ctx.cwd) currentCwd = ctx.cwd;
	installAutocompleteProviderOnce(ctx, "workflow", () => createWorkflowAutocompleteProvider(() => listWorkflows(currentCwd, getAgentDir())));
}
