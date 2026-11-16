# Conventions

A convention is a statement about how this repository is kept that spans several files or describes a change. Each convention below names the files it applies to. A statement about a single file is a comment in that file instead. Tools enforce parts of some conventions; review covers the rest.

A CI check (`npm run check:conventions`, `scripts/check-conventions.mjs`) reviews pull requests to main from branches of this repository against the version of this file on the base branch.

## Pi compatibility floor

`devDependencies` in `package.json` pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` to one exact version, and `typebox` to the exact version that the pinned `@earendil-works/pi-coding-agent` declares as its `typebox` dependency. `peerDependencies` lists `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as `>=` the pi pin and `typebox` as `>=` the typebox pin; `@earendil-works/pi-agent-core` is pinned and is not a peer. Both README lines that name the required Pi version name the pi pin. Renovate does not update these packages. A raise is made by hand, changes pins, peers and README lines in one commit, and is listed under Breaking Changes in `CHANGELOG.md`.

Applies to: `package.json`, `package-lock.json`, `README.md`, `.github/renovate.json`, `CHANGELOG.md`.

Why: the unit and end-to-end suites run against the pinned versions.

Tooling: `tests/unit/config-invariants.test.ts` checks the pinned Pi compatibility metadata and the README's Pi floor.

## Brand asset references

`pi.image` in `package.json` and the README hero image are the same URL, of the form `https://raw.githubusercontent.com/chunkhound/pi-schematic/main/assets/<file>`, and `<file>` is committed under `assets/`.

Applies to: `package.json` (`pi.image`), `README.md`, `assets/`.

Why: npm and the pi.dev gallery render the README and the image outside the repository.

Tooling: `tests/unit/brand-assets.test.ts` checks that `pi.image` resolves to an existing asset and that the README contains the `pi.image` URL; review covers that the hero is the place that uses it.

## Terminal output

Production code writes nothing to the process's stdout or stderr, except through a child process that takes over the terminal while the TUI is stopped. What the user must see goes through `ctx.ui.notify()`, `setStatus()` or `setWidget()`. Diagnostic output is removed.

Applies to: every TypeScript file outside `tests/` and `scripts/`, except `vitest.config.ts`.

Why: the extension runs in pi's process, and writes to stdout or stderr corrupt pi's TUI rendering.

Tooling: lint rejects `console.*` calls and direct `process.stdout.write` and `process.stderr.write` calls. Review covers a child process with inherited stdout or stderr and a write to file descriptor 1 or 2.

## HOME in tests

No script, CI step or configuration sets `HOME` for a whole test run.

Applies to: `package.json` (`scripts`), `.github/workflows/`, `vitest.config.ts`, `scripts/`.

Why: the readonly tests derive paths that must lie outside the temp directory from `os.homedir()`; a suite-wide `HOME` under the temp directory puts them inside it.

## Public surface

`pi.extensions` in `package.json` names only `./index.ts`, and `index.ts` has only a default export.

Applies to: `package.json`, `index.ts`.

## Node.js versions

`.node-version` holds the floor: the minimum of the `engines.node` range of `@earendil-works/pi-coding-agent`. `package.json` declares no `engines`. The floor entry of the test matrix in `.github/workflows/ci.yml` is the floor, and the `@types/node` `allowedVersions` rule in `.github/renovate.json` is `^` the floor. The current Node.js LTS is one exact version, written in the newest entry of the test matrix, the lint job and the current-Pi job of `.github/workflows/ci.yml`, and in every `node-version` of `.github/workflows/npm-publish.yml` and `.github/workflows/conventions.yml`. The test matrix runs both versions on Linux, macOS and Windows.

Applies to: `.node-version`, `package.json`, `.github/workflows/`, `.github/renovate.json`.

Tooling: Renovate updates the floor in all three places in one pull request, and the current LTS in every `node-version` its patterns match. Review covers a new `node-version` that those patterns do not match.

## What is tested

A pull request that changes the extension's behaviour adds or updates the tests for that behaviour.

Applies to: every pull request that changes production code.

## Untested behaviour recorded

A behaviour of the extension or of the test tooling that a pull request adds or changes and that the suites leave unpinned has an entry in the "Untested behaviour" list of `CONTRIBUTING.md`. An entry for a deliberate choice says so and gives the reason; an entry without that is a gap. A script that reports in CI, such as `scripts/check-conventions.mjs` or `scripts/coverage-comment.mjs`, gets no entry: review and its run in CI cover it.

Applies to: every pull request that changes production code or a test.

## Changelog

`CHANGELOG.md` has one `[Unreleased]` section. A pull request that changes what a user or another extension sees (a feature, a fix, a raised requirement) adds its entries under `[Unreleased]` and does not change `version` in `package.json`; a pull request that only changes tests, tooling, CI or contributor documentation adds none. An entry that removes or changes something a user or another extension can rely on is listed under Breaking Changes, and that includes an export that a module other than `index.ts` stops providing.

Applies to: `CHANGELOG.md`, `package.json` (`version`).

## Lint exemptions

Every rule in `eslint.config.mjs` is an error from the pull request that adds it; no rule is set to `off` or `warn`. `eslint-suppressions.json` records only the violations that exist when a rule lands, and new code adds no entries to it. A pattern the code needs on purpose keeps an `eslint-disable-next-line` comment with the reason at that line, not an entry in `eslint-suppressions.json`. Code that serves two Pi versions keeps a disable comment that names the versions.

Applies to: `eslint.config.mjs`, `eslint-suppressions.json`, every file with an `eslint-disable` comment.

Tooling: lint rejects a disable comment without a description, and fails while a recorded count in `eslint-suppressions.json` is higher than the actual one.
