You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

An 11-unit feature wave for Open Second Brain themed "belief lifecycle and decision memory". The variants requested are for the wave architecture as a whole (where to put shared abstractions vs isolated per-unit changes), not for the worth of individual units. The units:

1. `t_3ba9c404` (p3) - Atomic temporal fact-replacement: close an open fact and open its successor at one shared timestamp instant, half-open valid_from/valid_to intervals at timestamp precision (whole-day semantics preserved for date-only facts). Distinct from the existing conflict-resolution supersede (winner-picking only). Reuse the `superseded_by` relation as the successor link; scope to the temporal-boundary layer only.

2. `t_347e8224` (p3) - Preserve conversation chronology: retain each transcript turn's authored time as `authored_at`, surface it in search results, break exact hybrid-score ties in favor of more recently-authored content, add since/before time bounds to list. Idempotent dry-run-first backfill for existing vaults, no re-embedding.

3. `t_6916369f` (p3) - Unify temporal/supersession/contradiction into one persisted claim-graph query surface: a bounded, persisted projection OVER existing relations (superseded_by, contradicts) and bi-temporal validity fields (valid_from/valid_until derived in dream), answering "what is true now / what used to be true / what replaced it / what contests it" in one query. Current-truth default, opt-in history. Not a rewrite of extractors. Surface provenance per claim.

4. `t_7d5a3589` (p2) - General cross-type soft-delete (tombstone) + supersession lifecycle: idempotent tombstone via Markdown frontmatter status + reason + timestamp (re-issue is a no-op), supersede with replacement tracking, generalized beyond the claim ledger to preferences/signals/learnings. Curator read slices over observed-use verdicts (injected-never-used, contradicted, high-used) through the existing read surface. Tombstoned/superseded entries excluded from recall but preserved for audit; wired into dream/compaction.

5. `t_d9365884` (p2) - Supersedes-chain consumer policy over general memory driving three behaviors: inject prefers chain tips under budget (unless the query is explicitly historical), recall annotates superseded items with a pointer to their replacement, decay accelerates for low-recall superseded items. Acceptance: a chain of 3 superseding memories injects only the tip by default, surfaces replacement pointers on recall, retires low-recall ancestors on the dream pass.

6. `t_0e3f2bee` (p3) - Persist detected contradictions as first-class tension objects: deterministic Markdown notes with a state machine (open -> confirmed/dismissed/resolved) in frontmatter, plus an injection-time warning when subject notes of an unresolved tension enter a context pack. Lifecycle object is the higher-value half and can ship first.

7. `t_ac03214d` (p3) - Decision-record artifact: capture a decision with its assumption, scheduled review_date, and outcome backfilled when known; review_date opens an obligation; on a new decision, surface historically-similar past decisions and their outcomes via existing search/similarity. Optional pre-mortem field.

8. `t_6fe43fcc` (p3) - Rated decision capture separate from memory facts: human-triggered surface storing decisions, ratings, and rationale apart from ordinary signals; searchable and comparable. Focused on the rated searchable engine, not the artifact format (that is unit 7).

9. `t_5712fa39` (p3) - Recall rated past decisions verbatim into live sessions on matching prompts, governed by per-session injection caps and spacing rules. Builds on existing injection + observed-use + trust rating; the missing piece is prompt-match -> verbatim-resurface plus the cap/spacing governor.

10. `t_e112c63c` (p3) - Commitment-tier vocabulary: optional four-value decision-commitment axis (exploring/leaning/decided/locked) distinct from confidence, set on decision-tracking memories (preferences, declared-thesis entries), rendered in injected/context-pack text as the tier label; round-trips through frontmatter without breaking confidence-band display when unset.

11. `t_3547314d` (p3) - Decision-change receipts: a `decision_change.v1` receipt recording before, after, evidence triggers, confidence delta, alternatives, actor, rationale, reason code at the moment a belief/preference changes; durable idempotency keys; history query with pagination. Hidden chain-of-thought fields rejected - only accountable provenance. Natural home alongside the supersession/dream pipeline.

Cross-unit observations to weigh: units 1, 3, 4, 5 all touch supersession (`superseded_by`); units 7, 8, 9, 10, 11 form a decision-memory family; unit 6 (tensions) and unit 3 (claim graph) both consume contradiction relations; units 5 and 9 both modify injection; unit 2 is search/chronology-only. The wave ships as ONE release (v1.33.0) on one branch with per-unit atomic commits.

# Project context

Open Second Brain (o2b): TypeScript on Bun, CLI (`o2b`) + MCP server over an Obsidian-compatible Markdown vault; bun:sqlite + optional sqlite-vec for search; deterministic kernel - no LLM calls in core. Vault is synced peer-to-peer (Syncthing), no git transport.

