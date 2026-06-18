## Variant 1
Approach: Add an optional containment-root parameter to `writeFrontmatter` and `writeFrontmatterAtomic` so the writers themselves call `ensureInsideVault` before `mkdirSync`/write, making containment a property of the single write primitive rather than each caller. Every existing caller keeps working unchanged (the parameter is optional and defaults to today's behavior).
Trade-offs:
- Closes the gap at the lowest, most-shared layer, so any current or future caller that passes the root is contained by construction (strong DRY, defense-in-depth at the chokepoint).
- An optional, default-off guard is a misleading fallback: the protection only exists for callers that remember to pass the root, so the signature changes without actually moving the invariant unless every call site is also updated — which inflates scope toward the "route everything" large case.
Complexity: medium
Risk: medium

## Variant 2
Approach: Introduce explicit `safeIdentifier`/`safePathSegment` helpers that whitelist structural character classes, reject `.`/`..`, and admit `@`/`+` (matching the upstream `sender_id` rule), then apply them at the boundaries where partly-caller-supplied identifiers become path segments and are not already run through `validateSlug`. Keep the whitelist language-agnostic (character classes, no wordlists).
Trade-offs:
- Sanitizes the untrusted input at the boundary where it enters, complementing the existing `validateSlug` and giving email/plus-addressed ids a first-class path (directly mirrors the upstream defense).
- High overlap with the existing `validateSlug`/`slugify` and `paths.ts` constructors risks two competing sanitizers; without a careful audit of which inputs are genuinely unguarded, this adds surface area and can violate DRY rather than hardening.
Complexity: medium
Risk: medium

## Variant 3
Approach: Treat the card as an audit-and-prove task: enumerate every direct vault writer (the `writeFrontmatter`/`writeFileSync`/`appendFileSync`/`mkdirSync` sites from the grep), confirm each already funnels through a `paths.ts` constructor or `ensureInsideVault`, and route the few that do not through the existing guard. Lock the invariant with TDD regression tests (traversal slugs, sibling-prefix, symlink-ancestor, absolute paths) at the chokepoints, changing no shared signatures.
Trade-offs:
- Smallest, reversible diff that fits patch scope: it hardens only genuinely-unguarded writers with the helper that already exists and turns the "agent writes only inside Brain/" invariant into executable, regression-proof tests.
- Does not add the email/plus-addressed identifier whitelist, so the upstream `sender_id`-style sanitization is deferred; if the audit finds writers are already centralized, the visible code delta is mostly tests rather than new mechanism.
Complexity: small
Risk: low

## Recommended: Variant 3
The codebase already has the right primitive (`ensureInsideVault`), the path constructors, and `validateSlug`, so the honest small-patch move is to verify the invariant holds everywhere and pin it with tests, routing only the stragglers through the existing guard rather than reshaping shared writer signatures. This avoids the misleading-fallback and DRY-duplication risks of Variants 1 and 2 while delivering real defense-in-depth value, and it leaves the optional-root writer change and identifier whitelist as cleanly-scoped follow-ups if the audit shows they are actually needed.
