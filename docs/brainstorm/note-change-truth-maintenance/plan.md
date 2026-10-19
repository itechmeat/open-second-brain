# Note-change truth maintenance - implementation plan

Lanes are file-disjoint except where a Depends on names an upstream lane; the
extraction-call parameter (D2) lands after Lane 2's kernel commits. Every task:
failing test first, implement to green, refactor green, one conventional commit,
formatted and linted before the commit. Test runs use a throwaway HOME.

## Lane 1 - links and index freshness (F1 + F2)

### Task A1: minimal-spelling chooser
- **Files**: src/core/brain/link-graph/minimal-spelling.ts (new), tests/core/brain/link-graph/minimal-spelling.test.ts (new)
- **Acceptance**: `minimalSpellingFor(destinationRel, knownFiles)` returns the shortest of basename / suffix-less / full relPath whose exact-one resolution over knownFiles equals the destination; top-level basename beats nested (ladder rung 2); ambiguity returns the next-longer form, never a wrong one. Unit tests over nested and top-level populations.
- **Depends on**: none

### Task A2: ladder-agreement fixture
- **Files**: tests/core/brain/link-graph/minimal-spelling.test.ts (extended)
- **Acceptance**: a fixture builds a temp vault, indexes it, and asserts the chooser's spelling resolves through the store ladder (resolveLinkTargets) to the same document for every population shape in A1.
- **Depends on**: A1

### Task A3: retargetsFor emits minimal spellings
- **Files**: src/core/brain/notes/lifecycle.ts, tests/core/brain/notes/note-lifecycle.test.ts, tests/core/brain/notes/note-lifecycle-defects.test.ts
- **Acceptance**: on rename, a full-path inbound link is rewritten to the minimal resolving spelling; report field rewrittenSpellings records old->new form; deliberately updated pins: spelling-form preservation (note-lifecycle.test.ts:88-114) now asserts minimality; ambiguous destination still withholds (defects.test.ts:191-210 keeps its no-repair assertion only where the repair rule does not fire).
- **Depends on**: A1

### Task A4: third-party bare-name repair
- **Files**: src/core/brain/notes/lifecycle.ts, tests/core/brain/notes/note-lifecycle-defects.test.ts
- **Acceptance**: when a rename moves a bare spelling's carrier count from exactly one to several, existing links with that bare spelling are retargeted to the minimal unambiguous spelling of the pre-rename target; the pre-state comes from the counting probe; unprovable cases stay untouched; defects.test.ts:279-303 self-reference counting still holds.
- **Depends on**: A3

### Task A5: freshen force path
- **Files**: src/core/search/freshen.ts, tests/core/search/freshen.test.ts
- **Acceptance**: MaybeFreshenOptions gains force (bypasses the interval gate, keeps claim exclusivity, backoff and the writer-lock probe); interval 0 with force still refuses (config off means off); existing decideFreshen pins stay green.
- **Depends on**: none

### Task A6: post-write detached refresh
- **Files**: src/core/brain/notes/lifecycle.ts, tests/core/brain/notes/note-lifecycle.test.ts, tests/core/brain/notes/note-lifecycle-defects.test.ts
- **Acceptance**: an applied lifecycle write (move and delete arms) spawns one detached refresh through an injectable spawn seam via the deferred dynamic import; claim exclusivity prevents doubles; spawn failures never fail the write; contract doc sentences (lifecycle.ts:26-33) describe the claim; readIndexEvidence pins stay green; tests run with the freshen-off env and assert the seam was called with the force option.
- **Depends on**: A5, A4 (same file, sequential in-lane)

### Task A7: CLI/MCP report shapes
- **Files**: src/cli/brain/verbs/note-lifecycle.ts, src/mcp/brain/lifecycle-file-tools.ts, tests/cli/brain-note-lifecycle.test.ts, tests/mcp/note-lifecycle.test.ts
- **Acceptance**: the CLI and MCP results expose the new rewritten spellings and the refresh-claimed marker; shape tests updated.
- **Depends on**: A6