Recent commits:
- 61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
- 9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0) (#139)
- f2a037eb feat: today operator surface - dashboard, open loops, marker write-back (v1.31.0) (#138)
- 13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
- fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)

Related files (verified on main):
- Supersession: src/core/search/enrich.ts:23 SUPERSEDED_RELATION="superseded_by" (:116 stamps superseded flag on hits); src/core/search/types.ts:611-613 and :856-859 document demote-predecessor/boost-successor and contradicts warning reasons; src/mcp/brain/knowledge-tools.ts:352 renders superseded_by, :704 current-truth slots; src/core/brain/portability/graph.ts:35 RELATION_FIELDS includes contradicts + superseded_by; src/core/brain/preference.ts:256 superseded_by field.
- Truth ledger (append-only): src/core/brain/truth/store.ts appendClaimEvent:89, readClaimEvents:129, TruthState:266/319, sweep:350, cap CLAIM_EVENT_MAX_COUNT=10000; grounding.ts GroundingScore:61 bandFor:100 (bands strongly_supported|mixed|contested|contradicted).
- Contradiction detection: src/core/brain/health/contradiction.ts detectNoteContradictions:200, deriveNoteStance:154. Declared-thesis register: src/core/brain/health/thesis.ts (Brain/theses/thesis-<slug>.md, ThesisPage:70, ThesisError:68, stale/graveyard detectors).
- Bi-temporal validity: dream-plan.ts:132-133 valid_from/valid_until; dream.ts:458-459 emission, extractTemporalValidity:1308; dream-refresh.ts freshness_trend:53.
- Injection loop: inject-failopen.ts; observed-use.ts OBSERVED_USE_VERDICTS USED|IGNORED|CONTRADICTED:25 (deterministic token-echo/stance heuristics, persisted as recall_observed_use events); trust/self-approval-guardrail.ts; recall gate src/mcp/search-tools.ts toolBrainRecallGate:662; recall-telemetry.ts.
- Injected text: src/core/brain/active.ts regenerateActive:94 renders confidence band + numeric tail; context-pack.ts packContext:286 ContextPackItem:70; preference.ts confidence band:130 + confidence_value:132-137 (Wilson x freshness).
- Obligations: obligations.ts ObligationPage:61 (cadence:64, completions:74, nextDueDate:172, ObligationError). Attributes: attributes.ts assignNoteAttribute:129, validateAttributeAssignment:69.
- Session import: sessions/import.ts importSession/importSessionPath; resolveEventInstant:122 ALREADY preserves turn timestamp into created_at/recorded_at/valid_from bi-temporal slots; session_grep in src/mcp/brain/recall-tools.ts + core session-recall.ts - NO since/before created_at filter on the query surface today; search fusion src/core/search/fusion.ts rrfFuse DEFAULT_RRF_K=60, ranker.ts tierByDoc:39; src/core/search/time-range.ts exists for search-side time parsing.
- Provenance: provenance/provenance.ts ProvenanceLevel stated|deduced|inferred:41, provenanceTrustRank:69, Provenance:74, sourceIdentityHash:91. Git decision mining: git/decisions.ts detectDecisionSignals:37, mineCommitDecisions:110.
- v1.32.0 write path (fresh on main): src/core/brain/gates/durability.ts classifyDurability:191 (+config durability.denylist); src/core/brain/pending.ts (write_approval.enabled staging, apply/reject); signal-retire.ts retireSignal:97; write-advisory.ts adviseIncomingFeedback:103; snapshot-gate.ts withDestructiveSnapshot:87.
- Registration: CLI = switch dispatcher src/cli/brain.ts + thin verbs src/cli/brain/verbs/*.ts + data-only help-text.ts; MCP = frozen ToolDefinition[] slices (src/mcp/brain/*-tools.ts) assembled by src/mcp/tools.ts buildToolTable:319.
- Idea lineage: idea-lineage.ts transitionStage:296 (creation|promotion|retirement -> observation|synthesis|conclusion).
- Log event kinds: src/core/brain/types.ts BRAIN_LOG_EVENT_KIND:158 (~27 kinds; new belief/decision event kinds extend this one const object); daily files Brain/log/<date>.md.
- Decision surfaces today: RECONCILE_DOMAIN.decisions (types.ts:363, never auto-resolved operator bucket); git-mined decision signals; idea-lineage conclusion stage. NO dedicated decision note type exists - greenfield, but should reuse the decisions reconcile domain and lineage stage mapping.

Conventions:
- Typed errors per subsystem (SearchError codes for search/embeddings; typed brain-side rejections for vault writes); no silent fallbacks, no stubs; errors surface explicitly.
- Config keys resolved through src/core/config.ts helpers with env overrides; constants extracted, no magic literals.
- One-directional layering restored in v1.30.1 (no import cycles); shared choke points over scattered per-call-site checks.
- Language-agnostic classification only: structural signals, config-supplied vocabularies, no built-in natural-language word lists.
- Markdown vault is the source of truth; frontmatter carries typed fields; destructive operations go through the v1.32.0 snapshot gate (withDestructiveSnapshot).
- Every unit lands as one atomic conventional commit with its tests, formatted (oxfmt) and lint-clean (oxlint).

Constraints:
- Do not change existing public CLI/MCP APIs incompatibly; additive surfaces only.
- No new external dependencies.
- No LLM calls in the deterministic kernel (prompt-matching for unit 9 must be deterministic, e.g. token/anchor matching).
- The vault has no git; any history/receipt store must be Markdown/JSONL native and Syncthing-safe.
- Preserve byte-identical behavior for vaults that do not opt into new fields.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
