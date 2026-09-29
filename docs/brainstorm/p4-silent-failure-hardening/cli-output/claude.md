### Variant 1: Nine local patches at the verified anchors
- **Approach**: Each card lands as an isolated change at its named anchor with card-local types and tests: two redactor passes, one walk tweak, one receipt field, two independent skip counters, two `skipIfUnchanged` call sites, one pragma gate, two doctor checks plus one repair verb. Cards share nothing new; they only register into the vocabularies that already exist (`DEGRADATION_CODE`, `DOCTOR_CHECKS`, the verdict census).
- **Trade-offs**:
  - Pro: every card is independently reviewable and revertable; nine small PR-sized diffs fold cleanly into one squash.
  - Pro: fully parallelizable across subagents with no shared file contention beyond the census test.
  - Pro: lowest chance of accidentally widening a public shape, since no new shared type crosses a wire contract.
  - Con: cards 4 and 5 both count ingest skips on the same BatchPlan lane and would ship two counter shapes and two serializer touches for one concept.
  - Con: cards 8 and 9 each hand-roll census plumbing and an uncertain stream, duplicating what `embeddingSunsetCheck` already does.
  - Con: naming drift across nine authors (reason strings, warning codes) is likely and only caught at review.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Local patches with three shared seams where cards pair up
- **Approach**: Keep the nine anchors, but factor the three natural pairs onto one seam each: cards 4 and 5 share a typed ingest skip taxonomy (`SkippedPage.reason` membership list plus parser) whose per-reason counters also carry the unclassifiable-extension bucket, emitted once through `serializeBatchPlan`; cards 8 and 9 share a small read-only census helper modeled on `embeddingSunsetCheck` (probe, count, uncertain stream, embedded next command) and register two thin checks on top; cards 1 and 2 extend the redactor as one detector-table change with one census entry set. Cards 3, 6 and 7 stay strictly local, with 7 adding only a remoteness axis to `vault-backing.ts` that `applyPragmas` consults.
- **Trade-offs**:
  - Pro: one skip vocabulary and one serializer touch for the whole ingest lane, so CLI JSON and MCP cannot diverge.
  - Pro: doctor checks stay uniform in shape and failure isolation, and the repair verb for card 9 reuses the repair-lane discipline unchanged.
  - Pro: still additive and byte-identical-when-absent everywhere; no default flips; no new dependencies.
  - Con: the paired cards become sequential (taxonomy before counters, helper before checks), reducing parallelism for two of the nine.
  - Con: a shared helper is a small new internal surface that needs its own tests beyond the per-card ones.
  - Con: slightly larger diff on `batch-plan.ts` and `doctor.ts` than pure local patches.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Unified silent-failure ledger
- **Approach**: Introduce one cross-cutting notice primitive (code, count, surface, severity) with a single serializer, and make all nine cards producers into it: redaction hits, sibling-pair hits, absolute-path advisories, skipped files and reasons, short-circuited rewrites, WAL downgrade, and both doctor findings. Doctor checks then become readers of the ledger rather than independent scanners, and every CLI verb and MCP tool emits the same notice block.
- **Trade-offs**:
  - Pro: one place to look for everything that degraded silently, fully aligned with the v1.52.0 principle.
  - Pro: future cards plug in with zero new wire plumbing.
  - Con: touches every wire contract in the wave at once and makes byte-identical-when-absent hard to prove across CLI JSON and MCP.
  - Con: the write-receipt, batch-plan and doctor surfaces have different lifetimes; forcing them through one ledger blurs read-only doctor checks with write-path advisories.
  - Con: the redactor is a hot egress path and should not gain a ledger dependency; the mtime-skip audit result already has its own `updated` semantics.
  - Con: far exceeds the verified, narrowed scope of the nine premises.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: The premise verification already narrowed each card to a specific anchor, so the wave should stay anchor-local, but three pairs (4/5, 8/9, 1/2) genuinely describe one concept each, and shipping them as separate shapes would violate the one-serializer-per-wire-contract and closed-vocabulary conventions on day one. Variant 2 removes that duplication with two small internal seams and one detector-table change, keeps every change additive and opt-in, and preserves independent review for the six cards that do not overlap. Variant 3 is the right long-term shape but is a scope change the operator did not pick.
