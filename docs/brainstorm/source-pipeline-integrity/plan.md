# Source pipeline integrity and operator tooling - implementation plan

Ordering follows consultant Variant 1: two shared kernels ride inside the
first feature commit that needs them (P1 owns `src/core/fs/ignore.ts`, O2
owns the diagnostics-signal model); every other unit is a local change to
its existing module. Hard dependency edges are only P1 before P2 and O2
before O3; every prefix of the sequence leaves the branch releasable.
Each unit lands as one atomic conventional commit with its tests, formatted
(oxfmt) and lint-clean (oxlint, 134-warning/0-error baseline).

Sequence: O1 -> P1 -> P2 -> P3 -> P4 -> P5 -> Q1 -> Q2 -> Q3 -> O2 -> O3 -> L

## Tasks

### Task O1 - clean exit on early-closed stdout pipe (`t_2ed754d1`, p3, standalone)
- **Files**: `src/cli/main.ts` (EPIPE-aware exit path), shared stdout-write
  guard if needed by `vault-log`, tests.
- **Acceptance**: `o2b <listing command> | head -1` exits 0 with no error
  output for both `o2b` and `vault-log` entry points; EPIPE on stdout maps
  to exit 0; any other I/O error still fails nonzero with its message; a
  regression test simulates a closed-pipe write.
- **Depends on**: none.

### Task P1 - nested gitignore composition in hygiene scan (`t_9654de80`, p3, path-scope anchor)
- **Files**: new `src/core/fs/ignore.ts` (ignore-rule engine: pattern parse,
  nested composition, nearer-`!`-wins, `.git/info/exclude` layering),
  `src/core/hygiene/scan-repo.ts` wiring, tests (table suite mirroring git
  documented semantics).
- **Acceptance**: the hygiene scan skips paths ignored by root and nested
  `.gitignore` files; a deeper ignore file scopes only its subtree; a nearer
  `!` re-include wins over an outer ignore; `.git/info/exclude` participates;
  repos without ignore files scan byte-identically to today (static skip-dir
  behavior preserved as baseline); malformed patterns surface as explicit
  warnings, never silent skips.
- **Depends on**: none.

### Task P2 - source ingest scoping flags (`t_e82101a5`, p3)
- **Files**: ingest CLI/MCP surface (`--src-subpath`, `--exclude`),
  `src/core/brain/ingest/*` walk scoping via `src/core/fs/ignore.ts`
  pattern matching, tests.
- **Acceptance**: ingest of a monorepo scoped with `--src-subpath pkg/a`
  processes only that subtree; `--exclude` patterns compose with ignore
  handling (same engine, no duplicate matcher); a subpath outside the source
  root rejects with a typed error; without the new flags ingest planning is
  byte-identical to today.
- **Depends on**: P1 (`src/core/fs/ignore.ts`).

### Task P3 - extractable flag gate in discovery (`t_ed856388`, p3)
- **Files**: page-discovery path (locate the pack iteration), gate consuming
  the existing `extractable` schema flag, tests.
- **Acceptance**: pages in packs marked non-extractable are skipped before
  extraction and reported as skipped-with-reason in the discovery result;
  packs without the flag behave exactly as today; the skip is logged, not
  silent; no schema mutation surface changes.
- **Depends on**: none.

### Task P4 - no-LLM code-structure pre-ingest extractor (`t_ef786747`, p3)
- **Files**: new `src/core/brain/ingest/pre-extract.ts` (deterministic
  stdlib-only structural extractor: classes/functions/imports/inheritance
  edges as JSON seeds), wiring in `src/core/brain/ingest/ingest.ts` to pass
  seeds to the agent step, CLI/MCP exposure of the pre-pass, tests.
- **Acceptance**: running the pre-pass on a TypeScript/JavaScript and Python
  source produces deterministic JSON entity/edge seeds (same input, same
  output); unknown languages are reported as unextracted, never a fake empty
  success; ingest with the pre-pass off is byte-identical to today; no
  natural-language word lists; no new dependencies.
