# Recon: an advertised schema that documents itself only partly (kanban t_e24c6dbb)

Read-only reconnaissance against `main` @ 29ea0099. Scoped deliberately to two
halves: a CI guarantee of schema completeness, and naming an unknown argument back
to the caller. Per-caller filtering of `tools/list` is out of scope.

## What the guard enforces today

`src/mcp/registry-guard.ts` is test-time only. Two audits over one walk:
description caps (`TOOL_DESCRIPTION_MAX = 300`, `PROPERTY_DESCRIPTION_MAX = 160`
at `:21-22`) and preview-budget exemptions (`PREVIEW_BUDGET_EXEMPT:81-146`, a
frozen record of tool name to prose reason, audited three ways at `:168` so the
table cannot go stale).

`walkSchema:32` descends exactly two edges, `properties` and `items`, and fires
only on over-length descriptions. It does not care whether a description exists,
and it loses the distinction between a named property node and an array-items
node, which is precisely the distinction a completeness rule needs.

## The real numbers

Measured by importing `buildToolTable("full")`:

| Metric | Count |
|---|---|
| Tools advertised | 108 |
| Named property nodes, all depths | 635 |
| Array items schema nodes | 53 |
| Named properties with no or blank description | **59** |
| Tools carrying at least one gap | 13 |
| Tools with an empty description | 0 |

Every other completeness dimension is already clean at 108 of 108: root type is
object, `properties` is present, `additionalProperties` is false, every `required`
entry is declared, and every node carries a type or an enum. So the only currently
failing rule is the description rule, and the rest are free ratchets that lock in
a property nothing enforces today.

Thirty-two of the 59 sit in `src/mcp/search-tools.ts`. The rest are spread over
`ingest-tools.ts` (7), `generation-tools.ts` (7), `memory-bridge-tools.ts` (4),
`query-tools.ts` (3), `knowledge-tools.ts` (3), `calendar-tools.ts` (2),
`context-tools.ts` (1).

The 53 items nodes must be excluded by rule construction rather than by
exemption: the array property already carries the description, and demanding one
on `{type:"string"}` items produces 53 noise entries. Requiring descriptions on
named properties only yields exactly the 59 real gaps.

Verdict: a guard plus a 59-line backfill across seven files. An exemption table
for descriptions would be pure debt; do not build one.

## Unknown arguments are silently ignored today

`tools/call` (`server.ts:311-333`) validates only that `name` is a string and that
`arguments` is a non-array object, then hands the raw record to
`invokeToolHandler:160-185`, which calls the handler. No schema is consulted
anywhere between the wire and the handler, and handlers read the keys they know
and never enumerate `Object.keys(args)`. So `additionalProperties: false` is
declared on all 108 tools and enforced on none.

For `{"quiery": "x"}` on `brain_search` the caller gets a normal success envelope
computed from defaults, or an unrelated "missing required argument: query" if the
mistyped key was mandatory. The one place the unknown key is observed is telemetry
(`server.ts:180` records `argKeys`), which tells the caller nothing.

There is local precedent for the opposite discipline, hand-rolled per argument:
`brain_query` refuses `at` and `show_expired` outside topic mode rather than
ignoring them (`query-tools.ts:75,82`), and `recall-tools.ts:889-911` raises
"rather than a silently ignored filter".

## No string-distance helper exists

Nothing in `src/` implements Levenshtein, Damerau, Jaro or any edit distance.
`core/brain/similarity.ts:13-29` is word-set Jaccard, useless for `quiery` versus
`query`. `cli/argparse.ts:56` throws on an unknown flag with no suggestion. The
closest behavioural precedent is `mcp/hydrate-tool.ts:64-71`, which collects
unknown tool names and returns them rather than failing the batch.

So half (b) needs one new pure helper, and it should be generic and live in
`src/core/`, not `src/mcp/`.

## Recommended surface

Half (a), test time. Generalize the walker into a node stream so both audits share
one traversal, keyed by node kind, and add `auditSchemaCompleteness` returning
violations under a closed rule vocabulary (`missing-description`, `missing-type`,
`open-root`, `non-object-root`, `undeclared-required`, `unsupported-composition`).
`missing-description` applies to property nodes only. The unsupported-composition
rule matters: the walker silently skips `oneOf`/`anyOf`/`$ref` today, so a future
composed schema would quietly stop being guarded. Tests go in the existing
`tests/mcp/registry-guard.test.ts`, using its render-to-string idiom so a failure
names every offender, plus a negative test proving the guard can fail.

Half (b), request path. A pure helper `src/core/text/nearest-name.ts` with
`editDistance` and `nearestName(target, candidates)` returning undefined when
nothing is within a declared distance ratio, ties broken deterministically. Then
`src/mcp/argument-guard.ts` with `findUnknownArguments` and
`assertKnownArguments`, throwing `INVALID_PARAMS` naming every undeclared argument
with a did-you-mean where the distance supports one, and attaching structured
`data` (which `MCPError` already carries and `errorResponse` already forwards).

Wiring is one line: `assertKnownArguments` as the first statement of
`invokeToolHandler`, which covers both JSON-RPC `tools/call` and the CLI bridge
while leaving direct-handler unit tests untouched.

The two halves interlock rather than overlap: the runtime gate reads
`additionalProperties === false` from the schema rather than assuming it, and half
(a) is what guarantees the read never lands on an open schema.

Safety of making it a hard refusal: all 108 roots already declare the closure; the
only non-human payload builder is the Hermes provider, whose conformance suite
(shipped in 1.45.1) already proves it sends no unknown argument; and a scan found
zero keys read but never declared in `src/mcp`, and zero undeclared keys across 36
inline `tools/call` payloads in `tests/`.

Scope discipline: top-level closure only. Fifteen nested object nodes declare
`additionalProperties: false` that the gate will not enforce; state that in the
module header as a recorded limit rather than leave it as a second
declared-but-unenforced promise.

## Adjacent defects worth the same pass

1. `tests/mcp/skill-offer-tools.test.ts:141-146` duplicates the whole-table
   preview-budget assertion already made in `registry-guard.test.ts:31-39`.
2. `registry-guard.test.ts:43` inlines a magic minimum reason length; extract it
   next to the caps.
3. Two divergent string readers with incompatible blank-string semantics:
   `coerceStr(args, key, false)` treats whitespace as absent and returns the
   default (`coerce.ts:18-21`), while `optionalStringArg` throws on the same input
   (`brain/shared.ts:215-218`). Three error-message shapes coexist. The new error
   must pick the majority Brain-surface shape, and the divergence is worth a doc
   comment now and a separate unification unit later.
