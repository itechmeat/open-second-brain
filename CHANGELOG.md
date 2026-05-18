# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.5] - 2026-05-18

Brings the v0.10.5 "Brain maturity + embeddings activation"
cluster from `Projects/OpenSecondBrain/Features/_summary` and the
Hermes onboarding report at
`Projects/OpenSecondBrain/Features/embedding-provider-activation`:
§14 local HTML/web explorer, §12 merge-suggestions plus the
explicit `o2b brain merge` CLI, §4 completion of the deferred D5
from v0.10.4 (per-runtime cadence in `hooks/lib/messages.ts`), the
deferred D4 "good vs bad" examples in the `brain-memory` SKILL,
and a §E embeddings-activation cluster (macOS sqlite shim,
actionable `o2b search check` hints, `--cron-template`,
`embeddings-setup` SKILL).

No vault migration is required. Existing vaults stay valid:
`merge` introduces one new retired reason (`merged-into`) and one
new log event kind (`merge`); both surface only when the operator
runs `o2b brain merge`.

### Added

- §14 — `o2b brain explorer` launches a loopback HTTP server (default
  port `7777`, `--port <n>` to override) that renders preferences and
  retired entries as a force-directed graph. `o2b brain explorer
  --export <path>` writes the same view as a single offline HTML file
  with inlined data; `--force` overwrites an existing file. Live and
  export modes share one template at `templates/brain-explorer.html`.
  Zero backend, no LLM, no network. Markdown is parsed in the browser
  by a vendored ~150-line mini physics engine.
- §12 — `o2b brain digest` gains a `## Merge suggestions` section
  surfacing confirmed/quarantine pairs in the same `(topic, scope)`
  whose `principle` tokens reach jaccard ≥ `0.6`. Pairs ≥ doctor's
  own duplicate threshold continue to trip the
  `duplicate-preferences` doctor lint. `o2b brain merge <keep>
  <drop>` is the explicit resolver: `keep` retains its frontmatter,
  picks up the deduped union of `evidenced_by`, the summed
  `applied_count` and `violated_count`, and `max(last_evidence_at)`;
  `drop` retires under reason `merged-into` with a `superseded_by`
  wikilink to `keep`. The CLI prompts interactively unless `--force`
  is passed; `--dry-run` reports the plan and writes nothing.
- §4 (completes deferred D5 from v0.10.4) — `hooks/lib/messages.ts`
  emits a per-runtime cadence line above the
  `brain_feedback`/`brain_apply_evidence` block. Claude Code gets a
  "many turns ahead, capture now" hint; Codex gets a "one-shot exec,
  call before return" hint. Unknown runtime renders byte-identical
  to the v0.10.4 baseline. Detection lives in
  `hooks/lib/detect.ts:detectHookRuntime`, driven by hook-payload
  shape (`transcript_path` substring or Claude's
  `session_id`/`cwd`/`tool_use_id` triple). `stopGuardrailReason`
  follows the same pattern.
- §15 (completes deferred D4 from v0.10.4) — `skills/brain-memory/
  SKILL.md` gains an `## Examples — good vs bad` section: four
  contrastive pairs covering weak vs strong `principle`,
  too-general vs precise `topic`, and `note` with versus without
  the "why" line.
- §E.1 — `scripts/_macos-sqlite.sh` shim, sourced from
  `scripts/o2b` after the Bun precheck. Detects Darwin + Homebrew
  SQLite and exports `DYLD_LIBRARY_PATH` so `bun:sqlite` picks up
  a build with `LOAD_EXTENSION` enabled. No-op on Linux and on
  macOS without `brew install sqlite`. Resolves the v0.10.4
  blocker where `sqlite-vec` failed to load against Apple's
  system SQLite (built with `SQLITE_OMIT_LOAD_EXTENSION`).
- §E.2 — `o2b search check` gains a `recommendations` field on
  both the human and JSON outputs. Rules surface concrete next
  commands when `embedding_key` is missing, when `vec_extension`
  fails to load (with a macOS-specific `brew install sqlite`
  hint), and when the install is wired but no embeddings have
  been computed yet.
- §E.3 — `o2b search reindex --cron-template [--interval <N>m|h|d]`
  prints a watchdog script, a native crontab line, and a
  `hermes cron create` invocation. Pure stdout — writes nothing.
  Default interval is 30 minutes; `--interval` accepts under
  60m / 24h / unlimited days.
- §E.4 — `skills/embeddings-setup/SKILL.md` describes the
  proactive activation flow: when to engage, decision tree based
  on `o2b search check` output, env-var setup, macOS Homebrew
  branch, first reindex, and the optional cron template.

### Changed

- `tokenise` and `jaccard` lifted from `src/core/brain/doctor.ts`
  into `src/core/brain/similarity.ts`. No behavioural change. The
  doctor lint `duplicate-preferences` and the new merge-candidate
  detector now share one implementation.
- `tests/helpers/run-cli.ts` accepts an optional `stdin` string so
  interactive CLI prompts (`o2b brain merge`) can be exercised
  end-to-end.

### Internal

- New constant `BRAIN_RETIRED_REASON.mergedInto = "merged-into"`.
- New log event kind `BRAIN_LOG_EVENT_KIND.merge = "merge"`.
- New typed error `BrainMergeError` with discriminated `code`
  values for each invariant guard.
- New typed error `CronTemplateError` for the `--cron-template`
  interval parser.
- `IndexCheckReport` gains an optional `recommendations` array
  (additive, JSON consumers reading by key are unaffected).

## [0.10.4] - 2026-05-17

Brings the v0.10.4 "Brain onboarding quality" cluster from
`Projects/OpenSecondBrain/Features/_summary`: §18 machine-enforced
write protection for `Brain/`, §4 partial (per-runtime identity
reminder templates for the two runtimes that actually call
`buildReminder` per-turn / per-action), and §15 partial (bundled
starter set behind `o2b brain init --starter`).

No vault migration is required. Existing vaults are unaffected
until the operator opts in by running `o2b brain protect`,
appending `--starter` to a fresh `o2b brain init`, or setting
`O2B_TARGET=hermes` or `O2B_TARGET=openclaw` in the MCP server's
env block. The common identity reminder template is unchanged.

### Added

- §18 — `o2b brain protect --target {claudecode|codex}` writes a
  managed, idempotent block into the runtime's native permissions
  config that denies writes to `Brain/preferences/`, `retired/`,
  `log/`, `.snapshots/`, and `_brain.yaml` while leaving
  `Brain/inbox/` writable. `--print` (default) emits the snippet
  to stdout; `--apply` writes the file and saves a `.bak.<ts>`
  beside it. Pair `o2b brain unprotect` removes only the OSB-owned
  entries (tracked via the sidecar manifest
  `<vault>/.open-second-brain/protect.lock.json`).
- §4 (partial) — per-runtime identity reminder templates at
  `templates/identity-reminder.{hermes,openclaw}.txt`. The resolver
  in `buildReminder` accepts an explicit `target`, falls back to
  `O2B_TARGET`, and finally to the common template. Hermes Python
  shim has byte-level parity with the TypeScript resolver through
  a shared fixture. The common `identity-reminder.txt` is
  unchanged. Claude Code and Codex steer through
  `hooks/lib/messages.ts`, which is a different mechanism not
  addressed here — tracked under design doc D5.
- §15 (partial) — `o2b brain init --starter` drops a bundled
  example set (8 preferences, 3 retired, 1 inbox signal, 6 log
  days) into a fresh Brain. The bundle is regenerated through the
  canonical writers (`writePreference`, `appendApplyEvidence`,
  `moveToRetired`, `dream`) so its shape never drifts from real
  vault output. Doctor-clean and a no-op under
  `o2b brain dream`. Refuses to run on a non-empty Brain.

### Deferred

Full multi-runtime `o2b install` orchestrator (§4 second half),
interactive `o2b init --interactive` wizard (§15 second half),
per-runtime steering text for Claude Code / Codex in
`hooks/lib/messages.ts`, and the `brain-memory` SKILL "good-vs-bad"
examples section. Triggers to revisit are recorded in the vault
summary's "Deferred work" section
(`Projects/OpenSecondBrain/Features/_summary.md`).

## [0.10.3] - 2026-05-17

Brings four Tier-A items from
`Projects/OpenSecondBrain/Features/_summary`: §5 snapshot diff and
rollback dry-run (without the deferred sha256-manifest drift abort),
§10 numeric confidence with derived band, §21 cross-project pointer
plus a `primary_agent` declaration, and §27 titled wikilinks for
preferences and retired rules across every Brain writer.

No vault migration is required. Existing preferences and retired
files parse unchanged; the writer emits the new `_confidence_value`
field on the first dream refresh that touches each file, and the
`Brain/_brain.yaml.primary_agent` key defaults to `null` so vaults
without an explicit declaration keep their current behaviour.

### Added

- **`o2b brain snapshot diff <run_id_a> [<run_id_b>]`** — read-only
  artifact diff between two snapshots or between a snapshot and the
  live `Brain/` tree. Output groups changes by artifact kind
  (preference / retired / signal / log / config / other); `--json`
  emits the structured `BrainTreeDiff` payload for scripting.
- **`o2b brain rollback <run_id> --dry-run`** — previews the
  would-be restore plan as a live → snapshot diff via the same
  renderer. Mutually exclusive with `--yes` so preview and execute
  never collide. Leaves the live tree untouched.
- **`extractSnapshotToTemp(vault, runId)`** — shared snapshot
  extraction primitive used by `restoreSnapshot`,
  `rollback --dry-run`, and `snapshot diff`. The tar / zstd / gzip
  decompression logic lives in one place.
- **`src/core/brain/snapshot-diff.ts`** — pure `diffBrainTrees`
  walker plus `BrainTreeEntry` / `BrainFieldChange` / `BrainTreeChange`
  / `BrainTreeDiff` types. No I/O beyond `readFileSync` /
  `readdirSync`; classifier maps every Brain file into one of six
  artifact kinds.
- **`src/core/brain/snapshot-diff-render.ts`** — pure renderers
  (`renderDiffMarkdown`, `renderDiffJson`) split out so the differ
  stays format-neutral.
- **`_confidence_value` field** on every preference and retired
  file. Wilson 95% lower bound on `applied / (applied + violated)`
  modulated by linear freshness decay over
  `retire.stale_evidence_days`. Stored alongside the existing
  `_confidence` band, which becomes a derived view (band is the
  max of the legacy step-function and a numeric-threshold view,
  so it can only lift, never demote).
- **`_brain.yaml.confidence.medium_min` (default 0.40) and
  `high_min` (default 0.75)** — derived-band thresholds on the
  numeric value. Validated to lie in `[0, 1]` with `medium_min <
  high_min`.
- **`Brain/_brain.yaml.primary_agent`** declarative field. When set,
  dream runs invoked from a different agent emit a stderr warning,
  a `warnings` array entry on the MCP `brain_dream` response, and a
  `non_primary_agent: <caller>` row in the dream summary log.
