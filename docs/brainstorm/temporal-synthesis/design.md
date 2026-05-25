# Temporal + synthesis - one timeline index, five projections, two new atoms

**Status:** draft
**Author:** @claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain has no first-class time axis. Preferences carry
scattered date scalars (`created_at`, `confirmed_at`,
`last_evidence_at`, `retired_at`, `unconfirmed_until`) and per-day
event logs land in `Brain/log/<date>.jsonl`, but no helper assembles
a chronological view: per preference, per topic, or per window.
Operators cannot ask "how did my position on X evolve", agents
cannot answer "what changed in the vault this week", and the
`brain_doctor` / `brain_digest` surfaces have no notion of staleness
or activity drift over time. Synthesis surfaces (daily / weekly
briefs) that the operator wants would, without a temporal layer,
degenerate into point-in-time counters - they could not show drift.

## Scope

- New named subsystem `src/core/brain/temporal/` (one per release,
  precedent: v0.10.17 `link-graph/`).
- Atoms (data-shape additions):
  - `TemporalEvent` - normalized chronological event drawn from
    `Brain/log/<date>.jsonl`, retired/, and preference frontmatter.
    Flat shape with `at: string` (canonical UTC ISO), `kind:
    BrainLogEventKind` (reuses the existing event-kind enum), plus
    optional denormalized slots (`prefId`, `topic`, `result`,
    `artifact`, `transitionFrom`, `transitionTo`, `reason`, `text`,
    `validFrom`, `validUntil`, `recordedAt`, `source`).
  - `TimelineIndex` - frozen materialized view of all events in a
    requested window, grouped by kind / pref_id / topic.
  - Bi-temporal frontmatter atoms (additive optionals on preference
    + signal frontmatter): `valid_from`, `valid_until`,
    `recorded_at`. Read-only this release; write paths can land in
    a future release without breaking compatibility.
  - New `temporal:` block in `_brain.yaml` (parallel to `link_graph:`).
- Pure helpers (projections over `TimelineIndex`):
  - `temporal/build-index.ts` - `buildTimelineIndex(vault, opts)`.
  - `temporal/select-events.ts` - `selectEvents(index, filters)`.
  - `temporal/belief-evolution.ts` -
    `buildBeliefEvolution(index, vault, target)`.
  - `temporal/stale-watch.ts` - `findStaleEntries(index, vault, cfg)`.
  - `temporal/daily-brief.ts` - `buildDailyBrief(index, vault, date)`.
  - `temporal/weekly-brief.ts` -
    `buildWeeklySynthesis(index, vault, weekEnd)`.
- Consumers (CLI + MCP):
  - Five new full-scope MCP tools: `brain_timeline`,
    `brain_belief_evolution`, `brain_stale_scan`,
    `brain_daily_brief`, `brain_weekly_synthesis`.
  - Five new CLI verbs: `o2b brain timeline`, `evolution`, `stale`,
    `daily`, `weekly`.
- Tests:
  - Unit tests for every atom + helper under
    `tests/core/brain/temporal/`.
  - MCP shape tests under `tests/mcp/`.
  - CLI surface tests under `tests/cli/`.

## Out of scope

- Writing the new bi-temporal frontmatter atoms (`valid_from` /
  `valid_until`) - this release reads them where they exist;
  bulk-write tooling, dream-pass automatic timestamping, and
  migration scripts are deferred to a future release.
- Temporal *intent classifier* (the "is this query temporal" regex
  from gbrain a19ee8b): forbidden by project pref
  `language-agnostic-only`. Operator invokes the temporal helpers
  explicitly through CLI / MCP, not through query-text sniffing.
- LLM-driven synthesis prose. Helpers return deterministic data
  shapes; the agent does narrative work externally.
- `brain_search` integration - timeline surfaces stay separate
  this release. (Future: a `from:/until:` search modifier could
  use the same atom layer.)
- `complexity-vs-activity ratio` (`t_03752ca6`) - deferred; ties
  into `src/core/discipline/` rather than `temporal/`. Leaving
  for a discipline-focused release.
