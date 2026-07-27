# Signals that survive - every signal the kernel already computes reaches the decision it should change

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain computes more than it uses. A repository declares which files
it considers noise and the ingest planner ignores that declaration. A recall
attempt is graded weak and the grade evaporates when the call returns. A write
router picks between near-equal destinations and records neither the runner-up
nor the reason. A query names a time period and the ranker keeps applying a
freshness prior that points the other way. A knowledge-gap loop with promotion,
a session agenda and auto-close is fully implemented and has no caller.

Each of these is the same defect in a different subsystem: a signal exists, is
correct, and is dropped before it reaches the decision it could improve. This
wave carries nine of them the last few metres.

## Scope

Nine atomic units, in dependency-free order:

1. **Git-aware ingest discovery** (`t_4b2bd8f7`) - the ingest batch planner honours
   the repository's own `.gitignore`, nested `.gitignore`, `.git/info/exclude`,
   and submodule boundaries, through a discovery module extracted from the
   hygiene scan so both paths share one implementation.
2. **Typed parse errors** (`t_ceee3b4d`) - preference and retired-preference parse
   failures carry their path as a field instead of embedding it in the message,
   which removes the duplicated path from every `o2b brain doctor` parse-error line.
3. **Route discrimination** (`t_07ad3c42`) - **BUILT, REVIEWED, AND REVERTED. Not
   shipped.** The unit scored candidate routes and separated near-equal ones with a
   registered ladder, emitting a gated record. Independent review found the routed
   destination was not byte-identical with the gate absent, because the premise "a
   route captured for its own span always attains full coverage" is falsified by the
   extractor's 200-character cap. Fixing that produced a correctness proof, and the
   proof settled the unit: once the captured family is scored over the span it
   actually matched, a sub-reading always pays the containment penalty and falls at
   least 14 below it, outside the margin of 10. Only a rival claiming the span IN FULL
   can enter the band - and the three families this router chooses between cannot,
   because a complete `url` match carries `://`, a complete `email` match carries `@`,
   and `quantity` is a number bound to a unit sigil. The one overlap that does occur
   is already resolved by the extractor before routing. The ladder therefore never
   fires and the record is never written.

   The task premise is what was wrong. The ambiguity it describes - a taste signal
   that is also an obligation, a note that is really a decision - is real, but
   `routeExtractedFacts` chooses among structurally disjoint pattern families and has
   nothing to disambiguate. Anchoring the work there came from the task body and no
   reconnaissance caught it; the correctness proof did. Any future attempt must first
   name a write surface whose destinations can genuinely claim the same span.
4. **Unroutable-capture hint** (`t_75597bb9`) - a scope-less feedback write returns a
   non-blocking structured hint naming the missing routing signal and the scope
   slugs the vault actually contains, resolved through the advisory rail.
5. **Query-side temporal intent** (`t_58fc4720`) - a query carrying an explicit time
   window biases ranking toward that window through a capped additive layer, and
   damps the freshness prior when the window is historical.
6. **Recall-adequacy feeds the gap loop** (`t_3f96f87a`) - weak and insufficient
   recall verdicts become a second signal source for the already-built knowledge-gap
   loop, and that loop is wired into the session hooks it was written for.
7. **Fact and skill markers** (`t_9ba5c027`) - the inline marker grammar gains two
   kinds, routed into stores that already carry a review gate.
8. **Response-shape validation** (`t_80b01448`) - agent-supplied payloads on the three
   model-authored write paths are validated against a declared shape before any
   normalization, fail-closed.
9. **Durable work identity** (`t_e6be4f6b`) - an optional declared work id and lane id
   let session lineage re-attach resumed work across model, account, branch and
   worktree changes, ranked above the fifteen-minute timing window.

## Out of scope

- A local transformer embedding provider (`t_916f9953`). It requires a model
  artifact and an inference runtime - an external dependency the rest of this
  wave deliberately avoids.
- Auto-memory extraction from the conversation stream (`t_1dace26d`). It is the
  child of unit 8 and ships once the response-shape layer has settled in practice.
- Any integration with an external product. Obsidian compatibility is not an
  external integration; it is the vault format.
- Replacing `CRUTCH_LINK_WINDOW_MS`. Unit 9 demotes it to a fallback rung; deleting
  it would remove the only resolution path available when nothing declares an identity.
- Re-implementing the ambiguity abstention layer shipped in v1.39.0. Unit 9 consumes it.

