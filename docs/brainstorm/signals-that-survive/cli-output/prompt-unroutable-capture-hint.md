You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [upstream:plur] Capture-time routing hint for unrouted memories

**Source**: https://github.com/plur-ai/plur/releases/tag/v0.15.0
**Repo**: plur-ai/plur (154★)
**Released**: v0.15.0 (2026-07-24T16:11:21Z)

## What
When a captured memory cannot be routed because the user omitted a domain/scope, return a non-blocking hint naming the missing routing signal and likely eligible scopes.

## Why useful for OSB
This would improve capture quality without rejecting user writes. It helps users and agents learn the minimum metadata needed for reliable routing, reducing unrouted notes and later retrieval noise.

## Status in OSB
- **Verdict**: unverified
- **Codegraph hints**: unverified — codegraph MCP tools were not exposed in this runtime; projectPath would be /srv/projects/open-second-brain. No codegraph query was possible, so this task needs verification during triage.

## Notes
Upstream evidence: plur v0.15.0 adds a `domain_hint` for domain-less, scope-less writes when covers-declaring scopes are registered; it is silent on personal installs with no eligible scopes and never blocks a write.

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-07-25T22:53:39Z:
- sanity: clean
- cluster: no cluster
- priority: set to 1: unverified (codegraph MCP unavailable; capture-time routing hint needs verification; also depends on OSB having scope-declaring routes)

--- validator comment [claude-dev-agent]:
claude-dev-agent @ 2026-07-27: triage validation pass (operator-directed: link + priority actualization; internal work ranks above external-product integration)
- priority: 1 -> 2.
- verdict resolved unverified against source. The write router is routeExtractedFacts (src/core/brain/fact-extract.ts:307). OSB has NO domain/scope concept on it, so the literal upstream feature - a domain_hint naming which of the registered covering scopes was missing - has nothing to hint ABOUT. The validator's caveat ("depends on OSB having scope-declaring routes") is confirmed correct.
- re-scoped rather than closed, because the transferable half is the SHAPE, not the domain model: a non-blocking hint that names the missing routing signal instead of silently accepting an unroutable write. That is exactly the v1.40.0 rail - resolve a REGISTERED code, never caller-supplied prose (src/core/brain/next-step.ts, src/cli/advisory-rail.ts).
- raised to 2 on that basis: internal, small, and it now has a native seam instead of needing a bespoke hint mechanism.

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
