# Recon: a search result that cannot say why it is empty (kanban t_3309a27a)

Read-only reconnaissance against `main` @ 29ea0099.

## Signals already computed and then discarded

Produced, typed, and serialized by nothing:

| Signal | Produced at | Type |
|---|---|---|
| `chainStop`, origins deliberately not searched | `search/cross-vault.ts:172`, declared `search/types.ts:871` | `{triggered, stoppedAfter, skipped[]}` |
| `secondPass`, a retry fired | `search/pipeline/outcome.ts:141`, declared `types.ts:853` | `{triggered,kind,reason,added,targetedTerms?}` |
| `capHit`, the rank cap truncated the pool | `pipeline/assemble.ts:224`, consumed at `:299-303` | boolean |
| `preVisibility` vs `visible`, rows dropped by filters | `pipeline/pool-filters.ts:143` | two counts |
| score-floor drop count | `assemble.ts:263` | implicit |

Neither `jsonForOutcome` (`cli/search/outcome-render.ts:108-146`) nor
`toolBrainSearch` (`mcp/search-tools.ts:882-925`) reads any of them.

Serialized only as free-form English in an untyped `warnings: string[]` threaded
from `search.ts:71`: no-compatible-embeddings, sqlite-vec unavailable, capability
blocked (already typed by `SEMANTIC_CAPABILITY_TIER`), provider unavailable
(already carries `classifyEmbeddingError(e).category`, stringified and thrown
away), empty query vector, structured lanes skipped, embedding-ABI drift (typed
`StampMismatch[]` flattened to a sentence), `hybrid_degraded`, rerank degraded,
FTS index silently rebuilt mid-query, unparseable validity, dropped event anchor,
access-event write failure, per-origin cross-vault failures.

`store/trigram.ts` is the sharpest case: `TrigramFault` is a closed union at
`:53-58`, `classifyTrigramFault:60` maps SQLite messages onto it, and
`degradeWarning:75` immediately destroys the type by interpolating it into a
sentence. The classification exists and is discarded at the last step.

Fully silent, nothing said at all: `fts.ts:77` (query tokenized to an empty FTS
match, the purest silent empty in the tree), `keyword-lane.ts:105` (expansion
derived zero terms), `:134`/`:143` (trigram prefilter skipped, two distinct
recall narrowings), `assemble.ts:263` (relevance floor), `pool-filters.ts:143`
(an owner-scope filter that removes every hit returns the same empty as a vault
with no match), `cache-slot.ts:171,181`, `candidate-signals.ts:143,228`
(`DEGRADATION_CODE.frontmatterUnreadable` already exists for exactly this and is
not used here, while `tools.ts:250` uses it correctly for the same condition),
`relational-arm.ts:83`, `query-shape.ts:69`, `assemble.ts:377`.

## Two answers already written, wired to one surface each

`assessRecallAdequacy` (`brain/recall-adequacy.ts:104`) returns a typed verdict
with closed `level`/`action` vocabularies and is never called from the search
path: only `brain_recall_gate` and `brain_context_pack` call it, and only when the
caller hands in scores it already has. `brain_search`, which owns the scores,
never computes it.

`brain/negative-recall.ts` already implements the empty-explains-itself contract:
`NEGATIVE_RECALL_STATE:115` is `not_found | unknown | did_not_happen`,
`NEGATIVE_RECALL_UNKNOWN_REASON:150` is `index-absent | index-stale |
coverage-divergent | coverage-unavailable | index-instant-unusable |
embeddings-incomplete`, with a digest-bound coverage receipt and reasons built
from identifiers and integers only (`:556-561`, `:595`, `:602`, `:626`, `:674`).
It reaches exactly one surface, through the private `assessNegativeRecall`
(`search-tools.ts:1071`). `brain_search`, `second_brain_query` and the CLI cannot
reach it.

## Envelopes

The MCP transport envelope is one place, `toolResult` (`mcp/server.ts:389`) and
`buildMcpToolResult:408`, both calling `assertOutputContract` first, so a new key
must be declared in the tool's `outputSchema` or a contract reader cannot see it.

`_meta` is used nowhere in `src/`. Do not introduce it: it would be a new channel
outside `assertOutputContract`.

Each handler builds its own literal, so there is no single assembly point, but
there is a proven pattern for exactly this problem: `explain-envelope.ts` returns
a record spread into both surfaces (`outcome-render.ts:145`,
`search-tools.ts:919`) and its docblock states the intent, that the CLI JSON
payload and the MCP response name the same keys with the same bodies. Copy that
seam.

