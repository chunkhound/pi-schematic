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
   - Read the relevant suites in `tests/unit/` and `tests/integration/` before changing behavior.

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

Tests run on Vitest, in three projects of `vitest.config.ts`: `unit` runs `tests/unit/**/*.test.ts`, `integration` runs `tests/integration/**/*.test.ts` and `e2e` runs `tests/e2e/**/*.test.ts`. A new test file under one of these directories is picked up by its glob. Run one file with `npx vitest run --project <project> <file>`, for example `npx vitest run --project unit tests/unit/handoff.test.ts`. The suites test the behaviour of the shipped extension; repository configuration, documentation, CI helper scripts and the test helpers themselves have no tests.

Each test goes into the project that matches what it needs:

- `unit` holds deterministic in-process tests: pure modules, and extension handlers, tools and commands driven through pi's own extension runner. Their sessions and model registries are in memory, and their files live under a temp directory.
- `integration` holds tests that leave the process or are not deterministic: a real pi agent session, child processes, shells, the OS sandbox, git.
- `e2e` holds the tests that run the real pi CLI.

The project is decided per test. A file whose tests fall on both sides is split into two files with the same name, one in `tests/unit/` and one in `tests/integration/`. The shared test fixtures live in `tests/support/`, which holds no tests:

- `runner.ts`: `createRunner` loads the extension through pi's `DefaultResourceLoader` and drives it through one pi `ExtensionRunner`. It records what the extension sent, appended and showed, and a context member the test did not bind throws when used. `toolInfo` builds a `pi.getAllTools()` entry.
- `theme.ts`: `realTheme`, a pi `Theme` with a distinct truecolor value per token, and `createRealTheme`, which builds it with some foreground colours replaced.
- `model-registry.ts`: `createModelRegistry`, a pi `ModelRegistry` in memory whose available models come only from the providers the test passes.
- `model.ts`: `testModel`, a model with placeholder metadata.
- `session.ts`: helpers that fill a `SessionManager.inMemory` session through pi's append methods, message builders, and stand-in child sessions (`createSubscribableSession`, `createChildSession`, `createSession`).
- `guarded.ts`: `guardedInstance`, a class instance that throws on every member the test did not provide, and `stubInstance`.
- `temp.ts`: temp directories (`tmpDir`, `testWithDir`) and HOME or agent-directory isolation (`setTempHome`, `withTempHome`, `withTempAgentDir`).
- `tool-result.ts`: readers and checks for tool results (`recordOf`, `detailsOf`, `firstText`, `textOf`, `assertErrorResult`).
- `render-context.ts`: `createToolRenderContext`, the render context pi passes a tool's renderers.
- `sandbox.ts`: `SANDBOX_DENIAL_PHRASES`, the OS sandbox's denial text per platform, and `bashResult`.
- `deferred.ts`: `createDeferred`, a promise the test resolves.
- `spawn-node.ts`: `spawnNode`, which runs a Node child process to completion under a deadline.
- `real-child.ts`: `runRealChildInvocation`, which runs the spawn tool with a real child session against an offline probe provider, for integration tests.

