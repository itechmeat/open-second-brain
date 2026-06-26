# Variants

Three approaches to shipping the three v1.18.0 review follow-ups together.

## Variant A - Minimal independent patches

Fix each site in isolation: add a second `catch`-branch heuristic in the CLI
verb only (string-match the error), special-case cards in the cross-vault
return, swap `in` for `Object.hasOwn` in the guard.

- **Trade-offs:** smallest diff; but the event-trace fix would be string/shape
  heuristics (fragile), would leave the MCP twin broken (a half fix), and would
  not share the classification.
- **Complexity:** small. **Risk:** medium (fragile heuristics; known broken twin).

## Variant B - Focused per-seam fixes with one shared error type (RECOMMENDED)

Classify event-trace selector errors once in the resolver via a typed error,
consumed by both the CLI verb and the MCP tool; flow cards through the existing
cross-vault union (not a parallel path); hoist the guard's exempt set.

- **Trade-offs:** fixes both event-trace entry points without duplicating
  format-validation; reuses the union's read-only invariants and chain-stop
  policy for cards; one cohesive change per concern.
- **Complexity:** medium. **Risk:** low.

## Variant C - Broader refactor

Introduce a generic `runVerb` error-policy wrapper for ALL brain verbs, and
generalize `searchAcrossVaults` to fold results and cards through one
collection-agnostic merge pipeline shared with single-vault `search()`.

- **Trade-offs:** most future-proof, but far exceeds three bug fixes; touches
  unrelated verbs and the single-vault path, inflating review and regression
  surface for a patch release.
- **Complexity:** large. **Risk:** high.

## Recommended: Variant B

It does each fix right (no known-broken twin, no fragile heuristics) while
keeping the diff scoped to a patch release. Variant A is rejected for shipping a
half fix; Variant C for scope creep disproportionate to three deferred bugs.
