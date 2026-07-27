You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [upstream:obsidian-mind] Secondary discriminator stage on Brain routing signals

**Source**: https://github.com/breferrari/obsidian-mind/releases/tag/v7.0.0
**Repo**: breferrari/obsidian-mind (3073★)
**Released**: v7.0.0 (2026-07-19)

## What
A two-stage classifier for routing captured notes/signals: a primary hint picks a candidate route, then a secondary discriminator ("sub-hint") disambiguates among the routes the primary hint scores near-equally, instead of a single-shot winner-take-all decision.

## Why useful for OSB
OSB routes writes deterministically (signal -> Brain/inbox/sig-*, preference, note, pinned) and the same ambiguity exists: a taste signal that is also an obligation, a note that is really a decision. A deterministic tie-break layer keeps routing model-free while cutting the misfiled-write rate that dream later has to reconcile. Recording which discriminator fired also makes tie-break rules auditable and tunable rather than opaque.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints** (re-verified 2026-07-27):
  - The write router is `routeExtractedFacts` (src/core/brain/fact-extract.ts:307), with an operator durability denylist (fact-extract.ts:202) and a write-approval toggle (fact-extract.ts:209). Classification is single-stage; there is no tie-break layer and no record of near-equal candidates.
  - No grep match for "sub-hint" or "secondary discriminator".
  - Nearest prior art is brain_intake_entities / brain_labels, which classify CONTENT, not route.
- **CORRECTION to the original hints**: `brain_route_metrics` is NOT a write-routing histogram. It is route-level LATENCY telemetry for MCP tool calls (src/core/brain/mcp-route-metrics.ts; one `mcp_route_latency` continuity record per `tools/call`, gated on config key `mcp_route_metrics_enabled`, surfaced via src/mcp/brain/recall-tools.ts:319). It has nothing to do with where a captured write lands. Any claim that this task "gives brain_route_metrics something to report" is false and must not drive the design. `brain_recall_gate` and `brain_intent_review` are likewise different layers (retrieval gating and intent review), not write routing.

## Notes
- Must stay deterministic (rule/score table, not an LLM call) to preserve OSB's model-free guarantee, and language-agnostic — no natural-language word lists in the discriminator, on any language.
- The tie-break outcome needs its own emission surface. `emitGatedTelemetry` (src/core/brain/continuity/emit.ts) is the existing gated, fail-open, redaction-passing seam that `mcp-route-metrics.ts` already uses; model a new gated record on it rather than extending the latency record with an unrelated field.
- v1.40.0 precedent to follow: a diagnosis names its exit through a REGISTERED code, not caller-supplied prose (src/cli/advisory-rail.ts, src/core/brain/next-step.ts). If an ambiguous route surfaces anything to the operator, it should go through that rail with a registered code, not a bespoke sentence.

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-07-25T22:53:39Z:
- sanity: clean
- cluster: no cluster
- priority: set to 2: not_in_osb_useful, secondary discriminator stage on routing is an architectural routing-model change; needs design on the tie-break score table and metrics emission

--- validator comment [claude-dev-agent]:
claude-dev-agent @ 2026-07-27: triage validation pass (operator-directed: link + priority actualization; internal work ranks above external-product integration)
- priority: 2 -> 3.
- body CORRECTED (see the Status section): the original claimed this task "gives brain_route_metrics something to report beyond a flat route histogram". That is false. brain_route_metrics is route-level LATENCY telemetry for MCP tool calls (src/core/brain/mcp-route-metrics.ts, one mcp_route_latency continuity record per tools/call, gated on mcp_route_metrics_enabled, surfaced at src/mcp/brain/recall-tools.ts:319). It has nothing to do with where a captured write lands. Left uncorrected it would have sent an implementer to extend a latency record with an unrelated field.
- the real anchor is now recorded: the write router is routeExtractedFacts (src/core/brain/fact-extract.ts:307), single-stage, with a durability denylist (:202) and a write-approval toggle (:209).
- rank rationale: internal, deterministic by requirement, and it reduces misfiled writes that dream later has to reconcile. Verdict corrected not_in_osb_useful -> present_weaker.

# Project context

Project: Open Second Brain - a TypeScript/Bun command-line tool plus Model Context Protocol server over an Obsidian-compatible Markdown vault.
Runtime: Bun. Tests: `bun test` via `bash scripts/test` (910 *.test.ts files). Typecheck: `tsc --noEmit`. Lint: oxlint. Format: oxfmt.

Recent commits (newest first):
0963ef0a feat: no dead ends - every diagnosis names its exit (v1.40.0) (#151)
f91a698b feat: context integrity gates (v1.39.0) (#150)
c31a2574 feat: semantic-health baseline watermark (v1.38.0) (#148)
b0c37977 feat: retrieval quality and context delivery (v1.37.0) (#146)
842d690f feat: knowledge intake and consolidation (v1.36.0) (#145)
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (not just inline arrays) (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0) (#139)
f2a037eb feat: today operator surface - dashboard, open loops, marker write-back (v1.31.0) (#138)
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)
a99b0e71 feat(brain): add o2b brain vitals scorecard + batch-concept-inflation lint (#135)
70fb36e1 feat: operability, safety & first-run experience (v1.29.0) (#134)
ac26a675 feat: retrieval & ranking quality (v1.28.0) (#133)
5cd52e70 fix(hermes): resolve o2b when memory provider PATH is tiny (v1.27.1) (#131)
99adb65f feat: ingestion & import robustness (v1.27.0) (#132)
fb474acc test(hermes): verify OSB surface against core normalize/validate-before-wrap and in_place compaction (1.26.1) (#129)

Conventions:
- The kernel is deterministic. It issues no model calls. Anything that must classify, rank, or gate does so from structural signals or numeric scores.
- Search, classification, ranking and extraction must be language-agnostic. Hardcoded natural-language word lists (stop-words, greetings, keywords, negations) are forbidden in EVERY language.
- Every new flag, argument or configuration key must leave behaviour byte-identical when absent.
- A forward pointer printed to the operator resolves a REGISTERED diagnostic code through the advisory rail (src/cli/advisory-rail.ts, src/core/brain/next-step.ts). Caller-supplied prose is rejected by a build ratchet.
- Findings carry their data as structured fields, not embedded in prose messages.
- The vault is plain Markdown replicated peer-to-peer by Syncthing. There is NO git transport for the vault, and nothing may place a .git directory inside the replicated tree.
- Continuity telemetry is emitted through emitGatedTelemetry (src/core/brain/continuity/emit.ts): gated by a configuration key, fail-open, redaction-passing.

Constraints:
- No fallback that silently does nothing. An error must surface explicitly as an error.
- No stubs, no placeholders, no dead code paths.
- SOLID, KISS, DRY. Anything extractable belongs in a named constant or local.
- Do not add an external service dependency, and do not introduce a new runtime dependency without saying so explicitly as a trade-off.
- Do not change existing public command-line or Model Context Protocol surfaces incompatibly.

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