- Two-stage signal review gate (`t_ef94345e`) - dream-pass change,
  unrelated to temporal axis.

## Chosen approach

Variant 1 from `variants.md`: a single materialized `TimelineIndex`
plus pure projections. The atom layer adds three frontmatter slots
and one event type; the index builder scans `Brain/log/*.jsonl`,
`Brain/retired/`, and active preference frontmatter once per
invocation; five helpers project the index into operator-facing
shapes; five consumers (CLI verbs and MCP tools) expose the
helpers. The index is frozen and only ever built from disk in one
place, so every helper observes the same window semantics, the
same retirement treatment, and the same source-pointer
resolution.

Window semantics are inclusive at `since` and exclusive at `until`
(`[since, until)`), expressed as ISO-8601 UTC timestamps. Days are
expressed via the existing `validateIsoDate` helper. Weekly windows
default to ISO-8601 week boundaries (Monday 00:00:00 UTC -
following Monday 00:00:00 UTC), configurable via the
`temporal.weekly_start_dow` slot which takes ISO-8601 weekday
numbers (1=Monday ... 7=Sunday) - no language hardcoding.

Belief-evolution follows topic-renames across slugs by chaining
`supersedes` / `superseded_by` links on retired entries. The
chain-walker is bounded by the count of retired entries (no
infinite recursion even on a malformed chain).

Stale-watch reads three thresholds from config
(`temporal.stale_pref_days`, `temporal.stale_signal_days`,
`temporal.stale_log_days`), defaulted to 90 / 30 / 180 days
respectively. Pure structural staleness based on the most-recent
event-time stamp per entry; nothing about content.

Daily-brief returns event counts grouped by `BrainLogEventKind`,
the set of preferences whose status transitioned in the window
(derived from `promote` / `retire` / `force-confirmed` / `reject`
events), the vault delta (new feedback signals / new retired /
applied / violated counts) versus the previous day, and the list
of source-pointers cited. Weekly-synthesis returns the same shape
over a 7-day window plus contradiction counts (combining
`signal-suppressed` events with `apply-evidence` events where the
payload `result` is `"violated"`) and a "retired in window" list.

## Design decisions

- **One materialized index, five projections.** Sharing data, not
  operations, eliminates window-semantics drift and matches the
  v0.10.17 `link-graph/` precedent.
- **Atoms are additive optionals.** `BrainPreference`,
  `BrainSignal`, and `BrainRetiredRecord` frontmatter readers grow
  optional `valid_from` / `valid_until` / `recorded_at` slots;
  existing files stay byte-identical when not opted in.
- **Index builder is the single disk-touching helper.** The five
  projection helpers are pure functions over the frozen index,
  trivially testable with synthetic fixtures.
- **ISO-8601 everywhere.** All timestamps in `TimelineIndex` are
  canonical UTC strings of the shape `YYYY-MM-DDTHH:MM:SSZ` (or
  `.SSSZ` when source data carries sub-second precision), matching
  `log-jsonl.ts`'s `ISO_UTC_TS_RE`. Window inputs accept either an
  ISO date (interpreted as `T00:00:00Z`) or a full ISO timestamp.
- **Weekly weekday number is configured, not detected.** No
  English-word detection like "Monday"; the slot takes 1-7 per
  ISO-8601, defaulted to 1 (Monday).
- **`since` inclusive, `until` exclusive.** Mirrors the existing
  digest convention in `digest.ts` (`window: {since, until}`).
- **Briefs do NOT call the LLM.** They are deterministic counters
  + status-transition lists + source-pointer arrays. Operator-side
  agents do the narrative work over the structured payload.
- **MCP tools register in full scope only.** Writer scope stays
  frozen at four tools. Five new tools land alongside
  `brain_unlinked_mentions` / `brain_concept_synthesis` /
  `brain_moc_audit` in the full scope. Tool-count assertion in
  `tests/mcp/mcp.test.ts` updates from 26 to 31.
- **CLI verbs follow `o2b brain <verb>` convention.** Each verb
  reuses the existing `--vault` / `--json` flags via the shared
  CLI helpers.

