# Variants - integrity-control-agent-memory-surface

Consultant: Claude Code (primary; exit 0, three parseable variants plus a recommendation). The fallback consultant did not run. Prompt and raw output: `cli-output/prompt.md`, `cli-output/claude.md`. Premise verification ran before the consultant; the verified premises embedded in the prompt are recorded in `design.md`.

## Variants (verbatim consultant output)

### Variant 1: Narrowest seams, per-card local logic
- **Approach**: Each card lands as an isolated edit at its existing call site with no shared abstraction. Card 1 adds a title-plus-alias term pool and an inline "exactly one page carries this term" filter inside `collectRepairCandidates`; Card 2 adds a post-pass in `runPreExtract` that probes relative specifiers against the manifest path set and fills an optional `resolvedTo` on the seed; Card 3 adds one JSX opening-tag regex and a `uses` kind; Card 4 calls `rememberKey` from `applyWriteBatch` with a `write_batch` record whose `ref` carries the receipt; Card 5 is one sentence; Card 6 threads a `matchMode` boolean-ish flag through `SearchOptions` to `buildFtsMatch`.
- **Trade-offs**:
  - Pro: smallest diff, every default byte-identical, each card reviewable on its own.
  - Pro: no new modules, no new public types beyond the widened union and optional fields.
  - Con: the unique-match discipline is written twice (pages in Card 1, files in Card 2) with two chances to diverge.
  - Con: ambiguous terms and unbound specifiers tend to vanish silently unless each site remembers to count and report them, which strains the "nothing degrades silently" convention.
  - Con: Card 4 records the ledger entry after the commit, leaving a crash window between apply and remember that a retry can double-apply through.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Shared unique-resolution primitive with named refusals
- **Approach**: Introduce one small pure module (a term index plus a resolver that returns `unique | ambiguous | none` with the candidate list) and consume it from both the repair-lane term resolver (Card 1, terms pooled from titles and `buildAliasIndex`) and the pre-extract specifier binder (Card 2, terms are extension-probed paths over the ingested-file set passed in as an explicit input). Both surfaces carry the refusal counts outward: the repair report gains an ambiguous-terms section and the pre-extract result gains an `unbound` list with reasons. Card 4 reuses `rememberKey` unchanged with the batch receipt in `ref`, consulted before any commit and recorded inside the batch's atomic unit so the receipt and the writes land together; Card 6 defines one `FtsMatchMode` type shared by `buildFtsMatch` and `buildExpandedFtsMatch`; Cards 3 and 5 stay local.
- **Trade-offs**:
  - Pro: one tested discipline for "bind only when exactly one target matches", so Cards 1 and 2 cannot drift.
  - Pro: honesty by construction, since the resolver returns a typed status and callers must map every status to something visible.
  - Pro: no new dependencies, no new machinery beyond a pure function module, determinism is trivial to prove because the resolver takes the index as an argument.
  - Con: a new cross-cutting module means a broader test surface and one more thing for the link-graph and ingest owners to agree on.
  - Con: putting the ledger record inside the batch commit touches the write-batch kernel's atomic path, which is the most sensitive code in the wave.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Index-first candidate tables and a separate receipt store
- **Approach**: Build explicit reusable indexes as first-class inputs: `loadPages` returns a corpus term index that the repair lane, `findUnlinkedMentions` and future consumers share, and `ingestSource` builds an ingested-file index from the manifest and hands it to pre-extract. Cards 1 and 2 produce a full candidate table (every term with all matching targets and a resolution status) as an intermediate artifact surfaced in dry-run reports, and binding becomes a filter over that table. Card 4 gets a dedicated receipt store keyed by request ID rather than a ledger record, and Card 6 replaces the boolean with a parsed query object carrying tokens and mode.
- **Trade-offs**:
  - Pro: richest operator visibility, and the shared indexes would let the target-centric mention scanner converge with the corpus-wide path later.
  - Pro: the candidate table makes ambiguity a reported fact instead of a dropped edge.
  - Con: changes the shape of `loadPages` output and the pre-extract input contract, the widest blast radius in the wave.
  - Con: a separate receipt store duplicates what the idempotency ledger already does and drifts from the card's stated scope of extending `rememberKey` semantics; it also edges toward the struck durable-queue territory.
  - Con: the parsed query object for Card 6 is more than the card asks for and risks touching the two derived-term callers.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: Variant 2 keeps every default byte-identical and adds no machinery, yet it gives the two resolution cards one shared, typed unique-match discipline so ambiguity is always named rather than silently dropped, which is the project's core honesty rule. It reuses the existing idempotency ledger exactly as the validator scoped Card 4, while closing the apply-then-remember crash window that Variant 1 leaves open. Variant 3 buys visibility the cards did not ask for at the cost of public-shape changes and a parallel receipt store the constraints explicitly steer away from.