## Lane 2 - separator-tolerant anchoring (F3)

### Task B1: match-form generator
- **Files**: src/core/brain/entities/canonical.ts, tests/core/brain/entities/entities.canonical.test.ts
- **Acceptance**: a pure generator beside foldQuoteVariantsByClass expands one normalized form into separator-variant match forms (space/hyphen/underscore runs interchangeable; slug-prefixed form also matches at a path-segment boundary); MIN length rules preserved; identity keys untouched (quote-variant-fold and topic-key-quote-classes byte-stability pins stay green).
- **Depends on**: none

### Task B2: kernels adopt folded matching
- **Files**: src/core/brain/atomic-facts.ts, src/core/brain/fact-extract.ts, tests/core/brain/atomic-facts.test.ts, tests/core/brain/fact-extract.anchoring.test.ts, tests/core/truth/stated-claims.test.ts
- **Acceptance**: anchorEntityForms and entityAnchors match folded forms with both sides folded, Set-deduped, forms precomputed once per call; "ada lovelace" in text anchors "ada-lovelace" and "people/ada_lovelace" forms; existing exact-form pins extended, not weakened; precision cases ("canada" never anchors "ada") asserted explicitly.
- **Depends on**: B1

### Task B3: twins in sync
- **Files**: src/core/brain/truth/merge-guard.ts, src/core/brain/truth/contamination.ts, tests/core/brain/truth/merge-guard.test.ts, tests/core/brain/truth/contamination.test.ts
- **Acceptance**: the two inline re-implementations use the same generator; their tests updated in the same commit.
- **Depends on**: B2

## Lane 3 - link-derived attachment and relink (F4)

### Task C1: page-link to entity resolver
- **Files**: src/core/brain/intake/page-entity-links.ts (new), tests/core/brain/intake/page-entity-links.test.ts (new)
- **Acceptance**: given source page bytes and an entity-index accessor, returns the ordered list of canonical entity ids the page links to (extractWikilinks order), dropping withheld pages before returning (link-candidates precedent), and returns empty (never throws) when nothing resolves.
- **Depends on**: none

### Task C2: callers thread link-derived ids
- **Files**: src/core/brain/fact-extract.ts (optional parameter only), src/core/brain/ingest/ingest.ts, src/cli/brain/verbs/facts.ts, tests/core/brain/fact-extract.anchoring.test.ts (extended), tests/core/brain/ingest tests
- **Acceptance**: page-sourced extraction paths resolve link-derived entity ids server-side and pass them in; the persisted `entities:` union contains text-derived plus link-derived ids; a fact from a page linking an entity without naming it gains the anchor; first body-order link is the primary when both mechanisms match; session-sourced extraction without a page passes nothing and is unchanged. Depends on Lane 2's fact-extract.ts commits (kernel union site).
- **Depends on**: C1, B2

### Task C3: relink lane task
- **Files**: src/core/brain/maintenance/lane.ts, src/core/brain/maintenance/relink-anchors-task.ts (new), tests/core/brain/maintenance/relink-anchors.test.ts (new)
- **Acceptance**: fifth LANE_TASK recomputes anchors for page-sourced signals with the shipped rules, additive-only (existing anchors never removed), dry-run report by default with an apply flag, local reach only, never calls a model; lane registration test extended; report includes per-source added-anchor counts.
- **Depends on**: C2

## Integration

- **Integrator**: full gates on the merged branch (fmt, lint, mirrors, sync-version check, openclaw bundle with the CI Bun, targeted suites), disjoint-file ownership respected throughout; commit per atomic unit with `git commit --only <paths>`.
- **Acceptance for the wave**: every new test fails on the pre-fix code where applicable (regression discipline), full bun test suite green locally, no new runtime dependencies, acyclic-import ratchet green (deferred import only).
