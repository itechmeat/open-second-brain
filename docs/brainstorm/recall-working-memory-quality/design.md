# Recall & Working-Memory Quality Suite - composable recall tuning, graph densification, and self-pruning working memory

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain has a mature search/recall subsystem (explainable scores,
trust, threshold, reinforce, self-tuning grid) but four small gaps remain: recall
strategy is a single fixed point with no operator-selectable trade-off; link
suggestions come only from raw string matching, so entities that statistically
co-occur are never related; continuity working-memory records carry equal weight
forever regardless of use; and an agent opening a file gets no automatic surfacing
of prior work on that path. Each gap has a small, additive, deterministic fix that
shares structure with the others.

## Scope

Four additive units, each gated so OFF reproduces current behaviour byte-for-byte:

1. **Selectable recall profiles** - named presets `fast | balanced | thorough`
   expanding to a tuple of EXISTING knobs (candidate-pool multiplier, traversal
   depth, query expansion, fusion mode), reusing the axes `tuning.ts` already
   ranges over. CLI flag + MCP field. No profile selected = today's config.
2. **Language-agnostic co-occurrence auto-relate** - a dream/maintenance pass that
   scores canonical-entity co-occurrence with a document-frequency / PMI-style
   structural metric and emits derived link SUGGESTIONS. No NL word lists, no note
   mutation.
3. **Usage-driven working-memory decay** - a read-side deterministic decay weight
   for continuity records, computed from usage signals already recorded as
   `recall_telemetry` continuity records. Down-weights stale items at recall;
   never deletes or mutates a record.
4. **File-context recall** - a CLI verb + MCP tool that, given a file path, queries
   the existing search index (reusing `session-focus.ts` path-prefix biasing) for
   prior work touching that path, behind a file-size gate. No LLM.

## Out of scope

- Pluggable external recall-source registry (the other half of the prefetch-profile
  upstream task) - deferred as architectural.
- Mutating continuity records in place (they are append-only, immutable, deduped by
  `recordId()`); decay is strictly read-side weighting.
- Mutating note bodies to add co-occurrence links (suggestions only).
- Any new RRF arm, relational parser, or fusion-order change (that is a separate
  triage item, t_09b7ccea).

## Chosen approach

Consultant Variant 2 - two shared primitives, no orchestrator:

- **Primitive A - `resolveRecallProfile(name)`** (`src/core/search/profiles.ts`):
  maps a profile name to a knob tuple over the SAME axes as the self-tuning grid,
  so profiles and self-tuning stay coherent. Applied in `search()` next to the
  existing `applyTunedParameters` seam.
- **Primitive B - a usage-signal reader + deterministic weight helper**
  (`src/core/brain/continuity/usage-signal.ts` + a pure decay function): reads
  `recall_telemetry` records, derives per-source access frequency/recency, and a
  pure `decayWeight(signal, now) -> number in (0,1]` used by the continuity
  read-model to weight surfaced working-memory records.

Co-occurrence (Unit 2) is a dream-side PRODUCER that shares only the established
persistence convention (versioned + dataset-hashed + re-validated-on-read +
fail-soft, exactly like `tuning.json`); it never touches the read path. File-context
recall (Unit 4) is a standalone surface that reuses the existing `session-focus.ts`
path-prefix primitive rather than inventing biasing machinery.

### Deliberate scoping refinement of the consultant recommendation

The consultant placed the read-side adjuster for BOTH decay and file-context on the
hot `search()` public path. We keep Variant 2's two-primitive philosophy but scope
the read-side weight to where the candidates actually flow: decay weighting lives in
the continuity read-model (where working-memory records are surfaced), and
file-context recall is a separate surface over the search index. This keeps the
`search()` default path untouched (cheaper byte-identical proof, smaller blast
radius) - which directly addresses the consultant's own stated risk about widening
the search hot path. This is a scoping decision within Variant 2, not a different
variant.

## Design decisions

- **Profile vs self-tuning precedence.** When an explicit profile is selected it is
  applied as the base config; the persisted self-tuning grid point (opt-in) does NOT
  silently override an explicit operator profile - explicit intent wins over learned
  default. With no profile, behaviour is exactly as today. Documented and tested.
- **Profiles are fixed tuples, not free knobs.** Like the self-tuning grid, the
  preset values live in one table; nothing learned or user-supplied can leave the
  enumerated set. Unknown profile name = loud typed error, not a silent default.
- **Co-occurrence metric is structural.** Score = co-document-frequency normalised by
  per-entity document frequency (PMI-style), computed from the canonical-entity ->
  note incidence already available; no tokens, no language assumptions. A minimum
  co-document threshold and a top-N cap keep output bounded and deterministic.
- **Decay is pure and replayable.** `decayWeight` is a pure function of
  (access count, last-access age, now); identical inputs give identical output. The
  usage signal is derived, never persisted as a new mutable counter on the record.
- **File-context gate.** Size gate mirrors the mem0 source (default 1500 bytes),
  exposed as a config field; below the gate the tool returns an explicit empty
  result with a reason, not a fabricated hit.
- **Every unit flag-gated.** New config fields default to the value that reproduces
  prior behaviour; a byte-identical test asserts OFF == today for search and
  continuity read.

## File changes

New:
- `src/core/search/profiles.ts` - profile table + `resolveRecallProfile`.
- `src/core/brain/continuity/usage-signal.ts` - usage-signal reader + `decayWeight`.
- `src/core/brain/link-graph/co-occurrence.ts` - co-occurrence scorer + suggestion model.
- `src/core/brain/file-recall.ts` - file-context recall surface (search + session-focus reuse).
- CLI verbs under `src/cli/brain/verbs/` (recall profile passthrough on search; file-context; co-occurrence suggest).
- MCP tool(s) for file-context recall (and profile field on the search tool).
- Tests mirroring each module under `tests/core/...`, `tests/cli/...`, `tests/mcp/...`.

Modified:
- `src/core/search/types.ts` - add `recallProfile` resolved field (default null).
- `src/core/search/search.ts` - apply `resolveRecallProfile` at the existing config seam.
- `src/core/brain/continuity/read-model.ts` - apply decay weight when the flag is on.
- `src/core/brain/dream.ts` (or maintenance entry) - register the co-occurrence pass.
- `src/mcp/search-tools.ts` / tool registry - profile field + new tool; tool-count tests.
- `README.md`, `CHANGELOG.md`, `docs/mcp.md`, version manifests.

## Risks and open questions

- **Profile/self-tuning interaction** must be unambiguous and tested both ways
  (profile-only, self-tuning-only, both) - resolved by the precedence rule above.
- **Decay surfacing site** - confirm during TDD which continuity read path surfaces
  working-memory records (read-model.ts) so the weight is applied once, not twice.
- **Co-occurrence cost** - bound by min-co-document threshold + top-N; verify it
  stays within the dream-pass budget on a large vault.
- **MCP tool count** - adding tools changes the frozen count/name-list tests; update
  in lockstep (known from prior suites).
