# Temporal + synthesis - implementation plan

Order matters - the materialized-index variant has a strict layered
DAG (atoms - index - projections - consumers). Each task lands on
`feat/temporal-synthesis` as a separate conventional commit on top
of the brainstorm commit.

## Tasks

### Task 1: Temporal atoms + config block

- **Files**: `src/core/brain/temporal/types.ts` (new),
  `src/core/brain/types.ts` (modified - add `BrainTemporalConfig` +
  `ResolvedBrainTemporalConfig` + `BrainConfig.temporal?`),
  `src/core/brain/policy.ts` (modified - add
  `BRAIN_TEMPORAL_DEFAULTS`, `resolveTemporal(cfg)`, `temporal:`
  validator with safe-integer / range checks),
  `tests/core/brain/temporal/bi-temporal-atoms.test.ts` (new).
- **Acceptance**:
  - `TemporalEvent` is a flat shape with `at: string` (canonical
    UTC ISO), `kind: BrainLogEventKind` (reuses existing enum
    values verbatim), `source: TemporalEventSource` (vault-relative
    log path + line number when known), plus optional denormalized
    slots: `prefId`, `topic`, `result`, `artifact`,
    `transitionFrom`, `transitionTo`, `reason`, `text`,
    `validFrom`, `validUntil`, `recordedAt`. Frozen via
    `Object.freeze`.
  - `TimelineIndex` is a frozen `{events, eventsByKind,
    eventsByPrefId, eventsByTopic, window}` shape.
  - `BRAIN_TEMPORAL_DEFAULTS` exposes `stale_pref_days: 90`,
    `stale_signal_days: 30`, `stale_log_days: 180`,
    `weekly_start_dow: 1`, `daily_window_offset_hours: 0`.
  - `resolveTemporal(cfg)` returns a fully-populated config; absent
    block falls back to defaults.
  - Validator rejects: non-positive integers, weekly_start_dow
    outside [1, 7], offset_hours outside [-23, 23].
  - Test covers happy-path config, defaults fallback, and each
    validator branch.
- **Depends on**: none.

### Task 2: TimelineIndex builder

- **Files**: `src/core/brain/temporal/build-index.ts` (new),
  `tests/core/brain/temporal/build-index.test.ts` (new).
- **Acceptance**:
  - `buildTimelineIndex(vault, opts)` walks
    `Brain/log/<date>.jsonl` via existing `readLogDay` for every
    date file in the window, plus `Brain/retired/*.md` via existing
    `readAllRetired` shape, plus active preference frontmatter via
    existing `readPreference` shape, and returns a frozen
    `TimelineIndex`.
  - Window inputs: `since?` (ISO date or full ISO timestamp),
    `until?` (ISO date or full ISO timestamp). Default `since` is
    epoch; default `until` is now + 1ms (exclusive).
  - All event timestamps normalized to canonical UTC string before
    grouping. Sub-second precision preserved when present.
  - Tie-breaker for equal timestamps: source-pointer order (so the
    result is deterministic).
  - Test: synthetic vault with three JSONL files + two retired
    entries + four active prefs; assert events list, kind groups,
    pref groups, topic groups, and frozen-ness.
  - Empty vault: returns frozen index with zero events and empty
    groups (no throw).
- **Depends on**: Task 1.

### Task 3: Select-events projection + bi-temporal frontmatter reader

- **Files**: `src/core/brain/temporal/select-events.ts` (new),
  `src/core/brain/preference.ts` (modified - additive
  `valid_from?`, `valid_until?`, `recorded_at?` optional reads on
  the existing frontmatter reader), `src/core/brain/signal.ts`
  (modified - same three optional slots),
  `src/core/brain/dream.ts` (modified - `RetiredRecord` gains
  three optional slots),
  `tests/core/brain/temporal/select-events.test.ts` (new).
