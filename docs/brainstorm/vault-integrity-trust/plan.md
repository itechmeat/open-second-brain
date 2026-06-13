# Vault Integrity & Trust - implementation plan

Implemented one-by-one via TDD on branch `feat/vault-integrity-trust`. Each task is one atomic conventional commit. The identity core (Task 1) lands first; the others build on it or are independent.

## Tasks

### Task 1: Canonical NFC path identity (identity core + Unit 2)
- **Files**: `src/core/brain/note-path.ts`, `src/core/brain/content-hash.ts`; tests `tests/note-path.test.ts`, `tests/content-hash.test.ts`.
- **Acceptance**: a path differing only by NFC/NFD form resolves to one canonical identity and one content-hash key; already-NFC (Linux) inputs are byte-identical to today (idempotence test). No re-index churn for an NFD-vs-NFC path pair.
- **Depends on**: none.

### Task 2: Untrusted-source delimiter + structural neutralizer (Unit 1)
- **Files**: new `src/core/brain/untrusted-source.ts`; tests `tests/untrusted-source.test.ts`. Consumes Task 1's canonical identity for provenance.
- **Acceptance**: `wrapUntrustedSource(text, {path, sha256})` emits `<untrusted_source path="..." sha256="...">...</untrusted_source>` with nested delimiters escaped; neutralizer strips zero-width / bidi / C0-C1 control chars and defuses structural role-turn lines; ZERO natural-language word lists (grep test asserts no NL keyword arrays). Visible prose is preserved.
- **Depends on**: Task 1.

### Task 3: Wire delimiting into agent-facing assembly sites (Unit 1)
- **Files**: `src/core/brain/dream.ts`, `src/core/brain/deep-synthesis.ts`, `src/core/brain/pre-compact-extract.ts`; tests extend each site's suite.
- **Acceptance**: each site wraps untrusted note/source spans when the opt-in is set; default path is byte-identical to today (off-flag snapshot test). `sanitizePreCompactText` composes with the neutralizer without double-escaping.
- **Depends on**: Task 2.

### Task 4: File-watcher auto index sync (Unit 3)
- **Files**: new `src/core/search/index-watch.ts` (pure debounce/coalesce planner); new `src/cli/brain/verbs/watch.ts` (lifecycle); tests `tests/index-watch.test.ts` (planner, deterministic, no OS watcher).
- **Acceptance**: planner coalesces a burst of N events on M files into one pass per file-set within the debounce window; single-flight guard proves no overlapping passes; clean shutdown drains pending timers; verb errors clearly (not a silent no-op) where recursive watch is unsupported. Native `fs.watch` only - no new dependency.
- **Depends on**: none.

### Task 5: Graph side-indexes for O(1) stats/queries (Unit 4)
- **Files**: new `src/core/brain/link-graph/graph-index.ts` (memoized snapshot: name->node, (src,dst,type)->edge, node->degree, top-degree); `src/core/search/store.ts` (expose version + snapshot accessor); `src/core/brain/link-graph/communities.ts` (consume); tests `tests/graph-index.test.ts`.
- **Acceptance**: `detectCommunities` / `sharedEntities` read from the snapshot; results are byte-identical to the per-call-rebuild output (parity test against the old path); snapshot invalidates on store version change (stale-read test); no SQLite schema change.
- **Depends on**: none.

### Task 6: Agent-scoped recall isolation (Unit 5)
- **Files**: `src/core/search/types.ts` (`SearchOptions.agentScope`), `src/core/search/search.ts` (filter), `src/core/graph/visibility.ts` or sibling (owner read), `src/mcp/search-tools.ts` (surface option); tests `tests/agent-scope.test.ts`.
- **Acceptance**: a recall constrained to agent A never returns a note whose `owner:` is agent B and marked owner-private; absent `agentScope` is byte-identical to today; composes with `visibility` by intersection. Ownership read reuses the existing frontmatter parse path.
- **Depends on**: none.

### Task 7: Docs + version bump (same PR, per CLAUDE.md)
- **Files**: `README.md`, `CHANGELOG.md` (new `## [1.6.0]` heading + link-ref), `package.json` (1.5.0 -> 1.6.0), then `bun run scripts/sync-version.ts`.
- **Acceptance**: `bun run sync-version:check` passes; CHANGELOG version matches package.json; README documents the five opt-in capabilities.
- **Depends on**: Tasks 1-6.
