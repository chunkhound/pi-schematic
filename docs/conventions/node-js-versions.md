---
paths:
  - ".node-version"
  - "package-lock.json"
  - "package.json"
  - ".github/workflows/**"
  - ".github/renovate.json"
---

# Node.js versions

`.node-version` holds the floor: the minimum of the `engines.node` range that `package-lock.json` records for `@earendil-works/pi-coding-agent`. `package.json` declares no `engines`. The `floor` entry of the test matrix in `.github/workflows/ci.yml` holds the version in `.node-version`. The `@types/node` `allowedVersions` rule in `.github/renovate.json` is `^` followed by the version in `.node-version`. The `newest` entry of the test matrix, the lint job and the current-Pi job in `.github/workflows/ci.yml`, and every `node-version` in `.github/workflows/npm-publish.yml` and `.github/workflows/conventions.yml`, hold the same exact Node.js version. The test matrix in `.github/workflows/ci.yml` runs its `floor` and `newest` entries on Linux, macOS and Windows.

Tooling: Renovate updates the floor in all three places in one pull request, and the current LTS in every `node-version` its patterns match. Review covers a new `node-version` that those patterns do not match.
