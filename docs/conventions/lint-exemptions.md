---
paths:
  - "eslint.config.mjs"
  - "eslint-suppressions.json"
  - "**/*.ts"
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.cjs"
---

# Lint exemptions

Every rule in `eslint.config.mjs` is an error from the pull request that adds it; no rule is set to `off` or `warn`. `eslint-suppressions.json` records only the violations that exist when a rule lands, and new code adds no entries to it. A pattern the code needs on purpose keeps an `eslint-disable-next-line` comment with the reason at that line, not an entry in `eslint-suppressions.json`. Code that serves two Pi versions keeps a disable comment that names the versions.

Tooling: lint rejects a disable comment without a description, and fails while a recorded count in `eslint-suppressions.json` is higher than the actual one.
