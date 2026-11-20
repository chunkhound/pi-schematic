# Agent guide

- Before changing a file: [docs/conventions/](docs/conventions/), the conventions whose `paths` match it.
- To follow lifecycle hooks, state or package layout: [docs/architecture.md](docs/architecture.md).
- To trace how a tool or hook is wired: start at `index.ts`.
- To run tests, CI or a release: [CONTRIBUTING.md](CONTRIBUTING.md).

## Agent notes

None yet. A note belongs here only if all three hold:

1. It is specific to this repository.
2. A human following `CONTRIBUTING.md` never needs it, because it arises from how agents work: parallel runs, no memory between sessions, scripted probes.
3. It cannot be checked against the tree or a diff. If it can, it is a convention or a lint rule.