- **`o2b brain set-primary <name>` / `o2b brain set-primary --clear`** —
  idempotent edit of the primary declaration without rewriting the
  rest of `_brain.yaml`.
- **`o2b brain init --primary-agent <name>`** — sets the value
  during the fresh bootstrap; on re-runs the flag is a no-op (use
  `set-primary` instead).
- **`src/core/brain/set-primary.ts`** — `setPrimaryAgent(vault,
  name | null): SetPrimaryAgentResult`. Validates the rewritten
  YAML before persisting; surfaces a typed `BrainConfigError` when
  the on-disk file is malformed.
- **`renderPrefLink({ id, principle })`** in `src/core/brain/wikilink.ts`
  with `MAX_PREF_LINK_TITLE_LEN = 80`. Sanitises wikilink-breaking
  characters and truncates titles at a word boundary with an
  ellipsis. Empty titles fall back to bare `[[id]]`.
- **`docs/cross-project-pointer.md`** — agent-facing setup guide
  for projects whose coding work happens outside the vault root.
  Covers the canonical `CLAUDE.md` / `AGENTS.md` snippet, the
  `primary_agent` workflow, and the Syncthing multi-device case.
- **CLI tests:** `tests/cli/brain.snapshot-diff.test.ts`,
  `tests/cli/brain.test.ts` (new `set-primary` and
  `--primary-agent` sections).
- **Core tests:** `tests/core/brain.snapshot-diff.test.ts`
  (differ + renderer), `tests/core/brain.confidence-value.test.ts`
  (Wilson + freshness + hard floors + max-lift band derivation),
  `tests/core/brain.set-primary.test.ts`,
  `tests/core/brain.dream.non-primary.test.ts`.

### Changed

- **`computeConfidence`** returns `{ value, band }`. The band is the
  max of the legacy step-function (preserved verbatim) and a
  numeric-threshold view. Dream's refresh phase writes both
  `_confidence` and `_confidence_value` on every touched
  preference; legacy files migrate lazily on the next refresh.
- **`dream` summary log** carries a `confidence_shifts: [...]`
  payload whenever a band drop is detected during refresh — the
  digest's `## Confidence shifts` section picks them up through
  the existing tolerant parser. `non_primary_agent: <name>` payload
  row appears whenever the primary check triggers.
- **`brain_query` MCP response** carries `confidence_value` next to
  `confidence` on every preference and retired result row.
- **`brain_dream` MCP response** carries a `warnings: [{code,
  message}]` array. CLI `o2b brain dream` writes the same warnings
  to `stderr`.
- **`brain_dream` MCP schema** accepts an optional `agent` argument
  for the primary-agent check.
- **`active.md`** appends `(0.NN)` after the band on confirmed
  bullets and `conf: 0.NN` to the Quarantine block when the file
  carries a numeric value.
- **Every Brain writer** that emits a preference or retired wikilink
  now uses `renderPrefLink`. Affected surfaces: dream log payloads
  (promote, retire, retain-pinned, noted-redundant,
  signal-suppressed, summary), apply-evidence log entry, pin / unpin
  log entries, digest sections (new-unconfirmed, confirmed,
  retired, top-applied, top-referenced, confidence-shifts,
  contradictions), reject log entry, force-confirmed log entry,
  retired body's `superseded_by` reference. Signals and external
  artifacts stay bare-id because they have no useful title source.
- **`BrainConfig`** widens with `primary_agent: string | null`.
  `BrainConfidenceConfig` gains `medium_min` and `high_min`.
  `BrainPreference` and `BrainRetired` gain
  `confidence_value: number | null` (`null` only on pre-v0.10.3
  files that have not been refreshed yet).
- **`Brain/log/<today>.md`** dream events optionally carry a
  `confidence_shifts` array and a `non_primary_agent` scalar — both
  forward-compat and surfaced through the digest renderer.
- **`DigestJson*` shapes** gain `principle: string` on every entry
  rendered with a wikilink, so the markdown renderer can build
  titled links without re-parsing the artifact files.
- **`scanBrain` retired record** carries `principle` so the dream
  log payloads can render titled wikilinks for the retired side
  without re-reading the file.
- **README** lists the new CLI verbs (`set-primary`, `snapshot diff`)
  and the `--dry-run` flag on `rollback`; documents the
  Cross-project setup subsection.
- **install.md branch A (Hermes)** recommends
  `--primary-agent <agent-name>` during the `o2b brain init` step,
  with guidance on the `set-primary` follow-up.
- **`docs/how-it-works.md`** documents the numeric `confidence_value`,
  the read-only snapshot inspectors, and the primary-agent
  observability contract.

### Notes

- Snapshot diff and `rollback --dry-run` are CLI-only. The MCP
  surface deliberately stays read-and-shape-only (`brain_query` +
  the new `warnings` array); operator-only mutations stay outside
  the agent loop, matching how `rollback`, `reject`, and
  `migrate-frontmatter` are handled today.
- The deferred §5 sub-features (sha256-manifest drift abort and
  post-dream integrity drill hook) remain out of scope — see
  `Projects/OpenSecondBrain/Features/_summary` for the rationale.

## [0.10.2] - 2026-05-16

Adds three Tier-A capture and hygiene items from
`Projects/OpenSecondBrain/Features/_summary`: §9 inline `@osb`
markers, §16 session-import, and §24 `_field` prefix convention
for derived frontmatter keys. The Brain layer now has three
capture surfaces (live, inline, session-import) and a derived /
identity split in the preference / retired schema.

No vault migration is required — the new schema parser accepts
both legacy (`status:`) and `_`-prefixed (`_status:`) shapes for
the entire v0.10.x line. The writer always emits the new shape;
existing files migrate lazily on the next dream rewrite, or
eagerly via `o2b brain migrate-frontmatter --apply --yes`.

### Added

- **`o2b brain scan-inline`** — capture `@osb` markers from any
  vault markdown file. Two shapes are recognised: a single line
  (`@osb feedback negative topic=... principle="..."`) and a
  fenced ``` ```osb ``` block with YAML body. Markers create a
  signal in `Brain/inbox/` via the same writer as `brain_feedback`,
  with `source_type: inline`, the source-file wikilink in `source`,
  and a `dedup_hash` over the normalised payload. After capture
  the source line is annotated `@osb✓ [[sig-...]]` (inline form)
  or the info-string flips to `osb-checked` with a `<!-- @osb✓
  [[sig-...]] -->` comment line (block form), making re-runs
  idempotent. Default ignore set covers `Brain/`, `.git`,
  `node_modules`, `.obsidian`, `.trash`, `.stversions`,
  `.open-second-brain`; additional excludes via `--exclude`,
  scope narrowing via `--path`, dry-run via `--dry-run`.
- **`o2b brain import-session <path>`** — extract signals from a
  Claude Code / Codex CLI / Hermes session JSONL (or a directory
  of session files). Two extraction paths run in parallel:
  `@osb` markers in user / assistant message text (same parser
  as `scan-inline`), and replay of `brain_feedback` tool_use
  calls captured in the transcript. Each emitted signal carries
  `source_type: session` and a `session_ref: <path>#<turn-id>`
  for traceability. Autodetect runs on the first line; if it
  fails, exit 2 with a request to pass `--format`. The shared
  `dedup_hash` cross-deduplicates against signals already in the
  inbox (including those captured by `scan-inline`).
- **`o2b brain migrate-frontmatter`** — opt-in helper that walks
  `Brain/preferences/` and `Brain/retired/` and rewrites legacy
  Group C frontmatter keys (`status`, `applied_count`,
  `confirmed_at`, `last_evidence_at`, `violated_count`,
  `confidence`, `evidenced_by`, `contradicted_by`) to the
  `_`-prefixed form. Default is `--dry-run`; `--apply --yes`
  takes a pre-run snapshot under `Brain/.snapshots/migrate-...`,
  so rollback by run-id is the standard recovery path. Files
  carrying both shapes for the same field abort the migration
  with an actionable error.
- **`BrainSignal`** gains three optional frontmatter fields:
  `source_type` (`live` / `inline` / `session`; absent on
  legacy signals), `dedup_hash`, and `session_ref`. Non-live
  signals also get a `brain/source/<type>` tag for Obsidian
  filtering. Absence of `source_type` is interpreted as
  `live`; the parser never injects a default into the parsed
  object.
- **`src/core/brain/dedup-hash.ts`** — pure `computeDedupHash`
  shared between `scan-inline` and `import-session`. NFC
  normalisation + whitespace collapse on `principle`; `scope`
  defaults to empty string; SHA-256 over NUL-separated parts.
- **`src/core/brain/inline.ts`** — `discoverMarkers`,
  `parseInlineMarker`, `parseBlockMarker`. Single source of
  truth for `@osb` grammar.
- **`src/core/brain/sessions/`** — adapter registry plus three
  concrete adapters (`claude.ts`, `codex.ts`, `hermes.ts`) and
  the orchestrator (`import.ts`). Adding a fourth runtime is a
  new adapter file plus a registry entry, no other change.
- **`src/core/brain/sessions/validate-feedback.ts`** — extracted
  pure validator for the `brain_feedback` tool-use payload.
  Re-used by the MCP layer (`toolBrainFeedback`) and the
  session importer, so the contract cannot drift between
  surfaces.
- **Doctor `frontmatter-double-shape` warning** — surfaces a
  preference or retired file that carries both legacy and
  `_`-prefixed forms of the same Group C field (manual-edit
  corruption indicator).
- **Three new log-event kinds:** `scan-inline`, `import-session`,
  `migrate-frontmatter`. Each `o2b brain *` invocation appends
  one row to `Brain/log/<today>.md` (skipped on `--dry-run`).
- Test fixtures: `tests/fixtures/sessions/{claude,codex,hermes}-minimal.jsonl`.
  Anonymised five-line transcripts that lock the adapter
  detection + iteration contract.
- E2E scenario `tests/e2e/brain-capture-and-fields.test.ts`
  exercises the full chain: init → scan-inline → import-session
  → migrate-frontmatter → rollback.

### Changed

- **`parsePreference` / `parseRetired`** accept both the legacy
  (`status:`) and the new (`_status:`) shape for every Group C
  field. Files carrying both shapes for the same field raise a
  hard parse error (`frontmatter-double-shape` for doctor).
  Identity fields (`kind`, `id`, `created_at`,
  `unconfirmed_until`, `topic`, `principle`, `scope`, `tags`,
  `aliases`, `supersedes`, `pinned`) are not affected.
- **`writePreference`** emits Group C keys with the `_` prefix
  (`_status`, `_applied_count`, …). `moveToRetired` keeps
  `status: retired` un-prefixed on retired files (identity, not
  derived) and drops legacy keys from the inherited frontmatter
  before stamping retire metadata.
- **`writeSignal`** accepts the new optional fields and adds the
  `brain/source/<type>` tag when `source_type` is non-default.
  `parseSignal` round-trips them.
- **Backlinks collector** (`src/core/brain/backlinks.ts`) reads
  `evidenced_by` through the shared `normalizeDerivedKeys`
  helper so the index continues to resolve regardless of
  frontmatter shape.
