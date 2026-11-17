---
paths:
  - ".node-version"
  - "package.json"
  - ".github/workflows/**"
  - ".github/renovate.json"
---

# Node.js versions

`.node-version` holds the floor: the minimum of the `engines.node` range of `@earendil-works/pi-coding-agent`. `package.json` declares no `engines`. The floor entry of the test matrix in `.github/workflows/ci.yml` is the floor, and the `@types/node` `allowedVersions` rule in `.github/renovate.json` is `^` the floor. The current Node.js LTS is one exact version, written in the newest entry of the test matrix, the lint job and the current-Pi job of `.github/workflows/ci.yml`, and in every `node-version` of `.github/workflows/npm-publish.yml` and `.github/workflows/conventions.yml`. The test matrix runs both versions on Linux, macOS and Windows.

Tooling: Renovate updates the floor in all three places in one pull request, and the current LTS in every `node-version` its patterns match. Review covers a new `node-version` that those patterns do not match.
