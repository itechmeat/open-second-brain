# Knowledge Provenance Suite - implementation plan

Build order: shared primitives first (so features compose, not reinvent), then
features cheapest-to-riskiest, each its own atomic conventional commit on
`feat/knowledge-provenance`. TDD per unit: failing test first, then implement,
then refactor green. Format + lint before every commit. Byte-identical-when-off is
a test obligation for every behavioural unit.

The version bump to 1.7.0 (`package.json` + `bun run scripts/sync-version.ts`) and
the CHANGELOG/README updates ride inside this PR (Phase 5), per CLAUDE.md.

## Tasks

### Task 1: Provenance / citation primitive (shared lib b)
- **Files**: `src/core/brain/provenance/provenance.ts` (+ index), `types.ts`
  (Provenance value object + `ProvenanceLevel = "stated" | "deduced" | "inferred"`),
  `tests/core/brain/provenance/provenance.test.ts`.
- **Builds**: a pure value object carrying source links, premise links, and a
  level; a renderer for the canonical `## Sources` / citations section; a sha256
  idempotency helper over the source identity. No I/O.
- **Acceptance**: deterministic stamp + render; parse round-trip recovers the
  level and links; identical input renders byte-identically; rejects an unknown
  level without an `as` cast.
- **Depends on**: none.

### Task 2: Extraction-intake primitive (shared lib a)
- **Files**: `src/core/brain/intake/extract-intake.ts` (+ index, types),
  `tests/core/brain/intake/extract-intake.test.ts`. Consumes
  `entities/registry.ts` (`upsertEntity`, `relateEntities`).
- **Builds**: the single validated path that turns an agent-supplied typed
  `ExtractionIntake` (entities + concepts + relations) into registry records,
  idempotent by content hash, provenance-stamped via Task 1. The ONLY exported
  intake path.
- **Acceptance**: a valid intake upserts the expected entities/relations; a
  re-run with the same payload is a no-op (dedup); a malformed payload is rejected
  with a typed error (no fabrication, no partial write); entity records carry the
  source provenance.
- **Depends on**: Task 1.

### Task 3: Guardrail flags plumbing
- **Files**: `src/core/brain/types.ts` (`BrainGuardrailConfig` +
  `ResolvedBrainGuardrailConfig`), `src/core/brain/policy.ts`
  (`BRAIN_GUARDRAIL_DEFAULTS`, `resolveGuardrails`, validator known-keys), tests
  in `tests/core/brain/policy*` / guardrail-config tests.
- **Builds**: the new opt-in flags (e.g. `derived_fact_synthesis`,
  `provenance_trust_ordering`, `owner_scoped_facts`), each defaulting off/loose,
  following the exact v1.6 `untrusted_source_delimiting` pattern.
- **Acceptance**: each flag parses from `_brain.yaml`, resolves to its default
  when absent, rejects a non-boolean with a `BrainConfigError`, and is accepted by
  the known-keys validator; defaults keep existing behaviour.
- **Depends on**: none (parallel-safe with 1-2, sequenced for clean commits).

### Task 4: Model-based entity extraction on write / NER (feature 5)
- **Files**: `src/core/brain/entities/ner-intake.ts`,
  `src/mcp/brain/ner-tools.ts` (a `brain_extract_entities` tool), command-manifest
  wiring, `tests/core/brain/entities/ner-intake.test.ts`.
- **Builds**: an agent-driven, opt-in, non-blocking intake of entities discovered
  in free text - the tool accepts the agent's typed extraction and routes it
  through the Task 2 primitive. No model call inside OSB; no ML dependency; note
  save is untouched.
- **Acceptance**: the tool intakes agent-supplied entities into the registry via
  primitive (a); a plain note write triggers no extraction and no latency; the
  contract carries no natural-language word list; invalid input fails clean.
- **Depends on**: Task 2.

### Task 5: Source-ingest pipeline (feature 1)
- **Files**: `src/core/brain/ingest/ingest.ts`, `src/mcp/brain/ingest-tools.ts`,
  `src/cli/brain/verbs/ingest.ts`, command-manifest wiring,
  `tests/core/brain/ingest/ingest.test.ts`.
