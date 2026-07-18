# Belief lifecycle and decision memory - wave design

**Status:** approved for implementation
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Release:** v1.33.0, single PR, per-unit atomic commits

## Problem statement

Open Second Brain records beliefs but not their lifecycle. Supersession exists
only as a bare `superseded_by` relation scoped to the claim ledger; a wrong or
replaced memory is edited or removed with no tombstone, no replacement link,
and no receipt of why the belief changed. Detected contradictions have no
durable state, so they silently re-fire. Decisions - the highest-value operator
memories - have no first-class artifact, no rating, no review obligation, no
commitment vocabulary, and are never proactively resurfaced. Transcript turns
lose their authored time at the search layer, so recall cannot prefer recent
statements or answer time-bounded questions.

## Scope

Eleven kanban tasks shipped as one release, organized as two anchored tracks
plus two standalone units (consultant Variant 3):

**Track A - supersession spine** (anchor first, later units consume it):
- `t_7d5a3589` (anchor) - cross-type tombstone + supersede lifecycle module,
  curator read slices over observed-use verdicts.
- `t_3ba9c404` - atomic temporal fact-replacement with half-open
  `valid_from`/`valid_to` intervals.
- `t_6916369f` - persisted claim-graph projection + one query surface
  ("true now / used to be true / replaced by / contested by").
- `t_d9365884` - supersedes-chain consumer policy: inject prefers chain tips,
  recall annotates replacements, decay accelerates for low-recall ancestors.

**Track B - decision memory** (anchor first):
- `t_ac03214d` (anchor) - decision-record note type: assumption, review_date
  (opens an obligation), outcome backfill, similar-decision recall, optional
  pre-mortem field.
- `t_6fe43fcc` - rated decision capture: rating + rationale fields and a
  searchable list/compare surface, separate from ordinary signals.
- `t_e112c63c` - commitment tier (`exploring | leaning | decided | locked`)
  rendered in injected text in place of the raw confidence float when set.
- `t_3547314d` - `decision_change.v1` receipts: before/after/evidence/
  confidence-delta/actor/reason at the moment a belief changes, idempotent,
  with a paginated history query.
- `t_5712fa39` - recall rated decisions verbatim on deterministically matching
  prompts, governed by per-session caps and spacing.

**Standalone units:**
- `t_347e8224` - conversation chronology: `authored_at` on indexed transcript
  turns, surfaced in search, recency tie-break on exact hybrid-score ties,
  since/before bounds, idempotent dry-run-first backfill.
- `t_0e3f2bee` - tension objects: persisted contradiction notes with an
  open -> confirmed/dismissed/resolved state machine and injection-time
  warnings for unresolved tensions.

## Out of scope

- `t_469e4cfa` (typed revertible lifecycle history / undo) - needs its own ADR
  wave; receipts here are append-only accountability, not rollback.
- `t_b0c9d0a3` (overwrite-only exact-state lane) - separate storage
  architecture.
- Any rewrite of existing extractors, conflict-resolution supersede, or the
  truth ledger event format.
- LLM-based prompt matching or transcript classification (kernel stays
  deterministic).

## Chosen approach

Consultant Variant 3: cluster tracks with anchor-unit-owned abstractions. The
first unit of each track ships the track's shared module as part of its own
feature commit; later units consume it. No infrastructure-only commits, no
cross-subsystem framework. The single cross-track shared piece is an
injection-governor helper introduced by the chain-policy unit and reused by
the rated-decision recall unit.

## Design decisions

- **Lifecycle module home**: Track A's shared core lands as
  `src/core/brain/lifecycle/tombstone.ts` (tombstone/supersede state machine,
  idempotency, chain-tip resolver `resolveChainTip`) plus
  `src/core/brain/lifecycle/temporal-replace.ts` (half-open interval
  replacement). One-directional imports only: lifecycle imports from
  `preference.ts`/`types.ts`, never the reverse.
- **Tombstone is frontmatter, not deletion**: `_status: "tombstoned"`,
  `tombstoned_at`, `tombstone_reason`, optional `superseded_by`. Re-issuing a
  tombstone is a no-op returning the existing state. Tombstoned and
  superseded-non-tip entries are excluded from recall/inject/active.md but
  remain on disk for audit; dream/compaction respects the exclusion.
- **Temporal replacement reuses `superseded_by`** as the successor link. The
  operation closes the predecessor (`valid_to = T`) and opens the successor
  (`valid_from = T`) at one shared instant; intervals are half-open
  `[valid_from, valid_to)`. Date-only facts keep whole-day semantics. This
  layer does not touch the existing conflict-resolution supersede in
  hygiene/resolve-conflicts.
- **Claim graph is a projection, not a store of record**: built from existing
  relations (`superseded_by`, `contradicts`) plus bi-temporal validity fields,
  persisted as a bounded JSON artifact under the brain store, rebuilt
  deterministically; query surface is one CLI verb (`o2b brain claims`) and one
  MCP tool answering point-in-time and history questions. Current-truth is the
  default; history is opt-in.
