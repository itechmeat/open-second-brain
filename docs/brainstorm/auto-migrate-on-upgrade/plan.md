# Auto-migrate on upgrade - implementation plan

## Tasks

### Task 1: lazy search self-heal on read
- **Files**: search read path (`src/core/search/search.ts` / store-open used by `brain_search` + `o2b search`), `src/core/search/store.ts`; tests under `tests/core/search/`.
- **Acceptance**: a query against an index whose `schema_version` != LATEST (or a missing index over a vault with content) transparently reindexes once and returns results instead of throwing `SCHEMA_MISMATCH` / not-initialised. A genuinely empty vault still returns empty, not an error.
- **Depends on**: none

### Task 2: ensureVaultCurrent maintenance pass
- **Files**: `src/core/maintenance/ensure-current.ts` (new); reuse `planUpgrade`/`applyUpgrade`, dir bootstrap, `reindexVault`; tests.
- **Acceptance**:
  - ensures Brain dirs exist (idempotent);
  - applies the brain managed-file upgrade when pending (snapshot + log), no-op otherwise;
  - detects a stale/missing search index and triggers a background reindex;
  - never throws; returns a structured report of what it did;
  - second run is a no-op.
- **Depends on**: Task 1 (shares the reindex trigger)

### Task 3: background, single-flight reindex trigger
- **Files**: small helper (detached reindex; skip if index lock held).
- **Acceptance**: returns immediately; does not block the caller; concurrent callers do not double-build (lock-guarded).
- **Depends on**: Task 1

### Task 4: wire into entry points
- **Files**: `src/mcp/server.ts` (boot), `hooks/active-inject.ts` (SessionStart).
- **Acceptance**: MCP server start invokes `ensureVaultCurrent(vault, { background: true })` best-effort; SessionStart hook does the same; neither delays startup nor throws.
- **Depends on**: Tasks 2-3

### Task 5: docs
- **Files**: `docs/updating.md`, `hooks/README.md` note.
- **Acceptance**: documents that updates are automatic (self-migrate on next start; no manual reindex / brain upgrade), and the state-driven (not synced-stamp) rationale as an invariant.
- **Depends on**: Tasks 1-4

### Task 6: QA + release
- `bun run validate` green (hermetic); fmt:check + lint clean.
- Smoke: stale-schema index -> first `o2b search` returns results; boot with pending brain upgrade -> applied.
- Version bump + CHANGELOG, PR, release per playbook.
