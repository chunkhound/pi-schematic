# Contributing to pi-schematic

Welcome! This project welcomes focused, well-validated contributions. Use coding agents deliberately: research before editing, keep changes small, follow existing patterns, and document the validation you ran.

## Development Principles

- **Use code research first** — understand the surrounding module responsibilities before editing.
- **Make minimal changes** — prefer targeted edits that reuse existing mechanisms.
- **Match existing patterns** — keep naming, lifecycle hooks, tool contracts, and TUI behavior consistent with the current code.
- **Preserve context-management semantics** — changes to `spawn`, `notebook`, or `handoff` should keep the agent workflow predictable across session resets and compaction.
- **AI-agent generated contributions are welcome** — include enough human intent and validation context in the PR for reviewers to trust the result.

## Suggested Workflow

1. **Research the area**
   - Identify the relevant primitive: spawn, notebook, handoff, watchdog, or extension wiring.
   - Read the relevant suite in `tests/unit/` before changing behavior.

2. **Plan the smallest safe change**
   - Reuse existing state and lifecycle hooks when possible.
   - Avoid adding dependencies unless the change clearly needs them.

3. **Implement with tests or validation**
   - Add or update tests for behavior changes.
   - For documentation-only changes, review rendered links and examples.

4. **Submit a focused PR**
   - Explain why the change is needed.
   - Link the related issue or discussion when one exists.
   - List the validation you ran, or explain why a test command was not applicable.

## Quality Bar

Before submitting, check that your change:

- Keeps public tool names and contracts stable unless the PR explicitly proposes a breaking change.
- Does not introduce hidden context growth, unbounded output, or recursive child-agent spawning.
- Handles reset, cancellation, and stale-session cases where relevant.
- Keeps docs aligned with the package version and installed behavior.

## Tests

Tests run on Vitest, in two projects of `vitest.config.ts`: `unit` runs `tests/unit/**/*.test.ts` and `e2e` runs `tests/e2e/**/*.test.ts`. A new test file under either directory is picked up by its glob. Run one file with `npx vitest run --project <project> <file>`, for example `npx vitest run --project unit tests/unit/test-infra.test.ts`.

- `npm test` runs the unit suite (`vitest run --project unit`). Arguments after `--` go to Vitest, so a file filter works there too. A render snapshot whose golden file is missing is written locally and fails under CI.
- `npm run test:coverage` runs the same unit tests as `npm test` with V8 coverage (`vitest run --project unit --coverage`). It prints a text table and writes the report to `coverage/`: `coverage/lcov.info`, `coverage/coverage-summary.json` and the HTML report in `coverage/lcov-report/`. CI uploads this report as an artifact and, on a pull request from a branch of this repository, posts the coverage summary as a comment that later runs update. The comment also shows the totals against the PR's base commit.
- `npm run test:snapshots:check` runs only the render-snapshot tests with `--update=none`; fails on a missing or differing golden file in `tests/snapshots/`.
- `npm run test:snapshots:update` runs only the render-snapshot tests with `--update=all`, which rewrites each golden file in `tests/snapshots/` whose render differs from it, and writes a missing one, after an intentional render change. Review the diff carefully: snapshot updates are the only signal that catches unintended UI regressions.
- `npm run test:e2e` runs the `e2e` project, the end-to-end suites under `tests/e2e/`: the real-host suite drives the pi CLI in RPC mode through `RpcClient` with schematic and a scripted probe provider; the line host covers scenarios RPC cannot reach (headless mode, injected context usage, the no-model spawn error, line-protocol errors). `E2E_REAL_HOST_TIMEOUT_MS` sets how long a real-host step's barrier waits for outstanding runs, handoff calls awaiting their turn_end and extension inputs awaiting delivery before it fails (default 20 000 ms); a step that has counted fewer runs than it expects barriers again inside that same budget, because a run that a command handler starts (schematic's `/handoff`) is first visible to the probe at its input event. The real-host suite's `describe` sets a Vitest timeout of `4 × (E2E_REAL_HOST_TIMEOUT_MS + 5 000) + 60 000` ms (`REAL_HOST_TEST_TIMEOUT_MS`, `tests/e2e/real-host.ts`) for each of its tests: room for the four barriers a host may make, each running to the harness's own deadline (a step that barriers again inside its deadline adds at most one report backstop to its phase), so a slow test fails with the harness's message rather than Vitest's timeout. The timeout covers the test body: start, commands and the barriers of its steps. The test-finish callback runs afterwards: it first waits for a timed-out body to settle and then closes the host, a close bounded by its own waits whose barrier counts as one of the four. A test that needs a fifth barrier fails until `REAL_HOST_MAX_BARRIERS_PER_TEST` is raised, and an override that would push the per-test timeout above Vitest's limit of 2 147 483 647 ms is rejected at load.

### Untested behaviour

The suites leave these behaviours unpinned:

