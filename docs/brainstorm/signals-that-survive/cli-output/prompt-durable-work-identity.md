You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [upstream:contextlattice] Durable cross-session work identity with explicit execution lanes, replacing the timing crutch

**Source**: https://github.com/sheawinkler/contextlattice/releases/tag/v3.18.0
**Repo**: sheawinkler/contextlattice (61★)
**Released**: v3.18.0 (2026-07-15T15:36:08Z)

## What
A stable work/task identity that survives agent, account, model, session, branch, and worktree changes, with execution "lanes" kept explicit so parallel work cannot be collapsed into one process. Exact/external task IDs always win; semantic matching stays advisory and abstains on ambiguity.

## Why useful for OSB
OSB currently only has session lineage (parent/root/depth) and resolves "continuation vs parallel work" with a timing-based crutch (`CRUTCH_LINK_WINDOW_MS = 900_000`). A durable work identity would let the crutch resolver key on a stable ID instead of a 15-minute window, correctly re-attaching resumed work after a model/branch/worktree switch and refusing to merge concurrent lanes.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: No durable cross-session task-identity concept found. Session lineage only: `src/core/brain/lineage/ledger.ts:74` (`LedgerLine`), `:42` (`LEDGER_FILE`), `:34` (`CRUTCH_LINK_WINDOW_MS`=900_000). Timing-crutch resolver: `crutch.ts` (CRUTCH t_1459706f). Idea stage transitions (`src/core/brain/idea-lineage.ts:296` `transitionStage`) are the nearest analog but scope ideas/prefs, not work items with lanes.

## Notes
The explicit-lane / abstain-on-ambiguity contract is the substantive part — it directly targets the failure mode the timing crutch has (two parallel sessions inside the same window getting linked). Scope as an enhancement to the lineage/crutch layer, not a new subsystem.

--- validator comment [osb-triage-validator]:
osb-triage-validator @ 2026-07-18T08:30:00Z:
- sanity: clean
- cluster: parent of t_232fcf70 (existing link, unchanged)
- priority: set to 2: not_in_osb_useful, architectural (durable cross-session work identity + explicit execution lanes replacing CRUTCH_LINK_WINDOW_MS timing crutch) - needs ADR

--- validator comment [claude-dev-agent]:
SCOPE NARROWED by v1.39.0 (https://github.com/itechmeat/open-second-brain/releases/tag/v1.39.0, PR #150). This task's body says the substantive part is the explicit-lane / abstain-on-ambiguity contract, because it targets the failure mode where two parallel sessions inside the same window get linked. THAT FAILURE MODE IS NOW FIXED: t_580bb87c shipped the abstention layer - resolveCrutchLineage returns a discriminated outcome (linked, or an abstention naming no-candidate / self-known / no-workspace / ambiguous / stale / evidence-missing), two surviving candidates abstain instead of resolving by most-recent-wins, and repo/branch/commit joined cwd as required-match predicates. A dropped ledger observation is also recorded as a named gap and excluded from matching, so a lost write cannot invert the rule into a false stitch. What REMAINS in scope here: a durable work identity that survives agent, account, model, session, branch and worktree changes, so the resolver can key on a stable id instead of CRUTCH_LINK_WINDOW_MS = 900_000, which is still the freshness bound. Do not re-implement the ambiguity handling - it is in main.

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
