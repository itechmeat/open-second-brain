# Source pipeline integrity and operator tooling - one wave, eleven units

**Status:** accepted
**Author:** Claude orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Sources enter the vault through paths that cannot be scoped or gated, batches
can silently lose documents, prose citations never reach the temporal layer,
and vault health signals are scattered across six read-only surfaces with no
repair action. This wave makes intake trustworthy end to end: scoped and
gated discovery, reconciled dispatch, deterministic pre-extraction, citation
provenance, configurable indexing, degree-aware querying, and an operator
toolchain that can both summarize and repair.

## Scope

Eleven kanban tasks ship as one PR and one release (v1.34.0):

- `t_2ed754d1` early-closed stdout pipe exits clean in `o2b` / `vault-log`
- `t_9654de80` nested `.gitignore` composition in the hygiene file scan
- `t_e82101a5` `--src-subpath` / `--exclude` scoping on source ingest
- `t_ed856388` `extractable` flag honored during page discovery
- `t_ef786747` local no-LLM code-structure extractor as a pre-ingest pass
- `t_d067a153` dispatched-vs-ingested reconciliation for batch ingest plans
- `t_a3d1adb0` inline `[Source: <name>, YYYY-MM-DD]` citations become dated
  provenance events on the temporal timeline
- `t_618f7211` configurable FTS tokenizer language and diacritic rules
- `t_9bee8f0b` graph-degree cardinality predicates in the search/filter DSL
- `t_bd6cc4cb` `o2b brain doctor --repair` for the issue classes doctor
  already detects
- `t_9f9c5466` unified operator status snapshot with per-problem
  next-command hints

## Out of scope

- Rebuilding the reindex command (exists as `o2b search reindex`).
- Replacing or extending the codegraph partner integration; the pre-ingest
  extractor is a fallback pre-pass, not a codegraph substitute.
- Tree-sitter or any non-stdlib parsing backend for the extractor.
- An interactive profile explorer or onboarding scaffolder (different theme).
- Repair actions for issue classes doctor does not already detect.
- `t_71f96533` (created_at bounds on raw-session grep) is excluded as a
  duplicate: v1.33.0 already shipped `since` / `before` on session grep.

## Chosen approach

Consultant Variant 1: two shared kernels, cluster-local units. Exactly two
new shared abstractions, each riding inside the first feature commit that
needs it:

1. **Path-scope engine** `src/core/fs/ignore.ts` - nested ignore-file
   composition with git semantics (deeper file scopes its subtree,
   nearer `!` re-include wins, `.git/info/exclude` layering). Introduced by
   the hygiene-scan unit (P1), consumed by ingest scoping (P2). It sits
   below both `hygiene/` and `brain/ingest/`, keeping layering
   one-directional.
2. **Diagnostics-signal model** - issue class + detector + optional fixer +
   next-command hint, introduced by `doctor --repair` (O2) and consumed by
   the unified status snapshot (O3), so hints travel with issue definitions
   instead of being duplicated in the snapshot formatter.

Every other unit is a local change to its existing module. Four clusters:
scope/gate (P1 -> P2 -> P3), ingest integrity (P4, P5), provenance/query
(Q1, Q2, Q3), operator surface (O1, O2 -> O3). Hard dependency edges are
only P1 before P2 and O2 before O3; every prefix of the ship order leaves
`main` releasable.

## Design decisions

- **Ignore engine location** `src/core/fs/ignore.ts`, not under `hygiene/`
  or `ingest/`: both consume it; one home, no reach-across imports.
- **Byte-identical opt-out everywhere**: unset config, absent flags, and
  unconfigured features must leave existing outputs unchanged;
  regression-tested per unit.
- **Explicit errors, no silent fallbacks**: malformed ignore patterns,
  invalid tokenizer configs, invalid degree predicates, malformed repair
  targets, and unknown citation dates surface as typed errors or explicit
  warnings; nothing is silently skipped without a report.
- **Reconciliation is a report, not a retry**: `reconcilePlan(planId)` diffs
  the dispatched set against completed entries and returns/warns the gap;
  it does not re-dispatch (that stays operator-driven).
- **Extractor stays deterministic and stdlib-only**: structural parsing per
  language family via regex/line grammar, emitting JSON entity/edge seeds
  that ingest passes to the agent as pre-extracted facts; no natural-language
  word lists, no LLM in the kernel.
- **Citation syntax is structural**: `[Source: <name>, YYYY-MM-DD]` is a
  fixed marker grammar with an ISO-shaped date; no language-specific parsing.
  Dedup key is (normalized name, date) against already-logged source events.
- **Tokenizer config composes with CJK**: config selects FTS5 tokenizer
  options (stemming/diacritics); the existing trigram prefilter path is
  untouched. Changing the config requires an explicit `o2b search reindex`;
  the CLI says so rather than reindexing implicitly.
- **Degree predicates read the existing graph index**: the DSL gains count
  predicates over backlinks/outlinks backed by `graph-index.ts` degree data;
  no new graph computation.
- **Repair is opt-in and previewed**: `doctor --repair` defaults to dry-run
  preview; `--apply` performs fixes; `--strict` read-only behavior is
  unchanged. Every applied fix logs a typed event.
- **EPIPE handling is scoped to stdout write failures**: an early-closed
  stdout pipe exits 0; all other I/O errors keep failing loudly.
- **MCP parity**: agent-relevant new surfaces (status snapshot, repair
  preview, degree predicates, citation scan) get MCP counterparts; frozen
  parity lists and tool-count tests update accordingly.

## File changes

New: `src/core/fs/ignore.ts`, `src/core/brain/ingest/pre-extract.ts` (code
structure extractor), `src/core/brain/ingest/reconcile.ts`,
`src/core/temporal/citations.ts`, diagnostics-signal module next to
`doctor.ts`, snapshot verb module, tests per unit.

Modified: `src/core/hygiene/scan-repo.ts`, ingest CLI/MCP surface and
`ingest.ts` / `batch-plan.ts` / `checkpoint.ts`, discovery path consuming
`extractable`, `src/core/search/schema.ts` + config for tokenizer,
`src/core/search/property-filter.ts` + `src/cli/search.ts` for degree
predicates, `src/cli/main.ts` / `scripts/*` for EPIPE, doctor CLI/MCP,
docs and manifests (version 1.34.0).

## Risks and open questions

- Gitignore composition has sharp edge cases (anchoring, directory-only
  patterns, `!` precedence); mitigate with a property/table test suite
  mirroring git's documented rules. Full `git check-ignore` parity is not
  claimed; the supported subset is documented.
- The extractor's language coverage is bounded; unknown languages must fall
  through to today's behavior explicitly (reported as unextracted, never a
  fake empty result).
- Repair fixers touch vault files; every fixer needs a preview diff and an
  idempotency test.
- The diagnostics-signal model shape is set by O2 and may need a small
  extension when O3 lands; acceptable churn inside one branch.
- MCP tool-count and description-budget guards will need deliberate updates;
  keep additions within the 300-char description cap.