## Chosen approach

Every unit takes the variant that reaches the decision point through machinery the
repository already owns, rather than standing up a parallel mechanism.

**Unit 1** extracts the hygiene scan's ignore-layering into a module beside
`src/core/fs/ignore.ts`, so `collectIngestible` and `listScanTargets` compose the
same reader. Submodule detection - the one net-new piece - is written once. Warnings
are returned as structured values rather than printed, so the kernel does not write
to a stream. Discovery stays in-process: shelling out to `git ls-files` would make a
reproducible `planId` depend on an external binary and on user-global git config.

**Unit 2** introduces a typed parse error carrying `path` structurally, modelled on
`BrainStatusFolderMismatchError`, which `classifyParseError` already special-cases.
The two branches of that function stop being asymmetric, and a future throw site
cannot re-embed the path without going around the type.

**Unit 3** splits the router decision into two pure functions - candidate scoring and
discrimination - with the discriminator a fixed ordered ladder of structural rules,
each with a stable id. The terminal rule reproduces today's family-table order, so
routing is byte-identical until a rule earlier in the ladder separates a genuine tie.

**Unit 4** extends `write-advisory.ts`, which already implements exactly the required
shape: computed around the write, never blocking it, surfaced as a structured field.
Eligible scopes are derived from document frequency over vault frontmatter, never from
a word list.

**Unit 5** detects temporal intent at the query-plan seam and consumes it in the ranker
as its own capped additive layer over `temporalProximity`, alongside a modest recency
damping when the window is historical. Freshness prior and temporal intent stay
separately attributable in `reasons` and `ScoreBreakdown`.

**Unit 6** stamps the adequacy verdict onto the demand record whose bucket key
`normalizeQueryTerms` already computes, generalises `detectRecurringGaps` to aggregate
over both its structural source and the verdict source, and wires the module into the
session hooks its own header comment says it was written for.

**Unit 7** adds two rows to the marker kind table and their routing. A `fact` marker
becomes an unconfirmed preference; a `skill` marker becomes a pending proposal. Both
destinations already have a review gate, so no new gating code is introduced.

**Unit 8** promotes the JSON-Schema-subset validator in `src/mcp/output-contract.ts`
into a core module named for response *shape*, and declares one frozen descriptor per
model-authored write path.

**Unit 9** adds optional `workId` and `laneId` to the ledger line and a precedence rung
above the crutch resolver. Identity is declared, never derived. A lane mismatch is a
hard separator, not a tiebreak.

## Design decisions

- **Two consultant recommendations were overridden.** Both are recorded in
  `variants.md` with the reasoning; the rest were adopted as returned.

  - *Unit 8, the dormant configuration key.* The consultant proposed gating strict
    validation behind a key defaulting to today's tolerance, so the strict path ships
    inert until an operator opts in. That is a validator that validates nothing, which
    is the silent-no-op this project forbids. Validation is unconditional and fail-closed.
    The byte-identical-when-absent rule governs new flags and configuration keys; this
    unit adds neither. A payload that would have degraded silently now raises a named error.

  - *Unit 6, the durable artifact.* The task brief instructs minting an **obligation**.
    The implementation mints a **gap task** instead. The constraint the brief was
    protecting - stay internal, never write to an external tracker - is fully satisfied:
    `Brain/gap-tasks/` is a plain vault directory and `gap-loop.ts` states in its own
    header that it never touches the kanban board. Obligations are cadence-bearing by
    construction and have no auto-close; gap tasks close themselves when the same topic
    later recalls with sufficient confidence, which is what makes a minted item bounded
    rather than permanent litter. Building a second promotion-agenda-autoclose pipeline
    against `obligations.ts` would duplicate a working one.

- **A finding recorded here during scoping was wrong, and is corrected rather than
  deleted.** This document originally claimed `src/core/brain/gaps/gap-loop.ts` was 274
  lines of fully implemented machinery with no callers, and framed unit 6 as mostly
  hook wiring. That was based on a grep scoped to `src/`, which does not contain the
  hooks. `hooks/gap-promote.ts` and `hooks/gap-agenda.ts` exist, are registered in
  `hooks/hooks.json` and in the install manifest, shipped in v1.35.0, and are covered by
  tests for both the flag-on and flag-off paths. The two configuration keys are genuinely
  resolved, not merely documented. The loop was already wired end to end.

  What unit 6 actually adds is therefore narrower and more honest: a second signal
  source. The structural telemetry source was the only thing that could ever promote a
  gap; a graded recall verdict could not, because nothing carried it past the call that
  produced it. The release note must not claim dead machinery was revived.