- `npm test` runs the unit and integration projects (`vitest run --project unit --project integration`). Arguments after `--` go to Vitest, so a file filter works there too. A render snapshot whose golden file is missing is written locally and fails under CI.
- `npm run test:unit` runs the unit project (`vitest run --project unit`), and `npm run test:integration` runs the integration project (`vitest run --project integration`).
- `npm run test:coverage` runs the same tests as `npm test` with V8 coverage (`vitest run --project unit --project integration --coverage`). It prints a text table and writes the report to `coverage/`: `coverage/lcov.info`, `coverage/coverage-summary.json` and the HTML report in `coverage/lcov-report/`. CI uploads this report as an artifact and, on a pull request from a branch of this repository, posts the coverage summary as a comment that later runs update. The comment also shows the totals against the PR's base commit.
- `npm run test:snapshots:check` runs only the render-snapshot tests with `--update=none`; fails on a missing or differing golden file in `tests/snapshots/`.
- `npm run test:snapshots:update` runs only the render-snapshot tests with `--update=all`, which rewrites each golden file in `tests/snapshots/` whose render differs from it, and writes a missing one, after an intentional render change. Review the diff carefully: snapshot updates are the only signal that catches unintended UI regressions.
- `npm run test:e2e` runs the `e2e` project, the real-host suite under `tests/e2e/`: it drives the pi CLI in RPC mode through `RpcClient` with schematic and a scripted probe provider. `E2E_REAL_HOST_TIMEOUT_MS` sets how long a real-host step's barrier waits for outstanding runs, handoff calls awaiting their turn_end and extension inputs awaiting delivery before it fails (default 20 000 ms); a step that has counted fewer runs than it expects barriers again inside that same budget, because a run that a command handler starts (schematic's `/handoff`) is first visible to the probe at its input event. The real-host suite's `describe` sets a Vitest timeout of `4 × (E2E_REAL_HOST_TIMEOUT_MS + 5 000) + 60 000` ms (`REAL_HOST_TEST_TIMEOUT_MS`, `tests/e2e/real-host.ts`) for each of its tests: room for the four barriers a host may make, each running to the harness's own deadline (a step that barriers again inside its deadline adds at most one report backstop to its phase), so a slow test fails with the harness's message rather than Vitest's timeout. The timeout covers the test body: start, commands and the barriers of its steps. The test-finish callback runs afterwards: it first waits for a timed-out body to settle and then closes the host, a close bounded by its own waits whose barrier counts as one of the four. A test that needs a fifth barrier fails until `REAL_HOST_MAX_BARRIERS_PER_TEST` is raised, and an override that would push the per-test timeout above Vitest's limit of 2 147 483 647 ms is rejected at load.

### Untested behaviour

The suites leave these behaviours unpinned:

- A handoff that shares its message with other calls whose results all set `terminate`. The refusal then ends the run, and the model sees it only on the next prompt. Deliberate: the handoff tool is the only tool in this repo whose result sets `terminate`, so a test would pin a case that only a test tool can produce.
- `findHandoffCut` matching only a compaction whose details carry `handoff: true`. Deliberate: every boundary cut writes that flag, and the unit tests pin the drafts that write it.
- A spawn can fail after its child's agent run started, for a reason other than an empty reply. Examples are a failed prompt, a reset, or a dispose failure. Its child usage reaching the parent's totals in a real host is unpinned. Deliberate: the unit tests pin each cause (the error result from the `catch` block, an `error` or `aborted` completion, a dispose failure), and the e2e suite pins the empty-reply path.
- The trusted project prompt directory and the extension directory of the integration tests' spawn probe (`runRealChildInvocation` in `tests/support/real-child.ts`) are built from pi's `CONFIG_DIR_NAME`, not a literal `.pi`. Deliberate: the installed pi declares `.pi` as that name, so no test can tell the two apart. The typechecked import of `CONFIG_DIR_NAME` only catches pi removing or renaming that export; reverting either path to a literal `.pi` passes every gate.

## CI

Pull requests are automatically tested via GitHub Actions. `.github/workflows/ci.yml` defines which OS and Node lanes run and which checks each lane runs.

The floor is the minimum Node.js version Pi requires (the `engines.node` of `@earendil-works/pi-coding-agent`). This package declares no `engines` of its own, because it only runs inside Pi. Both the floor and the current Node.js LTS are tested on Linux, macOS and Windows, because platform-specific code paths can also depend on the Node version. The exact current LTS is written in the CI matrix, the current-Pi job, the lint jobs and the publish workflow, and Renovate bumps all of them together: patch and minor releases in a "Node.js" PR, a new LTS major in a separate "major Node.js" PR. Local development runs on the floor: `.node-version` holds it for version managers such as fnm and nodenv, because code that works on the floor almost always works on newer releases, while the reverse is where breakage comes from. When Pi raises its floor, Renovate updates `.node-version`, the floor entry of the CI matrix and the `@types/node` version cap, which keeps the Node types on the floor's major, in one PR.

All tracked text is LF in the index and in the working tree, snapshot goldens included: one `.gitattributes` rule, `* text=auto eol=lf`, owns that contract for every text file, so tests do not depend on `core.autocrlf`. A stale clone can still hold CRLF and fail `npm test`. To recover, commit or stash your changes first, because the recovery discards uncommitted work, then run `git rm --cached -r . && git reset --hard`. If you update snapshots, CI checks them on every lane of the test matrix.

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
