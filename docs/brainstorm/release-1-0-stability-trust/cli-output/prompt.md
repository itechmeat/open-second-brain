You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic: Release 1.0.0 - Stability & Trust: API freeze, deprecation sweep, hardening. One PR ships five atomic units that together justify the first major version of Open Second Brain (a TypeScript/Bun memory plugin for coding agents: MCP server + `o2b` CLI over an Obsidian-compatible vault).

## Unit 1 (epic-level): API freeze and deprecation sweep

- Remove the 9 `deprecatedAlias(...)` MCP tools that survive from the token-diet pass (hidden from `tools/list` but still callable): brain_digest, brain_daily_brief, brain_morning_brief, brain_weekly_synthesis, brain_monthly_review (aliases of `brain_brief` views) and brain_attention_flows, brain_concept_synthesis, brain_timeline, brain_belief_evolution (aliases of `brain_analytics` views). A major bump is the only legitimate moment to drop them.
- Pin public contracts as frozen-under-semver and document the compatibility policy: MCP tool surface (77 tools), CLI verb tree, config keys + env vars, search index schema (v7) and its migration ladder, on-disk formats (`o2b.metrics.v1`, `o2b.tuning.v1`, continuity records, `Brain/` layout).
- Write a SemVer policy section (what counts as breaking for schemas and file formats) and an upgrade guide 0.x -> 1.0.0 listing every removed alias with its replacement.
- An `o2b doctor`-style check that flags clients/configs still relying on removed surfaces (e.g. a callable-name probe or docs-level guidance; the right mechanism is part of this brainstorm).

## Unit 2: Per-command timeout safeguard with output caps (kanban t_06784b8d, upstream:mirage)

Long-running operations (dream pass, reindex, bridge discovery, cluster materialization, maintenance lane, large sync) currently have no hang protection and no output caps. Upstream mirage added a CommandSafeguard: per-command timeout resolution (override -> command default -> global fallback), stream wrapper firing a timeout error, background jobs propagating exit 124, YAML-configurable max_lines/max_bytes caps. For Open Second Brain the analogue is a safeguard layer around the long-running brain/search operations (CLI verbs and MCP tools), with per-operation timeout defaults, a config surface, and graceful partial-result or clean-abort semantics.

## Unit 3: Staged dream pipeline - persisted proposal bundle with validate-before-apply (kanban t_ae8a8ec0, article: Hermes Dreaming)

Today `dream()` (src/core/brain/dream.ts, ~2200 lines) promotes inline with a dryRun preview (`brain_review_candidates`) and snapshot+rollback as the post-hoc safety net. The task: make each dream run able to produce a persisted on-disk proposal bundle (manifest, human-readable report, scanned sources, proposed mutations as data) that can be diffed, validated, applied, or discarded as a unit - with an explicit validate step that must pass before apply writes anything to live state. Stage-validate-apply over a discardable artifact raises trust in the self-improvement loop.

## Unit 4: User-configurable timezone for all LLM/user-facing timestamps (kanban t_2ccadc6a, upstream:tencentdb-agent-memory)

Storage stays UTC. `resolveTimezone()` already exists in src/core/config.ts (order: VAULT_TIMEZONE env -> `timezone` config field -> null) but is consumed only by the openclaw surface and pay-memory verbs. The task: route user-facing and LLM-facing timestamp rendering (briefs, digests, timeline, recall output, CLI verbs, MCP tool responses) through a presentation-layer conversion honoring the configured IANA timezone, with UTC fallback when unset. Internal storage, frontmatter, log headings, and run ids remain canonical UTC.

## Unit 5: Dual-output reports - human-readable plus machine-diffable snapshot (kanban t_00eece5d, article: Hermes as an Onchain Analyst)

Digest/synthesis surfaces (daily/weekly/monthly briefs, digest) return structured envelopes in-memory but persist no machine snapshot for run-over-run diffing. The task: from one run, emit the human-readable report plus a structured JSON snapshot of the same findings, so a later run can diff against the prior snapshot and report "what changed since last digest" deterministically. This extends the dashboard-ready `Brain/metrics/` contract shipped in v0.45.0 (schema-versioned, append-only JSONL, fail-soft readers).

# Project context

Open Second Brain - TypeScript on Bun. SQLite (bun:sqlite) search index with FTS5 + optional sqlite-vec. MCP server (stdio JSON-RPC) + `o2b` CLI. 4176 tests across 539 files; oxlint baseline 111 warnings / 0 errors; oxfmt formatter; tsc typecheck.

Recent commits:
6d09d3c feat: Link & Recall Intelligence Suite - alias resolution, bridge discovery, communities, recall benchmark, self-tuning (#77)
789e3e3 feat: Write-Time Integrity & Governance Suite - schema ontology, tier guard, secret custody, maintenance lane (#76)
c03d569 fix(hermes): root cli.py shim completes the upstream CLI discovery contract (#75)
a0054dd feat: Entity Truth & Self-Improving Dream Suite - claim ledger, outcome-aware dream, foresight (#74)
b16c37d feat: Time-Aware Recall & Activation Suite - usage-aware ranking, event-time recall, two-pass recovery (#73)

Related files:
- src/mcp/tools.ts (deprecatedAlias helper, ToolDefinition, hidden flag), src/mcp/brain-tools.ts (9 alias registrations, ~5500 lines), src/mcp/server.ts (hidden tools callable but unlisted)
- src/core/brain/dream.ts (dream() with dryRun), src/core/brain/review-candidates.ts (read-only preview), src/core/brain/snapshot.ts (post-hoc rollback)
- src/core/config.ts (resolveTimezone, discoverConfig), src/core/brain/time.ts (isoSecond/isoDate canonical UTC)
- src/core/brain/temporal/ (daily-brief.ts, weekly-brief.ts, period-common.ts), src/core/brain/digest.ts
- src/core/brain/metrics.ts (o2b.metrics.v1 append-only JSONL layer, fail-soft reader)
- src/cli/brain/verbs/maintenance.ts (lane: dream, reindex, bridges, clusters), src/cli/command-manifest.ts
- src/core/brain/doctor.ts (diagnostic surface)

Conventions:
- Deterministic core: no LLM calls in library code; derived artifacts are deterministic projections
- Fail-soft observability: metrics/telemetry failures never break the operation ("Metrics are observability, not correctness")
- Reviewable artifacts: generated files under Brain/ with frontmatter kind + generated_at, regenerated per run, hand-written files never touched
- Atomic writes (atomicWriteFileSync), O_APPEND single-line JSONL for append-only logs
- Run-level metrics into Brain/metrics/<surface>.jsonl with schema "o2b.metrics.v1"
- CLI verbs: exit 0 success/fail-soft skip, exit 1 operational failure (JSON {ok:false}), exit 2 usage errors (plain stderr)
- MCP tools: INVALID_PARAMS before environment checks, descriptions <= 300 chars, previewBudget envelopes
- Opt-in behavior changes behind config flags; a vault that enables nothing behaves bit-identically
- TDD with per-unit atomic commits

Constraints:
- No new external dependencies
- Breaking changes allowed ONLY for the 9 documented deprecated aliases; every other public surface must stay byte-compatible
- Storage timestamps stay canonical UTC everywhere (frontmatter, logs, run ids); timezone is strictly presentation-layer
- dream() public API stays backward compatible; the staged pipeline must not fork a second promotion engine (single source of truth for promotion logic)
- Safeguard layer must not wrap synchronous SQLite calls with fake async timeouts; honest cancellation points only
- New run-level surfaces publish o2b.metrics.v1 records
- Doc artifacts: docs/ directory, CHANGELOG one version per PR

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
