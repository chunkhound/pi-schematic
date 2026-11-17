---
paths:
  - "CHANGELOG.md"
  - "package.json"
  - "**/*.ts"
  - "!tests/**"
  - "!scripts/**"
  - "!vitest.config.ts"
---

# Changelog

`CHANGELOG.md` has one `[Unreleased]` section. A pull request that changes what a user or another extension sees (a feature, a fix, a raised requirement) adds its entries under `[Unreleased]` and does not change `version` in `package.json`; a pull request that only changes tests, tooling, CI or contributor documentation adds none. An entry that removes or changes something a user or another extension can rely on is listed under Breaking Changes, and that includes an export that a module other than `index.ts` stops providing.