## Orchestrator decision

Variant 2 is adopted, with two documented refinements:

1. **Card 4 sequencing** - the consultant placed the ledger record "inside the batch's atomic unit". No cross-file atomic unit exists: the ledger is a JSONL store separate from the note files the batch writes. The implementation follows the pattern `src/core/brain/signal.ts` already ships and the ledger's own documentation accepts - `lookupKey` consult before any commit, `rememberKey` after a successful commit with its re-check under the shard lock. The residual crash window between commit and record is the one the ledger already documents; the card's target, a sequential retry after a lost response, stays fully deduped because the record is durable before the retry runs.
2. **Card 2 refusal visibility** - the consultant's separate `unbound` list with reasons on the pre-extract result is trimmed. A seed whose binding is refused keeps its raw specifier, which is itself the visible conservative outcome; an aggregate list would restate the seeds. Card 1 keeps named refusals because there the refusal genuinely erases output: the new `skip-ambiguous` action in the existing decision list is what tells the operator why no edge was proposed.

Variant 3 was rejected for the reasons the consultant gives: it changes public shapes (`loadPages` output, pre-extract input contract) and duplicates the ledger with a parallel receipt store, against the card's explicit "extend rememberKey semantics" scope. Variant 1 was rejected because the unique-match discipline in two places is exactly the drift the shared resolver prevents, and its silent-ambiguity tendency conflicts with the project's nothing-degrades-silently rule.

## Appendix: owner-mandated addition t_774dea61 (mid-wave)

The owner added triage card t_774dea61 (priority 4, "Per-device file names for Brain logs written from multiple synced machines") to the picked scope after the design node ran; this wave ships it in the same PR as the seventh feature. No second consultant run was made: the card arrives with a proposed fix of its own, and the live-source premise check below found the proposal sound with three corrections, so the adopted approach is the card's own fix, trimmed to the established conventions of `src/core/brain/ledger-shards.ts`.

**Premise verification result.** Every anchor held: `appendAuditRecord` (`src/core/reliability/audit.ts:15-34`, name built at line 21); the `ledger-shards.ts` grammar and helpers; `O2B_DEVICE_ID` (exists at `src/core/config.ts:466`, read by `resolveDeviceId`, delegated to by `resolveAppendShardId`; `tests/setup.ts` already pins it to `""` as the test preload default, exactly as the card's criterion 6 assumes); all thirteen writer-inventory line anchors plus the two low-risk sites and seven hook audit sites; and the already-sharded list. No inventory item turned out to be already sharded, and no named env var needed correction.

**Corrections applied to the card's fix.**

1. Fix step 2's premise - "make every reader of these audit directories merge" - overstates the reader set: the audit week directories have almost no content readers (session-lifecycle, hygiene, secret-custody, watchdog have none; the doctor's orphan-session check reads the already-sharded daily Brain log; the hook-audit reader probes existence only). The real reader work is one function (`readRecordedSchemaPackDigest`, which already scans every `.jsonl` and needs the conflict-copy exclusion) and the state inventory's reachability probes for the sharded fixed-name ledgers.
2. The doctor conflict sweep already exists (`syncConflictLogCheck` over `LEDGER_DIRS`, message carrying the manual union+dedup instruction); the card's step 4 reduces to extending the swept directory list. The "one-shot, opt-in merge" verb is deferred: the ledger-shards contract and the existing doctor message define merge-by-hand as the established recovery path, and an automatic merge is operator-facing machinery the wave does not build. Recorded in design.md's Out of scope.
3. Items 9 and 10 (capture-decisions, verifier-rejections) have no reader in `src/`, so their conversion is writer-side plus the capture-decisions state probe.

The card's criterion 8 (CHANGELOG entry and docs) is satisfied by the osb-pr-prepare docs phase inside the PR, per this run's boundaries, and is noted as deferred there.
