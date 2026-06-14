# Recall & Working-Memory Quality Suite - implementation plan

Four atomic units on ONE feature branch (`feat/recall-working-memory-quality`),
each its own conventional commit, each TDD (failing test first). Order chosen so
the two shared primitives land before their consumers.

## Task 1: Selectable recall profiles (Primitive A)

- **Files**: `src/core/search/profiles.ts` (new), `src/core/search/types.ts`
  (+`recallProfile` resolved field, default null), `src/core/search/search.ts`
  (apply at the `applyTunedParameters` seam), `src/cli/search.ts` (top-level
  `o2b search`, add `--profile` flag - NOT a new verb; `verbs/profile.ts` is the
  unrelated `o2b brain profile` digest), `src/mcp/search-tools.ts`
  (+`profile` field on `SEARCH_INPUT_SCHEMA`), tests:
  `tests/core/search/profiles.test.ts`, search byte-identical-OFF test.
- **Acceptance**:
  - `resolveRecallProfile("fast"|"balanced"|"thorough")` returns the fixed knob
    tuple; unknown name throws a typed `SearchError("INVALID_INPUT", ...)`.
  - With no profile, `search()` config is byte-identical to today (asserted).
  - Explicit profile wins over a persisted self-tuning grid point; both-set and
    each-alone cases tested.
  - CLI `--profile` and MCP `profile` field thread through to the resolver.
- **Depends on**: none.

## Task 2: Usage-driven working-memory decay (Primitive B)

- **Files**: `src/core/brain/continuity/usage-signal.ts` (new: usage-signal reader
  over `recall_telemetry` records + pure `decayWeight(signal, now)`),
  `src/core/brain/continuity/read-model.ts` (apply weight when flag on),
  `src/core/brain/continuity/types.ts` (config/flag if needed), tests:
  `tests/core/brain/continuity/usage-signal.test.ts`, read-model decay test +
  byte-identical-OFF test.
- **Acceptance**:
  - `decayWeight` is pure: identical (count, lastAccessAge, now) -> identical value
    in (0, 1]; frequently-/recently-accessed -> higher weight; stale -> lower.
  - Usage signal derived only from existing `recall_telemetry` continuity records;
    no new mutable counter written to records.
  - Read-model OFF reproduces current ordering/weights byte-for-byte (asserted).
  - No record is deleted or mutated; decay is weighting only.
- **Depends on**: none.

## Task 3: Language-agnostic co-occurrence auto-relate (dream producer)

- **Files**: `src/core/brain/link-graph/co-occurrence.ts` (new: structural
  co-occurrence scorer + versioned/hashed suggestion artifact, persistence
  convention mirroring `tuning.json`), maintenance/dream entry registration,
  `src/cli/brain/verbs/` co-occurrence-suggest verb, tests:
  `tests/core/brain/link-graph/co-occurrence.test.ts` + language-agnostic test
  (non-Latin entities scored identically by structure).
- **Acceptance**:
  - Score is document-frequency / PMI-style over canonical-entity -> note
    incidence; NO natural-language word list anywhere (asserted by a non-Latin /
    mixed-script fixture producing structurally-identical results).
  - Min co-document threshold + top-N cap make output bounded and deterministic
    (same vault -> same suggestions, hashed).
  - Emits derived link suggestions only; note bodies are never modified.
  - Re-validate-on-read + fail-soft to empty when the artifact is drifted/missing.
- **Depends on**: none (independent producer).

## Task 4: File-context recall (standalone surface)

- **Files**: `src/core/brain/file-recall.ts` (new: path -> prior-work query reusing
  `session-focus.ts` path-prefix biasing + size gate), `src/cli/brain/verbs/`
  file-context verb, `src/mcp/` new tool + registry, tests:
  `tests/core/brain/file-recall.test.ts`, `tests/mcp/` tool test + tool-count /
  frozen-name-list updates.
- **Acceptance**:
  - Given a file path, returns prior-work hits from the existing search index
    biased to that path; no LLM call.
  - File below the size gate (default 1500 bytes, config field) returns an explicit
    empty result WITH a reason, never a fabricated hit.
  - Path safety: traversal / outside-vault path -> typed error (reuse vault-relative
    normalisation), consistent with `session-focus.ts`.
  - MCP tool registered; tool-count and frozen-name-list tests updated in lockstep.
- **Depends on**: none (uses existing search + session-focus).

## Cross-cutting (Phase 4/5)

- Full suite: `bun test`, `bun run typecheck`, `bun run lint`, `bun run scripts/sync-version.ts --check`.
- Version bump `package.json` 1.9.0 -> 1.10.0 + `bun run scripts/sync-version.ts`.
- Docs: `CHANGELOG.md` (one `[1.10.0]` entry), `README.md`, `docs/mcp.md`.
- Byte-identical-OFF assertions per unit are the gate for "additive, no behaviour change".
