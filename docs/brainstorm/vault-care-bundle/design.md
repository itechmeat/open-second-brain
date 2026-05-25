# vault-care-bundle - layered metadata + maintenance pipeline

**Status:** draft
**Author:** @claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Eight related upstream-inspired vault features ship together in one Open Second Brain release: per-page confidence/lifecycle, page importance tier, page-level dedup, self-healing lint, token footprint monitoring, bounded-token context retrieval, Unicode/CJK dedup normalisation, and a ranked maintenance action list. Done one at a time they would touch the same files (ranker, digest, doctor, dream, dedup-hash, migrate-frontmatter) repeatedly across releases. Done as an unstructured bundle they would mash schema, scoring, scanning, and CLI changes into one giant diff.

## Scope

Layered architecture for the bundle, chosen from a 3-variant brainstorm:

- `src/core/brain/page-meta/` - frontmatter atoms (lifecycle, generalised confidence, tier, merged-pointer).
- `src/core/brain/text/` - deterministic helpers (NFKC+casefold normaliser, heuristic tokenizer).
- `src/core/brain/maintenance/action-scorer.ts` - impact-weighted action item builder used by digest and doctor.
- One `migrate-frontmatter` sweep covers F1+F2+F3 schema additions.
- Eight features (F1-F8) consume those layers through narrow edits to existing consumers (`ranker.ts`, `digest.ts`, `doctor.ts`, `dream.ts`, `inline-scan.ts`, `sessions/import.ts`) and new CLI verbs (`lint`, `token-footprint`, `context-pack`, `page-dedup`) + new MCP tools (`brain_context_pack`).

## Out of scope

- Semantic vault health (contradiction detection, concept-gap detection) - separate task t_1f00d9bc.
- Trust verdict / operator dashboard - separate tasks t_3440fa2c, t_dd9a602e.
- Block-link / heading anchor granularity in backlinks - separate task t_28f7dc4b.
- Frontmatter alias resolution - separate task t_fb753446.
- New tokenizer library or `tiktoken` integration - stays heuristic, Bun stdlib only.
- Auto-fixing semantic contradictions in `lint --consolidate` - this PR fixes only structural drift (broken links, orphan lifecycle, tag aliases).

## Chosen approach

**Variant 1 (Layered foundation)**. Three horizontal layers built bottom-up; the eight feature outputs sit on top.

```text
Consumer layer:  ranker.ts | digest.ts | doctor.ts | dream.ts | inline-scan.ts | sessions/import.ts
                 + new CLI verbs (lint, token-footprint, context-pack, page-dedup)
                 + new MCP tool (brain_context_pack)
                              ^               ^                   ^
                              |               |                   |
Helper layer:    text/normalize.ts     text/tokenizer.ts   maintenance/action-scorer.ts
                              ^               ^                   ^
                              |               |                   |
Atom layer:      page-meta/{lifecycle,confidence,tier,page-id}.ts
                              ^
                              |
Schema migrate:  cli/brain/verbs/migrate-frontmatter.ts (extended; one sweep covers F1+F2+F3)
```

Consumers depend on layers, never on each other. The DAG keeps the diff coherent: each feature commit edits ≤1 consumer file plus its tests; shared atoms get one file each.

## Design decisions

