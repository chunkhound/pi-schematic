---
paths:
  - "package.json"
  - ".github/workflows/**"
  - "vitest.config.ts"
  - "scripts/**"
  - ".husky/**"
  - "*.mjs"
  - "tests/**"
---

# HOME in tests

No script, CI step or configuration sets `HOME` for a whole test run.

Why: the readonly tests derive paths that must lie outside the temp directory from `os.homedir()`; a suite-wide `HOME` under the temp directory puts them inside it.
