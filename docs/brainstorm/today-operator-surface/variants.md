# Today operator surface - brainstorm audit trail

Consultant: Claude Code CLI (`claude -p`), prompt in
`cli-output/prompt.md`, raw output in `cli-output/claude.md`.
Fallback consultant (Codex) not needed - primary returned three
parseable variants on the first run.

## Variant 1: Live-derive with unified @osb grammar extension

- **Approach**: extend the existing marker grammar with two new
  structural kinds - `loop` (open loops) and `set` (write-back) - by
  widening `KNOWN_KINDS` in `inline.ts`, keeping one parser for all
  marker traffic. Open loops are never stored: every dashboard render
  re-scans `notes.read_paths` prose via `discoverMarkersDetailed`, and
  a loop stays open until a structural close token referencing its id
  appears; survival-across-scans falls out of simply not annotating
  loop markers as consumed. The dashboard ships as `view=today` in the
  `brain_brief` dispatch table composed of independent pure builders;
  write-back is a separate guardrail-gated verb resolving references
  through a fail-closed title resolver, mutating via
  `assignNoteAttribute`, logging one event per mutation.
- **Trade-offs**:
  - Pro: literally satisfies "never stored, re-derived on demand" -
    no state to drift or reconcile.
  - Pro: one grammar, one parser, one fence-aware discovery path
    shared by loops and write-back; smallest surface for the
    language-agnostic constraint.
  - Pro: read path and write path fully separated; only write-back
    needs the guardrails flag; existing views trivially stay
    byte-compatible.
  - Con: every dashboard render re-scans configured note files; no
    cheap escape hatch if `read_paths` grows large.
  - Con: loop identity lives in prose - a hand-deleted marker silently
    closes the loop with no audit trail.
  - Con: the close convention needs careful spec so ids stay stable
    without natural-language matching.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Materialized loop ledger (obligations pattern)

- **Approach**: the scan verb ingests loop markers into a file-per-item
  store `Brain/loops/*.md` (mirroring `obligations.ts`), deduplicated
  by content-derived id, with closing performed as a store mutation.
  The dashboard reads the structured store instead of re-scanning
  prose; write-back becomes a general mutation engine through which
  both frontmatter mutations and loop closes flow.
- **Trade-offs**:
  - Pro: closest fit to the file-per-item store idiom; loops get
    first-class lifecycle, audit trail, stable ids independent of
    prose edits.
  - Pro: dashboard render is O(store), not O(all daily notes).
  - Pro: one gated, logged mutation pipeline for closes and set-writes.
  - Con: directly tensions with the task's "live query, never stored
    content" framing - stored state can drift from prose between scans.
  - Con: ingest idempotency is subtle - markers must survive in prose
    and not re-ingest as duplicates, needing new sentinel semantics.
  - Con: most new code of the three variants.
- **Complexity**: large
- **Risk**: medium

## Variant 3: Event-sourced loops through the Brain log

- **Approach**: model loop lifecycle as Brain log events
  (`loop_opened` / `loop_closed` via `appendLogEvent`); the open-loops
  section is a pure fold over `buildTimelineIndex` (opened minus
  closed). The merged timeline automatically includes loop and
  mutation activity since everything lands in the same index.
- **Trade-offs**:
  - Pro: maximal composition - one temporal primitive feeds timeline,
    loops, and activity; full history of every loop for free.
  - Con: the append-only log becomes load-bearing state, not just
    audit - a missed or duplicated `loop_opened` emission permanently
    corrupts the fold, so scan idempotency must be perfect.
  - Con: most invasive change to a stable 19-caller core primitive.
  - Con: open-loop truth diverges from prose with no reconciliation
    story; violates the maintenance-free spirit of the dashboard task.
- **Complexity**: large
- **Risk**: high

## Consultant recommendation

Variant 1, because it is the only one honoring the explicit "never
stored, re-derived on demand" contract while satisfying
survive-until-closed through the simplest mechanism (the marker just
stays in prose and is never consumed), reuses every verified anchor
additively, and confines all risk to the single guardrail-gated write
verb.

## Orchestrator decision

Variant 1, accepted as recommended. Project context confirms rather
than overrides the recommendation: the vault is personal-scale (scan
cost acceptable), the repo's fail-closed and determinism conventions
map one-to-one onto the variant's read/write separation, and the two
rejected variants both introduce stored or event-sourced loop state
that the source kanban task explicitly rules out. The one refinement
over the consultant's sketch: loop ids derive from normalized text
(not source path), with an optional explicit `id=`, so file moves do
not reopen closed loops - detailed in `design.md`.
