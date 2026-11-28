# Ubiquitous Language

This is the living glossary of the project's agreed vocabulary: the terms the code, docs, UI copy, and tests should use for the same concept. It follows the Domain-Driven Design "Ubiquitous Language" practice — one meaning per term _within a bounded context_, with cross-context collisions flagged as seams rather than silently tolerated.

## How to contribute

- Add a row when a feature introduces a concept or renames an existing one.
- Prefer the identifier actually used in code (a constant, type, or function name) as the term; note user-facing copy that intentionally differs.
- If a term has more than one meaning in different parts of the codebase, keep one row per meaning and mark the collision as a **seam** — do not merge the rows.
- Keep the glossary small. If a term is obvious and unambiguous, it probably does not need a row.
- Link the code identifier in the row when it helps a reader jump to the definition.

## Bounded contexts

### Handoff (BC1)

The handoff lifecycle: a deliberate context pivot via compaction. A staged request is cut at `turn_end` into a boundary (cut + successor + note + notebook discard drafts), the successor continues the run, and the watchdog enforces a pending request until it is called, reset, or the attempt budget is exhausted.

| Term                                       | Meaning (as used in this context)                                                                                | Notes                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| handoff                                    | The tool, `/handoff` command, and lifecycle for a deliberate context pivot                                       | Same word names the tool (`HANDOFF_TOOL_NAME`), the command, and the module. Avoid the verb form "hand off" in code identifiers                       |
| cut                                        | The compaction boundary: a `SessionEntry` written at `turn_end`, identified by `details.handoffId`               | Always paired with the successor; a cut without its successor fails the handoff                                                                       |
| successor                                  | The post-cut continuation turn                                                                                   | Its message must persist after the cut with no later compaction                                                                                       |
| staged / submitted / declined              | Phases of `StagedHandoff`                                                                                        | "staged" is also used loosely for the whole request slot; a declined request carries a `declineReason` (abort / error / missing result)               |
| nextInstruction                            | The instruction carried into the next context, delivered verbatim                                                | A human `/handoff <direction>` wins; otherwise the model supplies it                                                                                  |
| context                                    | The model-owned situational remainder, distinct from the instruction                                             | Not the pi `ExtensionContext`, and not the context-window usage                                                                                       |
| continuation frame                         | The fixed opening text of the successor turn                                                                     |                                                                                                                                                       |
| discardPages / discardedPages              | The notebook pages drafted (`discardPages`) vs committed (`discardedPages`) for removal with the cut             | Written transactionally as part of the boundary                                                                                                       |
| requested / required                       | The two surface states of the sticky contract                                                                    | "requested" until the context is eligible; "required" once eligible and ready to compact (see `HANDOFF_REQUESTED_STATUS` / `HANDOFF_REQUIRED_STATUS`) |
| eligible                                   | The qualifier deciding whether a pending request is enforceable: context usage at or above ~30k tokens           | `isHandoffEligible` gates both the required status and the readonly boundary promotion                                                                |
| RequestedHandoff / pendingRequestedHandoff | The sticky contract object (state field) covering both requested and required states                             | Known naming debt: the field name covers both surface states — see "requested / required" above                                                       |
| enforcementAttempts                        | Settled runs counted while a handoff is still owed and the eligible nudge was delivered without calling the tool | Budget: `MAX_HANDOFF_ATTEMPTS` (5)                                                                                                                    |
| refusal                                    | A handoff call blocked before executing (not the same as a declined request)                                     | Rules: handoff must be the only tool call in its message; only the first call runs; no call after a failed cut in the same run                        |
| note                                       | The hidden `pi-schematic-handoff-note` message saying the system prompt is stale until the next run starts       |                                                                                                                                                       |
| compaction                                 | The transcript-replacement mechanism; the handoff's cut is a compaction entry                                    | "compaction" is also a pi-level concept; the handoff cut is the specific case                                                                         |
| pivot                                      | The model-facing word for a topic change or handoff recommendation ("a real pivot")                              | Appears in watchdog copy and the system prompt, not in code identifiers                                                                               |

### Other contexts (pending curation)

The remaining bounded contexts — Notebook, Spawn, Model Groups, Readonly, Advisory steering (watchdog), and Prompt/extension hosting — have draft glossaries in the DDD audit (report §6) but are not yet curated into this document. Known cross-context seams to split when they are added: `boundary` (handoff cut / notebook topic hint / readonly promotion), `epoch` (notebook generation vs child-session generation), and `topic` (semantic frame / prompt-section name / TUI status key).