- **Generalise existing `_confidence` rather than introduce a new field**: preferences already carry `_confidence` (BRAIN_CONFIDENCE enum) under the Group-C `_` prefix convention. Extend the same field to other page kinds (signals, evidence, retired entries) and surface lifecycle via a new `_lifecycle` field next to it. Reason: avoids re-cutting an existing concept; keeps reader-side parsing rules unchanged.
- **`tier:` is user-editable, NOT under `_` prefix**: tier expresses operator intent (which preferences/notes matter most), so it sits alongside `pinned` as user-owned metadata. Default at read-time is `"supporting"`.
- **`merged_into:` lives on the secondary, never the canonical**: a dedup merge writes `merged_into: pref-<canonical-slug>` to the secondary's frontmatter and rewrites every wikilink in the vault that pointed to the secondary. Reading code resolves `merged_into` transitively (capped at depth 5 to fail-loud on cycles).
- **NFKC + casefold goes into `text/normalize.ts`, NOT into `dedup-hash.ts` directly**: `dedup-hash.ts` keeps its narrow purpose (compute a SHA256 of normalised inputs). The new helper is a one-line `s.normalize("NFKC").toLowerCase()` wrapper but lives in `text/` so other call sites (search ranker, alias index, future fuzzy match) can reuse it.
- **Token counter is heuristic, not tokenizer-accurate**: deterministic `ceil(utf8_bytes / 4)`, the OpenAI rule-of-thumb generalised to bytes so it stays language-agnostic. No script-specific branching, no external tokenizer dependency. Good enough for monitoring + budget enforcement.
- **`brain_context_pack(max_tokens, query?)`**: returns highest-tier pages first, then most-recently-applied preferences, then `confirmed` signals, until adding the next item would exceed `max_tokens`. Result includes the actual token estimate so callers can introspect. `query?` is an optional substring filter; full semantic search stays in the existing `brain_search` tool.
- **`o2b brain lint --consolidate`**:
  - Dry-run by default; `--apply` required to write.
  - Operations: fix broken wikilinks (target file moved/renamed), reconcile orphan lifecycle (orphan + `lifecycle: stable` for > N days → demote to `draft`), normalise tag aliases (case + NFKC).
  - Does NOT touch semantic content. Emits a deterministic diff readable in CI.
- **Ranked action list**: each candidate action gets an impact score = base weight × multiplier (e.g. broken-link = 5 × number-of-files-affected). Top N (default 10) surface in `brain_digest` under a new `## Actions` section and in `brain_doctor` as a `suggested_actions:` block.
- **Existing CLI conventions preserved**: every new verb registers via `src/cli/brain/verbs/index.ts`; every new MCP tool registers via `src/mcp/brain-tools.ts`. No subcommand collapses; flat verb namespace continues.

## File changes

### New source files

- `src/core/brain/page-meta/lifecycle.ts` - `Lifecycle` enum (`draft|stable|verified|deprecated|archived|disputed`), `defaultLifecycle()`, `isStale()` predicate.
- `src/core/brain/page-meta/confidence.ts` - re-export + helpers to read/write `_confidence` on non-preference pages.
- `src/core/brain/page-meta/tier.ts` - `Tier` enum (`core|supporting|peripheral`), default = `"supporting"`, `tierWeight()` lookup table.
- `src/core/brain/page-meta/page-id.ts` - `mergedIntoPath()` resolver, `setMergedInto()` writer, cycle detection.
- `src/core/brain/text/normalize.ts` - `normalizeForDedup(s: string): string` returning `s.normalize("NFKC").toLowerCase()`.
- `src/core/brain/text/tokenizer.ts` - `estimateTokens(s: string): number` heuristic.
- `src/core/brain/maintenance/action-scorer.ts` - `ActionItem`, `scoreActions(input): ActionItem[]`.
- `src/core/brain/page-dedup.ts` - `findDuplicateCandidates(vault)`, `mergePage(vault, secondary, canonical)`, `patchWikilinks(vault, oldTarget, newTarget)`.
- `src/core/brain/lint-consolidate.ts` - `lintConsolidate(vault, opts: { apply: boolean })` returning a structured diff.
- `src/core/brain/token-footprint.ts` - `computeTokenFootprint(vault)` returning `{ byCategory: Map<string, number>, total: number, warnThreshold: number, exceeded: boolean }`.
- `src/core/brain/context-pack.ts` - `packContext(vault, opts: { maxTokens, query? })` returning a serialisable slice.
- `src/cli/brain/verbs/lint.ts` - `o2b brain lint [--consolidate] [--apply]`.
- `src/cli/brain/verbs/token-footprint.ts` - `o2b brain token-footprint [--json]`.
- `src/cli/brain/verbs/context-pack.ts` - `o2b brain context-pack --max-tokens <n> [--query <q>]`.
- `src/cli/brain/verbs/page-dedup.ts` - `o2b brain page-dedup [--apply]`.

