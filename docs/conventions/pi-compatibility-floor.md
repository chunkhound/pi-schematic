---
paths:
  - "package.json"
  - "package-lock.json"
  - "README.md"
  - ".github/renovate.json"
  - "CHANGELOG.md"
---

# Pi compatibility floor

`devDependencies` in `package.json` pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` to one exact version, and `typebox` to the exact version that `package-lock.json` records as the `typebox` dependency of the pinned `@earendil-works/pi-coding-agent`. `peerDependencies` lists `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as `>=` the pi pin and `typebox` as `>=` the typebox pin; `@earendil-works/pi-agent-core` is pinned and is not a peer. Both README lines that name the required Pi version name the pi pin. Renovate does not update these packages. A raise is made by hand, changes pins, peers and README lines in one commit, and is listed under Breaking Changes in `CHANGELOG.md`.

Why: the unit and end-to-end suites run against the pinned versions.

Tooling: `tests/unit/config-invariants.test.ts` checks the pinned Pi compatibility metadata and the README's Pi floor.
