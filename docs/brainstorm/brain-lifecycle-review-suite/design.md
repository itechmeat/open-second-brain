# Brain Lifecycle Review Suite - reviewed, validated, retained, and summarized Brain state

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain already captures signals, promotes preferences through `dream`, renders daily/weekly summaries, and reports basic discipline status. The missing surface is the lifecycle layer around those operations: pre-dream signal review, explicit artifact contracts, post-dream retention recommendations, monthly synthesis, and a warning when vault structure grows faster than actual thinking output. The selected kanban scope should ship those five capabilities without turning the deterministic core into a broad multi-phase rewrite.

## Scope

- Add a deterministic intent-review stage for active signal clusters, surfaced through a CLI/MCP read-only report and threaded into dream/review-candidates as structured audit data.
- Add package-local JSON Schema contracts for the new lifecycle envelopes and selected existing Brain boundaries, with lightweight validation where it keeps MCP/CLI outputs honest.
- Add a recommendation-only retention review over retired preferences and processed signals with `keep`, `improve`, `park`, and `prune` outcomes. It must not delete, move, or auto-restore artifacts.
- Add a monthly review projection over the existing temporal index, daily/weekly period helpers, and vault activity counters.
- Extend discipline reporting with a complexity-to-thinking metric that can surface productivity-trap warnings without hiding existing `ok/info/alert` semantics.
- Add focused core, CLI, MCP, and docs coverage for each shipped surface.

## Out of scope

- Full multi-phase `dream` rewrite (`t_1e4f70f5`).
- LLM-driven enrichment, due-date inference, or frontmatter mutation for user-authored notes.
- Background watchdogs, automatic rollback, or self-healing restore.
- Generic external memory ingest adapters.
- Destructive retention actions. This release only recommends actions and explains why.
- Heavy JSON Schema dependencies or a complete validator implementation for every JSON Schema keyword.

## Chosen approach

Use the refined Variant 3 from the consultant: a thin deterministic pre-review boundary plus independent lifecycle review pillars. The implementation keeps `dream` as the single mutating batch operation and adds pure helpers around it. Intent review becomes the first stage of the promotion decision model, but it preserves current default promotion outcomes by making existing threshold/conflict/suppression decisions explicit rather than introducing surprising new mutation behavior.

Retention and monthly review are read-only projections. Schema contracts are package artifacts plus a small local validator for the exact envelope shapes this release owns. Discipline complexity is a bounded heuristic added to `ActivitySummary` and report rendering; it may elevate a structurally noisy, low-thinking day to `alert`, but it does not demote existing alerts or mask taste-event success.

## Design decisions

- Keep mutation centralized in `dream`. New CLI/MCP tools for retention, monthly review, and intent review are read-only; `dream` may include intent-review data in its summary, but no separate tool writes Brain state.
- Treat intent review as explicit stage separation, not a new product policy engine. The first implementation classifies clusters as `ready_for_main_review`, `needs_more_evidence`, `blocked_conflicted`, or `suppressed_by_rejected_retired`; `planTopics` consumes that stage so future policy can evolve behind a tested boundary.
- Model retention recommendations as deterministic heuristics over current files and log evidence: recently useful retired artifacts are `keep`, low-evidence or stale entries are `park`, contradictory/noisy entries are `improve`, and duplicate or orphaned processed signals can be `prune` candidates. All decisions include reasons and source paths.
- Build monthly review on `TimelineIndex` and existing period helpers so daily, weekly, and monthly summaries share event semantics. The monthly envelope should include wins, patterns, decisions, advanced projects/goals when visible from events, neglected areas from configured watched/read paths, and a generated-at timestamp.
- Put complexity scoring in `src/core/discipline/complexity.ts`. The score should be transparent: folder depth, template/config churn, tag proliferation, and structural-file changes, compared against thinking output from Brain feedback/evidence/transitions.
- Keep JSON Schema contracts additive and visible. Static schemas live in a repo-level `schemas/brain/` directory and are referenced by tests and docs; lightweight validation supports only the subset needed by the new envelopes (`type`, `required`, `properties`, `items`, `enum`, `additionalProperties`).
- Keep CLI/MCP naming explicit: `brain intent-review`, `brain retention`, `brain monthly`, and MCP mirrors `brain_intent_review`, `brain_retention`, `brain_monthly_review`. Schema contracts can be exposed through a read-only `brain_schema_contracts` MCP tool and CLI verb if implementation remains compact.
- Preserve public JSON style: snake_case over MCP, CLI `--json` mirroring core envelopes, deterministic ordering for stable tests.

## File changes

Expected new files:

- `src/core/brain/intent-review.ts`
- `src/core/brain/retention.ts`
- `src/core/brain/monthly-review.ts`
- `src/core/brain/schema-contracts.ts`
- `src/core/brain/schema-validator.ts`
- `src/core/discipline/complexity.ts`
- `src/cli/brain/verbs/intent-review.ts`
- `src/cli/brain/verbs/retention.ts`
- `src/cli/brain/verbs/monthly.ts`
- Optional: `src/cli/brain/verbs/schema-contracts.ts`
- `schemas/brain/*.schema.json`
- Core/CLI/MCP tests for each new surface

Expected modified files:

- `src/core/brain/dream.ts`
- `src/core/brain/review-candidates.ts`
- `src/core/brain/types.ts`
- `src/core/discipline/decision.ts`
- `src/core/discipline/report.ts`
- `src/core/discipline/render.ts`
- `src/mcp/brain-tools.ts`
- `src/cli/brain.ts`
- `src/cli/brain/verbs/index.ts`
- `src/cli/brain/help-text.ts`
- `docs/cli-reference.md`
- `docs/how-it-works.md`
- `README.md`
- `CHANGELOG.md` in docs phase

## Risks and open questions

- The biggest risk is accidental behavior drift in `dream`. The guardrail is to write intent-review tests before integration and preserve current outcomes in existing dream tests.
- Complexity scoring can be noisy. The first version should expose raw factors and use conservative thresholds.
- Monthly review can only summarize what deterministic events reveal; it must not invent project/goal progress from unparsed prose.
- JSON Schema validation scope must stay small. If schemas become broad enough to need full draft support, defer full enforcement behind a future ADR.
- The combined PR is intentionally larger than a single feature. Keep commits atomic by surface so review remains tractable.
