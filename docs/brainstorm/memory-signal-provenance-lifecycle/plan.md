# Implementation plan — memory-signal provenance and lifecycle integrity

Branch: `feat/memory-signal-provenance-lifecycle`. Cards are driven ONE AT A
TIME on this shared branch. Each worker MUST `git pull` / build on the commits
previously-driven in-scope cards already landed, and must not duplicate or
conflict with sibling tasks. Follow TDD: write the failing test first.

Combined design: `docs/brainstorm/memory-signal-provenance-lifecycle/design.md`.
Variants + rationale: `docs/brainstorm/memory-signal-provenance-lifecycle/variants.md`.

Drive order: **A1 → C1 → A2 → D2 → D1 → E1 → C2 → C3 → C5 → C6 → A3 → C4 → D3**

In-scope cards (ship together in this one release):
- `t_c5184fd8` (A1, p4) — content-hash skip-unchanged manifest
- `t_213f356b` (C1, p3) — idempotent writes via client idempotency keys
- `t_7526e8d3` (A2, p4) — per-row event-time on batch remember/import
- `t_11e3db8b` (D2, p3) — note-position contradiction detection
- `t_4678a91a` (D1, p4) — signed source-diversity grounding score
- `t_1c894c19` (E1, p4) — session-bracketing memory wrapper for Aider
- `t_2c6cf3e2` (C2, p3) — dry-run extraction preview
- `t_92317f91` (C3, p3) — bounded verbatim last-N-turns buffer surviving compaction
- `t_a82b674e` (C5, p3) — caller-settable per-memory expiration date
- `t_edde2198` (C6, p3) — delete and search by exact source file
- `t_9eeb8ca2` (A3, p2) — batch-plan step (depends on A1)
- `t_1a3a9eba` (C4, p3) — batch checkpoint save for whole sessions (depends on C1)
- `t_74d29363` (D3, p2) — declared-thesis register monitor (depends on D2)

Engineering rules: SOLID / KISS / DRY; no misleading fallbacks; no hardcoding;
English-only strings, abstract multi-language. The kernel calls no LLM.

---

## A1 — `t_c5184fd8` — Content-hash skip-unchanged manifest (driven first)

### Files
- `src/core/brain/ingest/content-manifest.ts` — NEW.
  `hashFile(absPath)` / `hashTree(dir)` → SHA-256 hex over file BYTES (reuses the
  `createHash("sha256")` primitive of `sourceIdentityHash`, but over content, not
  source-path identity — a distinct artifact from identity dedup).
  `readManifest(vault)` / `writeManifestAtomic(vault, entries)` against
  `<vault>/.open-second-brain/ingest-manifest.json` (machine artifact, NOT under
  `Brain/`). `classifyPaths(vault, paths, manifest)` → `{ new, modified,
  unchanged, missing }`. `updateManifest(vault, paths)` records post-ingest
  hashes; a no-op rerun (all unchanged) rewrites nothing.
- `src/core/brain/ingest/ingest.ts` — call `classifyPaths` before the extraction
  pass; skip the LLM/extraction for `unchanged` sources (still idempotently
  rewrite the summary page only if its own bytes would change).
- `tests/core/brain/ingest/content-manifest.test.ts` — NEW.

### Acceptance (passing test)
A test in `tests/core/brain/ingest/content-manifest.test.ts` that:
1. After ingesting a source, re-ingesting an UNCHANGED file (same bytes) classifies
   it `unchanged` and the summary page is NOT rewritten (no-op-rerun invariant).
2. Touching/restat-ing the file (mtime change, byte-identical) still classifies
   `unchanged` (timestamp-independent — the regression this card exists to fix).
3. Modifying bytes classifies `modified`; deleting classifies `missing`; a new
   path classifies `new`.
4. Asserts the manifest is written atomically and a no-op rerun leaves it
   byte-identical.

### Depends on
None. Lands the shared manifest module that A3 consumes. Driven first (opens the
ingest axis).

---

## C1 — `t_213f356b` — Idempotent writes via client idempotency keys