- A handoff that shares its message with other calls whose results all set `terminate`. The refusal then ends the run, and the model sees it only on the next prompt. Deliberate: the handoff tool is the only tool in this repo whose result sets `terminate`, so a test would pin a case that only a test tool can produce.
- `findHandoffCut` matching only a compaction whose details carry `handoff: true`. Deliberate: every boundary cut writes that flag, and the unit tests pin the drafts that write it.
- The refusal of a second handoff in a run that already lost its cut, at e2e level. Deliberate: the unit and real-session tests pin it, and the e2e probe drops the cut with `continue: false`, which ends the run before a second call. An e2e test would need a probe change.
- A spawn can fail after its child's agent run started, for a reason other than an empty reply. Examples are a failed prompt, a reset, or a dispose failure. Its child usage reaching the parent's totals in a real host is unpinned. Deliberate: the unit tests pin each cause (the error result from the `catch` block, an `error` or `aborted` completion, a dispose failure), and the e2e suite pins the empty-reply path.
- The trusted project prompt directory and the unit-test spawn probe's extension directory (`runRealChildInvocation`) are built from pi's `CONFIG_DIR_NAME`, not a literal `.pi`. Deliberate: the installed pi declares `.pi` as that name, so no test can tell the two apart. The typechecked import of `CONFIG_DIR_NAME` only catches pi removing or renaming that export; reverting either path to a literal `.pi` passes every gate.
- The unit test host's check that pi loaded one extension per factory (`loadExtensions` in `tests/unit/test-host.ts`). Deliberate: discovered extensions are dropped, the project is untrusted and settings are in memory, so no other extension can load unless the host's loader options change. No test asserts the check's throwing branch or its message; the project-directory isolation test reaches them only when both `noExtensions: true` and the untrusted project are reverted.
- Which files pi reads while the test host loads. Deliberate: no test observes it, because pi swallows a malformed `package.json` in a discovered extension directory, so a read leaves nothing to assert. The host's `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, `systemPrompt` and `appendSystemPrompt` switches are unpinned for the same reason: they only stop pi reading those files, the host reads none of those resources, and no test outcome depends on them. Setting `systemPrompt` skips the SYSTEM.md lookup and setting `appendSystemPrompt` skips the APPEND_SYSTEM.md lookup, even when the value is empty.
- The `$HOME/.agents/skills` walk, which the test host cannot stop. On every load pi walks that directory recursively when it exists, following symlinks and reading ignore files in each directory it visits. No loader option stops the walk. Nothing from it loads, because skill files are not read. Only redirecting `HOME` would stop it, and the host does not change process environment variables.
- The removal of the test host's temp agent directory at process exit. Deliberate: pi writes nothing into it, and observing an exit handler needs a separate process.

## CI

Pull requests are automatically tested via GitHub Actions. `.github/workflows/ci.yml` defines which OS and Node lanes run and which checks each lane runs.

The floor is the minimum Node.js version Pi requires (the `engines.node` of `@earendil-works/pi-coding-agent`). This package declares no `engines` of its own, because it only runs inside Pi. Both the floor and the current Node.js LTS are tested on Linux, macOS and Windows, because platform-specific code paths can also depend on the Node version. The exact current LTS is written in the CI matrix, the current-Pi job, the lint jobs and the publish workflow, and Renovate bumps all of them together: patch and minor releases in a "Node.js" PR, a new LTS major in a separate "major Node.js" PR. Local development runs on the floor: `.node-version` holds it for version managers such as fnm and nodenv, because code that works on the floor almost always works on newer releases, while the reverse is where breakage comes from. When Pi raises its floor, Renovate updates `.node-version`, the floor entry of the CI matrix and the `@types/node` version cap, which keeps the Node types on the floor's major, in one PR.

All tracked text is LF in the index and in the working tree, snapshot goldens included: one `.gitattributes` rule, `* text=auto eol=lf`, owns that contract for every text file, so tests do not depend on `core.autocrlf`. A stale clone can still hold CRLF and fail `npm test`; the `repository text has one LF line-ending contract` test in `tests/unit/config-invariants.test.ts` is the executable check, and its assertion message is the only copy of the recovery command. If you update snapshots, CI checks them on every lane of the test matrix.

## Releasing

Feature PRs add changelog entries under [Unreleased] and do not change the version.

A release PR titled `release: X.Y.Z` sets the version in `package.json` and `package-lock.json` by hand. Rename `[Unreleased]` to `[X.Y.Z] - <date>`, add a fresh `[Unreleased]` heading above it, and update the compare links. After merge, tag the merge commit `vX.Y.Z` and push the tag, or create a GitHub release with that tag. The tag push runs `.github/workflows/npm-publish.yml`, which fails unless the tagged commit is on main, checks the tag against `package.json`, runs the gates, and publishes through npm trusted publishing.

For the first publish, a maintainer must publish by hand before registering a trusted publisher. The publishing account needs publish rights in the `chunkhound` npm org. `publishConfig.access` is `public`, so `npm publish` publishes the scoped package publicly. From a clean checkout of the tag, run:

```bash
git clone --branch vX.Y.Z https://github.com/chunkhound/pi-schematic <dir>
cd <dir>
npm ci
npm pack --dry-run
npm publish
npm trust github @chunkhound/pi-schematic --file npm-publish.yml --repository chunkhound/pi-schematic --allow-publish
```

The `npm trust` command requires npm 11.15 or later. If the tag's workflow run starts before the manual publish, rerun it after bootstrap. It finds the version on the registry and skips publishing.

## Community

Use GitHub Issues for bug reports and feature requests. Keep discussions concrete: describe the agent workflow you expected, what happened instead, and any reproduction steps.

## License

By contributing to this project, you agree that your contributions will be licensed under the same MIT License as pi-schematic.