- **Acceptance**:
  - `selectEvents(index, filters)` accepts
    `{pref_id?, topic?, kind?, since?, until?}` and returns a
    frozen `ReadonlyArray<TemporalEvent>` filtered by the AND of
    every set predicate.
  - When no filter is set, returns the index's full events array
    (still frozen, same reference is fine).
  - Bi-temporal atom reads: existing files without the new keys
    parse as before (no schema break); files with `valid_from`
    set surface it on `TemporalEvent.validFrom`; same for
    `valid_until` and `recorded_at`.
  - Test: every filter combination across a 6-event synthetic
    fixture; empty-filter happy path; bi-temporal atom presence /
    absence smoke.
- **Depends on**: Task 2.

### Task 4: Belief-evolution helper

- **Files**: `src/core/brain/temporal/belief-evolution.ts` (new),
  `tests/core/brain/temporal/belief-evolution.test.ts` (new).
- **Acceptance**:
  - `buildBeliefEvolution(index, vault, target)` accepts
    `target: {prefId: string} | {topic: string}` and returns a
    frozen
    `{target, transitions, evidence, retirements, generatedAt}`
    envelope.
  - `transitions` is the chronological list of status changes
    (`unconfirmed -> confirmed -> quarantine -> retired`,
    intermediate states emitted), each entry carries `at`, `from`,
    `to`, and the originating event reference.
  - `evidence` is the chronological list of applied / violated /
    outdated events with a per-phase running count.
  - `retirements` covers the retired entry plus the chain of
    `supersedes` / `superseded_by` links, with a visited-set
    cycle guard.
  - Empty target (no events found): returns the envelope with
    empty arrays, no throw.
  - Test: synthetic 4-transition history (unconfirmed -> confirmed
    -> quarantine -> retired) with three evidence events and a
    cross-slug rename chain via `supersedes`.
- **Depends on**: Task 3.

### Task 5: Stale-watch helper

- **Files**: `src/core/brain/temporal/stale-watch.ts` (new),
  `tests/core/brain/temporal/stale-watch.test.ts` (new).
- **Acceptance**:
  - `findStaleEntries(index, vault, cfg)` returns a frozen
    `{stalePreferences, staleSignals, staleLogFiles, thresholds,
    generatedAt}` envelope.
  - Threshold logic: an entry is stale when the difference between
    `now` and the most-recent relevant event timestamp exceeds the
    threshold-days config value.
  - Per-kind thresholds applied independently
    (`stale_pref_days`, `stale_signal_days`, `stale_log_days`).
  - Test: synthetic vault with one stale pref, one fresh pref, one
    stale signal, one stale log file, asserting the envelope
    classification.
- **Depends on**: Task 2.

### Task 6: Daily-brief helper

- **Files**: `src/core/brain/temporal/daily-brief.ts` (new),
  `tests/core/brain/temporal/daily-brief.test.ts` (new).
- **Acceptance**:
  - `buildDailyBrief(index, vault, date)` returns frozen
    `{date, eventsByKind, statusTransitions, vaultDelta,
    sourcePointers, generatedAt}` envelope.
  - `eventsByKind` keyed by `BrainLogEventKind`, with stable
    key order (sorted lexicographically).
  - `statusTransitions` is the list of pref-id status changes
    within the day.
  - `vaultDelta` reports `newPromotions` (count of `promote`
    events), `newRetired` (count of `retire` events), `newFeedback`
    (count of `feedback` events), `evidenceApplied` and
    `evidenceViolated` (count of `apply-evidence` events with the
    matching payload `result`) as integers.
  - `sourcePointers` is the deduplicated list of artifact
    wikilinks cited by evidence events in the day.
  - Test: synthetic day with 1 promotion + 2 applied + 1 violated
    + 1 retired; assert each envelope slot.
- **Depends on**: Task 2.

### Task 7: Weekly-synthesis helper

- **Files**: `src/core/brain/temporal/weekly-brief.ts` (new),
  `tests/core/brain/temporal/weekly-brief.test.ts` (new).