- **Builds**: a deterministic pipeline that, given an agent-supplied extraction of
  a text/Markdown/HTML/URL-text source, creates/updates entity + concept pages
  (via primitive a), writes a per-source summary page with a `Sources` section and
  a capture-time connections list (via primitive b), idempotent by source hash.
- **Acceptance**: one ingest creates the expected entity/concept pages + a summary
  page linking back to the source; re-ingesting the same source is a no-op; the
  summary lists connections to pre-existing notes; no raw binary path exists.
- **Depends on**: Tasks 1, 2.

### Task 6: Parameterized research pipeline (feature 2)
- **Files**: `src/core/brain/research/research.ts`,
  `src/mcp/brain/research-tools.ts`, `src/cli/brain/verbs/research.ts`,
  command-manifest wiring, `tests/core/brain/research/research.test.ts`.
- **Builds**: a pipeline that takes N agent-supplied source findings + a synthesis
  payload and writes one dated report page where each finding cites its source
  (via primitive b). Report becomes a first-class recall input.
- **Acceptance**: a report page is written with per-finding citations back to the
  flagging source; the page is a valid recall input; deterministic given the same
  payload. (Lowest-ROI unit - first to trim if the diff overruns.)
- **Depends on**: Task 1.

### Task 7: Owner-scoped canonical facts (feature 4)
- **Files**: `src/core/brain/preference.ts` / `preference-txn.ts` (`owner` field
  write/parse), the recall/fact-read site (apply `isOwnerVisible`), `types.ts`,
  `tests/core/brain/owner-scoped-facts.test.ts`.
- **Builds**: an optional `owner:` token on a preference, read with the existing
  `pageOwner`; fact recall filtered by `isOwnerVisible(owner, requestedScope)`,
  flag-gated.
- **Acceptance**: an ownerless fact is always visible; an owned fact is visible
  only to its owner's scope; absent scope (or flag off) returns byte-identical
  results to today; reuses `agent-scope.ts` with no second implementation.
- **Depends on**: Task 3.

### Task 8: Derived-fact synthesis with premise provenance (feature 3)
- **Files**: `src/core/brain/dream-derived.ts`, `dream.ts` / `dream-phases.ts` /
  `dream-workrun.ts` (wire the `derive` phase, flag-gated),
  `src/mcp/brain/derive-tools.ts` (`brain_derive_fact`), `preference.ts` /
  `types.ts` (`provenance` + premise links), recall ordering site (trust ordering,
  flag-gated), `tests/core/brain/dream-derived.test.ts` + recall-ordering test.
- **Builds**: deterministic candidate-premise-set identification in the `derive`
  phase; `brain_derive_fact` commits an agent-supplied derived fact with premise
  links + `provenance: inferred` via primitive (b); recall trusts stated > deduced
  > inferred when the ordering flag is on.
- **Acceptance**: candidate identification is deterministic and tested; a derived
  fact round-trips its provenance label and premise links; recall orders
  stated-above-inferred only with the flag on; with the derived-fact flag off the
  dream summary is byte-identical to today (phase is a true no-op). No test asserts
  model-generated prose.
- **Depends on**: Tasks 1, 3.

### Task 9: Operator-editable standing-query attention layer (feature 6)
- **Files**: `src/core/brain/attention-flows.ts` (new `standing_query` action),
  context-pack injection path (reuse existing), `tests/core/brain/attention-flows*`.
- **Builds**: a `standing_query` action in the existing flow recipe so an
  operator-authored flow doc declares queries that always fire and inject matching
  items into the assembled context, within the existing budget.
- **Acceptance**: a flow with a `standing_query` action injects matching items
  into the context pack; a vault with no such action is byte-identical to today;
  injected items respect the existing character/token budget.
- **Depends on**: none (uses existing attention-flow injection).

### Task 10: Docs + version (Phase 5, inside this PR)
- **Files**: `CHANGELOG.md` (1.7.0 entry + link-ref), `README.md` (What you get /
  Safety bullets), `package.json` (1.7.0) + `bun run scripts/sync-version.ts`.
- **Acceptance**: `bun run scripts/sync-version.ts --check` passes; CHANGELOG
  heading and `package.json` agree; README describes the new capability.
- **Depends on**: Tasks 1-9.
