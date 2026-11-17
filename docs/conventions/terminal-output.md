---
paths:
  - "**/*.ts"
  - "!tests/**"
  - "!scripts/**"
  - "!vitest.config.ts"
---

# Terminal output

No TypeScript file outside `tests/` and `scripts/`, other than `vitest.config.ts`, writes to the process's stdout or stderr, except through a child process that takes over the terminal while the TUI is stopped. What the user must see goes through `ctx.ui.notify()`, `setStatus()` or `setWidget()`. Diagnostic output is removed.

Why: the extension runs in pi's process, and writes to stdout or stderr corrupt pi's TUI rendering.

Tooling: lint rejects `console.*` calls and direct `process.stdout.write` and `process.stderr.write` calls. Review covers a child process with inherited stdout or stderr and a write to file descriptor 1 or 2.
