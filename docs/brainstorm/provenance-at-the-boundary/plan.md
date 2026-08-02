# Provenance at the boundary - implementation plan

Ten atomic units on `feat/provenance-at-the-boundary`, one commit each,
implemented largely in parallel. Every unit is test-first: the failing test runs
and fails for the expected reason before the implementation exists.

Standing rules for every unit, from the wave contract: no fallback that reads as
success, no stub, no hardcoded natural-language word list in any language,
absence and inability-to-examine stay different answers, a new flag or config key
is byte-identical when absent and a test proves it, diagnoses resolve a
registered code through the advisory rail, tests build temp vaults and make no
network calls, and no existing test may be edited to make a change pass.

## Tasks

### Task A: Trust at intake, and a quarantine that read paths honour
- **Files**: `src/core/brain/intake/extract-intake.ts`, `src/core/brain/ingest/ingest.ts`, `src/core/brain/entities/types.ts`, `src/core/brain/entities/registry.ts`, `src/mcp/brain/ner-tools.ts`, `src/core/brain/trust/retrieval-gate.ts`, a new shared entity-status predicate, `tests/core/brain/entities/*`, a new census test
- **Acceptance**: an entity extracted under untrusted provenance lands with `quarantine` status and is absent from every entity read surface; the same extraction under trusted provenance is byte-identical to today; the `untrusted_source` frontmatter key the retrieval gate reads now has a writer, proved by a test that drives the gate from a real intake rather than a hand-built fixture; the census fails when a new entity read path bypasses the shared status predicate, demonstrated by a test that adds one
- **Depends on**: none

### Task B: A config-declared write binding, and a census of what it cannot cover
- **Files**: a new write-binding module under `src/core/`, enforcement in `src/core/vault.ts` and `src/core/brain/write-batch.ts`, `src/core/brain/handoff.ts`, `src/cli/brain/verbs/links.ts`, the config policy block declaring the binding, a new write-site census test
- **Acceptance**: with no binding declared, every write path is byte-identical to today; with a binding declared, a caller-named write outside it is refused with a registered code naming the binding, and a write inside it succeeds; a caller-supplied agent argument cannot widen the binding, proved by a test that passes a different agent string and still gets refused; the census enumerates every in-vault write site and fails when a new direct-`fs` writer appears without a written exclusion
- **Depends on**: none

### Task C: Idempotent skip, pre-write validation, template-mode creation
- **Files**: `src/core/brain/notes/create-note.ts`, a new template module under `src/core/brain/notes/`, `src/mcp/brain/notes-tools.ts`, `tests/core/brain/notes/*`, `tests/mcp/brain-create-note.test.ts` additions
- **Acceptance**: default creation still refuses to clobber, with the existing tests untouched and green; `if_exists: "skip"` on an existing note returns a result a caller can tell apart from a create and leaves no parent directory behind; `strict` rejects a document the existing artifact validator rejects, reporting its coded violations, and is byte-identical when absent; template mode renders typed variables, a presence-driven section and a list iteration, and leaves an unknown placeholder intact; the frozen tool-name parity test is verified rather than assumed unaffected
- **Depends on**: none

### Task D: A body-derived date anchor, materialised at index time
- **Files**: `src/core/search/schema.ts`, `src/core/search/indexer.ts`, `src/core/search/store/documents.ts`, `src/core/search/pipeline/candidate-signals.ts`, `src/core/search/pipeline/event-time.ts`, a new schema-migration test, `tests/core/search/*`
- **Acceptance**: a note whose body carries an ISO date and whose frontmatter carries none ranks by that date under a temporal query; a note with neither is byte-identical to today; the chosen anchor's source is recorded as a registered token; a v10 index rewound and re-migrated preserves existing rows with the new column null; body text in three non-English scripts yields no anchor; a slash-formatted date yields no anchor; a future date is stored rather than dropped; the clock-relative branch of the reused extractor is unreachable from the ingest path, proved by a test that would catch a value drifting between two runs over unchanged content
- **Depends on**: none

### Task E: A per-request token budget for embedding batches
- **Files**: `src/core/search/embeddings/openai-compat.ts`, `src/core/search/embeddings/zeroentropy.ts`, `src/core/search/index.ts`, `src/core/search/types.ts`, `tests/core/search/*`
- **Acceptance**: with the budget unset, batching is byte-identical to today; with it set, a batch closes on the accumulated token estimate before the count cap when the estimate fills first, and on the count cap otherwise; the estimate includes the instruction prefix the provider prepends; both batching providers honour it; the config key is rejected at zero the way its sibling is, both as a string and as a programmatic override; the stale "three attempts" docblock and the super-batch comment are corrected
- **Depends on**: none

