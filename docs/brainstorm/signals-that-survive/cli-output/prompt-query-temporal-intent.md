You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [upstream:signetai] Query-side temporal-intent detection for hybrid recall re-ranking

**Source**: https://github.com/Signet-AI/signetai/releases
**Repo**: Signet-AI/signetai (183★)
**Released**: v0.148.2 (2026-07-22T21:17:14Z)

## What
Signet's recall engine now adds a temporal-intent signal to hybrid recall scoring: it detects time intent in the query itself (e.g. "last week", "recently", "before X") and biases ranking toward memories matching that window. This is distinct from a static freshness prior, which boosts recent items regardless of what the query asks.

## Why useful for OSB
OSB's Weibull recency boost is query-independent: it always favors recent notes, even when the query explicitly targets an older period ("what did I decide back in spring?"), where it actively hurts ranking. A query-side temporal-intent detector would modulate (amplify, suppress, or window-shift) the existing recency layer per query — a genuinely uncovered dimension, and cheap to prototype since OSB already has a temporal-expression extractor on the write path that could be reused for query parsing.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: Freshness-prior half is present: src/core/search/recency.ts:4-8 (configurable Weibull recency boost; recencyShape/recencyScale/recencyAmplitude at src/core/search/types.ts:905-908), fused in src/core/search/ranker.ts:1-5 and orchestrated in src/core/search/search.ts:1-4. Query-side temporal-intent half not found — extractTemporalConstraints (src/core/brain/temporal-extract.ts) runs only on the WRITE path (bi-temporal validity in dream.ts:1415-1419, dream-plan.ts:134-137); no query-time temporal parsing feeds the ranker or fusion (src/core/search/fusion.ts:1-3).

## Notes
Conservative scope: this is an enhancement, not a gap-critical fix — plain recency boost covers the common "recent stuff" case. Suggested minimal shape: parse query for temporal expressions (reusing temporal-extract), map to a target time window, and adjust recency parameters or apply a window-match multiplier in the ranker; amplitude-0 style opt-out should be preserved. Do not import Signet's implementation — only the idea; scoring internals differ (OSB uses min-max-normalized BM25+semantic fusion with link/tier boosts).

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-07-25T22:53:39Z:
- sanity: clean
- cluster: no cluster
- priority: set to 2: present_weaker but query-side temporal-intent is an enhancement to the recency/fusion layer; needs design on per-query Weibull modulation

--- validator comment [claude-dev-agent]:
claude-dev-agent @ 2026-07-27: triage validation pass (operator-directed: link + priority actualization; internal work ranks above external-product integration)
- priority: 2 -> 3.
- verified this run: the premise holds exactly. extractTemporalConstraints (src/core/brain/temporal-extract.ts:45) is imported by src/core/brain/dream.ts only (:52, :1501) - write path, never the query path. src/core/search/recency.ts, ranker.ts and fusion.ts exist as described.
- rank rationale: purely internal search-quality work, no external product anywhere in scope, and the extractor it needs is already written and tested. The remaining design question (how a query-side signal modulates the Weibull layer) is bounded, not architectural.

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