### Files
- `src/core/brain/idempotency-ledger.ts` — NEW.
  `rememberKey(vault, { key, contentHash })` → `inserted | duplicate_match |
  payload_mismatch`. Keyed by client key → content hash, stored under
  `<vault>/Brain/logs/idempotency/` (month-sharded JSONL, mirroring the
  continuity store's append/list model). Same key + same hash → deduped no-op;
  same key + different hash → `payload_mismatch` (explicit throw, never silent
  overwrite). `lookupKey(vault, key)` for audit/C6.
- `src/core/brain/signal.ts` `writeSignal` — add optional `idempotency_key?`
  (additive; absent → existing behavior byte-identical). When present, hash the
  would-be payload and consult the ledger before writing.
- `src/core/brain/preference.ts` `writePreference` — add optional
  `idempotency_key?` (same shape).
- `src/core/brain/apply-evidence.ts` `appendApplyEvidence` — add optional
  `idempotency_key?` (same shape).
- `src/mcp/brain/feedback-tools.ts` `toolBrainFeedback` — forward an optional
  `idempotency_key` arg to the underlying writers.
- `tests/core/brain/idempotency-ledger.test.ts` — NEW; extend writer tests.

### Acceptance (passing test)
A test that:
1. With NO `idempotency_key`, a write is byte-identical to the old path (the
   bit-identity guard).
2. Two writes with the SAME key + SAME payload → second is deduped (returns
   duplicate_match, no file appended, no duplicate signal).
3. Two writes with the SAME key + DIFFERENT payload → second THROWS
   payload_mismatch (explicit error, never silent overwrite).
4. A retried write (same key, same payload) after a simulated crash is safe
   (deduped, not duplicated) — the multi-runtime retry case.

### Depends on
None. Lands the shared idempotency-ledger module that C4 consumes. Driven second
(opens the write-integrity axis).

---

## A2 — `t_7526e8d3` — Per-row event-time on batch remember/import

### Files
- `src/core/brain/signal.ts` `WriteSignalInput` — add optional `valid_from?` and
  `recorded_at?` (additive; absent → existing signals byte-identical). These flow
  into the SAME frontmatter keys `readBiTemporalSlots()` already parses
  (`valid_from`/`valid_until`/`recorded_at`), so the read-side needs no change.
- `src/core/brain/sessions/import.ts` `emit` — prefer `SessionTurn.timestamp`
  (when present and parseable) for `created_at`/`recorded_at`, falling back to
  `now` only when absent or unparseable. Guard against future-dated turn
  timestamps during backfill (clamp/skip deterministically; document the choice).
- `src/mcp/brain/feedback-tools.ts` + batch import path — forward an optional
  per-row `event_time`.
- `tests/core/brain/sessions/import-event-time.test.ts` — NEW.

### Acceptance (passing test)
A test in the import test suite that:
1. Backfilling an old session log stamps each signal's `created_at`/`recorded_at`
   with the turn's ORIGINAL timestamp, NOT the import wall-clock.
2. A turn with NO timestamp falls back to `now` (backward-compatible).
3. A turn with an UNPARSEABLE or FUTURE-dated timestamp is handled deterministically
   (falls back to `now` or clamps — no throw, no corrupt future-dated signal).
4. Asserts existing imports (no `event_time`) are byte-identical.

### Depends on
None (orthogonal to C1). Driven third. NOTE: this card touches `import.ts`
`emit`; C2 (later) adds a dry-run short-circuit to the same path — sequenced.

---

## D2 — `t_11e3db8b` — Note-position contradiction detection over prose

### Files
- `src/core/brain/health/contradiction.ts` — add
  `detectNoteContradictions(notes, opts)` that pairs same-subject permanent notes
  asserting opposite stances. Reuses the existing language-agnostic machinery:
  `similarity.ts` `findSimilarPairs`/`tokenise` for token-overlap subject pairing
  and a sign derivation from note PROSE (not `evidenced_by` signals). Emits
  `ask_user` findings that quote the relevant span from each note; never
  auto-resolves. New result type `NoteContradictionFinding` alongside the
  existing `ContradictionFinding`.
- `tests/core/brain/health/contradiction-notes.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. Two same-subject permanent notes with opposite stances are paired and surfaced
   as a contradiction finding, each with its quoted span.
2. Notes that merely ADD complexity (same stance) are NOT flagged.
3. Unrelated-subject notes are not paired (token-overlap threshold).
4. Detection is deterministic and language-agnostic (no English wordlist); a
   negation/stance derived structurally.

### Depends on
None. Driven fourth. NOTE: this card touches `contradiction.ts`; D3 (later) adds
the thesis monitor on top — sequenced.

---

## D1 — `t_4678a91a` — Signed source-diversity grounding score

### Files
- `src/core/brain/truth/grounding.ts` — NEW.
  `computeGroundingScore(slot, events)` → `{ score: number (-1.0..+1.0),
  confidence: "high"|"medium"|"low", band: "strongly_supported"|"mixed"|
  "contested"|"contradicted", supportingSources, contradictingSources }`.
  Pure projection over the `ClaimEvent`s that feed the slot (same events
  `computeTruthState` folds). Source-DIVERSITY weighting: confirming vs
  contradicting evidence counted across INDEPENDENT sources (distinct `source` +
  `agent`), N mentions in one doc << N mentions across N independent sources
  (document a weight ceiling); relationship strength weights the contribution.
  Signed (+ confirming, − contradicting); separate confidence/sufficiency
  dimension. Deterministic, order-insensitive (sort internally like the fold).
  Never writes/mutates the append-only ledger.
- `src/core/brain/truth/{fold,conflicts}.ts` — surface the projection alongside
  `computeTruthStateWithConflicts` output (additive; CONTESTED flag stays, the
  score quantifies it). No mutation of the fold.
- `tests/core/brain/truth/grounding.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. A slot agreed by N independent sources scores strongly positive; agreed by 1
   source scores weaker (source-diversity weighting is the part o2b lacks).
2. A contested slot (independent sources disagree) gets a score whose SIGN points
   to the better-supported side and whose magnitude reflects the balance.
3. N mentions in ONE document weigh far less than N mentions across N independent
   sources.
4. The score is deterministic and order-insensitive (shuffled input events →
   identical score), and the append-only ledger is not mutated.

### Depends on
None (owns `truth/` alone). Driven fifth.

---

## E1 — `t_1c894c19` — Session-bracketing memory wrapper for Aider

### Files
- `scripts/o2b-aider` (or `o2b aider wrap`) — NEW CLI wrapper process. At start,
  runs the load-half (regenerate the context sidecar via the existing Aider
  adapter's snapshot logic, mirroring Hermes `prefetch()`); execs the Aider binary
  with the injected `read:` context; at session end runs the write-back half
  (capture the session and persist into the Brain, mirroring Hermes
  `sync_turn()`/`on_session_end()`). Wrapper-process design because Aider has no
  native MCP.
- `src/core/install/adapters/aider.ts` — keep as the documented fallback (static
  sidecar for users who do not run through the wrapper). Extract reusable
  snapshot/capture helpers so the wrapper and the adapter share one source of
  truth (DRY).
- `tests/` for the wrapper lifecycle (load/persist bracketing, fallback path).
- Lifecycle shape mirrors `plugins/hermes/provider.py`
  `prefetch`/`sync_turn`/`on_session_end`.

### Acceptance (passing test)
A test (and/or an integration smoke) that:
1. The wrapper loads the memory context at session start (the load-half fires
   before Aider is exec'd) and persists the session back at session end (the
   write-back half fires after Aider exits).
2. The static sidecar fallback path still works unchanged for users who do not
   run through the wrapper (byte-identical adapter output).
3. An interrupted session (non-zero exit / signal) is handled honestly (captured
   as interrupted, mirroring `pre_compact_extract`'s `interrupted` flag).

### Depends on
None (fully isolated; no shared file with any other card). Driven sixth.

---

## C2 — `t_2c6cf3e2` — Dry-run extraction preview

### Files
- `src/core/brain/pre-compact-extract.ts` `extractPreCompactRecords` — add
  optional `dryRun?: boolean` mirroring the EXISTING `opts.dryRun` idiom in
  `import.ts`. When true, return the candidate records it WOULD extract WITHOUT
  calling `appendContinuityRecord` (no vault mutation, no log event, no
  dream/retire trigger). The returned records are the exact objects the real path
  would append.
- `src/core/brain/sessions/import.ts` — already has `opts.dryRun`; ensure the
  pre-compact path generalizes the same short-circuit. No global wrapper.
- `src/mcp/brain/pack-tools.ts` (or the relevant extract surface) — expose the
  preview as a non-destructive MCP/CLI verb.
- `tests/core/brain/pre-compact-extract-dry-run.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. `dryRun: true` returns the candidate records but writes NOTHING to the vault
   (no `appendContinuityRecord` call, no dream/retire trigger).
2. A parity assertion: the dry-run candidate records are deeply equal to the
   records the real path appends for the same input (preview faithfully predicts
   real extraction).
3. `dryRun` absent/false is byte-identical to today.

### Depends on
A2 (touches the same `import.ts` `emit` path; A2 settles event-time first, then
C2 gates it). Driven seventh.

---

## C3 — `t_92317f91` — Bounded verbatim last-N-turns buffer surviving compaction

### Files
- `src/core/brain/continuity/types.ts` — add `recent_turn` to
  `ContinuityRecordKind` (additive; legacy records read as v1).
- `src/core/brain/recent-turns.ts` — NEW. Bounded verbatim ring buffer of the
  last N turns (hard cap, default 20). `appendRecentTurn(vault, turn)` evicts
  oldest beyond N; `listRecentTurns(vault, { limit })` for reads. Persisted via
  the continuity store. Ephemeral scaffolding — its own kind + reader, clearly
  separated from curated memory.
- Optional post-compaction re-surface (opt-in flag, default off → byte-identical)
  appends the buffer to the post-compaction context.
- `tests/core/brain/recent-turns.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. Appending N+1 turns evicts the oldest (hard cap enforced); the buffer never
   grows beyond N.
2. After a simulated compaction, `listRecentTurns` returns the exact recent
   wording (the continuity-store artifact survives).
3. The buffer is clearly separated from curated memory (its own kind; reads do
   not leak into preference/signal/provenance surfaces).
4. Post-compaction re-surface is default-off → byte-identical context when off.

### Depends on
None. Driven eighth.

---

## C5 — `t_a82b674e` — Caller-settable per-memory expiration date

### Files
- `src/core/brain/preference.ts` `WritePreferenceInput` — add optional ISO
  `expiration_date?` (additive; absent → byte-identical). Flow into frontmatter.
- `src/core/brain/signal.ts` `WriteSignalInput` — add optional `expiration_date?`
  (same shape).
- Read path (search/list) — default silently drops anything past its
  `expiration_date`; an opt-in `showExpired` flag re-includes them for audit.
- Orthogonal to dream's heuristic retirement: an expired-by-date memory is
  FILTERED, not moved to `Brain/retired/` (audit trail preserved).
- `tests/core/brain/{preference,signal}-expiration.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. Writing a preference with `expiration_date` stamps the frontmatter; a write
   WITHOUT it is byte-identical to today.
2. Default search/list DROPS memories past their `expiration_date`.
3. With `showExpired: true`, expired memories are included (audit path).
4. An expired-by-date memory is NOT moved to `Brain/retired/` (orthogonal to
   dream; audit trail preserved).

### Depends on
None. Driven ninth.

---

## C6 — `t_edde2198` — Delete and search by exact source file

### Files
- Search: add exact `source_file` filter (matches `[[source-ref]]` /
  `session_ref` / ingest source-link frontmatter).
- `src/core/brain/source-cleanup.ts` (or extend an existing surface) — NEW
  `deleteBySource(vault, sourceFile, { confirm, includeOriginals })` that is
  DRY-RUN BY DEFAULT: reports the blast radius (derived signals/preferences/
  index entries/summary pages tracing to the source) WITHOUT deleting. An explicit
  `confirm` deletes the derived entries (and index artifacts); original user notes
  removed ONLY with an explicit `includeOriginals` flag. Writes auditable
  (continuity record of the cleanup).
- CLI/MCP reader surfaces search-by-source and the dry-run blast-radius report.
- `tests/core/brain/source-cleanup.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. `source_file` search filter returns only entries derived from that exact source.
2. `deleteBySource` with NO `confirm` reports the blast radius and deletes NOTHING.
3. With `confirm` (no `includeOriginals`), derived entries + index artifacts are
   deleted but ORIGINAL user notes are preserved.
4. With `confirm` + `includeOriginals`, originals are also removed. Cleanup is
   auditable (a continuity record is written).

### Depends on
None. Driven tenth.

---

## A3 — `t_9eeb8ca2` — Batch-plan step (depends on A1)

### Files
- `src/core/brain/ingest/batch-plan.ts` — NEW. `planBatches(vault, sourceDir,
  { maxBatchBytes, maxBatchFiles })` discovers ingestible files, calls A1's
  `classifyPaths` to skip `unchanged`, then splits the remainder into
  size+count-bounded batches (deterministic: sort by path, fill greedily to the
  byte cap then the count cap). Returns the batch list for the caller (agent/CLI)
  to dispatch as parallel subagents. No parallel execution inside the kernel.
- CLI/MCP reader surfaces the plan.
- `tests/core/brain/ingest/batch-plan.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. `planBatches` skips `unchanged` files (via A1's manifest) and plans batches
   only over `new`/`modified` files.
2. Batches respect BOTH the byte cap and the file-count cap (no batch exceeds
   either).
3. The plan is deterministic (same dir → same batch list, stable ordering).
4. An empty/all-unchanged dir yields an empty plan (no spurious batches).

### Depends on
**A1** (`t_c5184fd8`) — consumes the content-hash manifest's `classifyPaths`.
Driven eleventh. Pull before starting (A1's commits must be present).

---

## C4 — `t_1a3a9eba` — Batch checkpoint save for whole sessions (depends on C1)

### Files
- `src/mcp/brain/synthesis-tools.ts` (or a new checkpoint module) — NEW
  `brain_session_checkpoint` tool that saves a whole session's signals + learning
  + summary in ONE idempotent MCP round-trip. Idempotency is session-id + content-
  hash, reusing C1's idempotency ledger (`rememberKey`). If some writes need
  review (payload mismatch / validation failure), returns
  `{ status: "ok" | "mixed", partial: [...] }` — never silently drops items.
- `tests/mcp/session-checkpoint.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. A checkpoint with a fresh session-id writes all items once; a RETRY with the
  same session-id + same content is deduped (idempotent, no duplicates) via C1's
  ledger.
2. A checkpoint where some items need review returns `status: "mixed"` with the
  partial list (never silently drops).
3. A retry with the same session-id but DIFFERENT content throws payload_mismatch
  (explicit error, no silent overwrite).

### Depends on
**C1** (`t_213f356b`) — reuses the idempotency-key ledger. Driven twelfth. Pull
before starting (C1's commits must be present).

---

## D3 — `t_74d29363` — Declared-thesis register with new-note monitor (depends on D2)

### Files
- `src/core/brain/health/thesis.ts` — NEW. A declared-thesis register
  (operator-recorded positions: statement, supporting evidence, counter-evidence,
  last-updated, falsification "what would make me wrong"), stored as a dedicated
  frontmatter kind under `Brain/theses/`. A monitor evaluates each newly-ingested
  note against active theses, flagging support/contradiction (builds on D2's
  note-position base). Reuses `obligations.ts` cadence machinery for the
  "not updated in N days" staleness check and the thesis-graveyard pass (flag
  theses with no supporting evidence in N days for formal closing). Suppresses
  mere added-complexity per the article. Alerts when incoming evidence matches a
  thesis's documented falsification scenario.
- `tests/core/brain/health/thesis.test.ts` — NEW.

### Acceptance (passing test)
A test that:
1. Recording a thesis and ingesting a note that CONTRADICTS it raises a conflict
  flag (quoting the thesis note); a note that SUPPORTS it raises a support flag.
2. A thesis not updated within the cadence is flagged stale (via the obligations
  machinery); a thesis with no supporting evidence in N days is flagged for the
  graveyard.
3. Incoming evidence matching a thesis's falsification field raises an alert.
4. A note that merely adds complexity is NOT flagged. Never auto-resolves.

### Depends on
**D2** (`t_11e3db8b`) — builds on the note-position detector. Driven last (closes
the honesty axis). Pull before starting (D2's commits must be present).