`second_brain_query` is not a search tool: it is a page lister (`mcp/tools.ts:220-260`)
that already consumes `DegradationNotice` to fail closed on unreadable
frontmatter, and it has no `outputSchema`.

## The closed-vocabulary idiom

Const object plus union type, never `enum`. Canonical form at
`negative-recall.ts:115-143`: frozen object with camelCase keys and kebab wire
values, a membership array, and a type guard. Identical at
`core/integrity/degradation.ts:47-105`, whose docblock `:17-40` is the written
policy for why the vocabulary is closed. The exhaustive-switch precedent with no
default arm is `search/embeddings/presets.ts:202-217`.

The wire-side enforcement idiom is `RECALL_GATE_NEGATIVE_STATES`
(`search-tools.ts:437-440`): a surface declares in its `outputSchema` `enum` the
subset it can emit, so emitting an undeclared member fails the contract loudly.

Every such trio must register in
`tests/core/architecture/verdict-vocabulary-census.test.ts`.

## Recommended surface

One new module `src/core/search/retrieval-trail.ts` owning the vocabulary, the
type, the single English mapping and the envelope:

```ts
export const RETRIEVAL_DEGRADATION = Object.freeze({ ... } as const);
export type RetrievalDegradationCode = ...;
export const RETRIEVAL_DEGRADATION_CODES: ReadonlyArray<RetrievalDegradationCode>;
export function isRetrievalDegradationCode(v: unknown): v is RetrievalDegradationCode;
export interface RetrievalDegradation { code; lane; detail? }
export interface RetrievalTrail { retrieved; pool; degraded; empty? }
export function describeRetrievalDegradation(code): string;  // exhaustive, no default arm
export function retrievalTrailEnvelope(outcome): Record<string, unknown>;
```

`detail` follows the `negative-recall.ts` rule: identifiers and integers only,
never a provider message and never a filesystem path.

Assembly belongs in `pipeline/outcome.ts`, whose docblock already claims sole
ownership of `SearchOutcome` construction. Thread a `degraded` sink exactly
parallel to the existing `warnings` array created at `search.ts:71`; each lane
pushes a typed code beside the sentence it already pushes. No lane restructuring.
`trigram.ts` and `semantic-phase.ts:167` are nearly free because the
classification already exists; `chainStop`, `capHit` and `preVisibility` are free
because the values are already computed.

Both surfaces get it by spreading `retrievalTrailEnvelope` at exactly two call
sites, `outcome-render.ts:145` and `search-tools.ts:919`, with the code enum
declared in `SEARCH_OUTPUT_SCHEMA`. The MCP payload carries codes only; the CLI
human transcript is the only caller of `describeRetrievalDegradation`.

An empty result explains itself in `emptyOutcome` (`outcome.ts:43`) and in
`buildSearchOutcome` when nothing survived. If the trail is non-empty the empty is
attributable and the CLI renders the first code's sentence instead of a bare
"(no results)". If the trail is empty, the corpus statement is the answer and it
is already written: lift the private `assessNegativeRecall` into a shared probe
and call it only on the zero-result path, which keeps the non-empty path
byte-identical because that probe opens the index status and coverage.

## Adjacent defects worth the same pass

1. `chainStop` and `secondPass` are dead payload; `chainStop` is a degradation and
   belongs in the trail, so fixing it is free.
2. `cross-vault.ts:180` puts `(exc as Error).message` straight into `warnings[]`,
   which travels into MCP payloads. `trigram.ts:45-52` documents the opposite rule
   for the identical channel. Also an unchecked cast.
3. The result-row projection is duplicated with two different grammars
   (`outcome-render.ts:110-136` emits `start_line`/`keyword_score`,
   `search-tools.ts:883-903` emits `startLine`/`score_breakdown`), while
   `serialize.ts` exists to prevent exactly that and covers only cards and index
   status. Out of scope here, but the trail must not become the third copy.
4. `searchTelemetryGaps` (`search-tools.ts:944`) is a fourth free-string
   vocabulary answering the same question from the same outcome. Repoint it at the
   trail rather than leave two.
5. `SearchOutcome.total` is the ranked pool size, not the retrieved count
   (`types.ts:813-831`); the retrieved count is computed ad hoc at
   `search-tools.ts:837`. The trail should state both.

## Tests

Idiom A, real vault and a fault injected into SQLite:
`tests/core/search/trigram-degrade.test.ts`, `hybrid-degrade.test.ts`,
`semantic-degrade-quota.test.ts`, over `tests/helpers/search-fixtures.ts`.
Idiom B, a frozen literal outcome rendered twice with bytes compared:
`tests/cli/search-explain-trace.test.ts`, which is the exact idiom for proving a
new key is absent by default.
