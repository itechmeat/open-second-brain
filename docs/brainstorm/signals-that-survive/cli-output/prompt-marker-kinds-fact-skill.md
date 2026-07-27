You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [article] Offline DREAM marker parsing for provider-free proposal seeding

**Source**: [[Articles/Introducing Hermes Dreaming- Reviewable Self-Improvement for Hermes Agent]]
**Article excerpt**: "The offline marker workflow looks for explicit DREAM: lines in the source bundle. ... DREAM: fact: {"type": "preference", "key": "tone", "value": "casual"}"

## What
An offline source-marker convention (explicit lines tagging memory/user/fact/skill proposals in plain text) so the self-improvement loop can be exercised deterministically without any model call.

## Why useful for OSB
A marker grammar lets operators or other agents seed proposals into the dream pipeline from plain text in a fully testable, provider-independent way — useful for fixtures, demos, and cross-tool authoring without going through a tool call.

## Status in OSB
- **Verdict**: present_weaker (was `unverified`; resolved against source 2026-07-27)
- **Codegraph hints** (re-verified 2026-07-27; the earlier hint "dream input is logged signals, not inline markers" was MISLEADING — the markers are what produce those signals):
  - A full inline + block marker grammar already ships: `src/core/brain/inline.ts` — `parseInlineMarker` (:201), `parseBlockMarker` (:401), `discoverMarkersDetailed` (:557), `discoverMarkers` (:616), fence-aware and consumed-sentinel-skipping so re-runs are idempotent.
  - Three marker kinds exist (`MarkerKind = "feedback" | "loop" | "set"`, inline.ts:51) with per-kind required fields (inline.ts:46-49): `feedback` requires topic + principle, `set` requires note + field + value. `loop` is validated structurally by the close-form decision table.
  - Consumers are wired: `src/core/brain/session-lifecycle.ts:530`, `src/core/brain/inline-scan.ts:33`, `src/core/brain/open-loops.ts:177`, `src/core/brain/inline-rewrite.ts`.
  - Net: provider-free, plain-text seeding of preference signals into `Brain/inbox/` ALREADY works and is already deterministic and testable.

## Notes
- Do NOT build a second marker grammar. The remaining delta is narrow and must land as kinds on the existing one:
  1. The article's convention also tags **fact** and **skill** proposals; OSB's grammar has no kind for either.
  2. OSB's markers are discovered on the session-import / inline-scan path. The article's workflow reads an arbitrary "source bundle", so the open question is whether a marker scan should be invocable over an operator-supplied file outside a session.
- Verify (2) before sizing: if the answer is "no", this task collapses to adding two kinds to `REQUIRED_FIELDS` plus their routing, which is small.
- The parent (t_ae8a8ec0, staged dream pipeline with a persisted proposal bundle) is now **done**, so the original reason this task sat at priority 1 — "value depends on the parent pipeline existing first" — has expired.

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-06-04T13:31:04Z:
- sanity: clean
- cluster: child of t_ae8a8ec0
- priority: set to 1: verdict unverified; value depends on t_ae8a8ec0 pipeline existing first

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-06-05T12:37Z:
- re-validated: priority=1 correct (verdict unverified; value depends on parent t_ae8a8ec0 pipeline existing first); parent t_ae8a8ec0 already linked; no changes needed

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-06-17T14:04:06Z:
- sanity: inserted missing Notes section with TODO placeholder
- cluster: child of t_ae8a8ec0 (existing link, no new link)
- priority: kept at 1 (validator-set, no priority mutation this run)

--- validator comment [claude-dev-agent]:
claude-dev-agent @ 2026-07-27: triage validation pass (operator-directed: link + priority actualization; internal work ranks above external-product integration)
- priority: 1 -> 2. The stated reason for 1 has expired: the parent t_ae8a8ec0 (staged dream pipeline with a persisted proposal bundle) is DONE.
- verdict resolved unverified -> present_weaker, and the old hint corrected. "dream input is logged signals, not inline markers" was misleading - the markers are what PRODUCE those signals. A full grammar already ships at src/core/brain/inline.ts: parseInlineMarker:201, parseBlockMarker:401, discoverMarkersDetailed:557, discoverMarkers:616, fence-aware and consumed-sentinel-skipping so re-runs are idempotent. Three kinds exist (MarkerKind:51 - feedback | loop | set) with per-kind required fields (:46-49). Consumers wired at session-lifecycle.ts:530, inline-scan.ts:33, open-loops.ts:177, inline-rewrite.ts.
- so provider-free plain-text seeding of preference signals ALREADY works. Do not build a second grammar.
- the remaining delta, now recorded in the body: the article convention also tags fact and skill proposals (no kind for either), and OSB discovers markers on the session-import path rather than over an arbitrary operator-supplied source bundle. If the latter is out of scope this collapses to adding two kinds plus routing - small.

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
