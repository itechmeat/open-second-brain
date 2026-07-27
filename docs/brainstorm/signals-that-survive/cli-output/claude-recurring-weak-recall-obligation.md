### Variant 1: Verdict-stamped demand log, dream-phase minting into obligations
- **Approach**: Solve question identity by reusing the bucket key `query-demand.ts` already owns — sorted significant terms (`normalizeQueryTerms`, IDF-derived, redacted, capped), never a word list — by adding an optional `adequacy` level to `QueryDemandRecord` and stamping it from the two existing verdict sites (`brain_recall_gate`, `brain_context_pack`). A new dream phase aggregates buckets whose weak/insufficient count clears a demand threshold, ranks by the existing `demandScore`, and mints at most top-N obligations via `addObligation` with a slug hashed from the bucket key and a re-check cadence, deduped through `obligationExists`. Session-start renders open obligations of that kind as the agenda, and the dream phase completes an obligation once the same bucket recalls `sufficient`.
- **Trade-offs**:
  - Pro: no new store, no new key concept — compaction, byte caps, secret-shaped-term dropping, and `[since, until]` filtering are inherited, not rebuilt.
  - Pro: minting is off the recall hot path; the dream pass is where the project already puts gated batch promotion, and caps are naturally per-run rather than per-attempt.
  - Pro: matches the brief's explicit "mint an obligation, not a board item" scoping without touching `agenda.ts`.
  - Con: couples two features — a demand record now also carries a retrieval verdict, so `query-demand.ts` stops being purely about coverage.
  - Con: obligations are cadence-bearing by construction; a one-shot "write coverage for this topic" is an awkward fit, and the re-check cadence is a semantic stretch that needs justifying.
  - Con: nothing happens until dream runs — the loop closes on a schedule the operator may not run, and a never-dreaming vault silently accumulates nothing.
  - Con: `demandScore` was tuned for coverage-driven ranking; reusing it as the mint trigger imports a threshold that was never validated for this purpose.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Second signal source into the existing gap loop, gap-task as the durable item
- **Approach**: Emit each adequacy verdict as a gated continuity record through `emitGatedTelemetry`, carrying the bucket key computed by the shared `normalizeQueryTerms` pure function so no new identity logic is invented. Generalize `gaps/gap-loop.ts` `detectRecurringGaps` to aggregate over both its current structural `gap_counts` source and the new verdict records, leaving promotion (`promoteGapsToTasks`, exclusive-create dedupe on `gapTaskKey`), the session-start agenda (`renderGapAgenda`), and auto-close (`autoCloseRecalledGaps`, with the self-close guard) exactly as built. Wire the currently dormant module into the session-start/session-end hooks behind the existing `gap_loop_enabled` / `gap_loop_threshold` keys.
- **Trade-offs**:
  - Pro: the promotion → agenda → auto-close half is already implemented and tested; this variant adds a signal source and hook wiring rather than a second copy of the same machinery.
  - Pro: auto-close is what makes the item *bounded* — a minted item that resolves itself when coverage appears is the difference between a tracked obligation and vault litter; only gap-loop has it today.
  - Pro: telemetry rides the continuity rail as convention requires (config-gated, fail-open, redaction-passing), and the agenda surface is one that was purpose-built for recall gaps.
  - Con: deviates from the brief's stated target — obligations get no use, and the vault gains recall-driven items in `Brain/gap-tasks/` instead of `Brain/obligations/`.
  - Con: scope grows beyond the feature: this variant must also wire a dormant module, so a bug there surfaces as a regression in this release.
  - Con: mixing a coarse structural code bucket (`no_matching_context`) and a fine term bucket in one aggregate makes `occurrences` mean two different things across rows in the same agenda.
  - Con: leaves the repo with two candidate durable-item kinds; if obligations later become the convention, this needs a migration.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Structural retrieval-neighborhood fingerprint, no query text at all
- **Approach**: Define question identity with zero natural-language input — hash the ordered top-artifact id set from the `recall_telemetry` `top_artifacts` payload into a "weak neighborhood" fingerprint, falling back to the registered structural gap code when the attempt returned nothing. Aggregate directly over `recall_telemetry` continuity records already on disk, so the feature works retroactively over existing history with no new store and no new emitted field, and mint one obligation per neighborhood that clears both an occurrence and an escalation threshold.
- **Trade-offs**:
  - Pro: the strictest possible reading of the language-agnostic rule — the key never touches prompt text, so it cannot be argued into a word list later.
  - Pro: no new persistence, no new write path, and no change to the two verdict call sites; retroactive over telemetry already captured.
  - Con: the fingerprint is unstable — one different artifact in top-k forks the bucket, so demand fragments across near-identical questions and the threshold rarely clears at all.
  - Con: the zero-result case is the one that matters most and has no artifacts, so it collapses onto a handful of coarse gap codes and over-aggregates unrelated questions into a single obligation.
  - Con: making it work needs quantization or set-similarity tuning — a new knob class the project deliberately avoids, and one that cannot be validated without a corpus.
  - Con: builds a third recurrence-key concept alongside the two the repo already has, with no reuse of the redaction and cap work.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: The genuinely missing piece is only the aggregation link — `query-demand.ts` already solved deterministic, language-agnostic question identity and `gaps/gap-loop.ts` already implements promotion, the session-start agenda, and the auto-close that makes a minted item bounded rather than permanent litter, so this variant adds a signal source and hook wiring instead of a second copy of that machinery. It also gives the caps their teeth: an item that closes itself when recall recovers is a stronger guard against one bad afternoon than any mint threshold. The one deliberate deviation is the durable target — this mints a gap-task, not an obligation; that still satisfies the actual constraint the validator was protecting (stay internal, never write to an external board), but it contradicts the brief's literal instruction and should be confirmed before implementation, since Variant 1 is the ready alternative if obligations must be the artifact.
