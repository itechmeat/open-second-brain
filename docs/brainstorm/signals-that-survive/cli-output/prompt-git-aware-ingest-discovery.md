You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## [upstream:obsidian-wiki] Make ingest source discovery git-aware by honoring on-disk .gitignore, .git/info/exclude, and submodules

**Source**: https://github.com/Ar9av/obsidian-wiki/releases/tag/v2026.07.10
**Repo**: Ar9av/obsidian-wiki (977★)
**Released**: v2026.07.10 (2026-07-26T05:29:26Z)

## What
Make the ingest batch planner's file discovery honor git's own view of a repository: layer the repo's on-disk `.gitignore` (root and per-directory nested), `.git/info/exclude`, and skip submodule/non-working-tree files — rather than only skipping dot-entries and applying operator-supplied `--exclude` patterns.

## Why useful for Open Second Brain
When ingesting a git repository as a source, the current planner pulls in build artifacts, vendored trees, and generated files the repo already declares ignored, wasting ingest budget and polluting `Brain/sources`. The hygiene scan already discovers files git-aware; making ingest match gives operators the discovery behavior they expect from a repo path with no extra flags.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**:
  - Ingest discovery gap: `src/core/brain/ingest/batch-plan.ts:298-317` (`collectIngestible`) skips dot-entries only; its `IgnoreScope` comes solely from operator `--exclude` patterns via `buildExcludeScope` (`batch-plan.ts:283-291`). It does NOT read the repo's `.gitignore`, nested `.gitignore`, or `.git/info/exclude`; no submodule handling.
  - The git-aware pattern already exists to reuse: `src/core/hygiene/scan-repo.ts:129-181` (`buildBaseScope` layers `.git/info/exclude` + root `.gitignore`; `collectFiles` layers per-directory `.gitignore`) and `scan-repo.ts:205-229` (`listScanTargets`).
  - Shared engine both paths already import: `src/core/fs/ignore.ts` (`IgnoreScope`, `parseIgnorePatterns`, `isIgnored`).
  - Git-repo detection available if discovery should branch on it: `src/core/brain/git/reader.ts:77` (`isGitRepo`).

## Notes
- The bulk of the machinery exists; the work is mostly wiring the hygiene scan's base-scope + per-directory layering into `collectIngestible`, keeping the no-git-files path byte-identical (empty scope) so existing plans/`planId`s do not shift.
- Submodule handling is net-new for both paths and is the one piece not already solved elsewhere — scope it explicitly or defer it.
- Not related to sync task t_c5e54902 (that is a GitHub-sync command surface); this is purely local file-discovery.

--- validator comment [claude-dev-agent]:
claude-dev-agent @ 2026-07-27: triage validation pass (operator-directed: link + priority actualization; internal work ranks above external-product integration)
- priority: 0 -> 4. Was untriaged (created 2026-07-26, no validator pass).
- verified this run, every anchor holds: the gap at src/core/brain/ingest/batch-plan.ts collectIngestible:298 / buildExcludeScope:283 (operator --exclude patterns only, dot-entry skip, no git awareness); the machinery to reuse at src/core/hygiene/scan-repo.ts buildBaseScope:129 / collectFiles:148 / listScanTargets:205; the shared engine both import at src/core/fs/ignore.ts (parseIgnoreLayer:162, parseIgnorePatterns:189, class IgnoreScope:209).
- rank rationale: top of the board. Purely internal (git metadata on disk is not an external product), present_weaker rather than net-new, and both halves of the wiring already exist - the work is composition, not design. No other task combines a real capability gap with this little unknown.
- cluster: no link. It shares the ignore engine with the hygiene scan but depends on no open task.

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