### Task F: One capability-tier resolver, one registered code, one predicate
- **Files**: a new tier-resolver module under `src/core/search/`, `src/core/search/semantic-phase.ts`, `src/core/search/indexer.ts`, `src/core/doctor-readiness.ts`, `src/core/search/embeddings/contract.ts`, `src/core/brain/diagnostics.ts`, a new backfill planner under `src/core/` and its verb under `src/cli/`, `tests/core/search/*`, `tests/cli/*`
- **Acceptance**: the four sites that computed tier facts separately return the same tier for the same configuration, proved by a test that drives all four; the deferred-reason prose is replaced by a registered code and the advisory-rail ratchet passes; a provider whose name is neither of the two current literals is classified by the contract predicate rather than by name, proved by a test provider; the backfill verb reports pending vector work in dry-run by default, applies only under the explicit flag, emits both report shapes, and records a registered log event whose append failure surfaces rather than being swallowed
- **Depends on**: none

### Task G: A declared continuity scope, and a census of who honours it
- **Files**: `src/core/brain/continuity/types.ts`, `src/core/brain/continuity/store.ts`, `src/core/brain/continuity/read-model.ts`, `docs/observability.md`, a new census test, `tests/core/brain/continuity/*`
- **Acceptance**: a record appended without a scope is byte-identical to today, field for field; a record appended with the shared scope is retained by a read-model filter that requests it and excluded by one that does not; the census names every continuity reader and asserts which go through the read model and which read the store directly, failing when a new reader joins either set without being listed; the documentation sentence stating the masking policy as universal is corrected to match
- **Depends on**: none

### Task H: Preview before a schema mutation lands
- **Files**: `src/core/brain/schema-mutate.ts`, `src/mcp/schema-tools.ts`, `tests/core/brain/*`, `tests/mcp/*`
- **Acceptance**: a preview returns the pack that would result and the difference from the current one, and the config file's modification time and bytes are unchanged afterwards; a preview of a mutation the validator rejects returns the same coded rejection an apply would, without writing; an apply with no preview behaves exactly as today
- **Depends on**: none

### Task I: The kernel's own evidence recorded beside the agent's claim
- **Files**: `src/core/brain/context-pack-outcome.ts`, `src/core/brain/token-impact.ts`, `src/core/brain/continuity/types.ts`, `src/mcp/brain/recall-tools.ts`, `tests/core/brain/*`
- **Acceptance**: posting an outcome also records a second entry, joined by the existing sample id, carrying the digest the kernel wrote at pack time and reads back off disk, and a match verdict; a claim contradicted by that evidence records a mismatch rather than being rejected or silently corrected; the record carries no verifier-identity field and no surface calls it independently witnessed; the outcome record now carries the actor field its sibling already had; the emit path stays fail-open and unfsynced
- **Depends on**: none

### Task J: An identified skill offer, a ranking floor, retained provenance
- **Files**: `src/core/surface/skills.ts`, `src/core/surface/skill-attach.ts`, `src/core/brain/skill-usage.ts`, `src/mcp/skill-tools.ts`, `src/mcp/registry-guard.ts`, `tests/core/surface/*`, `tests/mcp/*`
- **Acceptance**: an offer carries an identity that a subsequent invocation record can be joined to, proved end to end over an imported session fixture; the discriminating-term floor drops a skill matched only on terms common across the descriptor corpus and keeps one matched on a rare term, with no word list anywhere in the derivation; a skill shadowed by a same-named skill in a later root records the shadowed path instead of discarding it; any new tool surface declares a preview budget or is listed in the exemption map, so the registry guard passes
- **Depends on**: none

## Sequencing

All ten are independent by file ownership and can run concurrently. Two shared
concerns are decided here rather than at merge, per the design document's
amendments: the content digest comes from the existing manifest and stamp
helpers and no unit introduces a second hashing path, and the capability state
from task F answers what the operator configured while the existing search error
codes answer what a call attempted and could not do, with nothing reporting both.

Commits land in the orchestrator's hands, one per unit, after that unit's
formatter, linter, typecheck and tests are green.
