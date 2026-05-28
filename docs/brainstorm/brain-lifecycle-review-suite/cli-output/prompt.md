You are brainstorming architectural variants for the following task set. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a multi-task Open Second Brain release scope. The implementation should ship a coherent Brain lifecycle review suite from five Hermes kanban tasks.

## t_6fa649b9 | priority=3

TITLE: [article] Retention lifecycle for completed artifacts with keep/improve/park/prune review

**Source**: [[Articles/How to Build a Hermes Agent That Finds Important Work and Builds It Autonomously]]
**Article excerpt**: "A build being finished does not mean it should live forever. Retention asks whether an artifact should be: keep, improve, park, prune. Retention is recommendation-only in the public extraction. It can recommend what should happen, but it does not silently delete or move live artifacts."

### What

A systematic post-processing review cycle that evaluates completed brain artifacts (preferences, signals, log entries) and decides their fate: keep (active), improve (needs enhancement), park (preserve but inactive), or prune (remove). Currently OSB has status transitions (confirmed/quarantine/retired) but no structured lifecycle review after an artifact has been processed.

### Why useful for OSB

As the vault grows, retired preferences and processed signals accumulate without systematic review. A retention pass would prevent vault bloat, surface preferences that could be improved with new evidence, and ensure that pruned artifacts leave an audit trail. The recommendation-only approach ensures safety - no silent deletion of live state.

### Status in OSB

- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/brain/dream.ts:703 (RetirePlan interface with slug/principle/reason/supersededBy, but no keep/improve/park/prune states); src/core/brain/dream.ts:191 (dream function handles promotion and retirement in single pass); src/core/brain/paths.ts:105 (processedSignalPath moves signals to processed/ but no further lifecycle management). No retention review mechanism exists.

### Notes

The upstream pattern separates retention from the build loop - it recommends but doesn't mutate. OSB could implement as a brain_retention tool that runs after dream, scanning retired/ and inbox/processed/ for candidates.

### Latest comment

osb-triage-validator @ 2026-05-27T11:28Z: sanity clean; no cluster; priority 3; not_in_osb_useful, concrete; recommendation-only brain_retention tool, clear scope, unblocked.

## t_929a1333 | priority=3

TITLE: [article] Monthly comprehensive life review across all vault file types

**Source**: [[Articles/How to Build an Obsidian System That Runs Your Entire Life From One Folder]]
**Article excerpt**: "On the first day of every month N8N triggers a comprehensive life review workflow. It reads all activity from the previous month across every file type. It generates a monthly summary covering wins, patterns, decisions made, projects advanced, and goals progressed. It identifies any life areas that received no attention in the previous month. The monthly review compounds into your weekly reviews. Over 12 months you have a documented record of exactly how your life and work evolved."

### What

A scheduled monthly workflow that reads all vault activity from the previous month, generates a structured summary covering wins/patterns/decisions/projects/goals, identifies neglected areas, and produces a compounding record that enriches weekly reviews.

### Why useful for OSB

OSB has brain_dream (nightly signal consolidation) and brain_digest (preference summaries), but no periodic higher-order review that looks at the full vault holistically. A monthly review would surface long-term patterns and neglected areas that daily/weekly passes miss, and create a documented evolution record.

### Status in OSB

- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/discipline/decision.ts:15 (ActivitySummary interface); src/core/discipline/activity-git.ts:5 (ActivityWindow); src/core/discipline/activity-mtime.ts:17 (mtimeActivity); src/core/discipline/vault-delta.ts:39 (vaultDelta); src/core/brain/digest.ts (renders digests but scoped to preferences only, not full vault content). No monthly review mechanism exists.

### Notes

The upstream monthly review compounds into weekly reviews. OSB could implement as brain_monthly_review that reads vault content (not just Brain/ preferences) and generates a summary note. The ActivityWindow/ActivitySummary interfaces in src/core/discipline/ provide building blocks.

### Latest comment

osb-triage-validator @ 2026-05-27T11:28Z: sanity clean; no cluster; priority 3; not_in_osb_useful, read-only monthly review built on existing ActivityWindow/ActivitySummary and digest; clear output, unblocked.

## t_03752ca6 | priority=3

TITLE: [article] Vault complexity-to-thinking-activity ratio for productivity-trap detection

**Source**: [[Articles/Most Obsidian Beginners Accidentally Turn Their Vault Into a Productivity Trap]]
**Article excerpt**: "You spend more time redesigning your vault than actually using it. That single sentence explains why so many people quietly abandon Obsidian after a few weeks. The system became heavier than the thinking. And that's the opposite of what a second brain is supposed to do. A great vault should reduce friction. Not create more of it."

### What

A metric that compares vault structural complexity (folder depth, number of templates, tag proliferation, plugin count) against actual thinking output (preferences created, signals logged, connections formed) to detect when vault overhead exceeds productive use. When the ratio tips too far toward structure-over-substance, surface a warning in the discipline report.

### Why useful for OSB

