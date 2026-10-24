# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Date anchor** — the `schematic_date` prompt section holds a `## Current date` block (ISO date, weekday, IANA zone, UTC offset, plus a resolve-relative-references directive). `before_agent_start` renders it once per user prompt, and it is byte-stable within a calendar day, so while the host zone stays fixed it changes at most once per day; on a DST transition day the offset adds one more change. When it changes, Pi appends a section-update message and the leading system message stays unchanged. A zone Intl cannot render falls back to `UTC` rather than throwing.
- **Notebook pages open in a pager** — Enter in the interactive `/notebook` picker opens the selected page in `$PI_PAGER`, else `$PAGER`, else `less` if installed (not on Windows); with no pager or a `cat` or `more` pager it shows the inline preview instead. Quitting either returns to the list on the same page. See [Compatibility and limits](README.md#compatibility-and-limits).

### Breaking Changes

- **No compaction events for a handoff cut** — `session_before_compact` and `session_compact` no longer fire for a handoff; schematic no longer handles `session_before_compact`. Other extensions find the cut as a `compaction` entry whose `details.handoffId` is set.
- **`handoff` must be the only tool call in its message** — a `handoff` that shares an assistant message with other tool calls is refused and stages nothing; the other calls go to their own handlers, and the refusal tells the model to call `handoff` alone in its next message. Previously the `handoff` ran, its cut aborted the run, and the calls after it in the message were skipped. When a message holds only `handoff` calls, every call after the first is refused.
- **Successor recovery is removed** — a session written by an earlier version whose successor was lost after its cut is not repaired, and the user prompts again.
- **Spawn returns failures once the child session exists** — a spawn that fails after its child session was created now resolves with an error result carrying the child's usage. It used to throw. This covers a failed prompt, a child with no output, a reset, an abort, a failed dispose, and a prompt Pi rejects before the run. A failure before the child session exists still throws: model or route resolution, constraint validation, and the session factory rejecting. A direct caller of `execute` gets a resolved error result where its call used to reject, and `details` and `usage` now carry the child's stats, or `statsUnavailable`. A child run that ends with stop reason `error` or `aborted` also returns an error result with `isError`, and `details.outcome` stays `error` or `aborted`. See [Architecture](docs/architecture.md#behavioral-notes).
- **`truncateText` is no longer exported** — `spawn/index.ts` no longer exports `truncateText`. Spawn limits its result text internally, and a caller that imported the function needs its own copy.
- **Global Model Groups follow the agent directory** — with `PI_CODING_AGENT_DIR` set to a directory other than `~/.pi/agent`, the global `model-groups.json` is read only from `pi-schematic/` inside that directory. A `model-groups.json` at `~/.pi/agent/pi-schematic/` is then no longer read and is not migrated; move it into the agent directory. Until it is moved the file is missing, and a missing file loads as an empty configuration with no warning: `/model-groups` lists no global groups, and in an interactive session a prompt whose frontmatter names one of those groups, with no project group of the same name and no explicit `model:`, does not expand and reports an error containing `Model Group '<name>' is not defined.` A `spawn` naming such a group runs on the parent's model; the spawn tool's TUI display marks it as `<group>? fallback → <provider>/<model> • <thinking>` and the result's `details.route` carries status `unknown-fallback`, while the result text the model receives carries no marker. The global prompt scan moves the same way. With such a directory set, pi's default prompt discovery no longer covers `~/.pi/agent/prompts`, but schematic used to read the frontmatter of those prompts and apply their `readonly`, `model` and `thinking` values to a typed command that pi did not expand. Schematic no longer scans that directory.

### Changed

- **Handoff completes inside the calling run** — the cut and the successor are written together at the end of the turn that called `handoff`, in one `turn_end` boundary pass: notebook discard entries, a retain-none compaction, the successor, and a hidden note. The successor turn continues the same run. If another extension's `turn_end` handler stops the continuation, the successor runs on the next prompt. The successor shows as a `pi-schematic-handoff` message instead of a user message, and a hidden `pi-schematic-handoff-note` tells it that the system prompt is stale until the next run starts; a message typed during the run does not refresh it. If another extension's `turn_end` handler keeps the cut and the successor but drops the notebook discard entries, the pages stay in the notebook, the completion notice counts them as kept, and a session with a UI also shows a warning naming them.
- **Failed handoff cut** — a handoff whose cut is missing at the next turn or when the run settles reports the failure and leaves a pending handoff request pending. The failure guidance is a `pi-schematic-handoff-failed` message that starts no run, for an abort and for every other cause (another extension replacing the `turn_end` entries, invalid drafts). Further `handoff` calls in the same run are refused, and after a dropped cut the notebook is rebuilt from the branch. The watchdog's `MAX_HANDOFF_ATTEMPTS` still bounds the attempts, and the failure on the last attempt says no required handoff remains pending. A `handoff` call rejected at validation reports its reason in the tool's error result and queues no follow-up message. If another extension's `turn_end` handler keeps the cut but drops the successor, or appends its own compaction after the cut so the successor is no longer in context, the handoff fails instead of completing. A successor turn is aborted before it reaches the model, the failure message carries the instruction, and the request is cleared without a retry because the context is already cut.
- **Spawn result limit marker** — the truncation marker and the child prompt write the size as `50 KiB (51200 bytes)`, the form notebook uses, instead of `50KB`. The marker now advises spawning a new child with a narrower request.
- **Pi minimum** — Pi 0.99.2 is now the documented minimum for the `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peers, and the `typebox` peer minimum is 1.3.27.
- **Readonly allows real work inside the temp dir** — modeled mutable Git commands (`init`, `clone`, `add`, `commit`, `reset`, `push`, `rebase`, `merge`, `checkout`, and `gc`, among others) and relative-path writes are now allowed when every write root resolves inside the temp roots, instead of being blocked by command name. Common forms with unmodeled options still fail closed: `rebase --onto`, `commit -S`, `push --follow-tags`, and `add -p`. The classifier analyzes Git write locations end-to-end: repository discovery through ancestor `.git` directories, pointer files, `commondir`, and linked worktrees; `-C`/`--git-dir`/`--work-tree`; destination flags (`-o`, `--file`, `--separate-git-dir`); `GIT_DIR`-family environment overrides; and local push destinations; `merge-tree` is write-capable because it can create objects, and every Git operand parser accounts for subcommand-specific flag arity (`-f`/`-u` mean force/set-upstream for `push` but take values for `config`/`clone`). An unmatched glob is confined to its literal name instead of being treated as a no-op. Unrecognized options, unvetted `-c`/env config, and unprovable locations fail closed.
- **Readonly tracks the shell's working directory** — `cd`/`pushd`/`popd` in the parent shell move the tracked cwd across `;`, `&&`, `||`, and newlines, while pipelines, background jobs, subshells, and `env`-forked children do not. Compound commands (`if`/`while`/`until`/`for`/`case` bodies and function definitions) are classified in the parent shell too, and unresolvable directory changes fail closed, so `cd "$UNKNOWN" && rm -rf x` stays blocked; `cd -P` counts as unresolvable because the tracker models lexical paths only, and code defined by `trap`/`alias` is classified now while a directory change inside it fails closed. Assignments made earlier in a command line (including `TMPD=$(mktemp -d) && cd "$TMPD"`) resolve for downstream commands, while prefix assignments (`FOO=x cd`) cannot move the tracked cwd. Heredoc bodies are now treated as stdin data rather than commands (a data line like `foo > bar` no longer false-blocks), including under `sudo`/`env` wrappers, while heredocs piped to a shell (`bash <<EOF`, `cat <<EOF | bash`) are still classified as code, stdin consumed by `xargs` or read loops fails closed, and non-shell stdin (`python3 <<EOF`) fails closed.
- **Semicolon no longer proves mktemp success** — `D=$(mktemp -d); cd "$D"; ...` was previously allowed, but a failed mktemp assigns empty output, so `cd "$D"` resolves to the caller's cwd and later writes escape confinement. Only `&&` now establishes directory provenance from a substitution; `;` retains the caller's possible cwd. Use `D=$(mktemp -d) && cd "$D" && ...` to chain temp-directory workflows.
- **Unified writable temp roots across both enforcement layers** — the classifier and the OS sandbox now share one root list (`os.tmpdir()` canonical + unresolved, plus `/tmp` on POSIX and `/private/tmp` on macOS), guarded by parity tests so they cannot drift. On Linux, bwrap binds these real roots instead of a private `--tmpfs /tmp`, so sandboxed commands share the host's `/tmp` with other processes.
- **Pushes to network remotes remain blocked** — local-path pushes are path-checked like other writes, but https/SSH transports cannot be proven local and fail closed; `url.*.insteadOf`/`pushInsteadOf` rewrites are resolved before the destination is judged, so a locally-looking remote that git would rewrite elsewhere also fails closed.
- **Executable Git hook environment fails closed** — command-provided `GIT_PAGER`/`GIT_EDITOR`/`GIT_EXTERNAL_DIFF`/`GIT_SSH_COMMAND`/`GIT_ASKPASS` (and generic `PAGER`/`EDITOR`) assignments block even read-only Git subcommands, closing the env-provided equivalent of `-c core.pager=`. The user's own exported environment stays trusted.
- **New CI `sandbox-enforcement` lane** — runs the kernel-enforcement tests on Ubuntu and macOS with a real sandbox (bubblewrap installed, unprivileged namespaces enabled) and fails rather than silently skipping when no OS sandbox is available.
- **Coverage tooling and doc corrections** — added a `test:coverage` script; corrected the `git fsck --lost-found` note (it fails closed; the open gap is a `git status` index refresh in a repo discovered from an outside cwd); the OS-sandbox denial notice now matches `EROFS` instead of plain `EACCES`, which an unrelated permission failure can produce.

### Fixed

- **Killed Git config probes retry once, then fail closed** — a `git config` probe that is killed mid-flight (timeout, spawn hiccup) is retried once with a wider 500 ms ceiling and `SIGKILL`, so a child that ignores `SIGTERM` cannot stall classification, and on Windows the probe child starts with its console hidden. An exhausted probe fails closed as unproven ground truth, reporting `cannot prove git write location: git config probe unavailable (…)`, instead of a proven outside-temp write, while a missing `git` binary still reports `git binary unavailable`.
- **Handoff successor cannot be lost between the cut and a send** — the successor is persisted in the same pass as the cut instead of being sent afterwards.
- **Readonly parser bypasses closed** — bundled interpreter flags (`bash -lc`, `perl -we`, `perl -E`, `node -p`) now classify their inline script, including quoted and digit-bearing clusters (`perl -w'e'…`, `perl -0we`); xargs mutations require a replacement mode (`-I`/`-i`/`--replace`), because without it stdin appends unchecked paths, while replacement tokens in the wrapped command fail closed; `-J` mutations fail closed because BSD xargs appends stdin when its token is absent; cp-family option values after the destination can no longer hide it, `install -M` metalog paths are checked, and `install -d`/one-operand `ln` check every real target. GNU long options resolve unique prefixes — including `sed --in-place` and rsync's write-option set, where `-T` is also honored inside a short bundle — and unmodeled short or long options fail closed; macOS/GNU flag arity is modeled so valid temp copies stay allowed. A shared redirect-operator table now treats `>|` as an operator, so `cp src <outside> >| <temp>/log` checks the real destination. `find` now treats every operand before the expression as a root, so glob and tilde roots cannot fall back to the cwd; shell `-c` scripts that expand positional parameters fail closed; and pacman, dpkg, dpkg-deb, and rpm write modes are blocked from one table per manager that holds the short and long spelling of each mode, so neither grammar can drift: dpkg and dpkg-deb extract, control, build, and raw-extract modes (`-x`, `-X`, `-e`, `-b`, `-R`), database writes such as `--set-selections`, `--update-avail`, and `--add-architecture`, dpkg trigger processing (`--triggers-only`), pacman's file-database refresh (`-F`, `--files`, `--refresh`) and sync/database modes, and rpm's install/upgrade/erase modes, its build modes (`-b`/`-t` stages, `--rebuild`, `--recompile`), plus `--import`, `--rebuilddb`, and `--initdb`. Query modes stay reads, including their long spellings (`pacman --files --list`), separate short sub-operations (`pacman -S -s curl`), and unique long-option sub-operation abbreviations (`pacman --sync --sea curl`), while quoted flags and unique long-option abbreviations are matched like the argv word the program receives. uv/bun/conda and their `uvx`/`bunx` aliases block on every invocation, because their default modes write user caches and `.venv` even when every operand points inside temp.
- **Readonly write-target coverage** — write paths now resolve symlinks before applying `..`, so `link/../pwn` cannot escape temp; redirect targets are checked as whole shell words, so mixed quoted and unquoted words cannot hide the real file; `find -exec`-family payloads are classified as shell code and end at `+` only when `{}` precedes it, so a target after a bare `+` is still checked, `-execdir` payload targets resolve against every possible runtime directory for the search root (the search directory or entry parent, the caller cwd for command-line entries, the link parent on GNU, and the target when a root symlink is followed), so neither a symlink root nor a command-line directory or file entry can hide an outside write, every BSD `-f` operand is a search root and its getopt phase continues across repeats, so a later `-f` cannot hide an outside root, and the `{}` block hint names only fixes the classifier honors; rsync parses option values and operands in one pass, including its short value options such as `-@`/`--modify-window`, so a later value cannot stand in for the destination, and `--backup-dir`/`--temp-dir`/`--partial-dir` resolve relative paths against the destination where rsync writes them; `chmod` recognizes a dash-prefixed MODE (`chmod -w /etc/passwd`) and checks the target; and `unzip` recognizes `-d` inside a bundled flag (`-oqd/outside`). Quoted tilde prefixes (`~"/x"`, `~'/x'`, `~\/x`) stay literal like Bash, so classification cannot approve a different pathname than the shell writes.
- **Readonly unzip escapes closed** — `unzip -P` now consumes its attached or separate password before option-letter scanning, so password letters cannot mark extraction read-only; attached `-d` operands keep raw shell quoting, so `'$D'`, `\$D`, and `"$D"` resolve exactly as Bash does.
- **Heredoc expansion across shell versions** — an unquoted heredoc body now classifies under both candidate expansion environments (the parent shell and the redirect command's leading assignments) and blocks if either could write outside the temp roots. Bash ≤ 4.0 applies the leading assignment before expanding the body; bash ≥ 4.1 expands with the parent value first, so the previous single-model guard was unsound on one platform depending on the host shell. The parent candidate models bash ≥ 4.1 for tracked variables: a variable only the prefix sets expands to empty there, so non-path uses stay allowed while the resulting outside path still blocks, and block reasons name the failing expansion. `PWD` is seeded into shell state from the tracked cwd and refreshed on every directory change, so heredoc expansion and data substitutions resolve the same value and an assignment made before `cd` cannot pin expansion to the old directory. The differential suite now pins only host-independent quoted bodies; the version-divergent unquoted shapes are classifier-only regressions, including the parent-outside/prefix-inside mirror case.
- **Heredoc delimiters, consumer environments, and Git push/pointer accuracy** — heredoc delimiter words now join ANSI-C fragments with adjoining literals (`<<$'E'O` closes on `EO`) and remove unescaped backslash-newline joins before the delimiter comparison, so a split delimiter can no longer turn executable body lines into inert data. A heredoc's unquoted body now expands with the redirect command's own prefix assignments (including `time`-wrapped commands and a redirect written before the command word), and the body then classifies in the consuming shell's environment — resolved by one owner walk that strips `sudo`/`time` wrappers and group braces (`sudo D=x bash <<'EOF'`, `{ D=x bash; } <<'EOF'`), so an outside value hidden behind a safe parent value no longer slips through; `env` operand assignments stay excluded because the outer shell expands the body before `env` runs. `git push` now reads the destination the way Git does: a positional `<repository>` overrides `--repo`, and the last `--repo` before `--` wins, so an outside positional destination cannot hide behind a safe `--repo` value. `.git` `gitdir:` pointer pathnames are read byte-exact like Git (only trailing newline/return bytes stripped), so a symlink named with a trailing space can no longer send the guard to a harmless path while Git follows the real one.
- **Clone destination, submodule metadata, and brace `||` escapes closed** — `git clone` without a destination now checks git's derived default directory (its `/.git`/`.bundle` suffix choice, trailing-whitespace stripping, and the `.git` appended by `--bare`/`--mirror`), so a symlink at the real name no longer escapes; a name git's own stripping cannot prove fails closed. `git submodule update` and `checkout --recurse-submodules` follow each declared submodule's `.git` pointer, so outside metadata and the configured worktree join the write roots, recursively and cycle-bounded. A brace group's `||` fallback now classifies in every reachable cwd plus the caller cwd, so a mid-body failure cannot hide the fallback's real directory; the union over-blocks on provable success, which is the safe direction. And tar stdout modes write no filesystem path: `-O`/`--to-stdout` extraction and `-f -`/`--file=-` creation stream to stdout, while conflicting modes, command-execution options (`--to-command`, `-I`/`-F`, `--index-file`, …), the bare `--one-top-level`, and an attached `-s` tail fail closed. `--track` no longer consumes a separate value, so `git checkout --track --recurse-submodules <branch>` no longer hides the recursion flag.
- **Windows temp containment and dynamic Git operand escapes** — the OS temp dir and temp roots now canonicalize through `realpathSync.native`, so Windows 8.3 short names (`RUNNER~1`) expand exactly like the OS resolver and no longer misjudge a temp path as outside. Native backslashes in command-provided values are literal data, and `find` grouping tokens (`(`, `)`) and `mktemp` ambient bases decode correctly. Separately, a dynamic `$VAR` whose literal suffix carries an escape (`$D\/..\/..`, `${V:-…\/..}`) fails closed again: Bash decodes the suffix (`\/` to `/`) but the classifier appended it verbatim, which could send a Git target outside temp.
- **Shell dispatch escapes closed** — `command`/`builtin` unwrapping, double-quoted `$VAR` and substitution command words, attached `env -S` forms, `chmod --reference` / `cp -t` / `mv --target-directory` operands, and `eval`/`exec`/`coproc` handling now classify the real command; unknown words fail closed.
- **Directory-tracking escapes closed** — `cd` through a missing intermediate, non-executed changes (lookups, single-quoted operands, stale `unset` values, aborting redirects), and `||` after a brace group, `eval`, or a reachable `cd` now keep the correct cwd or fail closed instead of letting `;`/`||`-chained writes run outside temp.
- **Heredoc classification hardened** — double-quoted delimiters match Bash backslash rules, `sed s///e` bodies count as code, shell stages need pure `cat` pass-throughs, truncation and nested-shell de-escaping fixed, substitution-result-as-script and parked-fd bodies fail closed, unknown stdin owners fail closed, `awk` removed from data consumers, and shadowed consumers fail closed.
- **Git write-root coverage** — branch-remote push destinations, `.gitmodules` paths, action words after options, `GIT_CONFIG`/`GIT_CONFIG_GLOBAL`/`SYSTEM`, command-line `TMPDIR`, `GIT_PROXY_COMMAND`, `GIT_TRACE*`/`GIT_REDIRECT_*`, effective config/index/worktree locations, pinned `.git` anchors on immutable commands, and `gc`/`bundle`/`sparse-checkout`/`maintenance` are now modeled; network remotes and unvetted config still fail closed. A bare remote name in a repository whose metadata cannot be read fails closed too: a configured network remote is indistinguishable from a local path there.
- **Git read/write accuracy restored** — `git --version`/`--help` and per-subcommand help are reads again; `tag -l`, `worktree list`, and `config --get-color` recognized as immutable; `notes`/`reflog`/`restore`/`bundle`/`sparse-checkout`/`am` options modeled for in-temp work; config is immutable only for proven read forms.
- **False-block and messaging fixes** — `((…))` arithmetic, `/dev/stdout|stderr|tty|fd/N` targets, `unzip -p`/`-c` reads, and `tar --directory` handling; Git block reasons name the offending option; `mktemp` honors ambient `TMPDIR` (bare form and value-less `--tmpdir`/`-t`) and positional templates; glob expansion capped (issue #41); `os-sandbox.ts` excluded from the coverage gate owned by the `sandbox-enforcement` lane; dead types and stale Known-L2 entries removed.
- **Split-string and `--` operand handling closed** — `env -S` appends the trailing argv to the wrapped command instead of dropping it, and options stop parsing at `--` for `env` and file-mutation commands, so `env -S"touch" -- -r /etc/hosts /tmp/x` no longer reads a write operand as an option value. Archive bundle forms that attribute `-f`'s value ambiguously (`tar -czf/etc/x`) fail closed; old-style `tar fc x.tar dir` is parsed by obsolescent rules.
- **Archiver and `sed -i` write targets closed** — `tar -f` creation targets and `tar`/`unzip` extraction into the current directory are classified like any other write (cwd tracking only covers writes reached through a tracked `cd`), so `tar -cf /outside/x.tar .` and `unzip a.zip` from an outside cwd block; `tar -t` stays a read. A dot-less first operand after bare `sed -i` is read as a GNU script rather than a dropped backup suffix, so `sed -i 5d /etc/hosts` blocks; a BSD-style plain suffix (`sed -i bak s/a/b/ f`) over-blocks as the safe direction. An attached or separate backup suffix (`sed -i.bak`, `sed -i .bak`, `sed -i ""`) keeps the file operand as the checked target instead of leaving the target list empty.
- **Readonly blocks the powershell tool** — readonly mode now blocks pi's built-in `powershell` tool in the parent and removes it from readonly children, and readonly bash blocks launching PowerShell or cmd. Previously a Windows setup with `powershell` in `defaultTools` had an unguarded shell.
- **Sections from other extensions reach the model** — schematic now adds its prompt content as named Pi prompt sections instead of replacing the system prompt, so sections written by extensions that run after it are no longer dropped (#45). A topic, Model Groups, or notebook change no longer re-sends the context-management primer.
- **Empty notebook pages** — selecting a page with an empty body in `/notebook` now opens it like any other page instead of closing the picker.
- **Discarded notebook pages** — selecting a page removed by a handoff discard while the `/notebook` list was open now reopens the refreshed list instead of closing the picker.
- **Model edit opens on the current thinking level** — opening a model in the Model Groups TUI now puts the cursor on the model's configured thinking level and marks it `✓ current`, instead of always landing on `inherit`, where Enter silently reset the value. A configured level the model no longer supports (or whose model is not in the registry) is still shown as `⚠ current, unavailable` and preserved unless another option is deliberately chosen (#29).
- **Handoff enforcement ignores automatic retries** — the watchdog counts a required handoff's enforcement attempts once per settled agent run instead of once per `agent_end`, so a run that pi retries automatically counts once. A run counts only when one of its requests carried the eligible required-handoff nudge, so a run that ends in automatic threshold compaction still counts and a run nudged only to keep working does not.
- **Spawn usage reaches the parent's totals** — `spawn` returns the child session's token and cost usage with its result. The parent's session totals and footer then include the work its children did. The sum covers the child's whole session, including compaction summaries. If the child's entries cannot be read or summed, the result keeps the child's text, reports zero usage and sets `statsUnavailable`. Context-window accounting is unchanged, because Pi does not count a tool result's usage toward the parent's context size.
- **Spawn preview strips terminal sequences** — the collapsed spawn preview now removes OSC (including OSC 8 links), APC, and erase and cursor-position sequences from child assistant text, not only SGR styling (#83).
- **Global files follow `PI_CODING_AGENT_DIR`** — the global `model-groups.json` and the global prompt scan resolve inside pi's agent directory, so with `PI_CODING_AGENT_DIR` set both move with it, as pi's own global files do. With the variable unset, both stay at their previous locations.

### Known limitations

These gaps remain. Most predate the refactor (`git show HEAD:readonly-bash.ts` has the same behavior):

- Brace expansion is not modeled — `touch {/outside/x,/tmp/a}` writes outside temp.
- `mv`/`cp` check only the destination, so `mv /outside/x /tmp/` deletes outside temp.
- `sudo --chdir` value sits in the value-flag set but is not modeled like `env -C`'s chdir, and short `-D` is unmodeled; both classify the wrapped command at the caller cwd.
- A repository's own `.git/config` is trusted input. Inside temp it can name an executable (`remote.<n>.uploadpack`, `core.pager`, `core.sshCommand`) that a later Git command runs. This is code execution, not an outside write, and the guard is a coding guardrail — not a hardened boundary.
- `shopt -s lastpipe` runs the last pipeline stage in the parent shell, so a `cd` there moves the shell while the classifier assumes pipelines never leak. `shopt -s lastpipe; echo x | cd /etc; touch y` fails open; only the OS sandbox blocks the write.
- Immutable Git commands anchor `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_INDEX_FILE` but not `GIT_OBJECT_DIRECTORY`, so a redirected object store goes unchecked for read commands. Mutable commands check it. The exposure is small: immutable reads rarely write objects.

## [0.6.0] - 2026-09-26

### Added

- **Brand mark** — the blocky `S` for "schematic", built from Pi's 5×5 grid unit (`117.355`) and palette. Ships a static tri-colour mark, a monochrome variant, and a Tetris-style animated intro (`assets/`) used as the README hero and the pi.dev gallery preview (`pi.image`).

### Breaking Changes

- **Project renamed to `pi-schematic`** — the package, repository, and config directory move to `chunkhound/pi-schematic`. Runtime identifiers change with no backwards compatibility: session custom entries and TUI keys use the `pi-schematic-*` prefix, Model Groups persist under `~/.pi/agent/pi-schematic/` (or `.pi/pi-schematic/`), and the shared state type is now `SchematicState`. Existing sessions and config files from `pi-agenticoding` are not migrated.
- **Handoff carries the next instruction verbatim** — the handoff tool now takes `nextInstruction?`, `context?`, `discardPages?` (replacing the old `task` field). The successor's objective is delivered word-for-word in a real user message (`## Next instruction` + `## Context`), so it can no longer be paraphrased away at compaction. Human-facing behavior is unchanged (`/handoff <direction>` works as before); the break is limited to the internal LLM-facing tool contract, where stale callers passing `task` fail loudly.

### Changed

- **Handoff splits instruction from preparation** — the next instruction is carried by the extension and delivered verbatim (`/handoff <direction>` queues it, otherwise the model supplies it); the model owns only preparation: writing `context` (state, blockers, open questions, failed paths, concrete next step) and curating the notebook. The instruction must not be started in the current context, which is discarded at compaction.
- **Fixed continuation frame** — the compaction summary now has a fixed frame with no task text; each cut adds only an identity marker so Pi reports the correct compaction entry. The old synthetic "Proceed." is gone. The exact, versioned successor payload is also stored in compaction details, so `/tree` and resume recover it only when session-tree lineage shows no successor was delivered.
- **Readonly is live, not frozen** — the summary no longer embeds execution constraints (a `/tree` rollback can change readonly). On handoff completion a pending nudge re-announces the ON posture on the first post-handoff turn (a clean OFF-to-OFF handoff stays silent), and `/tree` navigation into an enabled branch re-announces it again; `tool_call` enforcement stays live.
- **Queue-safe post-compaction delivery** — handoff completion, failure guidance, and the successor's instruction are sent with `deliverAs: "followUp"`, so they queue while a run is active instead of being rejected (previously failure guidance could itself throw while streaming).
- **Recoverable successor delivery** — the exact payload remains in compaction details; `/tree`, resume, and a later settled run requeue it only when no user turn follows the cut and no session-tree descendant owned by that cut proves delivery. Pi exposes no delivery acknowledgement, so a failed fire-and-forget follow-up is recovered from persisted state rather than treated as confirmed delivery. Any user turn after the cut — the delivered successor or newer user input — ends recovery, while a delivered successor retained outside the active branch proves recovery is unnecessary during `/tree` editing, and an identical payload on another cut can neither mask a loss nor provoke a duplicate. Recovery coalesces repeated triggers through an in-process latch, waits for a queued follow-up to drain before rescanning (so a successor still in Pi's queue is never double-delivered), and clears the latch at every settled run so a genuinely lost send is retried while a persisted successor is never re-sent.

### Fixed

- **Lineage-based handoff recovery** — successor delivery is now attributed through the session tree: a user turn belongs to the nearest handoff cut on its `parentId` chain. Identical payloads on different cuts can therefore neither mask a genuinely lost delivery nor provoke a duplicate resend, replacing the previous same-message heuristic.
- **Malformed session content no longer crashes recovery** — unvalidated persisted user-message content (non-array content or non-object parts) is skipped instead of throwing during `session_start`, `/tree`, and settled-run recovery scans.

## [0.5.0] - 2026-08-21

### Added

- **Model Groups manager** — added `/model-groups` with durable project/global JSON persistence, boot validation, CRUD TUI flows, per-model thinking levels, and operator notifications for invalid configs or unavailable model refs.
- **Model Groups spawn routing** — `spawn` can route children through an optional exact Model Group name with names-only prompt guidance, `#group` autocomplete sugar that shows model/thinking details, authenticated random entry selection, thinking inheritance/clamping, and routed/fallback result identity lines.
- **Capability-aware spawn routing** — a Model Group now carries a capability set (currently input modalities: `text` and `image`) derived from its configured, authenticated members, with the option to narrow it via an explicit override capped at the member union. A `spawn` call can declare `constraints` the delegated task needs; the router checks the group and the exact selected model and fails before any child would be created when the requirement can't be met. The main-session prompt lists each group's capabilities.
- **Pluggable capability kernel** — added a small constraint system so each capability is one descriptor (read fact → aggregate → reconcile override → satisfy check → present). Modalities are the first, and only, production capability; a synthetic test-only descriptor exercises the full extension point so a future capability (e.g. min context window) needs no edits to config load, spawn routing, or UI render.
- **Frontmatter-driven model selection** — skills and prompts can declare `model`, `model-group`, and `thinking` frontmatter to control model routing and reasoning level per invocation. Resolved during idle input and visibly blocked while streaming; an explicit `model` overrides `model-group`; multi-slash model IDs are supported; invalid values block command expansion with operator notifications, and invalid thinking warns while a valid model still applies.
- **Handoff `discardPages`** — the handoff tool accepts `discardPages` to prune stale notebook pages, staged transactionally via a sequential epoch and committed only after compaction succeeds; interrupted or failed discards retain pages. Notebook rehydration is branch-scoped with generation markers and an epoch watermark, ignores future-format entries, and handoff now verifies notebook completeness first and reports completion truthfully after the discard commit.

### Changed

- **Model Groups editing** — searchable complete-result and ten-visible-row add-model pickers, plus a prompt-free inline group-name editor.
- **Spawn lifecycle** — migrated child spawning to Pi's public selected-model and child-owned runtime APIs, added `max` thinking support, and disposed every created child session exactly once across completion, failure, abort, and reset races. Pi 0.84.1 and Node 22.19.0 are now the documented minimums; parent-only transient provider/auth state fails explicitly without model fallback.
- **Model Group editing** — the editor now shows per-member capability chips (T/I) and lets users narrow the automatically derived modality set with an explicit override; group capability summaries also appear in `#group` autocomplete.

### Fixed

- **Model Groups add-model navigation** — now uses Pi's key matcher for Escape/left-arrow handling and filters provider/model choices to authenticated models.

## [0.4.0] - 2026-07-22

### Breaking Changes

- **Ledger renamed to notebook** — tools are now `notebook_write`, `notebook_read`, and `notebook_index`; `/ledger` is `/notebook`. Legacy `ledger-entry` session data still rehydrates so existing sessions keep their pages.
- **Handoff briefs no longer embed notebook bodies** — referenced pages are fetched on demand via `notebook_read`. The brief carries only the task and primer; the notebook remains the long-term grounding store.
- **Handoff eligibility gate** — handoff rejects empty briefs, sessions under ~30k tokens, or missing usage data so compaction cannot run without a real brief and a meaningful context load.
- **Human-set notebook topics are authoritative** — the agent cannot override a topic the user set via `/notebook` or the topic UI.

### Added

- **Readonly mode** — `/readonly`, Ctrl+Shift+R, and `--readonly` toggle a session-persisted read-only posture. Write/edit are blocked; bash is classified and limited (allowlist / temp-only writes), with OS sandboxing on macOS (`sandbox-exec`) and Linux (`bwrap`) when available. Spawned children inherit the posture (no write/edit; guarded bash). Status shows 🔒 with gentle nudges. Handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary; readonly resumes after compaction.
- **Notebook topics** — `notebook_topic_set` and `/notebook <topic>` set the active semantic frame (🧭 in the status bar). Topics clear after handoff so the next context assigns a fresh one. Topic-change boundary hints integrate with the watchdog.
- **Readonly frontmatter on skills and prompts** — `readonly: true` defers enabling readonly when that skill or prompt is invoked.

### Changed

- **Spawn tool inheritance** — child agents inherit active registered parent tools executable in the child session, including MCP/extension tools, while still excluding spawn and handoff and keeping child-local notebook tools.
- **Topic- and readonly-aware watchdog** — band-throttled primacy-zone nudges with copy that reflects the active topic and readonly state; warning widget at ≥70% context; malformed context percentages render as `ctx --%`.
- **Handoff lifecycle status** — richer TUI status (requested / required / in progress), generation guards, and rejection of overlapping handoff attempts.
- **Notebook overlay and indicators** — interactive `/notebook` overlay (renamed from `/ledger`) with subject-oriented page semantics; empty notebook count stays dim/discoverable rather than hidden without cue.

### Fixed

- **TUI-safe diagnostics** — removed stderr/console logging that corrupted pi's ANSI TUI rendering from the extension host process.
- **Headless UI guards** — `ui.notify` and readonly toggle no-op cleanly when no UI is attached instead of throwing.
- **Rehydration null-safety** — notebook and readonly session resume no longer crash on missing or partial persisted state.

## [0.3.0] - 2026-05-23

### Added

- **Interactive `/ledger` TUI overlay** — replaced the static notification popup with a full interactive overlay. Use arrow keys to navigate entries, press Enter to preview a selected entry body (truncated at 500 chars with `...`), and Escape to close. Empty state shows a discoverability hint.
- **Visual handoff indicator** — when `/handoff` is invoked, a live `🤝 Handoff in progress` badge appears in the TUI status bar. Clears automatically when compaction completes, or when the agent finishes a turn without calling the handoff tool.
- **Ledger tool TUI renderers** — `ledger_add` calls now render inline with a styled preview (`✓ Saved "entry-name": first line...`) in the conversation. Shows the full entry body when expanded.
- **Write-lock reentrancy detection** — nested calls to `saveLedgerEntry` now throw an explicit error instead of silently corrupting the serialization chain.

### Changed

- **Frame-based spawn scheduler** — replaced the microtask-per-event render model with a scheduler that batches expensive component work at ~30 FPS. High-frequency streaming events (50–100+/sec) accumulate state cheaply per-event; layout, cache invalidation, and TUI invalidates are deferred to the next frame tick. Eliminates UI jank during bursty LLM streaming in child sessions.
- **ESM module type** — added `"type": "module"` to `package.json` for compatibility with strict ESM projects.

### Fixed

- **Stray ANSI reset codes in spawn shell** — `truncateToWidth` no longer injects escape sequences that break background color styling in collapsed spawn renderer borders and padding.

## [0.2.0] - 2026-05-21

### Added

- **Microtask event batching** — rapid child session events are coalesced into a single parent invalidate per microtask boundary, preventing UI jank during bursty tool execution.
- **Epoch-based invalidation** — the spawn renderer uses epoch counters rather than pointer comparison to detect stale sessions, making ownership checks reliable across session resets.

## [0.1.0] - 2026-05-21

### Added

#### Context Management System Prompt

- **Automatic system-prompt injection** — the LLM receives a context management primer at session start, teaching it how and when to use spawn, ledger, and handoff. No configuration needed.
- **Live ledger listing in system prompt** — each session start injects the current ledger entries (name + first-line preview) so the agent always knows what stored knowledge is available without fetching blindly.

#### Spawn — Isolate Subtasks in Clean Child Contexts

- **`spawn` tool** — delegate isolated work to an in-memory child agent with its own clean context. The child inherits the parent's model, thinking level, working directory, and built-in tools. Only the condensed result is returned — no context pollution in the parent.
- **Parallel execution** — siblings run concurrently; the parent orchestrates and merges results. Tested for independent concurrent spawns producing correct results.
- **Child tool inheritance** — children receive ledger tools (add/get/list) and the parent's built-in tools, but never the spawn or handoff tools, preventing recursive nesting.
- **Ledger-aware child prompts** — child sessions are told what ledger entries exist so they can fetch knowledge on demand without the parent pre-loading bodies.
- **Child output truncation** — child results are limited to 2000 lines / 50KB to prevent runaway output from overwhelming the parent. Truncated results include an advisory message.
- **Explicit model-required error** — spawn fails immediately with a clear message when no model is configured, rather than with a cryptic runtime error.
- **No grandchildren** — children cannot spawn further children, preventing explosive branching.
- **Session lifecycle management** — children are properly cleaned up on completion, error, or parent session reset. Aborted children produce explicit `aborted` outcomes.
- **Signal-based cancellation** — spawn respects AbortSignal, allowing the parent to cancel a running child mid-flight.

#### Ledger — Sparse Continuity Cache

- **`ledger_add` tool** — save a named, compact continuity entry. Same-name writes overwrite (refinement). Writes are serialized via a process-local lock, preventing race conditions.
- **`ledger_get` tool** — retrieve a full entry body by name. Returns the current entry listing alongside the body. Reports "not found" gracefully with the complete entry list.
- **`ledger_list` tool** — list all entries with name and first-line preview. Returns empty-state placeholder when no entries exist.
- **Persistence across sessions** — ledger entries survive context resets, handoffs, and session restarts. On session start, the extension scans the session history newest-to-oldest and rehydrates the in-memory ledger from the latest epoch.
- **Ledger entry persistence via custom entries** — each `ledger_add` appends a versioned custom entry that survives compaction and session archival.
- **Epoch-based staleness** — child ledger tools reject access with a clear "invalidated by reset" error when the parent session has been reset, preventing stale writes.

#### Handoff — Deliberate Context Compaction

- **`handoff` tool** — triggers a deliberate compaction that replaces noisy context with a clean restart. The agent drafts a handoff brief preserving knowledge still missing from the ledger, then the session restarts with the brief at the top of context.
- **`/handoff` command** — user-facing shortcut that asks the agent to draft a handoff brief from a user direction, capture reusable state to the ledger, and call the handoff tool — all in one turn.
- **Rich compaction summary** — the handoff brief includes inlined ledger entries referenced in the task text (up to 3 entries, 4000 chars total), and a structured handoff primer explaining the continuation contract.
- **Clean slot handoff** — compaction replaces all pre-handoff messages with just the handoff summary. Full history remains in the session file for later reference.
- **Post-handoff auto-resume** — the agent receives a "Proceed." message after compaction completes, keeping momentum without manual re-prompt.
- **Enforcement tracking** — the `/handoff` command tracks whether the agent actually called the tool, preventing the command from being silently ignored. The watchdog cleans up stale enforcement state.

#### Primacy-Zone Watchdog

- **Advisory context-usage reminders** — a `context` hook injects a watchdog message before each LLM call when context usage exceeds 30%, 50%, or 70%. The message is advisory only — the agent decides whether to act.
- **Tiered nudge messages** — at 30-50% the agent is reminded of the primacy-zone heuristic; at 50-70% it's advised to consider handoff soon; at 70%+ it's warned that automatic compaction may trigger soon.
- **Hidden from user** — watchdog messages use a `custom` role with `display: false`, so they inform the LLM without cluttering the visible conversation.
- **`agent_end` tracking** — the watchdog records the latest context usage percent after each agent run, available for diagnostic use.

#### TUI and Status Indicators

- **Context usage in status bar** — a live `ctx 65%` indicator in the TUI status bar, color-coded: green (<30%), yellow (30-50%), orange (50-70%), red (≥70%).
- **Ledger count indicator** — a 📒 `N` badge in the status bar showing the number of ledger entries, hidden when the ledger is empty.
- **`/ledger` command** — shows all ledger entries with name, line count, and first-line preview in a TUI notification overlay.
- **Live spawn rendering** — child agent sessions render inside the parent's TUI with:
  - **Collapsed view**: model name, thinking level, real-time "last action" summary (thinking, tool execution, or assistant text preview), 5-line preview of last assistant output, and token/cost statistics.
  - **Expanded view**: full chat history with 4-space indent, streaming assistant messages, and tool execution components.
  - **Ownership lifecycle**: session ownership transfers from state to the renderer on first render, with proper cleanup on dispose, reset, or reattachment.
- **Render caching** — rendered output is cached by width/expanded/showImages, avoiding unnecessary re-renders when inputs haven't changed.
- **Graceful degradation** — the spawn renderer recovers from malformed events, missing tool definitions, subscribe failures, and null results without crashing the parent TUI.

#### Extension Wiring and Lifecycle

- **Single state object** — all primitives read/write through a single `AgenticodingState` instance, shared across extension hooks, tool executions, and the TUI renderer.
- **Session lifecycle hooks**:
  - `before_agent_start` — injects context primer and ledger listing.
  - `context` — injects watchdog reminders before LLM calls.
  - `session_start` — rehydrates ledger on continuation; resets state on `/new`.
  - `turn_end` — updates TUI indicators.
  - `agent_end` — records context usage and manages handoff enforcement.
  - `session_before_compact` — consumes pending handoff task as the compaction summary.
- **One-line install** — install via `pi install npm:pi-agenticoding` and disable platform compaction in settings.
- **Comprehensive test suite** — 50+ tests covering spawn execution and rendering (concurrency, cancellation, truncation, stale detection, ownership lifecycle, microtask batching), ledger tools (add/get/list, staleness, rehydration, empty states, prompt hints), handoff (tool, command, compaction), watchdog (nudge injection, enforcement), and extension lifecycle.
- **MIT licensed** — open-source permissive license.

[Unreleased]: https://github.com/chunkhound/pi-schematic/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/chunkhound/pi-schematic/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/chunkhound/pi-schematic/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/chunkhound/pi-schematic/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/chunkhound/pi-schematic/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/chunkhound/pi-schematic/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chunkhound/pi-schematic/releases/tag/v0.1.0
