# pi-agenticoding

[![pi.dev package](https://img.shields.io/badge/pi.dev-package-purple)](https://pi.dev/packages/pi-agenticoding)
[![npm version](https://img.shields.io/npm/v/pi-agenticoding?logo=npm)](https://www.npmjs.com/package/pi-agenticoding)
[![CI](https://github.com/agenticoding/pi-agenticoding/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/agenticoding/pi-agenticoding/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> A composable workflow layer for [Pi](https://pi.dev). Define task-specific workflows in saved prompts or skills, with declarative policy, short-lived shared memory, provider-independent delegation, and deliberate context boundaries.

**Give each task the workflow it needs: the right models, memory, permissions, and context boundaries.**

## Quick start

Requires [Pi](https://pi.dev) 0.84.1 or later and Node.js 22.19.0 or later.

```bash
pi install npm:pi-agenticoding
```

To let **handoff** own deliberate restarts, disable Pi's built-in compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": { "enabled": false }
}
```

You now have `spawn`, notebook, and `handoff` tools; `/model-groups`, `/readonly`, `/notebook`, and `/handoff` commands; and status indicators for context pressure, notebook state, topic, and readonly posture.

## Repeat the workflow, not the steering

Coding agents can research, implement, and review, but operators still have to define which specialists to involve, which models fill those roles, what may modify the tree, and which decisions must survive noisy exploration.

pi-agenticoding moves that procedure into saved prompts or skills. Model Groups keep roles independent of provider choices, `spawn` isolates specialist work, the notebook carries only canonical decisions, and `handoff` starts the next phase without dragging forward the transcript.

## Example: make critical review repeatable

Save a readonly review procedure as `.pi/prompts/review.md`, so every changeset receives the same evidence requirements, review dimensions, and scope discipline.

<details>
<summary><strong>View the complete critical-review workflow</strong></summary>

``````text
---
description: Critical code review before committing changes
argument-hint: "[description of intended changes]"
readonly: true
model-group: review
---
You are the project maintainer and an expert code reviewer.

The intent behind the changes in the working tree was:
`````
$@
`````
Analyze the current changeset:

- Explain what was done and how, and why based on the git changes
- Include exact files and line numbers supporting your claims

Think step-by-step through each aspect below, focusing solely on the changes in the working tree.

1. **Architecture & Design**
   - Verify conformance to project architecture
   - Check module responsibilities are respected and contracts aren't violated
   - Ensure changes align with the original intent and that invariants are maintained
   - Consider the scope the changes touch at, library, user facing, etc and review with this context in mind
2. **Code Quality**
   - Code must be self-explanatory and readable
     - Verify high quality comments for non-obvious patterns
     - Complete docs comments for public APIs
   - Style must match surrounding code style. Check related files and verify continuity and consistency
   - Changes must be minimal - nothing unneeded
   - Follow KISS principle
   - Conformance to surrounding architecture
3. **Maintainability**
   - Optimize for future LLM agents working on the codebase
   - Ensure intent is clear and unambiguous
   - Verify comments and docs remain in sync with code
   - Verify documentation is present inline when necessary
   - Reuses as much as possible from existing code
4. **User Experience**
   - Identify areas where extra effort would significantly improve UX
   - Balance simplicity with meaningful enhancements
5. **Tests**
   - Spawn an agent to research the current test coverage then search the web for industry best practices for testing external invariants, constraints, and user-facing contracts so tests are stable across refactors, shareable, and run reliably in CI. Verify tests are up to standards.
6. **Logging and Observability**
   - Verify that the logs available truly add operative value to the end user and don't pollute for little value.
7. **Scope** - are there additions, removals or changes not mentioned in the above intent?

**REMEMBER, the review has multiple dimensions: tech debt, correctness, and effects on the user**

Review the changes critically. Focus on issues that matter. Stay within the current scope of the changes, do NOT expand the scope. DO NOT EDIT ANYTHING - only review.

If you spawned agents, wait until all agents complete. Finally, spawn a final agent to independently review all findings.
``````

</details>

Configure the `review` role once with `/model-groups`, then invoke the workflow with the intended change:

```text
/review parser refactor and test cleanup
```

**Result:** one command applies the same review dimensions, delegated test research, and independent final pass to every changeset. The prompt owns the stable procedure; the `review` group owns the replaceable model choice.

Pi expands `$@` into the supplied intent and starts the parent reviewer with the workflow's model role and readonly posture. The parent can route focused `spawn` calls to specialist roles, wait for their condensed findings, and perform the final synthesis. Children cannot spawn or handoff, so orchestration stays with the parent.

## How it works

| Part | Role in the workflow |
|---|---|
| **Saved prompts and skills** | Define reusable procedures and frontmatter policy for review, migration, debugging, research, or project-specific work. |
| **Spawn** | Runs focused sub-agents in clean contexts without adding their full transcripts to the parent. Children inherit cwd, readonly posture, active registered parent tools executable in the child session, including MCP/extension tools such as ChunkHound, and child-local notebook tools; they cannot spawn grandchildren or handoff. |
| **Model Groups** | Map semantic roles to replaceable provider/model pools, globally or per project. |
| **Notebook** | Carries canonical decisions and constraints across parent, children, and handoffs, then disappears with the work stream. |
| **Handoff** | Starts the next phase with a directed prompt instead of a noisy transcript. |

This pattern scales from critical review to separate research, implementation, migration, and debugging passes.

## Why use it

- **Repeat expertise, not steering** — version the procedure and constraints instead of rebuilding them in conversation.
- **Change models without changing workflows** — prompts name roles; Model Groups hold provider/model choices.
- **Add perspectives deliberately** — role-specific passes can use different model families, reducing dependence on one family's blind spots and [self-preference](https://arxiv.org/abs/2404.13076). Provider diversity is only a proxy for model-family and training-pipeline diversity.
- **Preserve decisions, not transcripts** — the short-lived notebook keeps canonical state while `spawn` and `handoff` protect the parent context. See [why agent-managed context](docs/why.md).

## Compatibility and limits

| Area | Current behavior |
|---|---|
| **Runtime** | Requires Pi 0.84.1+ and Node.js 22.19.0+. Spawn passes the selected public model into a child-owned runtime. Persisted, environment-based, and extension-rediscoverable provider/auth configuration is available; parent-only transient credentials, inline provider factories, and in-memory catalog changes may not be. Resolution failures are explicit and never silently select another model. |
| **Frontmatter** | `model: <provider>/<model-id>` overrides `model-group`; `thinking: off|minimal|low|medium|high|xhigh|max` is capability-clamped and overrides group thinking; `readonly` is boolean. Interactive model selection runs at idle input, while readonly is deferred to `before_agent_start`. Model/thinking changes are sticky. Failed or streaming selection blocks expansion; headless/RPC invocations ignore this policy. |
| **Group routing** | A known group samples uniformly **with replacement** from authenticated, usable entries, so repeated calls may select the same model. Unknown spawn groups visibly fall back to the parent; known groups with no usable entries fail before child creation. There is no weighting, no-repeat selection, health routing, retry/failover, or optimizer. |
| **Context and cache** | Spawn creates a separate child context; handoff starts a new input prefix. A model/provider switch starts a different cache—the extension creates cache-aware boundaries, not cache preservation or provider cache configuration. |
| **Delegation** | Children return condensed results and cannot spawn or handoff. There is no worktree isolation or per-child granular tool policy. |
| **Memory** | Notebook pages are branch- and work-stream-scoped, survive handoff, and clear with `/new`; they are not forever memory. Handoff can transactionally discard stale pages. |

## Readonly and security

Readonly blocks write/edit and guards bash while researching; children inherit the posture. macOS uses `sandbox-exec`; Linux uses `bwrap` when available, otherwise only the command classifier remains. Windows is classifier-only. Interpreters and indirection can bypass classification. **Readonly is a coding guardrail, not a hardened security boundary.**

Toggle it with `/readonly`, `Ctrl+Shift+R`, `--readonly`, or workflow frontmatter. Skills and prompts can instruct models to run code and use tools, so review workflow files before trusting them.

## Documentation and help

- [Why agent-managed context](docs/why.md)
- [Architecture and exact lifecycle behavior](docs/architecture.md)
- [Changelog](CHANGELOG.md)
- [Questions, bugs, and feature requests](https://github.com/agenticoding/pi-agenticoding/issues)
- [Pi package page](https://pi.dev/packages/pi-agenticoding)
- [Agentic Coding](https://agenticoding.ai) — companion methodology

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project workflow and quality expectations.

## License

MIT — see [LICENSE](LICENSE).
