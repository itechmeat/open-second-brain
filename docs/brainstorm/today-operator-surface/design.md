# Today operator surface - dashboard, merged timeline, open loops, marker write-back

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain has no single read surface answering "what matters right
now": obligations, open loops, and recent activity each live in their own
silo (or do not exist at all). Informal "follow up on X" intentions jotted
into daily prose are lost, and turning prose like "set completion to 65"
into structured frontmatter requires a manual CLI call. Four kanban tasks
(t_5f65c992, t_4adb0b8b, t_97373418, t_d7be2a0c) close these gaps as one
composed release.

## Scope

- **Open-loop markers (t_97373418)**: new `loop` kind in the existing
  `@osb` marker grammar. A loop marker stays in prose and is never
  consumed; it counts as open until a matching structural close token
  appears. Live-derived only - no store.
- **Merged activity timeline (t_4adb0b8b)**: a renderer over the existing
  `TimelineIndex` that emits one chronologically merged, typed,
  age-labeled bullet list across all Brain log event kinds.
- **Today dashboard (t_5f65c992)**: `buildTodayDashboard` pure builder
  composing four independent live sections - due/overdue obligations,
  open loops, merged recent activity, totals. Exposed as
  `brain_brief view=today` (MCP) and `o2b brain today` (CLI).
- **Marker write-back (t_d7be2a0c)**: new `set` kind in the `@osb`
  grammar mapping to a schema-validated frontmatter attribute mutation.
  Guardrail-gated, deterministic, one log event per applied mutation,
  fail-closed on ambiguous note references. `set` markers ARE consumed
  (annotated) once applied, reusing the existing rewrite machinery.

## Out of scope

- Any storage for open loops (`Brain/loops/`, log-event lifecycle) - the
  live-derive contract explicitly excludes stored loop state.
- Natural-language marker syntaxes (`DONE:`, `OPEN:` prefixes from the
  source articles). The structural `@osb <kind>` grammar is the single
  syntax; natural-language front-ends would violate the
  language-agnostic rule.
- Frontmatter mutations outside the schema-pack-declared attribute
  vocabulary (no free-form YAML editing).
- A near-term-deadline scanner over arbitrary note types (only
  obligations carry due semantics today; widening that is a follow-up).
- Changes to existing `brain_brief` views or `buildMorningBrief` output.

## Chosen approach

Variant 1 from `variants.md`: live-derive with a unified `@osb` grammar
extension. `KNOWN_KINDS` in `src/core/brain/inline.ts` widens from
`feedback` to `feedback | loop | set`; one parser, one fence-aware
discovery path serves all marker traffic. Open loops are re-derived on
every render by scanning the configured note paths; a loop is open while
no close token referencing its id exists. The dashboard is a
`dispatchByView` composition of pure builders. Write-back is a separate
guardrail-gated verb that resolves targets fail-closed, mutates via
`assignNoteAttribute`, logs via `appendLogEvent`, and consumes applied
markers via `rewriteMarkers`.

## Design decisions

- **One grammar, per-kind field sets.** `parseInlineMarker` and
  `parseBlockMarker` currently hard-require `topic` and `principle`
  (feedback-specific). Validation generalizes to a per-kind required
  field table; unknown kinds keep rejecting exactly as today so existing
  negative tests stay green.
- **Loop marker shape.** Inline: `@osb loop <free text>` with optional
  `id=<slug>`. When `id` is absent the loop id derives deterministically
  from a short hash of the normalized loop text (source path excluded,
  so moving a note does not reopen a closed loop; editing the text does
  re-open, which is the honest reading of "the intention changed").
- **Close convention.** A separate structural token
  `@osb loop close id=<id>` (inline, anywhere in scanned prose) closes
  the loop. Open set = loop markers whose id has no matching close
  token. Both marker and close token survive scans unconsumed; there is
  no store to drift. The dashboard prints each loop's id so the operator
  can close it by jotting one line.
- **Close-form disambiguation is a fixed decision table.** After the
  `loop` kind token: (1) first token `close`, an `id=` pair present,
  and nothing else - close token; (2) first token `close` with `id=`
  plus extra free text - parse reject with guidance (ambiguous);
  (3) anything else - open-loop marker whose text is the remaining
  content minus an optional `id=` pair, and empty text is a parse
  reject. So `@osb loop close the deal` opens a loop titled "close the
  deal"; only the exact close form closes one.
- **Loops are never consumed, `set` markers are.** `discoverMarkers`
  already skips consumed sentinels; only the write-back verb annotates
  `set` markers after a successful apply. Loop markers are deliberately
  left untouched by every scanner.
- **Write-back grammar.** `@osb set note=<target> field=<field>
  value=<value>` where `<target>` is a vault-relative path or a
  `[[Title]]` wikilink. All three fields required; missing fields are a
  parse-level reject with guidance.
