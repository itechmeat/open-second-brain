# Memory Integrity Suite - implementation plan

TDD order: each task starts with failing tests. Features land sequentially (entities -> log shards -> capture boundaries -> fact extraction) because the fact router consumes both the entity kernel and the boundary gate. Format + lint before every commit.

## Tasks

### Task 1: Entity canonicalization kernel and registry core
- **Files**: `src/core/brain/entities/{types,canonical,registry,index-builder}.ts`, `src/core/brain/paths.ts` (entities dir), `tests/core/brain/entities.canonical.test.ts`, `tests/core/brain/entities.registry.test.ts`
- **Acceptance**: normalize/identity-key/alias resolution pass property fixtures (NFC, case, whitespace); upsert refuses duplicate `(category, normalized name)` and duplicate alias claims; archive removes from active lookup, restore returns it; registry rebuilds identically from Markdown alone; files stay Obsidian-valid frontmatter.
- **Depends on**: none

### Task 2: Entity surfaces - CLI verbs, MCP read tool, doctor lints, search alias boost, graph relations
- **Files**: `src/cli/brain/verbs/entity.ts`, `src/cli/brain.ts`, `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`, `src/mcp/brain-tools.ts`, `src/core/brain/doctor.ts`, `src/core/search/search.ts`, `tests/cli/brain.entity.test.ts`, `tests/mcp/entity-tool.test.ts`, `tests/core/brain/doctor.entities.test.ts`, `tests/core/search/entity-alias.test.ts`
- **Acceptance**: `o2b brain entity set/get/list/relate/archive` round-trip with `--json`; `brain_entity` (view get|list) read-only, registry-guard caps green; doctor flags duplicate claims and broken relations; a query naming an alias boosts chunks naming the canonical entity and `why_retrieved` says so; relations appear in graph export through existing frontmatter-relations.
- **Depends on**: Task 1

### Task 3: Device identity and sharded log writer
- **Files**: `src/core/config.ts`, `src/core/brain/paths.ts` (shard helpers), `src/core/brain/log.ts`, `tests/core/config.device-id.test.ts`, `tests/core/brain/log-shards.write.test.ts`
- **Acceptance**: `device_id` generated once into device-local config, validated `[a-z0-9-]{1,32}`, never read from the vault; `appendLogEvent` writes `<date>.<id>.jsonl` + `<date>.<id>.md` under the existing per-dir lock; two writers with different ids never touch the same file; byte-deterministic output for fixed inputs.
- **Depends on**: none

### Task 4: Shard-merging readers and scanner refactor
- **Files**: `src/core/brain/log-jsonl.ts` (`readLogDay` merge, `listLogDates`), `src/core/brain/doctor.ts` (x2 scanners + `sync-conflict-log` lint), `src/core/brain/digest.ts` (x2), `src/core/brain/digest-agent-summary.ts`, `src/core/brain/temporal/build-index.ts`, `tests/core/brain/log-shards.read.test.ts`, golden-equivalence updates in existing log/digest/doctor tests
- **Acceptance**: merged read over legacy-only fixtures is byte-identical to pre-change output; mixed legacy+shard fixtures merge in (ts, shardId, line) order; all five scanners produce identical results through `listLogDates`; doctor warns on `.sync-conflict-*` files under `Brain/log/`.
- **Depends on**: Task 3

### Task 5: Capture-boundary config and matcher
- **Files**: `src/core/brain/policy.ts` (+ config template), `src/core/brain/types.ts`, `src/core/brain/capture-boundary.ts`, `tests/core/brain/policy.sessions.test.ts`, `tests/core/brain/capture-boundary.test.ts`
- **Acceptance**: `sessions.{ignore_patterns,stateless_patterns,ignore_message_patterns}` parse with per-key warnings (policy.ts conventions); glob matcher covers `*`/`?`/`**` anchored semantics; invalid message regex degrades to a warning and is skipped; machine-local config unions with vault policy; unconfigured vault behaves bit-identically to today.
- **Depends on**: none

### Task 6: Boundary wiring at both seams
- **Files**: `src/core/brain/session-lifecycle.ts`, `src/core/brain/sessions/import.ts`, `src/core/brain/doctor.ts` (`invalid-capture-pattern` lint), `tests/core/brain/session-lifecycle.boundary.test.ts`, `tests/core/brain/import-session.boundary.test.ts`
- **Acceptance**: ignored session produces no signals/log/markers, only counters in the audit row; stateless session reads fine but writes nothing; suppressed message text never reaches marker extraction and is never persisted; existing behavior unchanged when no patterns configured; counters surface in both result types.
- **Depends on**: Task 5

### Task 7: Regex fact extraction module
- **Files**: `src/core/brain/fact-extract.ts`, `src/core/brain/types.ts` (`source_type: extracted`), `tests/core/brain/fact-extract.test.ts`
- **Acceptance**: 7 pattern families extract from positive fixtures and reject negative fixtures (assistant text, code blocks, quoted speech); only `role: user` turns scanned; emitted signals carry `source_type: extracted`, family-scoped dedup hash, session ref; second run is a no-op (dedup).
- **Depends on**: none

### Task 8: Fact routing - live + batch wiring, entity anchoring, counters
- **Files**: `src/core/brain/session-lifecycle.ts`, `src/core/brain/sessions/import.ts`, `src/core/brain/fact-extract.ts` (router), `tests/core/brain/fact-extract.routing.test.ts`
- **Acceptance**: extraction runs only on turns that pass the boundary gate (pipeline order pinned by a test: suppressed input never extracts); a fact naming a registered entity or alias gets the canonical `entity_id` stamped in the signal note; `facts_extracted`/`facts_deduped` counters in capture and import results and audit rows.
- **Depends on**: Tasks 1, 6, 7

### Task 9: Docs
- **Files**: `README.md`, `CHANGELOG.md` (one v0.35.0 entry bundling the suite), `docs/` pages the design names
- **Acceptance**: every new surface (entity verbs, `brain_entity`, `sessions:` config, shard layout, extraction families) documented; CHANGELOG follows Keep a Changelog with the release narrative.
- **Depends on**: Tasks 1-8
