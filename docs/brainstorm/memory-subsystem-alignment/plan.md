# Memory subsystem alignment — implementation plan

Branch: `feat/memory-subsystem-alignment`

Overall release scope:

- `t_64ec5bbd` — Make pinned_context budget honest: surface truncation instead of silent data loss.
- `t_c492e539` — Add atomic batch (operations array) writes to Open Second Brain writer tools.
- `t_5e06b572` — Implement the on_memory_write memory-provider bridge (capture host native memory writes).

Drive these cards one at a time on the shared branch. Each worker must inspect `git log` and `git status` before editing, build on commits from prior in-scope cards, and avoid duplicating or conflicting with sibling work.

## t_64ec5bbd — Make pinned_context budget honest: surface truncation instead of silent data loss

### Files

- `src/core/brain/pinned.ts`
- `src/core/redactor.ts`
- `src/mcp/brain/context-tools.ts`
- Focused tests under `tests/` for pinned-context budget behavior.

### Plan

1. Add a pinned-context-specific normalization/budget result instead of relying on the generic `sanitiseTextField(...).slice(0, maxLen)` behavior as an unreported success path.
2. Preserve current behavior for content whose normalized length is at or below `MAX_PINNED_CONTEXT_LEN`.
3. For over-budget write/append input, return an explicit machine-readable budget signal rather than silent success. Prefer a rejected/budget-exceeded result that includes original and normalized sizes, budget, operation, and a consolidation/retry hint.
4. Ensure `brain_pinned_context` serializes the budget signal consistently and does not write a partial/truncated value while claiming success.
5. Keep generic `sanitiseTextField` stable for unrelated callers unless a full audit proves a narrower change is safe.

### Acceptance (passing test)

- A test writes over-budget pinned-context input and asserts:
  - the response includes an explicit budget/truncation/rejection signal;
  - original and allowed/stored counts are exposed;
  - the persisted pinned context is not silently replaced by an unmarked truncated value.
- Existing within-budget write, append, read, and clear tests still pass.

### Depends on

- No in-scope card dependency. This should land first because `t_c492e539` should use the same budget-honesty semantics for batch mode.

## t_c492e539 — Add atomic batch (operations array) writes to Open Second Brain writer tools

### Files

- `src/core/brain/pinned.ts`
- `src/mcp/brain/context-tools.ts`
- `src/core/brain/continuity/store.ts`
- `src/core/brain/continuity/types.ts`
- Focused tests under `tests/` for pinned and continuity batch atomicity.

### Plan

1. Build on the budget result from `t_64ec5bbd`; do not reimplement a separate budget path.
2. Add an optional ordered `operations` array mode to `brain_pinned_context` while preserving the existing single `operation` parameter behavior.
3. Support ordered pinned operations for `write`, `append`, `clear`, and targeted `replace` segments. Validate every operation and the final projected content before writing anything.
4. Add terminal/idempotent success metadata to writer success responses so agents can stop after a successful call.
5. Add continuity batch append support that builds and validates all records before writing, then appends under a single lock acquisition per target shard.
6. If continuity batches can span month shards, make the boundary explicit in code comments and tests; do not imply cross-shard atomicity unless the implementation truly guarantees it.

### Acceptance (passing test)

- A pinned-context batch test with a malformed middle operation leaves the existing pinned-context file byte-for-byte unchanged.
- A valid pinned-context batch applies operations in order and returns terminal/idempotent success metadata.
- A continuity batch test proves valid records append under the batch path, and an invalid record in the batch leaves the log unchanged for the tested shard.
- Existing single-operation writer tests still pass.

### Depends on

- `t_64ec5bbd` should land first so batch mode reuses the same budget-honesty contract.

## t_5e06b572 — Implement the on_memory_write memory-provider bridge (capture host native memory writes)

### Files

- `plugins/hermes/__init__.py`
- `plugin.yaml`
- `plugins/hermes/plugin.yaml`
- Any shared bridge/core adapter module needed to keep plugin glue thin.
- `src/core/brain/pinned.ts` and `src/core/brain/continuity/store.ts` only through the shared primitives from prior cards.
- Focused tests under `tests/` for host payload mapping, vault persistence, and no-op behavior.

### Plan

1. Before coding, verify the exact `on_memory_write` contract from Hermes source and PRs #48507/#48262: hook discovery, function signature, payload fields, operation names, batch `operations` shape, replace/remove semantics, and success response expectations.
2. Record the verified contract in comments or a small test fixture so future changes do not depend on memory of the external PR.
3. Implement the Hermes hook handler as a thin adapter that maps verified host payloads into the shared batch substrate from `t_c492e539`.
4. Persist host memory writes into the vault using the chosen durable representation: continuity record kind and/or pinned-context update as justified by the verified payload semantics.
5. Reject unknown or malformed payloads explicitly. Do not guess signatures, ignore unsupported fields silently, or perform partial writes.
6. Keep the path no-op when the host does not invoke the hook; plugin startup must not mutate the vault by itself.

### Acceptance (passing test)

- A test using a representative verified host payload proves native memory writes land in the vault.
- A batch payload, if supported by Hermes, is applied atomically through the same substrate as `brain_pinned_context` batch mode.
- A malformed or unsupported payload returns an explicit failure and leaves the vault unchanged.
- A no-invocation/no-host path performs no writes.

### Depends on

- `t_64ec5bbd` and `t_c492e539` should land first. The bridge must reuse their budget-honesty and batch-atomicity primitives rather than implementing independent memory-write semantics.