- **`brain_doctor`** picks up the new `frontmatter-double-shape`
  warning. No existing lint codes change.
- **README** documents the three capture surfaces and lists the
  three new CLI verbs.
- **`skills/brain-memory/SKILL.md`** notes inline markers as the
  no-agent fallback path and points to `import-session` for
  back-filling sessions.

### Notes

- Hard removal of the legacy frontmatter shape is planned for
  a future minor release. The cutover is dependency-driven, not
  calendar-driven.
- `_brain.yaml: scan_inline.exclude:` is not yet honoured (the
  existing minimal YAML parser does not support inline arrays).
  Additional excludes go through the `--exclude` CLI flag in this
  release; YAML-config support is a follow-up.
- Three operator-only commands (`scan-inline`,
  `import-session`, `migrate-frontmatter`) are intentionally
  CLI-only — they don't appear in the MCP surface, consistent
  with how `init`, `reject`, `pin`, `unpin`, and `rollback` are
  kept off the agent loop.

## [0.10.1] - 2026-05-16

Closes the "preference body is dead weight" gap. Every active and
quarantined preference file now mirrors its log activity instead of
shipping a fixed placeholder body; signal files stop emitting the
`_(not provided)_` placeholder when no verbatim quote was passed; and
`o2b brain reject` requires a `--reason` so the next dream pass can
suppress new signals on the same topic. Tier-A item §6 of
`Projects/OpenSecondBrain/Features/_summary` (`reject --reason` +
signal suppression) is implemented in this patch.

No vault migration is required — the first post-upgrade dream pass
detects v0.9.x placeholder bodies and rewrites them to the new shape
in place.

### Added

- **`## Recent applications` / `## Recent violations`** sections on
  every preference and retired file. Dream collects the last 5
  applied + last 3 violated rows from `Brain/log/` on every pass and
  writes them as bulleted `[[artifact:lines]] — timestamp (agent)
  [result] — note` entries. The data was already on disk in the
  daily log; v0.10.1 joins it back to the rule.
- **`src/core/brain/evidence.ts`** — read-only log scanner used by
  dream and `moveToRetired`. Returns newest-first slices for a given
  pref slug; sorts by timestamp; stops at `pref.created_at` so older
  log days are never opened in vain.
- **`o2b brain reject --reason "<text>"`** — `--reason` is now
  mandatory. The text is persisted on the retired file as
  `user_rejected_reason` and rendered in the `## Retired` body. CLI
  exits 1 when `--reason` is missing.
- **`signal-suppressed` log event + `signalSuppressed` event kind.**
  When a fresh signal lands on a topic that has a retired pref with
  `user_rejected_reason` set, dream drops the signal from the
  candidate-pref planner, moves it to `processed/`, and emits one
  audit row per signal linking back to the retired pref + the
  original user reason.
- **`wouldRewritePreference(vault, input)`** exported predicate —
  twin of `writePreference`'s content-equality short-circuit. Lets
  the dream pass decide whether a refresh entry is needed without
  doing the write twice.
- **`BrainEvidenceSummary`** type and `BrainSignalSuppressedLogEvent`
  variant added to the discriminated union of log events.
- Test file `tests/core/brain.body-hygiene.test.ts` — coverage for
  Raw-section omission, preference-body shape, retired re-render,
  signal suppression, and the v0.9.x → v0.10.1 body migration.

### Changed

- **`renderPreferenceBody`** drops the redundant `## Principle`
  duplicate and the `_(no evidence yet)_` / `_(not provided)_`
  placeholder lines. Sections are emitted only when they have real
  content; a brand-new pref with no log evidence yet has an empty
  body, which is the honest representation.
- **`renderSignalBody`** omits the `## Raw` section entirely when
  no verbatim quote was passed instead of shipping the
  `_(not provided)_` placeholder. Parsers stay tolerant of both
  shapes (old placeholder, new absent section).
- **`writePreference`** is now content-aware: when overwriting, it
  reads the existing file, compares to the would-be rendered bytes,
  and skips the rename if they match. Preserves the dream
  "no rewrite on a no-op rerun" invariant even though dream now
  recomputes the body on every pass.
- **`moveToRetired`** re-renders the body from scratch (current
  frontmatter + freshly collected log evidence) before appending
  the `## Retired` block. The source file's body shape no longer
  bleeds into the retired snapshot — a v0.9.x preference being
  retired produces a v0.10.1 retired file.
- **`dream`** plumbs the evidence slice through to every
  `writePreference` and `moveToRetired` call. A pref whose
  counters did not change is still considered for refresh if its
  on-disk body differs from the rendered output (this is what
  carries the v0.9.x body migration forward without a separate
  migrate command).
- **`brain-memory` skill** explicitly recommends passing `raw` with
  the verbatim user quote and documents the `--reason` requirement
  on `o2b brain reject`, with the warning that re-recording signals
  on a user-rejected topic will be suppressed by the next dream.

### Notes

- The schema version on `Brain/_brain.yaml` stays unchanged. All
  changes are additive at the data layer (`user_rejected_reason` is
  an optional frontmatter field; `BrainEvidenceSummary` is a derived
  render-time view, never persisted as its own file).
- The §6 implementation in this release covers suppression only.
  The follow-up "after 5 rejects of the same topic, auto-block" mode
  from the _summary doc is deliberately out of scope — suppression
  + the explicit `--reason` audit trail is enough to break the
  reject → re-grow loop the user observed.

## [0.10.0] - 2026-05-16

Full-text search over the vault as a deterministic, filesystem-first
layer. Index lives at `<vault>/.open-second-brain/brain.sqlite`
(SQLite + FTS5, schema versioned). Optional semantic layer via
`sqlite-vec` plus any OpenAI-compatible `/v1/embeddings` provider
(OpenRouter, OpenAI, Together, Google's OpenAI-compat endpoint,
local Ollama, Hermes proxy). Closes design plan
`docs/plans/2026-05-16-brain-search-design.md`.

### Added

- **Core module `src/core/search/`** with isolated walker, chunker,
  store (the only SQL boundary), FTS query, links, ranker, indexer,
  search, and embedding providers (`null-provider`, `openai-compat`).
  Public surface: `resolveSearchConfig`, `indexVault`, `reindexVault`,
  `indexStatus`, `indexCheck`, `search`, plus typed `SearchError`
  codes.
- **CLI** namespace `o2b search` with verbs `query` (default),
  `index`, `reindex`, `status`, `check`. Human and `--json` output;
  `--auto-refresh` for read-time incremental indexing.
- **MCP tool** `brain_search` (read-only, agent-facing). Diagnostic
  score components (`keywordScore`, `semanticScore`, `linkBoost`,
  `recencyBoost`) are intentionally absent from the MCP shape; they
  live in CLI `--verbose` only. Content per chunk is truncated to
  600 characters. Index-management verbs are NOT exposed over MCP
  (operator business, never agent business — design §3 principle 5).
- **`second_brain_status`** gains a `search.*` block: index path,
  schema version, document/chunk/embedding counts, embedding model
  and dimension, sqlite-vec status, key presence (redacted),
  `last_indexed_at`, `last_full_index_at`. Reports
  `{ exists: false, hint }` when the index has not been built yet.
- **Ranking** combines min-max-normalised BM25, cosine similarity
  on unit-normalised vectors, in-result wikilink boost (capped at
  0.03), shared-tag boost (capped at 0.02), and recency steps
  (≤7d → 0.05, ≤30d → 0.025, ≤90d → 0.01). Tie-break on equal
  final score: keyword desc, mtime desc, chunk id asc.
- **Atomic reindex** via `brain.sqlite.new` + same-directory rename
  swap with `brain.sqlite.bak` retention. Auto-restore from `.bak`
  on open if the main file is missing.
- **Embedding-model fingerprint** stored in `index_state`. Changing
  `embedding_model` or `embedding_dimension` drops `embeddings`,
  `chunk_vec`, and `chunk_vec_map` on next open, logs one line, and
  preserves `chunks` + `chunk_fts`. The next
  `o2b search index --embeddings` repopulates vectors.
- **Concurrency guard** via `proper-lockfile` on the index path:
  three attempts, 1s backoff, then `INDEX_LOCKED`. Readers do not
  take the lock; WAL handles concurrent reads safely.
- **Semantic-unavailable policy** (design §7): implicit semantic
  (config default) warns and falls back to keyword-only; explicit
  `--semantic` / `semantic: true` throws a typed `SearchError` so
  the failure cannot hide. Data-state cases (no embeddings yet)
  warn and skip even when explicit — running
  `o2b search index --embeddings` is the right answer there, not a
  panic.

### Changed

- **`sqlite-vec`** added to `optionalDependencies`. The runtime
  detects whether the loadable extension is present on disk and
  records availability in `index_state.vec_extension_available`;
  no failure if the platform package is missing.

### Notes

- v0.10.0 ships schema version 1 only. Future migrations follow the
  same `MIGRATIONS[]` pattern in `src/core/search/schema.ts`.
- `o2b index` (the Markdown index generator at `AI Wiki/index.md`)
  is unchanged. The new system is `o2b search index`.

## [0.9.1] - 2026-05-15

Active-preferences digest, MCP Resources, and a visibility expansion
across status, digest, and backlinks. Closes `BRAIN-FUT-006`
(active-preference injection per turn) and ships the read-only
"visibility family" from the project's feature summary (§3 status,
§8 backlinks, §13 hot preferences). Adds a `quarantine` preference
status that catches rules whose recent evidence has turned dominantly
negative without yet crossing the rebuttal threshold.

### Added

- **`Brain/active.md`** — an auto-generated digest of every confirmed
  preference, every quarantined preference (with applied/violated
  counters), and the three most recently retired entries. Pure
  derivation, no LLM. Regenerated at the tail of every `dream` run
  and after `o2b brain pin`/`unpin`. The writer is idempotent: when
  the rendered body matches the existing file, no I/O happens.
- **SessionStart hook** (`hooks/active-inject.ts`) with matcher
  `startup|resume|clear`. Reads `Brain/active.md` and emits it as
  `additionalContext` so the agent sees current rules at the start
  of every session. Fails closed: any error path exits 0 with no
  output so the runtime proceeds unaffected.
- **PostCompact hook** with matcher `manual|auto`. Re-injects the
  same `Brain/active.md` body after `/compact` (manual or
  background), so the agent does not lose its preferences view
  partway through long sessions. Same script as SessionStart — the
  hook event name is taken from the payload so one script covers
  both surfaces.
- **MCP Resources** capability on the MCP server. Two concrete URIs:
  - `osb://preferences/active` — body of `Brain/active.md`. Auto-
    generated on first read if the file does not exist yet (fresh
    vault with prefs but no dream).
  - `osb://digest/latest` — `renderDigest({format: "markdown"})`
    output, same as the `brain_digest` tool's default window.

  Three URI templates:
  - `osb://preference/{id}` — body of `pref-{id}.md`, with fallback
    to `ret-{id}.md` when the active copy is gone. Accepts the bare
    slug or the prefixed id.
  - `osb://topic/{slug}` — synthesised markdown of every signal,
    the current preference (or retired), and the most recent log
    entries for the topic.
  - `osb://log/{date}` — body of `Brain/log/<date>.md`.

  The MCP initialize response advertises
  `capabilities.resources = { listChanged: false, subscribe: false }`.