### Modified source files

- `src/core/brain/dedup-hash.ts` - swap `"NFC"` → call to `normalizeForDedup` (F7).
- `src/core/search/ranker.ts` - add tier signal to `RankerInputs` + `rankResults` weighting (F2).
- `src/core/brain/digest.ts` - add tokenFootprint section, rankedActions section (F5, F8).
- `src/core/brain/doctor.ts` - emit `suggested_actions` (F8).
- `src/core/brain/preference.ts` - emit `_lifecycle` next to `_confidence`, accept `tier` as input (F1, F2).
- `src/core/brain/dream.ts` - apply lifecycle transitions (`stable` → `verified` on N reapplies); update tier auto-suggestion (F1, F2).
- `src/cli/brain/verbs/migrate-frontmatter.ts` - extend the single sweep to add `_lifecycle: stable`, `tier: supporting` to existing pages (F1, F2, F3).
- `src/cli/brain/verbs/index.ts` - register the four new verbs.
- `src/mcp/brain-tools.ts` - register `brain_context_pack` MCP tool (F6); extend `brain_digest`, `brain_doctor` outputs to surface new sections.

### New test files

- `tests/core/brain/page-meta/lifecycle.test.ts`
- `tests/core/brain/page-meta/tier.test.ts`
- `tests/core/brain/page-meta/page-id.test.ts`
- `tests/core/brain/text/normalize.test.ts`
- `tests/core/brain/text/tokenizer.test.ts`
- `tests/core/brain/maintenance/action-scorer.test.ts`
- `tests/core/brain/page-dedup.test.ts`
- `tests/core/brain/lint-consolidate.test.ts`
- `tests/core/brain/token-footprint.test.ts`
- `tests/core/brain/context-pack.test.ts`
- `tests/cli/brain/lint.test.ts`
- `tests/cli/brain/token-footprint.test.ts`
- `tests/cli/brain/context-pack.test.ts`
- `tests/cli/brain/page-dedup.test.ts`
- `tests/mcp/context-pack-tool.test.ts`
- `tests/core/search/ranker-tier.test.ts`
- `tests/core/brain/digest-actions.test.ts`
- `tests/core/brain/dedup-hash-unicode.test.ts` (Unicode regression cases)

### Docs / metadata

- `README.md` - one new paragraph in the feature list.
- `CHANGELOG.md` - new `[0.10.15]` entry with capability-first summary + Added / Changed / Notes sections.
- `docs/brainstorm/vault-care-bundle/{design.md,plan.md,variants.md,cli-output/}` - this artifact set.

## Risks and open questions

- **Migration sweep deliberately skipped**: the original plan extended `migrate-frontmatter` to backfill `_lifecycle: stable` and `tier: supporting` on legacy pages. Implementation chose read-side defaults instead - `readLifecycle()` and `readTier()` return the documented default whenever the field is absent. Trade-off: legacy files stay byte-identical (no Syncthing churn, no migration risk on user vaults), at the cost of the new fields not appearing in on-disk YAML until a write touches the page. Acceptable because every reader has a fallback path; revisit only if a future feature actually needs the field materialised on disk.
- **Page-dedup wikilink patcher rewriting tests**: care needed not to rewrite wikilinks inside committed fixture files. Mitigation: dedup operates only on `Brain/` paths (use `brainDirs()`), tests run in a tmpdir.
- **Token estimator accuracy on CJK**: heuristic may under- or over-count; the warn threshold (200k default) has slack. If accuracy proves insufficient post-merge, swap the implementation behind `text/tokenizer.ts` without touching consumers.
- **Ranker tier weighting must not regress existing test snapshots**: ranker tests use fixture vaults where every page is implicitly `tier: supporting` (the default). The new weighting term must be neutral when all pages carry the default tier. Plan: tier weight multiplier defaults to `1.0` for `supporting`.
- **Lint --consolidate side-effects on user vaults**: requires `--apply` flag and emits a dry-run diff first. Document the diff format in `lint.ts` so operators can review before applying.