- **Acceptance**:
  - `buildWeeklySynthesis(index, vault, weekEnd, cfg)` returns
    frozen `{windowStart, windowEnd, eventsByKind,
    statusTransitions, retired, contradictions, vaultDelta,
    generatedAt}` envelope.
  - Window is computed from `weekEnd` (ISO date) back to the
    `weekly_start_dow`-aligned Monday-or-other-weekday by config.
  - `contradictions` counts `signal-suppressed` and
    `evidence-violated` events grouped by pref_id.
  - `retired` lists every pref retired within the window with the
    retirement reason.
  - Test: synthetic 7-day window with 1 retirement, 2
    contradictions, 4 transitions; assert envelope and window
    bounds.
- **Depends on**: Task 2.

### Task 8: Five MCP tools

- **Files**: `src/mcp/brain-tools.ts` (modified - register
  `brain_timeline`, `brain_belief_evolution`, `brain_stale_scan`,
  `brain_daily_brief`, `brain_weekly_synthesis` in full scope),
  `tests/mcp/temporal-mcp-tools.test.ts` (new),
  `tests/mcp/mcp.test.ts` (modified - tool inventory 26 -> 31).
- **Acceptance**:
  - Each new tool: schema-validates input (strict booleans /
    string-tolerant integer coercion matching v0.10.17 precedent),
    converts internal errors to MCP `INVALID_PARAMS` where
    appropriate, returns a frozen envelope serialised as JSON.
  - Writer scope stays at 4 tools (unchanged).
  - `tests/mcp/mcp.test.ts` tool-inventory assertion updated to 31
    + the five names added to the expected Set.
  - Test for each tool: happy-path input + one INVALID_PARAMS case
    (bad type / out-of-range integer / unknown filter key).
- **Depends on**: Tasks 4-7.

### Task 9: Five CLI verbs

- **Files**: `src/cli/brain/verbs/temporal-timeline.ts` (new),
  `src/cli/brain/verbs/temporal-evolution.ts` (new),
  `src/cli/brain/verbs/temporal-stale.ts` (new),
  `src/cli/brain/verbs/temporal-daily.ts` (new),
  `src/cli/brain/verbs/temporal-weekly.ts` (new),
  `src/cli/brain.ts` (modified - dispatch the five verbs),
  `src/cli/brain/verbs/index.ts` (modified - re-export),
  `src/cli/brain/help-text.ts` (modified - help block),
  `tests/cli/brain-temporal-cli.test.ts` (new).
- **Acceptance**:
  - Each verb supports `--vault`, `--json`, plus verb-specific
    flags:
    - `timeline` - `--pref-id`, `--topic`, `--kind`, `--since`,
      `--until`, `--limit`.
    - `evolution` - `--pref-id` or `--topic` (mutually exclusive).
    - `stale` - no extra flags; reads thresholds from config.
    - `daily` - `--date` (ISO date, default today UTC).
    - `weekly` - `--week-end` (ISO date, default today UTC).
  - Invalid flag combos surface as `CliError` with the
    project-standard message shape.
  - `--json` returns the helper envelope; the default human-readable
    rendering is a short multi-line text block.
  - Test: each verb's argv parsing happy-path + one invalid-args
    case.
- **Depends on**: Task 8.

## Out of scope reminders (do not implement here)

- Writing the bi-temporal frontmatter atoms back onto disk.
- LLM-driven brief narrative generation.
- Temporal intent classifier on `brain_search` / `brain_query`.
- Vault complexity-vs-activity ratio.
- Two-stage signal review gate.

## Verification commands

- `bun test tests/core/brain/temporal/` - subsystem unit tests.
- `bun test tests/mcp/` - MCP shape + inventory tests.
- `bun test tests/cli/` - CLI surface tests.
- `bun test` - full regression suite.
- `bun run typecheck` - strict TypeScript.
- `bun run sync-version:check` - manifests in lockstep (phase 6).