- **Depends on**: none (P2's scoping optional at call site).

### Task P5 - dispatched-vs-ingested reconciliation (`t_d067a153`, p3)
- **Files**: new `src/core/brain/ingest/reconcile.ts` (`reconcilePlan`
  keyed on `planId` diffing `BatchPlan` dispatched set vs checkpoint
  completed set), invocation after a batch/plan drains, CLI/MCP surfacing of
  the gap report, tests.
- **Acceptance**: a plan whose agent response omits dispatched files yields
  a reconciliation report naming each lost source; a fully completed plan
  reports an empty gap; the report is a warning surface, not a retry; the
  reconcile is idempotent and read-only over checkpoint state.
- **Depends on**: none.

### Task Q1 - inline citation promotion to temporal timeline (`t_a3d1adb0`, p3)
- **Files**: new `src/core/temporal/citations.ts` (structural
  `[Source: <name>, YYYY-MM-DD]` marker parser + promotion into temporal
  log/provenance sinks), scan surface (CLI/MCP), tests.
- **Acceptance**: a note containing a well-formed citation marker produces a
  dated provenance event on the timeline; re-scanning does not duplicate
  (dedup on normalized name + date against already-logged source events);
  malformed markers (bad date shape, missing comma) are reported explicitly
  and skipped; notes without markers produce no events; parsing is purely
  structural.
- **Depends on**: none.

### Task Q2 - configurable FTS tokenizer (`t_618f7211`, p3)
- **Files**: `src/core/search/schema.ts` (tokenizer string assembled from
  config), config keys (e.g. `search.fts_tokenizer.*`), validation, docs
  note that changing config requires `o2b search reindex`, tests.
- **Acceptance**: with no config the generated schema keeps
  `unicode61 remove_diacritics 2` byte-identically; valid config changes the
  tokenizer clause after reindex; invalid tokenizer options reject with a
  typed error listing allowed values; the CJK trigram path is untouched
  (its tests stay green); no implicit reindex.
- **Depends on**: none.

### Task Q3 - graph-degree predicates in filter DSL (`t_9bee8f0b`, p3)
- **Files**: `src/core/search/property-filter.ts` (count predicates over
  backlinks/outlinks), degree lookup via existing
  `src/core/brain/link-graph/graph-index.ts` data, `src/cli/search.ts` and
  MCP filter surface, tests.
- **Acceptance**: filters can select notes by backlink/outlink count with
  `=`, `!=`, `>`, `>=`, `<`, `<=` (orphans `= 0`, hubs `>= N`); results match
  the graph index degree data; invalid predicate syntax rejects with a typed
  error; queries without degree predicates behave byte-identically.
- **Depends on**: none.

### Task O2 - doctor repair mode (`t_bd6cc4cb`, p3, diagnostics anchor)
- **Files**: diagnostics-signal model (issue class + detector + optional
  fixer + next-command hint) co-located with `src/core/brain/doctor.ts`,
  `--repair` (dry-run preview default) and `--apply` on the doctor CLI/MCP,
  fixers only for issue classes doctor already detects (orphaned references,
  WAL gaps), typed event per applied fix, tests.
- **Acceptance**: `doctor --repair` previews planned fixes without writing;
  `--repair --apply` performs them and logs one typed event per fix;
  re-running after apply is a no-op (idempotent); `--strict` and plain
  doctor remain read-only and byte-identical; unfixable issue classes state
  so explicitly.
- **Depends on**: none.

### Task O3 - unified operator status snapshot (`t_9f9c5466`, p3)
- **Files**: snapshot verb (CLI + MCP) composing existing signal sources
  (health, doctor, hygiene, stale scan, review candidates, active profile,
  state-file health) through the diagnostics-signal model, per-problem
  next-command hint rendering, tests.
- **Acceptance**: one command prints a consolidated readable snapshot with
  counts, stale/orphaned, review queue depth, active profile, and state
  health; every problem line carries the exact next command to run (hint
  supplied by the signal definition, not hardcoded in the formatter); a
  healthy vault prints a compact all-clear; snapshot performs reads only.
- **Depends on**: O2 (diagnostics-signal model).

### Task L - docs, CHANGELOG, version bump
- **Files**: `README.md`, `CHANGELOG.md` (`## [1.34.0]` + link reference),
  `docs/cli-reference.md`, `docs/mcp.md`, `package.json` 1.34.0 +
  `bun run scripts/sync-version.ts`.
- **Acceptance**: one CHANGELOG entry covers all eleven units;
  `bun run sync-version:check` passes; README and reference docs cover the
  new surfaces.
- **Depends on**: all previous tasks.
