---
paths:
  - "**/*.ts"
  - "!tests/**"
  - "!scripts/**"
  - "!vitest.config.ts"
---

# Terminal output

No TypeScript file outside `tests/` and `scripts/`, other than `vitest.config.ts`, writes to the process's stdout or stderr, except `notebook/pager.ts`, which hands the terminal to the pager while the TUI is stopped.

Why: the extension runs in pi's process, and writes to stdout or stderr corrupt pi's TUI rendering. What the user must see goes through `ctx.ui.notify()`, `setStatus()` or `setWidget()`.

Tooling: lint rejects `console.*` calls and direct `process.stdout.write` and `process.stderr.write` calls. Review covers a child process with inherited stdout or stderr and a write to file descriptor 1 or 2.
