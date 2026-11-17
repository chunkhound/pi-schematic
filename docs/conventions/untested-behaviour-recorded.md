---
paths:
  - "**/*.ts"
  - "tests/**"
  - "scripts/**"
  - "!scripts/coverage-comment.mjs"
  - "!scripts/conventions-verdict.schema.json"
---

# Untested behaviour recorded

A behaviour of the extension or of the test tooling that a pull request adds or changes and that the suites leave unpinned has an entry in the "Untested behaviour" list of `CONTRIBUTING.md`. An entry for a deliberate choice says so and gives the reason; an entry without that is a gap. A script that reports in CI, such as `scripts/coverage-comment.mjs`, gets no entry: review and its run in CI cover it.