## File changes

### New files

```
src/core/brain/temporal/types.ts            # TemporalEvent + TimelineIndex + config defaults
src/core/brain/temporal/build-index.ts      # buildTimelineIndex(vault, opts)
src/core/brain/temporal/select-events.ts    # selectEvents(index, filters)
src/core/brain/temporal/belief-evolution.ts # buildBeliefEvolution(index, vault, target)
src/core/brain/temporal/stale-watch.ts      # findStaleEntries(index, vault, cfg)
src/core/brain/temporal/daily-brief.ts      # buildDailyBrief(index, vault, date)
src/core/brain/temporal/weekly-brief.ts     # buildWeeklySynthesis(index, vault, weekEnd)

src/cli/brain/verbs/temporal-timeline.ts    # o2b brain timeline
src/cli/brain/verbs/temporal-evolution.ts   # o2b brain evolution
src/cli/brain/verbs/temporal-stale.ts       # o2b brain stale
src/cli/brain/verbs/temporal-daily.ts       # o2b brain daily
src/cli/brain/verbs/temporal-weekly.ts      # o2b brain weekly

tests/core/brain/temporal/build-index.test.ts
tests/core/brain/temporal/select-events.test.ts
tests/core/brain/temporal/belief-evolution.test.ts
tests/core/brain/temporal/stale-watch.test.ts
tests/core/brain/temporal/daily-brief.test.ts
tests/core/brain/temporal/weekly-brief.test.ts
tests/core/brain/temporal/bi-temporal-atoms.test.ts
tests/mcp/temporal-mcp-tools.test.ts
tests/cli/brain-temporal-cli.test.ts
```

### Modified files

```
src/core/brain/policy.ts        # BRAIN_TEMPORAL_DEFAULTS + resolveTemporal() + temporal: validator
src/core/brain/types.ts         # BrainTemporalConfig + ResolvedBrainTemporalConfig + BrainConfig.temporal?
src/core/brain/preference.ts    # read optional valid_from/valid_until/recorded_at
src/core/brain/signal.ts        # read optional valid_from/valid_until/recorded_at
src/core/brain/dream.ts         # RetiredRecord: optional valid_from/valid_until/recorded_at
src/mcp/brain-tools.ts          # five new tool registrations
src/cli/brain.ts                # dispatch five new verbs
src/cli/brain/verbs/index.ts    # register five new verbs
src/cli/brain/help-text.ts      # help block for five new verbs

tests/mcp/mcp.test.ts           # 26 -> 31 tool inventory assertion
```

Approximate file count: 17 new (helpers + verbs) + 9 new tests +
9 modified = ~35-40 source files plus the brainstorm + design +
plan + cli-output set (3 + cli-output) brings the PR to ~45-55
files. README + CHANGELOG + version manifests add another ~10
during phases 5-6.

## Risks and open questions

- **Index width.** If the materialized event shape needs a new
  field mid-implementation (e.g. evidence-violated needs a
  contradiction-target slot), the atom is widened in `types.ts`
  and every helper rebuilds. Mitigation: settle the
  `TemporalEvent` field list during phase 0 step 7 (now) and
  resist creep; future fields can land as additive optionals
  exactly like backlink atoms in v0.10.17.
- **Retired-chain cycles.** Bad `supersedes` / `superseded_by`
  links could loop. Mitigation: chain-walker carries a visited
  set; break with a warning emit, never throw.
- **Weekly boundary on DST / timezone vaults.** All math is in UTC.
  Operators in non-UTC timezones see weeks that don't align with
  their local calendar. Acceptable for v0.10.18 - the brief shape
  already includes the literal ISO timestamps; downstream agents
  can re-window locally. Future release can add a
  `temporal.timezone` slot if operator demand exists.
- **Empty vault.** All projection helpers must return frozen empty
  envelopes (not throw) when the timeline has zero events in the
  window. Covered in tests.
- **Sub-second timestamps in JSONL vs second-precision in
  retired/.** The index normalizes both to the canonical UTC shape
  before grouping; collisions on the same second are resolved by
  source-pointer order (deterministic).
