You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [upstream:yantrikdb-hermes-plugin] Auto-generate bounded follow-up tasks from recurring low-confidence recalls and surface a session-opening agenda by default

**Source**: https://github.com/yantrikos/yantrikdb-hermes-plugin/releases/tag/v0.10.0
**Repo**: yantrikos/yantrikdb-hermes-plugin (27★)
**Released**: v0.10.0 (2026-07-25T17:23:38Z)

## What
Memory watches for recurring low-confidence answers and, when the same weak recall recurs enough to clear a demand threshold, mints a bounded follow-up work item; a per-session agenda is surfaced at the start of the next session. Both behaviors default on, with caps and demand-aggregation so a single poor recall never spawns an item.

## Why useful for OSB
OSB already classifies a weak recall and already names the action to take, but the verdict is per-attempt and evaporates. Nothing aggregates "this same question has come back insufficient four times" into durable, bounded remediation work. Closing that loop turns a repeated retrieval failure into a tracked obligation instead of a silently repeated disappointment.

## Status in OSB
- **Verdict**: present_weaker (was `unverified`; resolved against source 2026-07-27)
- **Codegraph hints** (re-verified 2026-07-27):
  - The low-confidence DETECTOR already exists: `src/core/brain/recall-adequacy.ts` classifies a recall attempt as `sufficient -> proceed`, `weak -> re_recall`, `insufficient -> abstain`, reading only numeric top-k scores (deterministic and language-agnostic). This is the signal to aggregate — do not build a new one.
  - Adjacent surfaces present: `src/core/brain/recall-telemetry.ts`, `src/core/brain/gaps/`, `src/core/brain/anticipatory-cache.ts`, `src/core/brain/recall-budget.ts`, `src/core/brain/session-recall.ts`.
  - The natural durable target already exists: `src/core/brain/obligations.ts` — `addObligation` (:246), `completeObligation` (:279), `showObligation` (:304), `obligationExists` (:313), with cadence parsing (:105) and `nextDueDate` (:173).
  - What is MISSING: recurrence aggregation across recall attempts (nothing keys repeated weak verdicts to a stable question identity), and any automatic minting path from a verdict to a durable item.
- **CORRECTION to the original notes**: `brain_agenda` does NOT cover the "session-opening agenda" half. `src/core/brain/agenda.ts` is a CALENDAR agenda — its vocabulary is `AgendaEventInput`, `AgendaConflict`, `FocusBlock`, `ExternalOrganizer`. It is unrelated to recall gaps and must not be extended for this.

## Notes
- Scope this as INTERNAL. Mint an **obligation** in the vault, not a task on an external tracker — OSB owns obligations; it does not own a board, and writing to one would make this an external-product integration for no gain.
- The hard part is the recurrence key: what makes two weak recalls "the same question" must be deterministic and must not use natural-language word lists in any language. Decide this before implementation.
- Caps and demand aggregation are load-bearing, not polish: without them one bad afternoon fills the vault with obligations.
- v1.40.0 precedent: a detector that finds a population should name the exit through a REGISTERED diagnostic code (`src/core/brain/next-step.ts`, `src/cli/advisory-rail.ts`), never caller-supplied prose.
- "Defaults on" needs an explicit decision. OSB's convention is that a new flag or config key is byte-identical when absent; a behavior that mints vault content by default has to be justified against that.

--- validator comment [claude-dev-agent]:
claude-dev-agent @ 2026-07-27: triage validation pass (operator-directed: link + priority actualization; internal work ranks above external-product integration)
- priority: 0 -> 3. Was untriaged (created 2026-07-25, no validator pass).
- verdict resolved unverified -> present_weaker against source, and two premises corrected in the body:
  1. The detector already exists. src/core/brain/recall-adequacy.ts classifies a recall attempt sufficient/weak/insufficient and names the action, deterministically from numeric scores. Do not build a second one.
  2. brain_agenda does NOT cover the session-opening-agenda half. src/core/brain/agenda.ts is a CALENDAR agenda (AgendaEventInput, AgendaConflict, FocusBlock, ExternalOrganizer) and must not be extended for recall gaps.
- re-scoped to stay internal: mint an OBLIGATION (src/core/brain/obligations.ts addObligation:246, completeObligation:279, cadence:105, nextDueDate:173), not a task on an external tracker. OSB owns obligations; it does not own a board, and writing to one would turn an internal feature into an external-product integration for no gain.
- genuinely missing, and the only hard part: recurrence aggregation - nothing keys repeated weak verdicts to a stable question identity. That key must be deterministic and must not use natural-language word lists in any language.

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