OSB's discipline report already tracks vaultDelta (new signals, preferences, retired) and activity signals (commits, modified files). Adding a complexity-vs-activity ratio would extend the discipline report to catch the "productivity trap" early: a vault where the agent spends more cycles on vault organization than on generating or recording actual thinking. This maps directly to the existing decideStatus infrastructure in src/core/discipline/decision.ts.

### Status in OSB

- **Verdict**: present_weaker
- **Codegraph hints**: src/core/discipline/vault-delta.ts:5-47 (VaultDelta interface and vaultDelta function track new files by type); src/core/discipline/decision.ts:39-60 (decideStatus compares taste events vs activity signals); src/core/discipline/report.ts:33-87 (runDisciplineReport assembles the full report). No complexity metric or structure-vs-thinking ratio exists.

### Notes

The existing discipline report detects "activity present but zero brain events" (alert status). The extension would detect "high structure churn but low thinking output" - a different failure mode. Implementation could add a complexity_score to ActivitySummary (counting folder creates, template edits, config changes) and compare against vaultDelta thinking signals in decideStatus.

### Latest comment

osb-triage-validator @ 2026-05-27T11:28Z: sanity clean; no cluster; priority 3; present_weaker, extends discipline decideStatus with a complexity-vs-thinking metric; concrete and bounded.

## t_05cb41d7 | priority=2

TITLE: [article] Schema-gated artifact chain with JSON Schema validation for brain pipeline stages

**Source**: [[Articles/How to Build a Hermes Agent That Finds Important Work and Builds It Autonomously]]
**Article excerpt**: "The buildroom forces the system to separate research, ideas, reviews, plans, builds, verification, trust, retention, and operator reporting. In the buildroom, this exists as: schemas/research-input.schema.json, schemas/idea-contract.schema.json, schemas/intent-review.schema.json, schemas/main-review.schema.json, schemas/product-plan.schema.json, schemas/build-plan.schema.json, schemas/verification-report.schema.json, schemas/trust-report.schema.json, schemas/retention-review.schema.json, schemas/operator-summary.schema.json"

### What

JSON Schema validation files for each stage of the brain pipeline, ensuring that intermediate artifacts (brain_feedback input, dream output, preference transitions, log events) conform to explicit contracts. Currently OSB validates frontmatter structure but doesn't enforce JSON Schema contracts on the data flowing through brain operations.

### Why useful for OSB

Schema-gated artifacts would catch malformed brain_feedback submissions, invalid dream outputs, and inconsistent preference transitions before they land in the vault. This would make brain_doctor's job easier (fewer structural errors to detect) and provide clearer error messages when agents submit invalid data. The buildroom pattern of separate schemas per pipeline stage maps well to OSB's existing tool boundaries.

### Status in OSB

- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/brain/dream.ts:191 (dream function produces DreamRunSummary interface but no schema validation on output); src/core/brain/preference.ts (preference interface with status field but no JSON Schema enforcement); src/mcp/brain-tools.ts (MCP tool definitions accept parameters without schema validation). No JSON Schema registry or validation layer exists.

### Notes

The upstream buildroom ships schemas as separate .schema.json files in a schemas/ directory. OSB could implement similarly: a Brain/schemas/ directory with schema files for each brain operation, validated at the MCP tool boundary.

### Latest comment

osb-triage-validator @ 2026-05-27T11:28Z: sanity clean; no cluster; priority 2; not_in_osb_useful JSON-Schema registry across pipeline stages; design-heavy per-stage contracts, needs an ADR.

## t_ef94345e | priority=2

TITLE: [article] Two-stage signal review gate separating weak-signal filtering from approval decisions

**Source**: [[Articles/How to Build a Hermes Agent That Finds Important Work and Builds It Autonomously]]
**Article excerpt**: "The buildroom has both intent review and Main review. Intent review is the early filter. It checks whether the idea is ready to become a contract-backed candidate. The main review is the approval gate. A real Main review exists in the demo room: decision: approved_for_coder, risk_band: low, risk_score: 3, auto_approved: false, force_approved: false, block_reason: null"

### What

A two-stage promotion pipeline: stage one (intent review) filters weak or unsafe signals before they become candidates, stage two (main review) makes the actual approval decision with risk assessment. Currently OSB dream pass does both signal clustering and preference transitions in a single pass without separating the filtering stage from the approval stage.

### Why useful for OSB

A two-stage gate would improve signal quality: weak signals get filtered early without consuming the full dream pass budget, and approval decisions get explicit risk scoring. The upstream pattern shows structured review artifacts (intent-review.json, main-review.json with decision/risk_band/risk_score/auto_approved fields) that provide audit trails for why a signal was promoted or rejected.

### Status in OSB

- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/brain/dream.ts:746 (planTopics function handles both signal clustering and transition planning in one pass); src/core/brain/dream.ts:191 (dream function runs the entire pipeline without stage separation). src/core/brain/backlinks.ts:170 (collectSignals gathers signals but doesn't filter them before dream processing). No two-stage review gate exists.

### Notes

The upstream intent-review + main-review separation could map to OSB as: stage 1 filters signals by evidence quality and topic relevance before dream, stage 2 runs the actual preference promotion with risk scoring. This would make the dream pass more efficient and provide better audit trails.

### Latest comment

osb-triage-validator @ 2026-05-27T11:28Z: sanity clean; no cluster; priority 2; not_in_osb_useful two-stage review gate restructures the single-pass dream into intent + main review; architectural, needs design.

# Project context

Project: Open Second Brain, TypeScript/Bun CLI and MCP server, deterministic filesystem-first Brain memory layer over an Obsidian-compatible Markdown vault.

Recent commits:

- 9b87838 (HEAD -> main, tag: v0.16.0, origin/main, origin/HEAD) v0.16.0 - Agent boundary control surfaces: pinned context, Markdown links, MCP output contracts (#43)
- 66980b2 ci: drop bun version floor, track latest only (#42)
- feca6a7 (tag: v0.15.0) v0.15.0 - Cross-agent query foundation: source-agent provenance retrieval and comparison (#41)
- ffde4ac (tag: v0.14.1) chore(release): v0.14.1 (#40)
- bc97b38 refactor: add validation toolchain and normalize project formatting (#39)
- b76199a (tag: v0.14.0) v0.14.0 - Semantic Brain Health and Self-Maintenance: contradiction detection, concept gaps, stale claims, edit-history, remediation (#38)
- 2147640 (tag: v0.13.0) v0.13.0 - Hybrid Search and Recall Quality: explainable recall, MMR, link traversal, entity boost, header anchoring (#37)
- 84886d1 (tag: v0.12.0) v0.12.0 - Brain Integrity Suite: typed collision detection, content-hash drift, durable dream workruns (#36)
- c002268 (tag: v0.11.0) v0.11.0 - Brain-centric vault layout: one agent-owned root, opt-in user notes (#35)
- a8d4803 (tag: v0.10.18) v0.10.18 - temporal axis: timeline, belief evolution, stale watch, daily brief, weekly synthesis (#34)

Related files:

- src/core/brain/dream.ts - deterministic batch writer; DreamRunSummary already carries warnings/quarantined/gated_retires.
- src/core/brain/review-candidates.ts - read-only dry-run projection over dream; existing preview boundary for candidate review.
- src/core/brain/paths.ts - canonical Brain/ path helpers.
- src/core/brain/preference.ts - preference/retired parser and writer.
- src/core/brain/types.ts - Brain artifact, config, and event type contracts.
- src/core/brain/log.ts and src/core/brain/log-jsonl.ts - append-only audit trail and JSONL sidecar.
- src/core/brain/temporal/build-index.ts - timeline index over Brain log and retired frontmatter.
- src/core/brain/temporal/daily-brief.ts and weekly-brief.ts - read-only period summaries that monthly review can mirror/extend.
- src/core/discipline/decision.ts - discipline status decision over BrainEventCounts + ActivitySummary.
- src/core/discipline/report.ts - daily discipline report assembly.
- src/core/discipline/vault-delta.ts - counts new signals/preferences/retired in a window.
- src/mcp/brain-tools.ts - MCP tool definitions and handlers.
- src/cli/brain.ts, src/cli/brain/verbs/index.ts, src/cli/brain/help-text.ts - CLI brain verb wiring.
- tests/discipline/decision.test.ts, tests/discipline/report.test.ts - existing discipline report coverage.
- tests/mcp/brain-review-candidates.test.ts - existing review candidate MCP smoke test.
- tests/core/brain.doctor.test.ts, tests/cli/brain-health.test.ts - existing health/doctor patterns.

Conventions:

- The core must remain deterministic and dependency-light. No LLM calls inside core helpers.
- Brain writes are limited to Brain/; user-authored notes outside Brain/ are read-only and opt-in through config.
- Mutating CLI operations that touch Brain/ normally take snapshots or provide dry-run previews; read-only tools are preferred for autonomous agent surfaces.
- Public docs should use the full project name "Open Second Brain" rather than abbreviations.
- CLI read verbs should support --json where practical, mirroring MCP shapes.
- MCP tool outputs are structured JSON envelopes; recent releases add explicit output contracts for core agent-facing tools where useful.
- Tests are Bun tests under tests/; project verification commands are `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run sync-version:check`.
- Versioning follows Semantic Versioning and Keep a Changelog; latest package version is 0.16.0.

Constraints:

- Prefer a coherent release of at most 5 features from the selected tasks.
- Do not silently delete, move, or auto-restore live artifacts for retention; recommendation-only is required.
- Avoid a full rewrite of dream into a large multi-phase engine unless strongly justified.
- Avoid adding heavy external dependencies for JSON Schema if a small local validator or schema emission contract is enough.
- Preserve existing public APIs unless an additive field/tool/verb is the smaller safer path.
- Keep new logic TDD-friendly: pure core helpers first, then CLI/MCP wrappers.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

## Variant N: <short name>

- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

## Recommended: Variant N

**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
