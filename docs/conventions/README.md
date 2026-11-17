# Conventions

A convention is a statement about how this repository is kept that spans several files or describes a change. A change is a set of edits checked as one: the diff of a pull request in CI, or the edits an agent or contributor makes before committing. Each convention names the files it applies to. A rule about a single file belongs in a comment in that file, not here. Tools enforce parts of some conventions; review covers the rest.

A CI check (`.github/workflows/conventions.yml`) reviews pull requests to main from branches of this repository against the conventions in this directory as they read once the pull request is merged. The CI check skips this README.

## File format

Each convention is one file in this directory, named `<slug>.md`. It starts with frontmatter that holds `paths`, a list of globs relative to the repository root, each a double-quoted string. An item that starts with `!` excludes. A changed file matches when it matches an including glob and no excluding glob. The CI check reviews a pull request against a convention when at least one of its changed files matches; added, modified and deleted files count, and so does either side of a rename.

The H1 after the frontmatter is the convention's name, and the paragraphs after it are the statement. `Why:` and `Tooling:` paragraphs explain the convention and are not part of the statement. The CI check fails on a convention file without this format.