- **`quarantine` preference status** (closes design summary §20).
  Entry: a `confirmed` preference whose recomputed counters satisfy
  `violated_count ≥ applied_count AND applied_count >
  confidence.low_max_applied` transitions to `quarantine`. The rule
  is still listed in `Brain/active.md` (under its own section), but
  the digest surfaces it separately. Exit: a new `violated`
  evidence event since the last `dream` snapshot retires the rule
  with `retired_reason: quarantine-violated`; or a fresh
  `applied_count > violated_count` returns it to `confirmed`. Pinned
  quarantine preferences emit `retain-pinned` instead of retiring,
  consistent with other automatic retires.
- New `BRAIN_RETIRED_REASON.quarantineViolated = "quarantine-violated"`
  enum value distinct from `rebutted` (which counts opposite-sign
  signals, not evidence events).
- **Backlink index** (`src/core/brain/backlinks.ts`). A single read
  pass over `preferences/`, `retired/`, `inbox/`, `inbox/processed/`,
  and `log/` produces an inverted reference map: target id → list of
  sources that wikilink to it, with `field` and (for log entries) the
  event timestamp. Self-references and duplicate (source, target)
  pairs are deduplicated. Powers digest §13 and the `brain_backlinks`
  surfaces.
- **`brain_backlinks` MCP tool** + `o2b brain backlinks <id>` CLI verb.
  Returns the count plus a list of `{source, source_kind, field,
  timestamp?}` records for any Brain artifact id (preference,
  retired, or signal).
- **`osb://backlinks/{id}` MCP resource template** — markdown render
  of inbound references grouped by source kind. Same data as the
  tool; the resource surface is for MCP hosts that prefer pull-style
  access.
- **Hot sections in `brain_digest`** (closes §13). Two new sections
  in both Markdown and JSON outputs:
  - **Top applied** — top-5 confirmed/quarantine preferences by
    `applied_count` desc (zero-applied excluded). JSON field:
    `top_applied`.
  - **Top referenced** — top-5 preferences by inbound backlink
    count (using the index above). JSON field: `top_referenced`.

  The sections render only on non-empty windows so `--silent-if-empty`
  exit semantics are preserved; JSON always emits the arrays so
  programmatic consumers can read them regardless of window state.
- **`broken-backlinks` lint** in `brain_doctor`. Walks the backlink
  index and reports any source that still references a `pref-*`,
  `ret-*`, or `sig-*` target whose file no longer exists. Warning
  severity (not error), since the underlying state isn't corrupted
  — the source artifact's pointer just went stale.
- **`brain` section in `second_brain_status`**. The existing MCP
  tool now includes a `brain: { present, counts, last_dream_at,
  last_apply_evidence_at, sanity }` field. Counts cover
  inbox/preferences (split by status)/retired/log_days/snapshots.
  `sanity.signals_awaiting_dream` is non-zero when inbox signals
  predate the `unconfirmed_window_days` cutoff — a one-glance "you
  need to run `dream`" signal.
- **`osb://status` concrete MCP resource** — the same snapshot
  rendered as markdown for direct pull by MCP hosts.

### Changed

- `regenerateActive(vault)` is now called at the tail of every
  `dream` invocation (both `changed: false` and `changed: true`
  paths), gated on `dryRun: false`. Failure is logged to stderr and
  swallowed — the rest of `dream`'s work is independent.
- `setPinned` calls `regenerateActive` after a successful flip so
  the `pinned` flag visible in the digest matches the new state
  immediately. Same swallow-and-warn fallback as in `dream`.
- `renderDigest` JSON shape gains `top_applied` and `top_referenced`
  arrays. `schema_version` stays at `1` — both fields default to
  empty arrays, so existing readers that ignore unknown fields
  remain compatible.
- **Input sanitisation** for Brain writers. The Pay Memory redactor
  is promoted to `src/core/redactor.ts` (Pay Memory keeps the import
  path) and joined by a new `normaliseTextField` helper that strips
  C0 control characters (except `\t` / `\n`), folds `U+2028` /
  `U+2029` line separators to `\n`, NFC-normalises, and caps length.
  `writeSignal` runs `principle` (cap 512, single-line), `scope`
  (cap 128, single-line), `raw` (cap 4096), and `source[]` items
  (cap 512) through redact + normalise. `appendApplyEvidence`
  applies the same to `artifact` (cap 512, single-line) and `note`
  (cap 4096). Inputs that sanitise down to empty (e.g. pure C0
  bytes) raise the existing `missing field` error rather than
  smuggling into YAML.
- **`outdated` apply-evidence result** (`BRAIN_APPLY_RESULT.outdated`).
  Records that a preference's scope still matched the artifact but
  the rule itself is obsolete in this context (framework migration,
  convention change). Dream interprets any `outdated` event as a
  retire trigger with new reason
  `BRAIN_RETIRED_REASON.supersededByContext` =
  `"superseded-by-context"`. Pin protects against decay-driven
  retires only; an `outdated` event is an explicit context shift
  and bypasses the pin. CLI and MCP tool schema accept the new
  enum value.
- **Claim-level provenance in apply-evidence artifacts**. The
  `artifact` wikilink optionally carries an inclusive 1-based line
  range: `[[src/cli/main.ts:120-145]]` (range) or
  `[[src/cli/main.ts:42]]` (single line). New
  `parseArtifactRef(value)` helper in
  `src/core/brain/wikilink.ts` extracts `{target, range?,
  malformedRange?}`. The writer accepts the syntax verbatim; the
  parser is used by downstream readers (lint, future fragment
  display).
