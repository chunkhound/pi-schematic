---
paths:
  - "package.json"
  - "README.md"
  - "assets/**"
---

# Brand asset references

`pi.image` in `package.json` and the README hero image are the same URL, of the form `https://raw.githubusercontent.com/chunkhound/pi-schematic/main/assets/<file>`, and `<file>` is committed under `assets/`.

Why: npm and the pi.dev gallery render the README and the image outside the repository.

Tooling: `tests/unit/brand-assets.test.ts` checks that `pi.image` resolves to an existing asset and that the README contains the `pi.image` URL; review covers that the hero is the place that uses it.