- **Recurrence identity is never natural language.** Unit 6 reuses `normalizeQueryTerms`,
  which derives its bucket from document frequency and drops secret-shaped tokens. Unit 5
  detects time intent only from ISO tokens and the existing `<field>:<value>` grammar.
  The natural-language phrase detection the upstream sources perform is not portable to a
  system that must behave identically in every language, and is not attempted.

- **Discrimination is recorded, not just performed.** Unit 3 emits through
  `emitGatedTelemetry`, carrying the candidate set, the scores, the margin and the winning
  rule id - never the fact text. A tie-break that cannot be audited is a tie-break that
  cannot be tuned.

- **Ambiguity is separated from resolution.** Unit 3 decides; it does not quarantine.
  A quarantine lane converts misfiled writes into operator queue depth, which moves the
  cost rather than removing it. If the emitted records later show a margin band the ladder
  genuinely cannot separate, quarantine is the bounded escalation to add then.

- **No new runtime dependency, in any unit.** Unit 8 reuses a validator the repository
  already owns rather than adding a schema library.

## File changes

New:

- `src/core/fs/git-discovery.ts` - repo-root base scope, per-directory extension, submodule predicate, structured warnings.
- `src/core/brain/parse-error.ts` - typed parse error carrying `path` as a field.
- `src/core/brain/routing/route-discriminator.ts` - candidate scoring, the rule ladder, the gated record.
- `src/core/search/temporal-intent.ts` - query-side temporal window detection at the plan seam.
- `src/core/brain/response-shape.ts` - shape descriptors and the fail-closed validator.

Modified:

- `src/core/brain/ingest/batch-plan.ts`, `src/core/hygiene/scan-repo.ts` - both consume the extracted discovery module.
- `src/core/brain/preference.ts`, `src/core/brain/doctor.ts`, `src/cli/brain/verbs/doctor.ts` - typed parse error.
- `src/core/brain/fact-extract.ts` - route discrimination at the single write router.
- `src/core/brain/write-advisory.ts` and its two call sites - the routing hint.
- `src/core/search/query-plan.ts`, `src/core/search/ranker.ts`, `src/core/search/search.ts`, `src/core/search/types.ts` - the temporal-intent layer.
- `src/core/brain/query-demand.ts`, `src/core/brain/gaps/gap-loop.ts`, the session hooks - the adequacy signal and the wiring.
- `src/core/brain/inline.ts` and the marker routing sites - the two new kinds.
- `src/core/brain/lineage/ledger.ts`, `src/core/brain/lineage/crutch.ts` - the identity rung.
- `src/core/brain/next-step.ts`, `src/cli/advisory-rail.ts` - the registered codes units 4 and 6 resolve.
- `CHANGELOG.md`, `README.md`, `package.json` and the mirrored manifests.

## Risks and open questions

- **Unit 1 touches a green subsystem.** The hygiene scan is behaviour-pinned by existing
  tests. The extraction must be provably inert there before the ingest wiring is written;
  the hygiene diff is motion, not behaviour.
- **Unit 5 adds a key to `ScoreBreakdown`,** which is visible over the Model Context
  Protocol. It is additive, and an absent temporal window contributes zero, but the new
  capped constant must be calibrated against the existing link, entity, activation and
  reuse caps so the layers stay in proportion.
- **Unit 3 has no ground truth on day one.** Early records will mostly show the terminal
  rule firing. That is the expected shape of a measurement surface before data accumulates,
  and is not a reason to guess weights.
- **Unit 6 changes what `occurrences` counts.** The structural gap source is a coarse code
  bucket and the verdict source is a fine term bucket. The two must remain distinguishable
  on the agenda rather than being summed into one number whose meaning varies by row.
- **Unit 9 depends on something declaring an identity.** An unwired host gets no benefit.
  This is accepted: the alternative - deriving identity structurally - places a mutable,
  effectively irreversible union registry inside a Syncthing-replicated tree with no arbiter.
- **Unit 2 is cosmetic in effect and structural in cost.** It is included because the
  duplication is a symptom of prose carrying data, which the previous release spent eleven
  units removing elsewhere.
