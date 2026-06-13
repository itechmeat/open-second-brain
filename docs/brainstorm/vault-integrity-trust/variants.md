# Vault Integrity & Trust - brainstorm variants (audit trail)

Consultant: Claude Code (`claude -p`), primary. Exit 0, three parseable variants returned, so the Codex fallback was not invoked (anti-pattern: sequential, fallback only on primary failure). Prompt: `cli-output/prompt.md`. Raw output: `cli-output/claude.md`.

## Variant 1: Trust-Boundary Kernel

- **Approach**: One new shared module (`src/core/boundary/`) owns every trust/identity primitive: canonical identity (NFC path + content-hash, Units 1+2), provenance-delimiter/neutralizer (Unit 1), scope-predicate factory (Unit 5), and a generic side-index abstraction the graph (Unit 4) and watcher-driven indexer (Unit 3) register against. Each unit is a thin caller of the kernel.
- **Trade-offs**: Pro - the theme is literally one module, one test surface for cross-cutting invariants; identity defined once so Unit 1 `sha256` and Unit 2 change-key cannot drift. Con - premature abstraction over genuinely different mechanics (string neutralizer vs daemon vs SQL filter share almost no shape); largest blast radius against byte-identical-when-off (every call site rerouted through the kernel even with flags off).
- **Complexity**: large
- **Risk**: high

## Variant 2: Five Independent Units, Shared Nothing New

- **Approach**: Each unit stays in its named home and reuses only what exists (current content-hash). No new shared module; the only common discipline is convention (pure derivation, opt-in flag, byte-identical-when-off). Persisted-vs-derived decided locally per unit, defaulting to read-time derivation.
- **Trade-offs**: Pro - smallest diff per unit, cleanest TDD-one-by-one, each unit independently revertable; lowest risk to the byte-identical guarantee. Con - the unifying theme exists only in the changelog, not the code; the identity primitive shared by Units 1 and 2 lives in two files (drift risk); Units 3 and 4 both want a kept-fresh derived view but solve it twice with no shared invalidation discipline.
- **Complexity**: medium
- **Risk**: low

## Variant 3: Thin Identity Core, Independent Edges (CHOSEN)

- **Approach**: Extract only the one primitive two units provably share - canonical identity (NFC-normalized path + content-hash) - into the existing `content-hash.ts` / `note-path.ts` boundary, consumed by both Unit 1's provenance and Unit 2's change-detection key. Leave the three operational units (3 watcher at CLI/MCP edge, 4 graph side-indexes, 5 recall scope) fully independent. Resolve derive-vs-persist by rule: read-time-derive everywhere (Units 1, 2, 5), Unit 4 alone allowed an in-memory side-index memoized + invalidated on store version (not SQLite-persisted), Unit 3's watcher reusing the existing incremental `indexVault`.
- **Trade-offs**: Pro - shares exactly what is provably shared and nothing speculative; one explicit documented rule for the derive-vs-persist tension; preserves byte-identical-when-off cleanly (NFC idempotent on already-NFC inputs). Con - requires judgment on where "shared enough" stops; Unit 4's memoize-and-invalidate needs careful concurrency/determinism review; slightly more upfront coordination (identity extraction lands first).
- **Complexity**: medium
- **Risk**: low

## Consultant recommendation: Variant 3

> The only real cross-unit coupling is identity (Unit 1's provenance hash and Unit 2's change-detection key must be the same canonical NFC+hash), so extracting that one primitive - and nothing else - captures the theme's coherence without paying for Variant 1's speculative kernel or accepting Variant 2's latent drift. It honors the repo's established read-time-derive precedent (`recall-hint.ts`, `enrich.ts`) as the default while granting Unit 4 the single principled exception its O(1) performance goal demands.

## Orchestrator decision: accept Variant 3

No override. Variant 3 matches three standing project facts the consultant could not weigh on its own:

1. The repo's read-time-derive precedent (`recall-hint.ts`, `enrich.ts`) is an established, reviewed pattern - Variant 3 makes it the explicit default rule rather than a per-unit coin-flip (Variant 2) or an abstracted-away detail (Variant 1).
2. The byte-identical-when-flags-off guarantee is a hard release gate here; Variant 1's "reroute every call site through a kernel" is the highest-risk path against it, and Variant 3 confines the only unconditional shared change to NFC normalization, which is idempotent on the dominant (Linux) platform.
3. The suite ships one-by-one via TDD on one branch; Variant 3's thin identity-core-first ordering gives a clean dependency chain (Task 1 -> Tasks 2/3) while leaving Tasks 4/5/6 independent.

De-scope noted in `design.md`: `t_bf6933bc` (codegraph ghost-duplicate auto-merge) is dropped from this suite - it is a passthrough to the external `graphify` binary and would require a silent no-op fallback when graphify is absent, which the project forbids.
