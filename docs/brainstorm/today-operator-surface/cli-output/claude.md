### Variant 1: Live-derive with unified @osb grammar extension
- **Approach**: Extend the existing marker grammar with two new structural kinds - `loop` (Task C) and a mutation kind such as `set`/`done` (Task D) - by widening `KNOWN_KINDS` in inline.ts, keeping one parser for all marker traffic. Open loops are never stored: every dashboard render re-scans `notes.read_paths` prose via `discoverMarkersDetailed`, and a loop stays open until the operator (or a Task D mutation) appends an id-referencing structural close token, so survival-across-scans falls out of simply not annotating loop markers as consumed. Task A ships as a new `view=today` entry in the brain_brief `dispatchByView` table composed of four independent pure builders (obligations via `listObligations`, merged timeline via a new `renderTimeline` over `buildTimelineIndex`, loops via the scan, totals), and Task D is a separate guardrail-gated `apply` verb that resolves references through a new fail-closed title-to-path resolver, mutates via `assignNoteAttribute`, and emits one `appendLogEvent` per mutation.
- **Trade-offs**:
  - Pro: literally satisfies Task A's "never stored, re-derived on demand, maintenance-free" - there is no state to drift or reconcile.
  - Pro: one grammar, one parser, one fence-aware discovery path shared by C and D; smallest surface for the language-agnostic constraint (kinds and ids are structural tokens).
  - Pro: read path (A/B/C) and write path (D) are fully separated; only D needs the guardrails flag, so byte-compatibility of existing views is trivially preserved.
  - Con: every dashboard render re-scans all configured daily-note files; fine for personal-vault scale but no cheap escape hatch if read_paths grows large.
  - Con: loop identity lives in prose - a marker edited or deleted by hand silently closes the loop with no audit trail.
  - Con: the close convention (id-referencing token) needs careful spec so ids stay stable without natural-language matching.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Materialized loop ledger (obligations pattern)
- **Approach**: Task C's scan verb *ingests* loop markers into a file-per-item store `Brain/loops/*.md` (mirroring obligations.ts render/parsePage), deduplicated by a content-derived id, with closing performed as a store mutation (CLI verb, MCP tool, or a Task D close marker) rather than a prose edit. The dashboard (`view=today` in brain_brief, same as Variant 1) reads the fast, structured store instead of re-scanning prose; Task D becomes a general guardrail-gated mutation engine through which both frontmatter `set` mutations and loop closes flow, each emitting a log event. Task B is the same `renderTimeline` over `buildTimelineIndex` in both variants.
- **Trade-offs**:
  - Pro: closest fit to the repo's established file-per-item store idiom; loops get first-class lifecycle, audit trail, and stable ids independent of prose edits.
  - Pro: dashboard render is O(store) not O(all daily notes); loop state survives even if the operator rewrites the original note.
  - Pro: one mutation pipeline for C-close and D gives a single gated, logged write surface.
  - Con: directly tensions with Task A's "live query over vault notes, never stored content" framing - the loops section now reads derived stored state that can drift from prose until the next scan runs.
  - Con: ingest idempotency is subtle: loop markers must survive in prose *and* not re-ingest as duplicates, requiring a new sentinel semantics distinct from the consumed-feedback annotation.
  - Con: most new code (store module, ingest reconciliation, close verb, plus everything Variant 1 needs anyway).
- **Complexity**: large
- **Risk**: medium

### Variant 3: Event-sourced loops through the Brain log
- **Approach**: Model loop lifecycle as Brain log events: scanning emits `loop_opened` (once, idempotent) and closing emits `loop_closed` via `appendLogEvent` with new `BRAIN_LOG_EVENT_KIND` entries; the open-loops section is a pure fold over `buildTimelineIndex` (opened minus closed). This makes Task B's merged timeline automatically include loop and mutation activity with zero extra wiring, since D's mutation log events land in the same index. Dashboard is again a `view=today` composition, but three of its four sections (timeline, loops, recent activity) derive from the single TimelineIndex substrate.
- **Trade-offs**:
  - Pro: maximal composition - one temporal primitive feeds timeline, loops, and activity; D's audit events and C's lifecycle share infrastructure by construction.
  - Pro: full history of every loop (when opened, when closed, by what) for free.
  - Con: the append-only log becomes load-bearing *state*, not just audit - a missed or duplicated `loop_opened` emission permanently corrupts the fold, so scan idempotency must be perfect.
  - Con: growing the typed event-kind union and making 19-caller log.ts semantics carry lifecycle meaning is the most invasive change to a stable core primitive.
  - Con: open-loop truth diverges from prose (marker present but event says closed, or vice versa) with no reconciliation story; violates the maintenance-free spirit of Task A.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: Variant 1 is the only one that honors Task A's explicit "never stored, re-derived on demand" contract while satisfying C's survive-until-closed requirement through the simplest possible mechanism - the marker just stays in prose and is never consumed. It reuses every verified anchor (dispatchByView, buildTimelineIndex, listObligations, discoverMarkersDetailed, assignNoteAttribute, appendLogEvent) with additive-only changes, keeping existing brief views byte-compatible and confining all risk to the single guardrail-gated write verb. The prose-rescan cost is the one real concern, and at personal-vault scale it is a far cheaper price than the state-drift and idempotency machinery Variants 2 and 3 take on.
