You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave for Open Second Brain: "knowledge intake and consolidation". Eight kanban tasks ship together as one PR, in two sub-themes.

A. Intake: new content reaches the vault
1. t_f8f5ef6a (p4) Inbound Telegram journal bot for phone capture plus a /catchup flow. Today the Telegram integration is outbound-only (src/core/discipline/telegram.ts delivers discipline reports, src/cli/discipline-install.ts). Add the inbound path: captures sent to a bot land in the vault Brain staging area, /catchup replays what the operator missed. Reuse the existing MarkdownV2 escaping and token/config plumbing in telegram.ts. Constraint: no new external dependencies, so the bot transport is plain HTTPS long-polling (getUpdates) via fetch under an explicit runner command, not a webhook server framework.
2. t_b0bba8cb (p3) Scheduled inbox-drain pass that classifies and routes each capture: walk the inbox staging area, classify each raw capture (source-reference vs atomic idea vs task/obligation), route it (ingest as a source page via src/core/brain/ingest/ingest.ts:77 ingestSource, create or merge a note, or open an obligation), archive the processed capture, and emit a per-item report of what was created and why. Must be a reviewable report-then-apply pass like the dream pass. Classification must be structural (frontmatter, markers, URL shape), never natural-language word lists. Anchor: src/core/brain/governance/forget-plan.ts:109 already distinguishes inbox vs processed kinds.
3. t_1dcbf352 (p3) Keyed env-gated pluggable web-research providers (Brave Search, Tavily) feeding the research pool, plus a full-page extract step. The research pipeline (src/core/brain/research/research.ts, types ResearchFinding / ResearchReportInput, strict no-uncited-claims constraint) is provider-agnostic but ships no bundled sources. Providers join the pool only when their API key env is set (TAVILY_API_KEY, BRAVE_API_KEY), keyless pool degrades gracefully, plain HTTP with Bearer auth and a shared cache, no per-provider SDK. Full-page extract feeds the existing citation-constrained synthesis path.

B. Consolidation: accumulated knowledge becomes trustworthy insight
4. t_c5263e27 (p3) Count-triggered hierarchical fact rollup ladder in the dream pass: after N new facts accumulate at a tier, synthesize a higher-tier rollup; after N rollups, an identity-tier fact. Deterministic counter trigger in the dream synthesize phase (src/core/brain/dream-phases.ts, dream.ts synthesize); the trigger is counting, not language. Anchors: src/core/brain/fact-extract.ts:223 routeExtractedFacts, src/core/brain/page-meta/tier.ts PageTier/TIER_WEIGHT (static weights, no promotion ladder today).
5. t_28ba3fc4 (p3) Subject diarization: given an entity, read every document that mentions it and synthesize one structured profile page including a stated-vs-evidenced gap section (claims by the subject versus behavioral signals across its sources). Anchors: src/core/brain/deep-synthesis.ts:196 (topic-centric deepSynthesis), src/core/brain/truth/contamination.ts:47 (checkEntityContamination). Reuse the entity registry and ingestSource source pages as the per-subject document set; the gap section reuses claim machinery comparing stated claims against evidence frequency and recency.
6. t_40fa4e8d (p3) Extend deep-synthesis findings with an explicit causal-context field, decomposed confidence (components, not one scalar, deterministic), and a hard evidence-identity gate that EXCLUDES findings lacking a proof identity while reporting the excluded count. Anchors: deep-synthesis.ts:78 counter-finding basis vocabulary, :134-158 steelman seed (keep unchanged).
7. t_6832aac6 (p3) Deterministic memory-graph repair lane with graph-efficacy holdouts: CLI-first, dry-run default, adds high-confidence link-graph edges ordered by identity strength (explicit references, session continuity, same-topic evidence, opt-in inferred), gated by a confidence threshold, a hard per-run write cap, exact confirmation, idempotent forward-scan batching (reruns converge to zero writes). Paired harness: graph-neighbor holdouts measuring graph lift separately from direct recall; a graph target must resolve to durable memory and hydrate into bounded evidence, a dangling edge fails the gate. Anchors: src/core/brain/link-graph/graph-index.ts, graph.ts, src/core/brain/similarity.ts (jaccard findSimilarPairs), src/core/brain/recall-telemetry.ts.
8. t_6fc8663c (p3) Skill proposals hardening: a deterministic pre-promotion verifier gate (validate a candidate against its own supporting records: evidence count, structural checks) so thin drafts never reach the pending queue; skill versioning so an accepted skill evolves version-over-version; same-name merge when two proposals collide. Human stays the final approver. Anchors: src/core/brain/skill-proposals.ts:43,269,461, src/core/brain/apply-evidence.ts.

The architectural question: sequencing and shared seams. Candidate seams: (1) intake staging contract: the Telegram bot writes captures the inbox-drain pass consumes, so the capture note shape (frontmatter kind, provenance, timestamps) is one shared vocabulary; (2) an external HTTP fetch layer with keyed env gating and a shared cache used by both web-research providers and full-page extract; (3) a synthesis evidence-identity vocabulary shared by the finding gate (6) and the diarization gap section (5); (4) dream-pass extension points: the rollup ladder (4) rides the synthesize phase while the repair lane (7) is explicitly CLI-first and NOT a dream phase. Which seams deserve extraction, which stay conventions, and what ordering minimizes rework.

# Project context

Open Second Brain (o2b): TypeScript on Bun, CLI plus MCP server over an Obsidian-compatible Markdown vault, bun:sqlite with sqlite-vec. Deterministic kernel: the algorithm calls no LLM (LLM-facing steps are emitted as needs-llm-step envelopes for the agent, never called inline).
Recent commits:
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (not just inline arrays) (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
Conventions:
- TDD, one atomic conventional commit per task on one feature branch, all eight in one PR and one CHANGELOG version (target v1.36.0).
- MCP registry guards: tool descriptions <= 300 chars, property descriptions <= 160 chars; current surface 106 tools.
- Byte-identical opt-out: every new surface leaves behavior exactly unchanged when its flag/param/env is omitted.
- Errors surface explicitly; no do-nothing fallbacks; no stubs.
- Language-agnostic: no built-in natural-language word lists anywhere; classification by structural signals, config vocabularies, provenance.
- No import cycles (CI-guarded), no new external dependencies.
Constraints:
- Existing public API semantics unchanged; new MCP params optional.
- Network calls (Telegram, Brave, Tavily, page extract) are env-gated opt-in, fail with explicit typed errors, and never run inside the deterministic dream/synthesis kernel.
- The dream pass stays deterministic: rollup TRIGGERS are counters; rollup TEXT synthesis emits a needs-llm-step envelope consistent with existing extraction surfaces.
- Repair lane: dry-run default, hard write cap, idempotent reruns.

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
