# Contributing to pi-schematic

Welcome! This project welcomes focused, well-validated contributions. Use coding agents deliberately: research before editing, keep changes small, follow existing patterns, and document the validation you ran.

## Development Principles

- **Use code research first** — understand the surrounding module responsibilities before editing.
- **Make minimal changes** — prefer targeted edits that reuse existing mechanisms.
- **Match existing patterns** — keep naming, lifecycle hooks, tool contracts, and TUI behavior consistent with the current code.
- **Preserve context-management semantics** — changes to `spawn`, `notebook`, or `handoff` should keep the agent workflow predictable across session resets and compaction.
- **Use static imports only for `spawn/renderer.ts`** — it registers the frame scheduler into the singleton container at module evaluation time. Switching to `await import()` will silently break test isolation because the test harness cannot overwrite the singleton before registration.
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

- `npm test` — runs the unit suite under `tests/unit/` via the in-repo Node test runner.
- `npm run test:snapshots:check` — runs only the render-snapshot tests; fails on any drift in `tests/snapshots/`.
- `npm run test:snapshots:update` — rewrites the golden files in `tests/snapshots/` after an intentional render change. Review the diff carefully: snapshot updates are the only signal that catches unintended UI regressions.
- `npm run test:e2e` — runs the end-to-end suites under `tests/e2e/`: the real-host suite drives the pi CLI in RPC mode through `RpcClient` with schematic and a scripted probe provider; the line host covers scenarios RPC cannot reach (headless mode, injected context usage, compaction races, the no-model spawn error, line-protocol errors). `E2E_REAL_HOST_TIMEOUT_MS` sets how long a real-host step's barrier waits for outstanding runs, compactions and successor sends before it fails (default 20 000 ms); a step that has counted fewer runs than it expects barriers again inside that same budget, because a run that a command, `session_tree` or `agent_settled` handler starts is first visible to the probe at its input event. Each real-host test runs with a `node:test` timeout of `4 × (E2E_REAL_HOST_TIMEOUT_MS + 5 000) + 60 000` ms (`REAL_HOST_TEST_TIMEOUT_MS`, `tests/e2e/real-host.ts`): room for the four barriers a test may make, its close included, each running to the harness's own deadline (a step that barriers again inside its deadline adds at most one report backstop to its phase), so a slow test fails with the harness's message rather than the `node:test` timeout. A test that needs a fifth barrier fails until `REAL_HOST_MAX_BARRIERS_PER_TEST` is raised, and an override that would push the per-test timeout above `node:test`'s limit of 2 147 483 647 ms is rejected at load.

## CI

Pull requests are automatically tested via GitHub Actions. A cross-platform matrix runs on every push and PR:

| OS | Node | Runs |
|---|---|---|
| Ubuntu | 22 (minimum) | Type check, security audit, unit tests, E2E tests |
| Ubuntu | 24 | Type check, security audit, unit tests, E2E tests |
| macOS | 24 | Unit tests, E2E tests |
| Windows | 24 | Unit tests, E2E tests |

Node 22 (minimum) is tested only on Linux — the primary platform and the only one guaranteed to have the oldest toolchain. macOS and Windows test Node 24 (latest) to catch regressions in the newest runtime while balancing CI cost.

Snapshot golden files in `tests/snapshots/` are stored with LF line endings (enforced by `.gitattributes`). The `normalizeEOL` helper in the snapshot test file normalizes `\r\n` to `\n` on read, so Windows developers get correct comparisons even if their working tree has CRLF. If you update snapshots, the CI matrix validates them on all platforms.
Both E2E suites run on Linux, macOS and Windows.

## Community

Use GitHub Issues for bug reports and feature requests. Keep discussions concrete: describe the agent workflow you expected, what happened instead, and any reproduction steps.

## License

By contributing to this project, you agree that your contributions will be licensed under the same MIT License as pi-schematic.