- **Title resolution is fail-closed and follows wikilink semantics.**
  A new resolver maps `[[Target]]` to exactly one note. A target
  containing `/` is treated as a vault-relative path (via the existing
  `resolveNotePath` containment check); otherwise the target is
  normalized with the existing wikilink helpers and matched against
  note basenames (Obsidian resolution convention) across the
  configured note paths. Zero matches or more than one - typed error
  listing candidate paths; never a guess.
- **Mutation validity comes from the schema pack.** The write path is
  `assignNoteAttribute`, which already fail-closes on undeclared
  types/fields with a vocabulary-listing error. The write-back verb adds
  nothing to that contract - it only front-ends it.
- **Guardrail gate.** New `marker_writeback` flag (default `false`) in
  `BRAIN_GUARDRAIL_DEFAULTS`, checked via `loadGuardrailsConfigSafe`
  using the same idiom as `derived_fact_synthesis`. The dry-run report
  path works without the flag; applying requires it.
- **Audit.** One `appendLogEvent` per applied mutation with a new
  `BRAIN_LOG_EVENT_KIND` (`attribute-write`) carrying note path, field,
  prior value, new value, and marker source. Because the event lands in
  the Brain log, applied write-backs appear in the merged activity
  timeline with zero extra wiring.
- **Timeline tags are the event kinds.** The merged timeline maps each
  `BrainLogEventKind` to its own structural tag (the kind string
  itself) - no display-name translation table to maintain, inherently
  language-agnostic.
- **Dashboard sections are independent.** Each section derives from its
  own primitive (`listObligations`, loop scan, `buildTimelineIndex`
  projection, counters). A failure computing one section surfaces as an
  explicit per-section error entry rather than blanking the whole
  dashboard or faking an empty state.
- **Determinism.** Every builder takes `now` via options; nothing calls
  the wall clock internally; envelopes are frozen - matching
  `buildMorningBrief` and `buildDailyBrief`.

## File changes

New files:

- `src/core/brain/open-loops.ts` - loop/close marker collection over the
  configured note paths, open-set computation, stable ids.
- `src/core/brain/temporal/activity-timeline.ts` - merged chronological
  renderer over `TimelineIndex` (reuses `relativeAge`, bullet shape from
  `timelineBullet`).
- `src/core/brain/today-dashboard.ts` - `buildTodayDashboard` composing
  the four sections.
- `src/core/brain/marker-writeback.ts` - `set` marker application
  engine: discovery, target resolution, guarded apply, logging,
  consumption.
- `src/core/brain/notes/note-title-resolver.ts` - exact-title to path
  resolution with fail-closed ambiguity errors.
- `src/cli/brain/verbs/today.ts` - CLI verb for the dashboard.
- `src/cli/brain/verbs/apply-markers.ts` - CLI verb for write-back
  (report + `--apply`).
- `tests/core/brain/open-loops.test.ts`,
  `tests/core/brain/temporal/activity-timeline.test.ts`,
  `tests/core/brain/today-dashboard.test.ts`,
  `tests/core/brain/marker-writeback.test.ts`,
  `tests/core/brain/note-title-resolver.test.ts`.

Modified files:

- `src/core/brain/inline.ts` - `MarkerKind` union, `KNOWN_KINDS`,
  per-kind required-field validation, loop/set parsing.
- `src/core/brain/types.ts` - new `attribute-write` entry in
  `BRAIN_LOG_EVENT_KIND`.
- `src/core/brain/policy.ts` - `marker_writeback` guardrail default.
- `src/mcp/brain/brief-tools.ts` - `view=today` handler. Write-back
  stays CLI-only in this release; exposing attribute mutations over
  MCP is a separate decision deferred with the rest of the
  agent-driven-mutation surface.
- `src/cli/brain.ts`, `src/cli/brain/helpers.ts` - verb dispatch + help.
- Existing marker tests extended for the widened grammar.

## Risks and open questions

- **Scan cost.** The loops section re-scans `notes.read_paths` on every
  dashboard render. Accepted at personal-vault scale; the scanner
  honors the same size/ignore limits as `scanInline`. If it becomes
  hot, a cache is a follow-up, not part of this release.
- **Prose edits close loops silently.** Deleting a loop marker removes
  the loop with no audit trail. Accepted consequence of the never-stored
  contract; documented in the CLI help.
- **Hash-id stability.** Editing loop text changes its id (reopens).
  Accepted and documented; operators wanting stable identity across
  edits use explicit `id=`.
- **Field-validation generalization in `inline.ts`** must keep every
  existing feedback-marker test byte-identical in behavior. The
  per-kind table is additive; the feedback row reproduces today's exact
  requirements.
- **`buildTimelineIndex` has near-zero direct test coverage.** The
  timeline renderer tests will pin the merge behavior they rely on
  (ordering, tie-breaks) as a side benefit.
