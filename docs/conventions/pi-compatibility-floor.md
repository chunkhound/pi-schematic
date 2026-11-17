---
paths:
  - "package.json"
  - "package-lock.json"
  - "README.md"
  - ".github/renovate.json"
  - "CHANGELOG.md"
---

# Pi compatibility floor

`devDependencies` in `package.json` pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` to one exact version. `devDependencies` in `package.json` pins `typebox` to the exact version that `package-lock.json` records as the `typebox` dependency of the pinned `@earendil-works/pi-coding-agent`. `peerDependencies` in `package.json` lists `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`, each as `>=` its version in `devDependencies`. `peerDependencies` in `package.json` does not list `@earendil-works/pi-agent-core`. Both lines of `README.md` that name the required Pi version name the `@earendil-works/pi-coding-agent` version in `devDependencies`. `.github/renovate.json` disables Renovate updates for `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`. A change to the `devDependencies` version of an `@earendil-works/pi-*` package or of `typebox` also changes the other `devDependencies` versions, the `peerDependencies` ranges and the lines of `README.md` that this convention ties to it. A change that raises the `@earendil-works/pi-coding-agent` version in `devDependencies` adds an entry under Breaking Changes in `CHANGELOG.md`.

Why: the unit and end-to-end suites run against the pinned versions.

Tooling: `tests/unit/config-invariants.test.ts` checks the pinned Pi compatibility metadata and the README's Pi floor.
