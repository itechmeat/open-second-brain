# Self-Learning Skill Proposals - review-first procedural learning

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain currently learns durable user preferences from repeated correction signals, but it does not learn reusable procedures from repeated successful work patterns. The project also ships skills and runbooks as passive files; there is no Brain-native procedural index that can list them, track usage, or connect them to proposal/review history. Finally, repeated procedural knowledge across scopes is not counted as support, so the operator has to manually infer when a lesson has become broadly useful.

## Scope

- Add a deterministic self-learning skill proposal queue that scans Brain log/session-style events and writes reviewable Markdown proposal artifacts under `Brain/skill-proposals/`.
- Add accept/reject lifecycle commands that keep pending/rejected/accepted proposal history auditable and write accepted runbooks into a Brain-owned procedures area rather than mutating repo `SKILL.md` files.
- Add a procedural memory reconciler for Brain-owned procedures and installed skill/runbook roots, with metadata parsing, stale-entry pruning, and usage sidecar updates that do not rewrite source files.
- Add a small recurrence/support ledger for procedural/proposal knowledge, so same-scope duplicates and cross-scope recurrence become visible evidence before any future automatic promotion.
- Expose the workflow through focused CLI verbs and read/diagnostic MCP surfaces where useful.
- Cover detector, lifecycle, reconciliation, usage, recurrence, and integration behavior with tests.

## Out of scope

- Auto-activating generated skills in any runtime.
- Rewriting packaged `skills/*/SKILL.md` files from learned proposals.
- Replacing `dream` preference promotion or changing existing preference-learning thresholds.
- LLM summarization, embeddings, or network calls in the default proposal path.
- Full graph-export/entity integration for procedural entries beyond stable metadata and explicit relation/source fields in this release.

## Chosen approach

Use the consultant's Variant 1: three dream-adjacent modules with shared helper primitives instead of one unified engine. Skill proposals, procedural memory, and recurrence support each get a clear core module, storage contract, and CLI/test slice. Shared code should stay limited to path helpers, deterministic hashing/slugging, frontmatter parsing/rendering, and watermark/scan utilities.

## Design decisions

- **Keep proposals as Markdown artifacts.** Pending, accepted, and rejected proposals should be inspectable and editable in Obsidian, matching the rest of Brain's local-first model.
- **Accept writes Brain procedures, not active agent skills.** Accepted proposals become `Brain/procedures/proc-<slug>.md` runbook/reference artifacts. A future explicit install/promote workflow can copy or package them into runtime skills.
- **Keep `dream` unchanged.** Proposal learning is a companion scan command. It reads Brain log/continuity/session evidence but does not enter the deterministic preference mutation pipeline.
- **Use explicit status transitions.** Proposal files carry `status: pending|accepted|rejected`; commands move or rewrite only managed proposal/procedure files and append Brain log events for audit.
- **Make recurrence diagnostic first.** The recurrence ledger records support, scope recurrence, and reference decrement behavior, but does not auto-broaden scope or lock rules in this release.
- **Do not dirty source skill files on usage.** Procedural usage lands in a sidecar/ledger so installed `SKILL.md` and accepted procedure notes remain stable unless the operator edits them.

## File changes

Expected new or modified areas:

- `src/core/brain/skill-proposals.ts` - proposal artifact parsing, rendering, detection, lifecycle.
- `src/core/brain/procedural-memory.ts` - procedural metadata parsing/reconciliation/usage sidecar.
- `src/core/brain/recurrence.ts` - support ledger and reference-counted source accounting.
- `src/core/brain/paths.ts` - Brain path constants and constructors for proposals, procedures, procedural index, recurrence ledger.
- `src/core/brain/types.ts` - log event kinds or shared enums if needed.
- `src/cli/brain/verbs/*` and `src/cli/brain/help-text.ts` - CLI verbs for learning, proposal review, procedural listing/usage, recurrence diagnostics.
- `src/mcp/brain-tools.ts` and MCP tests - read/diagnostic surfaces for proposals/procedural entries if the implementation slice warrants them.
- `tests/core/brain/*`, `tests/cli/*`, `tests/mcp/*` - TDD coverage for each atomic unit.
- `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md` - docs once implementation is complete.

## Risks and open questions

- Detector quality can become noisy. The first slice should prefer deterministic, explainable, conservative detectors over broad heuristic matching.
- Recurrence support must not accidentally change existing preference semantics. Keep it opt-in/diagnostic until a later release proves the thresholds.
- Procedural roots must be explicit and safe. The reconciler should scan known roots or caller-provided roots, never arbitrary home directories by default.
- MCP surface count may require updating full-server tool listing tests if new full-scope read tools are added.
