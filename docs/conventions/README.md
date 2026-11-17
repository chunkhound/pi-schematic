# Conventions

A convention is a statement about how this repository is kept that spans several files or describes a change. A change is a set of edits checked as one: the diff of a pull request in CI, or the edits an agent or contributor makes before committing. Each convention names the files it applies to. A rule about a single file belongs in a comment in that file, not here. Tools enforce parts of some conventions; review covers the rest.

A CI check (`.github/workflows/conventions.yml`) reviews pull requests to main from branches of this repository against the conventions in this directory as they read once the pull request is merged. The CI check skips this README.

## File format

Each convention is one file in this directory, named `<slug>.md`. It starts with frontmatter that holds `paths`, a list of double-quoted globs. Each glob is a git glob pathspec relative to the repository root: `*` does not cross `/`, `**/` matches any depth, and there is no brace alternation, so a glob holds no `{` or `}`. An item that starts with `!` excludes. A changed file matches when it matches an including glob and no excluding glob. The CI check reviews a pull request against a convention when at least one of its changed files matches; added, modified and deleted files count, and so does either side of a rename.

The H1 after the frontmatter is the convention's name, and the paragraphs after it, up to the first `Why:` or `Tooling:` paragraph, are the statement. `Why:` and `Tooling:` paragraphs explain the convention and are not part of the statement. Each sentence of the statement is judged on its own, so it names what it speaks about. A sentence ends at a full stop followed by whitespace or the end of the statement; a full stop inside backticks does not end one. The CI check fails on a convention file without this format.

A convention file has this shape, shown here with a sample rule that is not a convention of this repository.

```markdown
---
paths:
  - "**/*.ts"
  - "!tests/**"
---

# Example: error messages

An error message the extension throws names the file or setting it concerns. An error message the extension throws starts with a capital letter and does not end with a full stop.

Why: a message without its subject leaves the user to guess what failed.

Tooling: none; review covers it.
```