- **`brain_doctor` hygiene lints** (closes the remaining §11 items
  from the project's feature summary):
  - `duplicate-preferences` — pairwise jaccard ≥ 0.7 on principle
    tokens within each `(topic, scope)` bucket of confirmed /
    quarantine preferences.
  - `low-evidence-confirmed` — confirmed pref with
    `applied_count ≤ low_max_applied` and `confirmed_at` older
    than `unconfirmed_window_days`.
  - `pinned-without-recent-evidence` — pinned pref with no
    `last_evidence_at` or with evidence older than
    `stale_evidence_days`.
  - `malformed-evidence-range` — apply-evidence artifact uses
    range syntax but the range fails validation (non-numeric,
    reversed, zero-based, dangling dash).
  - `orphan-evidence` — apply-evidence artifact wikilink doesn't
    resolve to any file in the vault (basename match via
    `listVaultPages`).
- `runDoctor` accepts an `opts.now` for deterministic age-based
  testing. CLI `--strict` semantics unchanged.

## [0.9.0] - 2026-05-15

Brain: a new top-level vault layer for observing, accreting memory.
Agents record taste signals from conversation and per-artifact
evidence of preference application; a deterministic `dream` pass
turns repeat signals into rules whose confidence grows from real use
and decays when nothing applies them. Filesystem-first, Obsidian-
native, no LLM inside the algorithm — counters, thresholds, atomic
file operations only. Conceptually mirrors Anthropic's *Dreaming*
research preview (2026-05-06) but stays runtime-agnostic and
deterministic.

The previous agent-facing write paths (`event_log_append` and
`second_brain_capture` MCP tools, the `agent-event-log` skill) are
soft-deprecated in v0.9.0: the handlers remain in the codebase and
the CLI counterparts (`o2b append-event`, `vault-log`) keep working
for humans on the shell, but agents through the plugin surface no
longer see them. Brain replaces them as the writable surface.

Pay Memory is **unchanged** in v0.9.0 — it remains agent-visible as
an orthogonal audit layer for paid actions.

### Added

- **Brain layer** at top-level `Brain/` directory in the vault.
  Subdirectories: `inbox/`, `preferences/`, `retired/`, `log/`,
  `.snapshots/`. Plus `_brain.yaml` (schema-versioned config with
  thresholds for `candidate_threshold`, `unconfirmed_window_days`,
  `contradiction_window_days`, `stale_evidence_days`,
  `high_freshness_factor`, `snapshots.retention_count`) and
  `_BRAIN.md` (agent-facing operating manual, rendered by `o2b
  brain init`, kept under 200 lines).
- **CLI namespace `o2b brain *`** with 11 verbs: `init`,
  `feedback`, `dream`, `apply-evidence`, `digest`, `query`,
  `reject`, `pin`, `unpin`, `rollback`, `doctor`.
- **MCP tool namespace `brain_*`** with 6 tools: `brain_feedback`,
  `brain_dream`, `brain_apply_evidence`, `brain_digest`,
  `brain_query`, `brain_doctor`. `init`, `reject`, `pin`, `unpin`,
  `rollback` are intentionally CLI-only (admin / destructive
  operations are not exposed to autonomous agents).
- **Pre-run snapshots**: each `dream` run that mutates state writes
  `Brain/.snapshots/<run_id>.tar.zst` of the entire `Brain/` tree
  (excluding `.snapshots/` itself) before any mutation. Retention
  is configurable in `_brain.yaml` (default 10 most-recent).
  `o2b brain rollback <run_id>` restores from a snapshot.
- **Pin protection**: preferences marked `pinned: true` are exempt
  from automatic retirement (`stale-no-evidence`,
  `expired-unconfirmed`, `rebutted`). Only `o2b brain reject` can
  retire a pinned preference (with an extra warning). CLI verbs
  `o2b brain pin` and `o2b brain unpin` toggle the flag; both are
  CLI-only — the MCP surface intentionally does not expose them.
- **Skill `brain-memory`** (`skills/brain-memory/SKILL.md`):
  instructs agents when to call `brain_feedback` (taste signals
  from dialogue) and `brain_apply_evidence` (per durable artifact).
  Loaded automatically alongside the existing `open-second-brain`
  skill.
- **Brain digest**: `o2b brain digest` renders a Markdown or JSON
  summary of new unconfirmed preferences, confirmations,
  retirements, confidence shifts, and contradictions in a window.
  Exit code `2` when empty and `--silent-if-empty` is set — fits
  Hermes cron `--no-agent --script` jobs cleanly. Recipe in
  [`docs/hermes-cron.md`](docs/hermes-cron.md).

### Changed

- **`AI Wiki/_OPEN_SECOND_BRAIN.md`** is now overwritten by
  `o2b brain init` to a Brain-first operating manual; the file
  previously described agent-owned write conventions for
  `AI Wiki/` itself. With approximately zero non-author users at
  this stage no backup of the prior file is taken — by design.
- **`hooks/lib/messages.ts` PostToolUse reminder** rewritten:
  no longer references `event_log_append`. Points the agent at
  `brain_feedback` (when the turn contained a user preference)
  and `brain_apply_evidence` (when an active preference scopes
  to the artifact just produced).
- **`skills/open-second-brain/SKILL.md`** body rewritten to
  describe the three-layer model (`Brain/` writable, `AI Wiki/` +
  `Daily/` read-only, Pay Memory orthogonal). Cross-references
  the new `brain-memory` skill.

### Removed (from agent-facing surface; handlers retained in code)

- **`Stop` lifecycle hook** that previously blocked the turn once
  on missing `event_log_append`. The entry is removed from
  `hooks/hooks.json`; the handler file
  `hooks/stop-log-guardrail.ts` remains in the codebase. No
  Brain-specific Stop guardrail is added in v0.9.0 — the
  PostToolUse reminder is the only nudge.

### Deprecated (agent-facing only, code and CLI retained)

- **MCP tool `event_log_append`** — no longer in the advertised
  tool list returned by `src/mcp/tools.ts`. Handler stays on disk.
  The CLI counterparts `o2b append-event` and `vault-log` remain
  fully functional for human shell use.
- **MCP tool `second_brain_capture`** — same pattern: removed
  from advertisement, handler retained.
- **Skill `agent-event-log`** moved to `docs/legacy-skills/` so
  the runtime skill scanner stops loading it. The Markdown remains
  accessible as documentation.

### Notes

- Pay Memory is unchanged. All 11 Pay Memory CLI commands and
  8 MCP tools work exactly as in v0.8.1.
- `AI Wiki/` and `Daily/` remain on disk and stay readable for
  agents via `second_brain_query`. Agents do not write to them
  in v0.9.0+.
- OpenClaw native JavaScript parity for Brain tools is deferred
  to v0.9.1 (tracked as BRAIN-FUT-007 in
  [`docs/plans/2026-05-15-brain-roadmap.md`](docs/plans/2026-05-15-brain-roadmap.md)).
  v0.9.0 ships Brain through the TypeScript CLI + MCP path used by
  Hermes, Claude Code, and Codex.
- Hard removal of the deprecated v0.8.x agent-facing write code
  is deferred to v0.10 or later, gated on observed usage of Brain
  (BRAIN-FUT-009).
- Full design and implementation plan:
  [`docs/plans/2026-05-15-brain-observing-memory.md`](docs/plans/2026-05-15-brain-observing-memory.md).

## [0.8.1] - 2026-05-14

Plugin-bundled lifecycle hooks for Claude Code and Codex that close a
real silent-skip bug: the MCP server's `instructions` reminder to call
`event_log_append` after a durable artifact was being dropped under
load with no visible signal — agent finished the turn, the vault's
Daily log stayed empty, no stderr trail. This release moves the
reminder out of soft instructions and into a runtime-side guardrail.

Hermes and OpenClaw are unaffected: Hermes already injects the
equivalent reminder through its `pre_llm_call` shim, and OpenClaw's
native JS plugin format predates the hook schema. The new hooks are
loaded only by Claude Code and Codex.

### Added

- **Lifecycle hooks** (`hooks/`):
  - `PostToolUse` (matcher `Write|Edit|MultiEdit|apply_patch`) — emits
    a developer-context reminder right after the file-mutating tool
    returns. Skipped when `tool_response` reports `is_error: true` or
    `success: false` so failed edits do not generate noise.
  - `Stop` — parses the runtime's transcript JSONL, decides whether
    the turn produced a durable artifact AND whether
    `event_log_append` was called (recognising both the bare Codex
    name `event_log_append` and the Claude-decorated
    `mcp__plugin_open-second-brain_open-second-brain__event_log_append`,
    matched via `/(?:^|__)event_log_append$/` so future prefix
    renames keep working). Emits `{"decision":"block","reason":…}`
    once per turn; respects `stop_hook_active === true` so the next
    Stop passes unconditionally — the agent decides whether to log
    or just finish, no deadlocks.
  - Bash logging counts: if the agent ran `o2b append-event …` or
    `vault-log …` through `Bash` (Claude) or `exec_command` /
    `shell` (Codex), the parser pulls the command string out of the
    transcript and the guardrail treats it as a valid log call.
- **`scripts/o2b-hook`** — PATH-deployed shim that both runtimes
  invoke from `hooks/hooks.json`. Resolves its own location, runs
  the Bun precheck, and execs `hooks/<name>.ts`. `o2b install-cli`
  now symlinks `o2b-hook` alongside `o2b` and `vault-log`. One
  PATH-discoverable entry point works in both runtimes without a
  per-runtime `${PLUGIN_ROOT}` env var (Codex 0.129 exposes none).
- **Codex manifest wiring**: `"hooks": "./hooks/hooks.json"` added to
  both `.codex-plugin/plugin.json` and
  `plugins/codex/.codex-plugin/plugin.json`; `plugins/codex/hooks`
  symlinked to `../../hooks` (mirrors the existing
  `plugins/codex/skills` pattern).
- **Tests** (`tests/hooks/`): 52 new bun:test cases covering format
  detection, Claude / Codex transcript shapes, artifact / log
  classification (including the prefix-decorated MCP names),
  Bash-as-log paths, the trailing-newline JSON contract, malformed
  JSONL, empty transcripts, missing `transcript_path`,
  `stop_hook_active`, failed-edit suppression.
- **Documentation**:
  - `hooks/README.md` — full design notes (cross-runtime detection,
    PATH-based shim rationale, symlink caveat for Codex marketplace
    staging, cwd contract for test subprocesses).
  - `install.md` branches C (Codex) and D (Claude Code) — new
    `### 6b. Lifecycle hooks (auto-enabled)` sections; step 3 in
    every branch now mentions the `o2b-hook` symlink.
  - `install.md` readiness checklist — split the `VAULT_AGENT_NAME`
    line so it requires the env var for Hermes / Codex only;
    Claude Code derives identity from the persisted plugin config
    that `o2b init --agent-name` writes.
  - `README.md` rewritten to be runtime-neutral — removed Hermes-first
    framing and duplication with `install.md`, added a
    Supported-runtimes table and a Lifecycle-hooks section.

### Fixed

- Silent `event_log_append` skips after a durable artifact landed,
  visible in real Claude Code sessions where a Write or Edit was
  followed by no log call and no warning. The `Stop` guardrail now
  blocks the turn once with a clear reason; the agent must either
  log or explicitly skip by sending its final reply a second time.

### Changed

- `sync-version` now also updates `plugins/codex/.codex-plugin/plugin.json`
  (it was stuck at 0.7.0). All seven manifests stay in lockstep with
  `package.json`.
- `tsconfig.json` `include` extended to cover `hooks/**/*.ts`.

## [0.8.0] - 2026-05-10

Pay Memory: a memory and audit layer for paid agent actions. Hermes (or any
other supported runtime) makes a paid API call through `pay.sh`; Open Second
Brain saves the reason, the policy check, the receipt, the generated asset,
the spending policy decision, the human-approval state, and a per-task
report — all as plain Markdown inside the configured vault.

This release does not execute payments and does not hold wallet keys. The
payment still happens through the agent's local `pay` CLI; Open Second Brain
records what happened.

### Added

- **Core Pay Memory module** (`src/core/pay-memory/`):
  - filesystem helpers (`paymentsDateDir`, `receiptPath`, `assetPath`,
    `reportPath`) and `validateSlug` (defense-in-depth against path
    traversal in user-supplied slugs);
  - best-effort raw-output redactor for `api_key` / `token` / `secret` /
    `bearer` / `authorization` / `private_key` / `password` / `passwd` /
    `pwd` / `credential` / `session_token` in env, YAML, JSON, and
    HTTP-header shapes;
  - deterministic Markdown receipt / asset / report writers with
    frontmatter; bracket and backtick sanitisation in wikilinks /
    inline-code spans;
  - spending policy template renderer (`spending.md`) plus a separate,
    optional **machine-readable policy** (`spending.json`) with
    allowlist, single-call cap, daily budget cap, per-category receipt
    quotas, and "require approval above" threshold;
  - daily payment digest (`buildPaymentDigest` +
    `renderPaymentDigestTelegram`) for cron-friendly 4-line summaries;
  - **approval workflow** (`pending-payment-request` artifact under
    `AI Wiki/payments/_pending/`) with `pending → approved/rejected →
    consumed` state machine.
- **Path-safety helpers** (`src/core/path-safety.ts`): `ensureInsideVault`
  and `vaultRelative` use `path.sep` so the prefix check works on Windows
  too; replaces the duplicated POSIX-only versions previously inlined in
  `src/mcp/tools.ts` and `src/core/pay-memory/paths.ts`.
- **Atomic / race-safe writers** (`atomicCreateFileSyncExclusive`,
  `writeFrontmatterAtomic`): Pay Memory artifacts are written via
  `link(2)` semantics so "refuse to overwrite" is enforced atomically
  even with concurrent CLI + MCP server processes.
- **CLI commands** (eleven new in this version):
  - `init-pay-memory` — bootstrap `AI Wiki/{policies,payments,assets,drafts,reports}/`
    and write `policies/spending.md`.
  - `append-payment-receipt` — save a Markdown receipt; `--raw-output-file`
    is redacted before persisting.
  - `capture-asset` — save a Markdown note for a generated asset.
  - `payment-report` — aggregate a date's receipts into a Markdown report.
  - `check-payment-policy` — evaluate a prospective paid call against
    `spending.json`; exit 0 / 1 / 3 = allowed / denied / approval_required.
  - `request-payment-approval` — create a pending request the user must
    sign off on before the agent runs `pay`.
  - `approve-payment-request`, `reject-payment-request`,
    `consume-payment-request`, `list-pending-payments` — human / agent
    sides of the approval workflow.
  - `payment-digest` — render a Telegram-friendly 4-line summary for a
    date (with `--empty-mode silent|empty|summary`).
- **MCP tools** (eight new in this version): `payment_memory_init`,
  `payment_receipt_append`, `asset_capture`, `payment_report_generate`,
  `payment_policy_check`, `payment_request_approval`,
  `payment_request_status`, `payment_request_consume`. Server
  `initialize.instructions` describes the suggested call chain.
- **Documentation**: `docs/hermes-cron.md` (wiring `payment-digest` into a
  Hermes cron `--script --no-agent` job for daily Telegram delivery),
  `examples/hermes-payment-digest.sh` reference wrapper,
  `docs/plans/2026-05-10-pay-memory.md` (implementation plan), and
  `tests/e2e/pay-memory-sandbox.sh` (manual end-to-end smoke test against
  the real `pay --sandbox` CLI).

### Changed

- The MCP tool server now advertises **thirteen** tools (the previous five
  plus eight Pay Memory tools).
- `core/vault.ts` exposes `formatFrontmatter` (pure renderer) and
  `writeFrontmatterAtomic` (race-safe writer used by Pay Memory). The
  legacy `writeFrontmatter` keeps its non-atomic semantics for non-critical
  callers (`init.ts`, the `o2b index` command, etc.).

### Out of scope

- On-chain anchoring of vault hashes (Solana memo, web3 RPC) is
  intentionally excluded from this project. Pay Memory continues to record
  `payment_proof` strings opaquely for whatever upstream system produced
  them; the audit trail lives in the vault, not on a blockchain.

## [0.7.0] - 2026-05-09

Single TypeScript source of truth on the [Bun](https://bun.sh) runtime.
Hermes, Claude Code, Codex, and OpenClaw all consume the same `src/core/`
modules; the duplicate JavaScript copy under `openclaw/*.js` and the
parallel Python implementation under `src/open_second_brain/*.py` are gone.

### Added

- TypeScript core (`src/core/`) for config, event-log, vault, init, doctor.
- `bun:test` suite (176 cases) + Python shim tests (13 cases). Includes a
  12-worker multi-process append-event lock test.
- Per-runtime install flows for local marketplaces (Claude `claude plugin
  marketplace add <path>`, Codex `codex plugin marketplace add <path>`,
  Hermes via plugin-dir symlink, OpenClaw `openclaw plugins install <path>`).
- `agent-event-log` skill: stronger trigger description and a language
  policy that follows the user's session language.
- `scripts/sync-version.ts` and `bun run sync-version:check` to keep all
  manifests aligned with `package.json`.
- `bun.lock` for reproducible dependency resolution.

### Changed (BREAKING)

- **Runtime:** `o2b` CLI requires [Bun](https://bun.sh) (>=1.1.0). The
  wrapper script aborts with an install hint if `bun` is not on PATH.
- **Source layout:** Python `src/open_second_brain/*` replaced by TypeScript
  `src/core/*`, `src/cli/*`, `src/mcp/*`.
- **OpenClaw plugin:** `openclaw/index.js` is now a `bun build` bundle
  (target=node) of `src/openclaw/index.ts`; no more hand-translated JS.
  CI rebuilds and diffs the committed bundle.
- **Hermes plugin:** `plugins/hermes/__init__.py` slimmed to a thin shim
  (`pre_llm_call` + minimal health). Identity reminder template lives in
  `templates/identity-reminder.txt`, shared with the OpenClaw
  `before_prompt_build` hook.
- **Version source of truth:** `package.json`. `pyproject.toml` and the
  five plugin manifests carry synced copies.
- **CI:** `oven-sh/setup-bun@v2`, `bun test`, `bun run typecheck`,
  Python-shim tests, manifest + bundle freshness checks.

### Fixed

- **Security — path traversal in `event_log_append`:** `date` parameter is
  now validated against `^\d{4}\.\d{2}\.\d{2}$` and rejects non-existent
  calendar dates and `..` segments. Previously `date: "../AI Wiki/notes/pwn"`
  could write outside `Daily/`.
- **Identity hallucination:** placeholder blacklist extended to include
  `codex`, `codex-cli`, `codex-exec`, `claude-code`, `hermes`, `openclaw`.
  When the model echoes its runtime name as the `agent` argument the server
  now falls back to the persisted `agent_name` instead of writing
  `@codex` / `@hermes` / etc.
- **Cross-platform paths:** `fs-atomic`, `install-cli`, `uninstall` use
  `node:path` `basename` / `sep` instead of hard-coded `/`.
- **Test reliability:** `expect(Bun.file(...).text()).resolves` now awaited
  — assertion was silently dropped.
- **Hermes shim:** `__init__.py` tolerates both relative and absolute
  `plugins.hermes` import paths (Hermes loads it as a file directly).

### Removed (BREAKING)

- Python `open_second_brain` package and its pip entry points
  (`o2b`, `vault-log`, `o2b-mcp`).
- `openclaw/event-log.js` and `openclaw/vault.js` (rolled into the bundle).

### Migration

1. Install Bun (`curl -fsSL https://bun.sh/install | bash`).
2. `git pull` the plugin checkout.
3. Re-run `o2b install-cli` to refresh symlinks.
4. `o2b doctor --vault <path> --repo <repo>` to verify.

Hermes / Claude Code / Codex / OpenClaw configurations do not change.

## [0.6.2] - 2026-05-08

### Added

- install.md `## Verification — identity registry` block. Confirms
  the chosen agent name appears in
  `<vault>/AI Wiki/identity/agents.md` after `o2b init`. Multi-runtime
  installs grow the list incrementally.
- install.md prelude note: `o2b` CLI on PATH is a single shared
  symlink across runtimes — first-installed wins, subsequent
  `install-cli` refuses to overwrite. Manual repointing is allowed
  but unnecessary.

### Changed

- install.md "Agent name" subsection (branches A–D): installer agent
  **MUST** ask the user, **MUST** first check
  `~/.config/open-second-brain/config.yaml`,
  `<vault>/AI Wiki/identity/agents.md`, and `<vault>/Daily/*.md` for
  a previously-set identity and surface it as a reuse-or-change
  question. Defaults list only shown if no prior identity is found.
- install.md "no version pin" guidance: replaced the ambiguous
  "tracks `main`" framing with "**latest released version**" plus an
  explicit `v0.6.1` vs `v0.6.0` example, and a direct statement that
  manually appending `@v...` freezes the install at the literal tag
  you typed.
- install.md prelude: `o2b init` idempotency description updated to
  describe the new multi-agent append behavior on
  `AI Wiki/identity/agents.md`.

### Fixed

- Multi-agent registration in `AI Wiki/identity/agents.md`. Second and
  later `o2b init --agent-name <name>` runs now append under
  `## Registered agents` instead of being a silent no-op once the
  placeholder is gone. Idempotent for already-registered names.
- install.md Branch C steps 2–3: Codex CLI 0.129+ caches the
  marketplace under `~/.codex/.tmp/marketplaces/<name>/`, not the
  previously documented `~/.codex/plugins/cache/<marketplace>/<plugin>/<hash>/`.
  Step 3 now uses a `find` pattern that works on either layout.
- install.md Branch D step 3: Claude Code caches plugins under a
  `<version>` segment (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/scripts/o2b`).
  Same `find`-based fix as Branch C.

## [0.6.1] - 2026-05-08

### Added

- `pre_llm_call` hook in the Hermes-side adapter. Each turn the plugin
  injects a compact identity + workflow nudge into the user message —
  the LLM learns its `@agentName` and the contract for
  `event_log_append` (plain message text; the server prepends timestamp
  and identity). Skips injection silently when the agent identity is
  not configured, so the literal `@agent` placeholder never reaches
  the LLM.
- `.claude-plugin/marketplace.json` — single-plugin Claude Code
  marketplace manifest. Claude Code 2.x install flow is
  `claude plugin marketplace add` → `claude plugin install <plugin>@<marketplace>`,
  and the marketplace step expects this catalog file. Without it, the
  install fails with `Marketplace file not found`. Manifest declares
  the repository as a one-plugin marketplace pointing at itself
  (`source: "./"`), so the same Git URL works for every other runtime
  without restructuring.
- `.mcp.json` at the repo root — Claude auto-registers MCP servers
  declared here when the plugin is installed, so users never run
  `claude mcp add` manually. The entry uses `${CLAUDE_PLUGIN_ROOT}` to
  stay portable, and intentionally carries no `--vault` arg or env
  vars: the MCP server reads vault/agent/timezone from the persisted
  plugin config (see `vault` field below). Same `.mcp.json` works on
  every user's machine without per-host customization.
- `o2b init --vault <path>` now also persists the vault path into the
  plugin config (`vault` field, alongside `agent_name` and `timezone`).
  `o2b mcp` invoked without `--vault` (Claude `.mcp.json`
  auto-register, Hermes/Codex MCP entries that omit the flag) reads
  from this field — falling back to `VAULT_DIR` env, then to a clear
  error referencing `o2b init`.
- `config.resolve_vault(config_path)` — public helper, mirroring the
  existing `resolve_agent_name` and `resolve_timezone` shape.
- install.md Branch D is rewritten end-to-end against current Claude
  Code CLI (2.x): step 2 uses `claude plugin marketplace add` plus
  `claude plugin install <plugin>@<marketplace>` (the legacy
  `claude plugins install <git-ref>` form was removed in 2.x); step 5
  collapses to a no-op because Claude auto-registers MCP servers from
  the bundled `.mcp.json`; step 6 verifies via `claude plugin list` and
  `claude mcp list`; step 7 uses the marketplace + plugin update
  commands; step 8 uses the matching uninstall/remove pair.

- `.agents/plugins/marketplace.json` — single-plugin Codex marketplace
  manifest at the repo root. Codex 0.129+ has dropped the legacy
  `codex plugins install <git-ref>` command; the only documented install
  path is `codex plugin marketplace add <source>`, which validates a
  marketplace catalog at this exact location. Without this file the
  install fails with `marketplace root does not contain a supported
  manifest`. The manifest declares the repository as a one-plugin
  marketplace pointing at itself (`path: "."`), so the same Git URL
  that worked for `hermes plugins install` works for the new Codex
  flow without restructuring the repo.
- install.md Branch C is rewritten end-to-end against current Codex CLI
  (0.129+): step 2 uses `codex plugin marketplace add` plus a manual
  `[plugins."open-second-brain@open-second-brain"] enabled = true`
  stanza in `~/.codex/config.toml` (Codex has no `plugin enable`
  subcommand); step 5 uses `codex mcp add ... -- o2b mcp --vault ...`
  with both `VAULT_AGENT_NAME` and `VAULT_TIMEZONE` env vars; step 7
  uses `codex plugin marketplace upgrade`; step 8 uses
  `codex mcp remove` + `codex plugin marketplace remove`. The previous
  text referenced commands (`codex plugins install/update/uninstall`)
  that simply do not exist on current Codex.
- Timezone support for Daily event log entries. The plugin now stamps
  `HH:MM` and the day-file selection in the user's local timezone
  instead of the host's clock — important when the host runs in UTC
  but the user lives in a different zone, or when Daily entries
  straddle midnight in the user's local time. Resolution order:
  `VAULT_TIMEZONE` env var → `timezone` field in the plugin config →
  fallback to system local. Invalid names are silently treated as not
  configured (entries still land, just stamped in server time) so a
  typo never breaks logging.
- `o2b init --timezone <iana-name>` validates the IANA name via stdlib
  `zoneinfo` and persists it to the plugin config alongside
  `agent_name`. Invalid input is rejected before any vault scaffolding
  is written, so a typo cannot leave the install in a half-configured
  state.
- `open_second_brain.config.resolve_agent_name()` and
  `resolve_timezone()` — public helpers used by both the MCP server
  and the Hermes hook so identity and timezone reads stay consistent
  across every runtime / CLI surface.
- `scripts/sync-version.py` — propagates the canonical version from
  `pyproject.toml` into every runtime manifest (`plugin.yaml` × 2,
  `package.json`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `openclaw.plugin.json`). Idempotent;
  ships a `--check` mode for CI drift detection.

### Changed

- `.claude-plugin/plugin.json` modernized to current Claude 2.x schema:
  `author` is now an object (`{ "name": "..." }`) per the docs (Claude
  2.1.x rejected the legacy string form with `author: Invalid input`),
  and the embedded `commands` array is removed (Claude no longer
  parses in-manifest slash command definitions; they are authored as
  Markdown files under `commands/` at the plugin root if needed).
- `o2b doctor` `claude_manifest` check rewritten to validate the new
  schema. It accepts the modern `author` object form and reports a
  clear error when an old-style `commands` array is present.
- OpenClaw native plugin entry brought to parity with the Python /
  MCP side for the features added in this release. `openclaw/index.js`
  now uses `resolveTimezone(api)` (reads `api.pluginConfig.timezone`,
  falls back to `VAULT_TIMEZONE` env) and a `normalizeAgentArgument`
  helper (strips leading `@`, treats common LLM self-name guesses
  like `agent` / `assistant` / `claude` / `gpt` as "no value" so the
  resolved default identity is used instead). `openclaw/event-log.js`
  `currentDate(tz)` / `currentTime(tz)` use `Intl.DateTimeFormat` so
  Daily entries are stamped in the user's local timezone instead of
  the host's clock — matching the Python `current_date(tz)` /
  `current_time(tz)` behavior. The `appendEvent(...)` signature gains
  a trailing optional `tz` argument; backward-compatible.
  `openclaw.plugin.json` `configSchema` and `uiHints` now declare a
  `timezone` field so OpenClaw users can set it via
  `openclaw config set plugins.entries.open-second-brain.config.timezone "..."`.
- install.md Branch B step 1 corrected: previously claimed the
  OpenClaw native plugin reads timezone from
  `~/.config/open-second-brain/config.yaml`. It does not — the JS
  plugin reads exclusively from `api.pluginConfig` (OpenClaw's own
  per-plugin store, populated by `openclaw config set`). Step 5 now
  includes a fourth `openclaw config set` line for the timezone, and
  the worked example JSON shows `timezone` alongside `agentName`.
- Removed the unused, drifting `PLUGIN_VERSION = "0.6.0"` constant
  from `openclaw/index.js`. The two unused local helpers
  `currentDate()` / `currentTime()` in the same file were also
  deleted (the active versions live in `openclaw/event-log.js` and
  are now timezone-aware).
- Hardened vault resolution across every write-mode CLI entry point.
  Previously `vault-log`, `o2b append-event`, `o2b doctor`,
  `o2b index`, `o2b tool-call`, and `o2b mcp` (the standalone
  `open_second_brain.mcp:main` console script) all fell back to the
  current working directory (`Path(os.environ.get("VAULT_DIR", "."))`)
  when neither `--vault` nor `VAULT_DIR` was set. That fallback was
  silent: an agent invoking `vault-log "..."` from `$HOME` would
  write `~/Daily/<date>.md` instead of the user's actual vault, and
  the success line `appended: Daily/...` gave no signal that the
  entry had landed in the wrong place. Now every one of these entry
  points resolves the vault via `--vault → VAULT_DIR → persisted
  plugin config (vault field)`, and exits with a clear
  `error: no vault configured. Pass --vault ... or run o2b init ...`
  if none of those is set. The shared resolver lives in
  `cli._require_vault`; the `vault-log` and standalone-`o2b mcp`
  paths use the same logic inline because they don't share the cli
  module's argparse setup.
- `vault-log` and `o2b append-event` now print the **absolute** path
  of the appended Daily file (`appended: /abs/.../Daily/<date>.md`),
  not a relative `Daily/<date>.md`. The relative form was the visual
  disguise that hid the silent-cwd-fallback bug above.
- install.md step 1 in every branch is now "Collect installation
  parameters (vault path + agent name + timezone)" — three values
  instead of two. The new "Vault path" subsection tells the
  installer agent how to discover the user's Obsidian vault on the
  target machine: scan common roots (`~/`, `~/Documents/`,
  `~/Sync/`, iCloud paths, Syncthing mounts), look for the
  `.obsidian/` marker subdirectory, list candidates and ask the user
  to pick one, or ask for a path if none are found. The agent must
  confirm the resolved absolute path with the user before passing it
  to `o2b init`. No vault location is hard-coded in the docs — the
  example `/path/to/vault` placeholder remains generic.
- `docs/architecture.md` example config snippet no longer hard-codes
  `/root/vault` / `hermes-vps-agent` / `vps-techmeat`. Replaced with
  generic placeholders so the doc reads correctly on any machine.
- `set_config_value` (`config.py`) is now atomic and stricter:
  contents go through a sibling temp file with `fsync` + `os.replace`,
  so an interrupt during the write leaves either the previous config
  or the new one intact — never a half-written hybrid. Values
  containing characters that the simple parser cannot round-trip
  (`"`, `\\`, `\n`, `\r`) are rejected with a clear `ValueError`
  instead of being silently corrupted on the next read. The fields
  this helper persists (`vault` paths, IANA timezone names, agent
  identifiers) never legitimately contain those characters; the
  rejection is a guardrail against future callers passing arbitrary
  strings through. Surfaced by an autonomous CodeRabbit review pass.
- OpenClaw `resolveTimezone(api)` now validates the candidate against
  `Intl.DateTimeFormat` before returning it. An invalid IANA name in
  `api.pluginConfig.timezone` or `VAULT_TIMEZONE` would otherwise
  crash every `event_log_append` call inside `Intl.DateTimeFormat`
  with `RangeError`. The Python side already had this fallback
  (`config.resolve_timezone` swallows `ZoneInfoNotFoundError`); the
  JS side now matches.
- `o2b doctor`'s `claude_manifest` author check rejects an empty
  `name` (e.g. `{"author": {"name": ""}}`) with the same error
  message used for missing or wrong-typed `author`. Previously
  ``isinstance(author.get("name"), str)`` accepted the empty string.
- The two timezone-aware MCP tests now capture the local-tz wall
  clock **before** invoking the tool. The previous order computed
  `now_local` after the tool returned, which around midnight could
  flake: tool stamps day N, assertion looks for day N+1. Tightened.
- New install.md **Branch E — Generic adapter (other runtimes)**. For
  any runtime not covered by branches A–D (a new MCP-aware client, a
  different agent platform, or a supported runtime after a breaking
  CLI rename), Branch E describes the install **contract** the
  plugin needs — directory layout, `o2b` on PATH, `o2b mcp` registered
  as stdio MCP server, persisted plugin config — instead of literal
  commands. It instructs the installer agent to consult the target
  runtime's own plugin / MCP documentation and translate each step
  into the runtime-specific equivalent, asking the user before
  guessing on any step that has no obvious analogue. The document
  prelude was updated to list E as the fallback option alongside
  A–D.
- "When to log" criteria broadened in both surfaces the LLM sees:
  the per-turn `pre_llm_call` nudge and the MCP server's
  `serverInfo.instructions`. The previous wording only listed concrete
  artifacts (feature/fix/config/instruction-file/content) and instructed
  the LLM to skip "exploration, planning, or pure discussion". This
  caused agents to refuse logging substantial-but-non-tangible work —
  research findings, design decisions, investigations that surfaced
  facts worth recalling. The rules now treat any **durable artifact**
  as loggable, including research outcomes, design decisions, and
  external-fact discoveries (CLI behaviour change, API quirk, etc.),
  and end with a self-test prompt: *"would future-me want to find this
  in the log by searching for it later?"*. Skip-list is unchanged in
  spirit but reworded around "did not produce an artifact" rather
  than against specific activity types.
- `tests/test_cli.py` `run_cli` helper now isolates
  `OPEN_SECOND_BRAIN_CONFIG` per call by default. With `o2b init` now
  unconditionally persisting `vault` / `agent_name` / `timezone` into
  the config file, init-tests without explicit isolation were silently
  writing to the developer's real `~/.config/open-second-brain/config.yaml`.
  Tests that specifically exercise the default-config path can still
  pass `env={"OPEN_SECOND_BRAIN_CONFIG": ...}` to override the guard.
- The package version is now a single source of truth in
  `pyproject.toml`. `open_second_brain.__version__` reads it
  dynamically (live `pyproject.toml` first, `importlib.metadata`
  fallback) so a version bump shows up at runtime without a pip
  reinstall. `mcp.SERVER_VERSION` re-exports the same value.
- `event_log.append_event(..., tz=...)` accepts an optional
  `datetime.tzinfo` parameter; `current_date` and `current_time` are
  likewise tz-aware. Backward-compatible: omitting `tz` keeps the
  previous server-local behavior.
- install.md step 1 in every branch is now "Collect identity (agent
  name + timezone)" — a single up-front step that asks the user for
  both values before any commands run. The instructions tell the
  installer agent to accept free-form timezone input (city, country,
  abbreviation) and translate it to canonical IANA before passing to
  `o2b init`.
- `event_log_append` accepts and normalizes a wider set of LLM-supplied
  values for the optional `agent` argument: leading `@` is stripped
  (so `@hermes-vps-agent` no longer becomes `@@hermes-vps-agent`), and
  common placeholder/self-name guesses (`agent`, `assistant`, `claude`,
  `gpt`, …) fall back to the server-resolved default identity instead
  of being written verbatim into Daily.
- `event_log_append` and other tools that take optional string
  arguments now treat empty strings the same as omitted arguments.
  LLMs in tool-use mode frequently emit `""` for fields they want to
  skip; the previous behavior rejected `time=""` / `date=""` with a
  validator error.
- `o2b init --agent-name <name>` now also persists the chosen identity
  into the plugin config (`~/.config/open-second-brain/config.yaml` by
  default), not only into `AI Wiki/identity/agents.md`. Resolution
  order in `event_log_append` is unchanged
  (`VAULT_AGENT_NAME` env → plugin config → literal `agent`
  placeholder), but persistence now survives runtimes that do not
  propagate the env into the MCP subprocess.
- The MCP `initialize` response's `serverInfo.instructions` field now
  carries an identity + workflow block (you-are-@&lt;agent&gt;, when to
  call `event_log_append`, message format rules) rather than a plain
  list of tool names. Clients that surface MCP `instructions` to the
  LLM benefit immediately; clients that ignore the field are unaffected.

## [0.6.0] - 2026-05-08

### Added

- Daily-log agent identity workflow. Each runtime install now selects an
  agent name (e.g. `openclaw-main`, `hermes-vps-agent`, `<hostname>-codex`,
  …) that is used as the `@agent-name` prefix in `Daily/*.md` event log
  entries.
- `o2b init --agent-name <name>` writes the chosen identity into
  `AI Wiki/identity/agents.md` and replaces the template placeholder
  (`(add your agents here, …)`). Existing vaults are upgraded in place
  without `--force`: the placeholder line is rewritten.
- `agentName` field in `openclaw.plugin.json` `configSchema` and `uiHints`
  alongside `vault` / `instanceName`. The OpenClaw native plugin reads
  `api.pluginConfig.agentName` and uses it as the default agent for
  `event_log_append` calls that omit the `agent` argument.
- `event_log_append` (Python MCP) now resolves the default agent from
  `VAULT_AGENT_NAME`, then from `agent_name` / `agentName` in the
  discovered config file, then falls back to `agent`.
- New "Verification — daily identity" step in `install.md` and
  `after-install.md`. Calls `event_log_append` without an explicit
  `agent` and asserts the daily entry shows `@<chosen-agent-name>` rather
  than `@agent`.
- `install.md` now covers all four runtimes (Hermes, OpenClaw, Codex,
  Claude Code) with runtime-appropriate agent name defaults.
- Installation readiness criteria now require `agentName` to be configured
  (or `VAULT_AGENT_NAME` exported), the placeholder removed from
  `agents.md`, and the daily-identity check to pass.

### Changed

- Bumped package, plugin, MCP server, OpenClaw plugin, and Hermes adapter
  versions to 0.6.0.

## [0.5.5] - 2026-05-08

### Added

- `o2b install-cli` subcommand: creates symlinks for `o2b` and `vault-log`
  in `~/.local/bin` pointing to the wrapper scripts inside the plugin
  checkout. Run once after `hermes plugins install` to make bare `o2b`
  available on PATH. Symlinks survive `hermes plugins update` because they
  point into the git-managed checkout.
- `o2b uninstall --remove-cli` flag: removes the symlinks created by
  `install-cli` during uninstall.

### Fixed

- Installation instructions (`install.md`, `after-install.md`, `README.md`)
  now include the `install-cli` step between `hermes plugins install` and
  `o2b init`, closing the gap where bare `o2b` was not found on PATH after
  a clean plugin install.

## [0.5.4] - 2026-05-07

### Fixed

- Added `name` field inside each tool object passed to `api.registerTool()`.
  OpenClaw 2026.5.6 reads `tool.name` during normalization and calls `.trim()`
  on it — omitting it caused `TypeError: Cannot read properties of undefined`.

## [0.5.3] - 2026-05-07

### Fixed

- Changed `register(api)` from `async` to synchronous in `openclaw/index.js`.
  OpenClaw requires `register` to be synchronous — only `execute()` callbacks
  inside tools may be async.

## [0.5.2] - 2026-05-07

### Changed

- Rewrote OpenClaw runtime entry in pure JavaScript — all five tools
  (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
  `event_log_append`, `vault_health`) now operate directly on the vault
  filesystem using `node:fs/promises` and `node:path` instead of spawning
  a Python subprocess. This passes the OpenClaw security scanner which
  blocks `child_process` imports.
- Removed `openclaw/o2b-runner.js` subprocess helper (no longer needed).
- Added `openclaw/vault.js` and `openclaw/event-log.js` pure JS modules.
- Switched to `api.pluginConfig` for reading plugin configuration and
  two-arg `api.registerTool(tool, { name })` registration pattern to
  match bundled OpenClaw plugin conventions.

### Removed

- `openclaw/o2b-runner.js` — subprocess runner blocked by security scanner.

## [0.5.1] - 2026-05-07

### Added

- Root `package.json` with `openclaw.extensions` so OpenClaw can install the
  plugin via `git:` and `npm-pack:` resolvers without errors.
- `openclaw/index.js` runtime entry that registers five native OpenClaw tools
  (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
  `event_log_append`, `vault_health`) through `definePluginEntry` and
  `api.registerTool`. Tool execution spawns `python3 -m open_second_brain.cli`
  with `PYTHONPATH` pointing at the plugin's `src/` directory.
- `openclaw/o2b-runner.js` subprocess helper for calling Python from the JS
  entry.
- `tool-call` CLI subcommand that bridges MCP tool handlers to the command
  line, enabling the JS entry to invoke tools like `second_brain_query` and
  `second_brain_capture` without running a full MCP server.
- `check_openclaw_installability` doctor checks that validate `package.json`
  exists, has `openclaw.extensions`, and each extension file is present.
- `uiHints` and `activation` fields in `openclaw.plugin.json`.
- OpenClaw packaging validation step in the CI release workflow.

### Changed

- Bumped package, plugin, and manifest versions to 0.5.1.
- `install.md` OpenClaw branch now uses `openclaw config set` for vault
  configuration instead of manual MCP registration — tools are registered
  natively by the plugin entry.
- `mcpEnabled` default changed to `false` in `openclaw.plugin.json` because
  native tool registration makes the MCP server unnecessary for most OpenClaw
  setups.
- `docs/architecture.md` OpenClaw adapter section now describes the JS entry +
  Python bridge pattern instead of the Bundle-only approach.

## [0.5.0] - 2026-05-07

### Added

- OpenClaw native plugin compatibility through `openclaw.plugin.json` manifest at
  the project root. OpenClaw discovers the plugin via the Bundle format
  (auto-detecting `.claude-plugin/` and `.codex-plugin/`) combined with the
  static manifest for cold discovery. The MCP server serves as the runtime tool
  bridge. See `docs/architecture.md` for the adapter layout.
- `check_openclaw_manifest` health check in `doctor.py` that validates
  `openclaw.plugin.json` has required fields (`id`, `configSchema`) and that the
  declared tool names match the MCP tool table.
- `openclaw_manifest` check in the Hermes adapter health report
  (`plugins/hermes/__init__.py`).
- OpenClaw installation and configuration section in `README.md`.
- OpenClaw post-install steps in `after-install.md`.
- OpenClaw adapter section in `docs/architecture.md`.
- Validation of `openclaw.plugin.json` in the CI release workflow
  (`.github/workflows/release.yml`).
- `tests/test_openclaw_plugin.py` covering manifest validity, required fields,
  tool name consistency with the MCP server, and installability invariants.

### Changed

- Bumped package, plugin, MCP server, and Claude/Codex manifest versions to 0.5.0.
- Updated `pyproject.toml` description to mention OpenClaw alongside Hermes,
  Claude Code, and Codex.
- Updated `.codex-plugin/plugin.json` description to mention OpenClaw.

## [0.4.2] - 2026-05-06

### Changed

- Reworded the `--args` guidance in `after-install.md` and `docs/mcp.md` so
  the docs no longer contain a literal copyable quoted-args anti-example.
  The corrected `hermes mcp add open-second-brain --command o2b --args mcp
  --vault /path/to/vault` example stays; the negative case is now described
  in prose ("do not wrap all of those arguments into one quoted shell
  string and do not repeat `--args` per token") so a careless copy/paste
  cannot pick up the wrong form.
- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.2.

## [0.4.1] - 2026-05-06

### Added

- `o2b uninstall` CLI helper that prints a read-only uninstall plan, including
  the exact Hermes commands the user must run (`hermes mcp remove`,
  `hermes plugins remove`, `hermes gateway restart`) and the location of the
  machine-local config directory.
- `--apply-local` flag for `o2b uninstall` that may remove the machine-local
  config directory only (`~/.config/open-second-brain` or the parent of
  `$OPEN_SECOND_BRAIN_CONFIG`). Refuses to act on directories whose name is
  not a recognized Open Second Brain config dir, paths inside Hermes-owned
  trees, or directories that look like git repositories.
- `after-install.md` at the repository root so Hermes can show post-install
  guidance (init, MCP registration, update, uninstall) right after
  `hermes plugins install`.
- `uninstall` command entry in the Claude Code plugin manifest.
- README now documents an explicit Hermes CLI form for MCP registration
  (`hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault`)
  and adds dedicated **Updating** and **Uninstalling** sections that spell
  out the Hermes-owned vs. machine-local layers.
- `docs/mcp.md` now covers updating and removing the MCP registration, and
  warns against passing `--args` as a single quoted string.
- Dedicated `tests/test_uninstall.py` covering dry-run safety, vault and
  Hermes config preservation, the `--apply-local` allow-list, the
  `OPEN_SECOND_BRAIN_CONFIG` env override, and the help text invariants.

### Changed

- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.1.

### Migration / Uninstall notes

- `o2b uninstall` is read-only by default. It **never** edits
  `~/.hermes/config.yaml`, removes the installed plugin directory, or
  touches the vault — including `Daily/`, `AI Wiki/`, or any Markdown.
- To deregister the MCP server and remove the plugin run the Hermes
  commands yourself (`hermes mcp remove open-second-brain`,
  `hermes plugins remove open-second-brain`, `hermes gateway restart`).
- `o2b uninstall --apply-local` only removes the machine-local
  Open Second Brain config directory; it refuses to delete anything else.
- Existing users do not need to re-register the MCP server after upgrading
  to 0.4.1; the plugin update flow keeps `~/.hermes/config.yaml` untouched.

## [0.4.0] - 2026-05-06

### Added

- Optional Model Context Protocol (MCP) tool server over stdio JSON-RPC 2.0 (`o2b mcp`, `o2b-mcp`).
- Five MCP tools backed by the existing core: `second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`.
- `docs/mcp.md` guide for Hermes `~/.hermes/config.yaml mcp_servers` registration, Claude Code, and Codex.
- `mcp_server` metadata in the top-level Hermes plugin manifest and `plugins/hermes/plugin.yaml`.
- `mcp` command entry in the Claude Code plugin manifest.
- 20 dedicated MCP tests covering handshake, tools listing, every tool, stdio loop, and CLI integration.

### Changed

- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.0.
- Updated README and roadmap to mark v1 as implemented and link to the new MCP guide.

## [0.3.1] - 2026-05-06

### Added

- Top-level Hermes plugin manifest and entrypoint so the repository can be installed from a GitHub or Git URL through Hermes plugin installation.

### Changed

- Reworked README content for end users with a Hermes-first description and concise setup flow.
- Updated package and Hermes plugin metadata to version 0.3.1.

## [0.3.0] - 2026-05-06

### Added

- Deterministic `o2b` CLI foundation with status, init, doctor, append-event, export-config, and index commands.
- Append-only daily Markdown event log backend and `vault-log` compatibility wrapper.
- Vault profile bootstrap for the `AI Wiki` structure and Open Second Brain operating manual.
- Wiki helpers for frontmatter parsing, wikilink extraction, vault page listing, and index regeneration.
- Runtime adapter manifests for Hermes, Claude Code, and Codex.
- Hermes plugin health checks with safe best-effort registration.
- Plugin manifest validation through `o2b doctor --repo`.
- Sandbox vault and plugin manifest fixtures for tests.
- GitHub release workflow for tag-based and manually dispatched releases.

[0.10.4]: https://github.com/itechmeat/open-second-brain/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/itechmeat/open-second-brain/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/itechmeat/open-second-brain/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/itechmeat/open-second-brain/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/itechmeat/open-second-brain/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/itechmeat/open-second-brain/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/itechmeat/open-second-brain/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/itechmeat/open-second-brain/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/itechmeat/open-second-brain/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/itechmeat/open-second-brain/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/itechmeat/open-second-brain/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/itechmeat/open-second-brain/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/itechmeat/open-second-brain/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/itechmeat/open-second-brain/compare/v0.5.4...v0.5.5
[0.5.2]: https://github.com/itechmeat/open-second-brain/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/itechmeat/open-second-brain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/itechmeat/open-second-brain/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/itechmeat/open-second-brain/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/itechmeat/open-second-brain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/itechmeat/open-second-brain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itechmeat/open-second-brain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itechmeat/open-second-brain/releases/tag/v0.3.0
