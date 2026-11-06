// The test files that run on Vitest. vitest.config.ts runs exactly these in its unit project, and
// scripts/run-node-test.mjs leaves them out of the node:test run. The list is temporary while the
// suite moves to Vitest; every other test file still runs on node:test.

/** Repository-relative paths of the test files that run on Vitest. */
export const VITEST_FILES = [
  "tests/unit/abort-child-session.test.ts",
  "tests/unit/brand-assets.test.ts",
  "tests/unit/dependency-graph-assertions.test.ts",
  "tests/unit/model-groups-display.test.ts",
  "tests/unit/pi-module-identity.test.ts",
  "tests/unit/resolve-path.test.ts",
  "tests/unit/test-infra.test.ts",
  "tests/unit/thinking-levels.test.ts",
];