- **Chain consumer policy** lives at existing choke points: inject
  (context-pack/inject path prefers `resolveChainTip` results under budget),
  recall (annotates superseded hits with the replacement pointer via the
  existing enrich layer), decay (dream pass accelerates retirement of
  low-recall superseded ancestors). Historical queries bypass tip-preference
  via an explicit flag, not language detection.
- **Decision records are a new note family** under `Brain/decisions/` with
  frontmatter `type: decision`, `chosen`, `assumption`, `review_date`,
  `outcome` (backfilled), optional `premortem`, plus rating fields from the
  rated-capture unit (`rating`, `rationale`). `review_date` maps onto the
  existing obligations engine (one obligation per decision review). Outcome
  backfill is a logged mutation. Similar-decision recall reuses the existing
  search machinery scoped to the decision family.
- **Commitment tier is additive**: optional frontmatter `commitment` with the
  four-value vocabulary on preferences, theses, and decision records;
  `active.ts` and the context-pack formatter render the tier label when set
  and fall back to the confidence band byte-identically when unset.
- **Receipts are JSONL, Syncthing-safe**: `decision_change.v1` records append
  to a receipts log alongside the truth ledger shards, keyed by a durable
  idempotency key (hash of subject id + before-state + after-state); replays
  are no-ops. History query paginates with an opaque cursor. Free-text hidden
  reasoning fields are rejected by the schema; only the accountable fields
  listed in the task ship. Receipt emission hooks the lifecycle module's
  supersede/tombstone path and the preference-confidence update path.
- **Injection governor** is one helper (`src/core/brain/inject-governor.ts`)
  owning per-session caps, spacing, and tip-preference bookkeeping; introduced
  by the chain-policy unit, extended (caps/spacing for rated decisions) by the
  recall unit. Prompt matching for decision recall is deterministic
  token/anchor overlap - no LLM, no language-specific word lists.
- **Chronology**: `authored_at` carried from the already-preserved turn
  instant (`resolveEventInstant`) into indexed documents and search results;
  exact hybrid-score ties break toward more recent `authored_at`; `session_grep`
  and session-recall gain `since`/`before` bounds parsed by the existing
  `time-range.ts`; backfill command is idempotent, dry-run by default, and
  never re-embeds.
- **Tensions**: `Brain/tensions/tension-<slug>.md` notes created from detected
  contradictions with `_status: open | confirmed | dismissed | resolved`;
  deterministic dedup key (subject pair + stance signature) so re-detection
  updates instead of duplicating; context-pack build emits a warning line when
  a subject note of an unresolved tension is included.
- **Event kinds**: new `BRAIN_LOG_EVENT_KIND` entries (`tombstone`,
  `temporal-replace`, `decision-record`, `decision-outcome`,
  `decision-change-receipt`, `tension`, `chain-decay`) extend the existing
  const object.
- **Errors and config**: each new module declares its own `XxxError extends
  Error`; config keys follow the paired `FOO_CONFIG_KEY`/`OPEN_SECOND_BRAIN_*`
  env pattern in `src/core/config.ts` (`decision_recall.max_per_session`,
  `decision_recall.min_spacing_turns`).

## File changes

New: `src/core/brain/lifecycle/tombstone.ts`, `lifecycle/temporal-replace.ts`,
`src/core/brain/claim-graph.ts`, `src/core/brain/decisions/record.ts`,
`decisions/receipts.ts`, `src/core/brain/inject-governor.ts`,
`src/core/brain/tensions.ts`, CLI verbs (`lifecycle`, `claims`, `decision`,
`tensions`, `backfill-authored-at` under existing verb files where natural),
MCP tool additions in existing `src/mcp/brain/*-tools.ts` slices, tests
mirroring each module under `tests/`.

Modified: `src/core/brain/types.ts` (event kinds), `preference.ts` (commitment
field passthrough), `active.ts` + `context-pack.ts` (tier render, tension
warnings, tip preference), `dream.ts`/`dream-refresh.ts` (decay, exclusion),
`src/core/search/enrich.ts` (replacement pointer annotation),
`src/core/search/fusion.ts` or `ranker.ts` (recency tie-break),
`src/core/search/indexer.ts`/`walker.ts` (authored_at),
`src/mcp/brain/recall-tools.ts` (since/before), `src/core/brain/obligations.ts`
(decision-review obligation source), `src/cli/brain.ts` + `help-text.ts`,
`src/core/config.ts`, docs (`README.md`, `CHANGELOG.md`,
`docs/cli-reference.md`, `docs/mcp.md`).

## Risks and open questions

- Anchor commits (t_7d5a3589, t_ac03214d) are larger than average; mitigated
  by TDD and by keeping curator slices/pre-mortem optional sub-features inside
  the same commit.
- A mid-track flaw in the anchor abstraction means churn on the release
  branch; acceptable, branch is unpushed until phase 6.
- Injection changes (chain tips + rated-decision recall + tension warnings)
  all touch context assembly; the injection governor and context-pack are the
  only two choke points allowed to change, and each unit adds tests proving
  the others' behavior is preserved.
- Recency tie-break must not reorder non-tied results: applies strictly on
  exact score equality after fusion.
- Backfill touches every indexed session document; dry-run default plus
  snapshot-free (non-destructive, additive field) keeps it safe; no
  re-embedding by construction.
