# Recall Control & Trust Suite - implementation plan

## Tasks

### Task 1: FTS safety foundation

- **Board task**: `t_38ec86bd`
- **Files**: `src/core/search/fts.ts`, `src/core/search/fts-safety.ts`, `src/core/search/store.ts`, `src/core/search/search.ts`, `src/core/search/types.ts`, `tests/core/search/fts.test.ts`, `tests/core/search/search.test.ts`
- **Acceptance**: Failing tests first show operator tokens in mixed natural queries currently over-constrain search and rebuildable FTS desync currently escapes as an uncontained SQLite error. Passing implementation drops standalone operator tokens only when meaningful tokens remain, retries one rebuildable FTS failure once, preserves programming errors, and emits a search warning when self-heal occurs.
- **Depends on**: none

### Task 2: Structured recall query documents

- **Board task**: `t_b25d9891`
- **Files**: `src/core/search/structured-query.ts`, `src/core/search/search.ts`, `src/core/search/types.ts`, `src/cli/search.ts`, `src/mcp/search-tools.ts`, `tests/core/search/structured-query.test.ts`, `tests/core/search/search.test.ts`, `tests/cli/search.test.ts`, `tests/mcp/search.test.ts`
- **Acceptance**: Failing tests first show CLI/MCP reject or treat query documents as plain strings. Passing implementation parses `intent:`, `lex:`, `vec:`, and `hyde:` lanes behind explicit CLI/MCP input, validates malformed lane syntax, preserves plain string behavior, degrades semantic lanes with warnings when semantic search is unavailable, and includes lane contribution reasons.
- **Depends on**: Task 1

### Task 3: Session focus steering

- **Board task**: `t_ff693b7f`
- **Files**: `src/core/search/session-focus.ts`, `src/core/search/ranker.ts`, `src/core/search/search.ts`, `src/core/search/types.ts`, `src/cli/search.ts`, `src/cli/brain.ts`, `src/mcp/search-tools.ts`, `tests/core/search/session-focus.test.ts`, `tests/core/search/ranker-reasons.test.ts`, `tests/cli/search.test.ts`, `tests/mcp/search.test.ts`
- **Acceptance**: Failing tests first show focus cannot be set or influence ranking. Passing implementation supports set/status/clear or equivalent explicit focus input, applies a bounded boost/demotion only for the selected session/query, reports focus contribution in reasons, and returns to baseline after clear/expiry.
- **Depends on**: Task 2

### Task 4: Retrieval surfacing gate

- **Board task**: `t_0e2f3a60`
- **Files**: `src/core/search/surfacing-gate.ts`, relevant hook/context-surfacing caller if present, `src/mcp/search-tools.ts` or hook diagnostics surface, `tests/core/search/surfacing-gate.test.ts`, integration test for the chosen caller
- **Acceptance**: Failing tests first show automatic surfacing callers do not distinguish greetings, slash commands, shell-only prompts, duplicates, and real memory questions. Passing implementation exposes a pure fail-open gate with explicit skip reasons, avoids invoking retrieval for skipped automatic surfacing, and leaves explicit `brain_search` unchanged.
- **Depends on**: Task 2

### Task 5: Polarity-aware context lanes

- **Board task**: `t_71942f88`
- **Files**: `src/core/brain/context-lanes.ts`, `src/core/brain/context-pack.ts`, `src/mcp/brain-tools.ts`, CLI context-pack wiring, `tests/core/brain/context-lanes.test.ts`, context-pack integration tests
- **Acceptance**: Failing tests first show context packs are flat and cannot separate constraints from directives. Passing implementation classifies deterministic negative/prohibition rules, honors a manual override, returns `directives`, `constraints`, and budget-capped `consider` lanes when requested, preserves source IDs/provenance, and keeps legacy flat output unless lanes are requested.
- **Depends on**: Task 3

### Task 6: Verified multi-record evidence packs

- **Board task**: `t_85581d59`
- **Files**: `src/core/search/evidence-pack.ts`, `src/core/search/search.ts`, `src/core/search/types.ts`, `src/cli/search.ts`, `src/mcp/search-tools.ts`, `tests/core/search/evidence-pack.test.ts`, `tests/core/search/search.test.ts`, `tests/cli/search.test.ts`, `tests/mcp/search.test.ts`
- **Acceptance**: Failing tests first show no opt-in mode can return complementary evidence across multiple records with missing-term diagnostics. Passing implementation returns evidence packs with matched/missing significant terms, support coverage, dropped-candidate reasons, explicit abstention for unsupported significant terms, terminal-state down-ranking, and existing `why_retrieved` detail in JSON from CLI and MCP.
- **Depends on**: Task 2

### Task 7: Documentation, changelog, and version release prep

- **Board tasks**: all selected tasks
- **Files**: `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, `package.json`, generated version sync targets
- **Acceptance**: User-facing docs describe new explicit flags/options and backward compatibility. `CHANGELOG.md` has one new version entry for the PR. Version sync check passes after the release version bump phase required by the operator.
- **Depends on**: Tasks 1-6
