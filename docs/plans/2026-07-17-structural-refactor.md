# Structural refactor: dependency cycles and complexity hotspots

Date: 2026-07-17
Status: in progress
Branch: `refactor/structural-cleanup`

## Goal

Remove import cycles from the TypeScript source tree and reduce the
complexity of the worst-ranked modules, without any behavior change.
Every step is verified with `bun run validate` (typecheck + lint + tests).

## Baseline (code-ranker snapshot, commit fd5661f9)

672 internal TypeScript files analyzed. Seven import cycles (strongly
connected components) and a cluster of low-maintainability files.

### Import cycles

| # | Scope | Files | Notes |
|---|-------|-------|-------|
| 0 | `src/mcp/**` | ~35 | `capabilities.ts`, `tools.ts`, and every `brain/*-tools.ts` form one component |
| 1 | `src/core/brain` | 3 | `doctor.ts`, `trust/instruction-file-ceiling.ts`, `trust/compute-trust-verdict.ts` |
| 2 | `src/core/search` | 11 | `index.ts`, `search.ts`, `store.ts` orbit: rerank, benchmark, tuning, profiles |
| 3 | `src/core/search/embeddings` | 5 | `provider.ts` and its four implementations |
| 4 | `src/core/brain` | 3 | `procedural-memory.ts`, `procedural-graph.ts`, `procedural-hints.ts` |
| 5 | `src/core/search` | 4 | `types.ts`, `structured-query.ts`, `session-focus.ts`, `evidence-pack.ts` |
| 6 | `src/core` | 3 | `config.ts`, `brain/wikilink.ts`, `brain/link-graph/format-wikilink.ts` |

### Worst files by maintainability index

| File | MI | Cognitive | SLOC | fan_in |
|------|----|-----------|------|--------|
| `src/core/search/search.ts` | -85.8 | 442 | 1223 | 5 |
| `src/core/search/store.ts` | -69.8 | 199 | 1520 | 17 |
| `src/core/brain/policy.ts` | -68.7 | 396 | 1314 | 37 |
| `src/cli/search.ts` | -66.0 | 287 | 1070 | 1 |
| `src/core/brain/preference.ts` | -56.3 | 226 | 927 | 34 |
| `src/core/brain/dream.ts` | -54.6 | 344 | 970 | 11 |
| `src/core/brain/doctor.ts` | -51.6 | 256 | 1010 | 9 |

## Plan

The standard remedy for each cycle is dependency inversion at the type
level: extract the shared contract (types, interfaces) into a leaf
module that owns no imports back into the component, then point both
sides at it. No re-export shims left behind unless an external caller
requires the old path.

### Wave 1 - small, independent cycle breaks (parallel)

- W1a: cycle 1 (`doctor.ts` and `trust/*`)
- W1b: cycle 4 (`procedural-*` triple)
- W1c: cycle 6 (`config.ts`, `wikilink.ts`, `format-wikilink.ts`)

### Wave 2 - subsystem components (parallel)

- W2a: `src/core/search` - cycles 2, 3, 5 in one pass, since they share files
- W2b: `src/mcp` - cycle 0, expected fix is extracting the tool-registry
  contract out of `capabilities.ts`/`tools.ts` so leaf tool modules stop
  importing the aggregator

### Wave 3 - complexity decomposition

- W3a: split `src/core/search/search.ts` (worst MI in the tree) into
  focused modules along its existing internal seams

### Explicit non-goals (follow-up candidates, not this branch)

- Decomposing `policy.ts`, `preference.ts` (fan_in 37 and 34 - high blast
  radius, deserve their own reviewed plans)
- Decomposing `store.ts`, `dream.ts`, `doctor.ts`, `cli/search.ts`
- Behavior or API changes of any kind

## Verification

- `bun run validate` green after every wave
- `code-ranker report` re-run at the end; cycle count for touched
  components must be zero and no file's MI may regress
