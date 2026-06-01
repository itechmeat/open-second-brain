# Context Continuity & Receipts Suite - OSB-native context audit and recall continuity

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain already has strong recall, context-pack, pre-compress, session-import, artifact, and safety surfaces, but the exact context crossing the agent prompt boundary is still hard to audit after the fact. Long sessions also lose navigability once host runtimes compress older turns: derived facts and preferences survive, while the source turn ranges behind decisions, commitments, summaries, and repeated context are not exposed as a bounded drill-down graph. Operators need read-only, local, privacy-aware continuity tools that explain what was injected, what recall queries succeeded or failed, what session material was compacted, and how to recover exact source slices without flooding the model.

## Scope

- Shared append-only continuity record substrate for redaction-safe, source-linked, bounded JSONL records under the Brain vault.
- Prompt context receipts for `brain_context_pack` and `brain_pre_compress_pack`, with CLI/MCP list/show surfaces.
- Recall telemetry for search/context-pack/pre-compress calls, with view and summary filters for coverage, cache, latency, top artifacts, and gaps.
- Pre-compaction extraction API/CLI that records typed decisions, commitments, outcomes, rules, and open questions from a bounded turn segment without blocking host compression.
- Session recall DAG foundation: raw imported session turns, deterministic summary nodes, search, describe, and expand with source lineage and pagination.
- Opt-in context transforms: cache-stable ordering, repeated-context deduplication with reference hints, and model-aware budget preset diagnostics.
- User-facing docs and version metadata for the new release.

## Out of scope

- Replacing Hermes-LCM or implementing a general conversation compression engine.
- Automatic promotion of extracted rules into confirmed preferences.
- Persisting raw private content in receipts by default.
- Automatically mutating `_brain.yaml`, runtime configs, or host MCP settings from context presets.
- Enabling cache-stable ordering, deduplication, receipts, or telemetry by default for existing callers.
- Cross-session deduplication or recall contamination across different agents/visibility scopes.

## Chosen approach

Use Variant 1 from the brainstorm: create a small shared continuity substrate and build feature modules on top. The substrate owns stable record IDs, hashes, timestamps, source references, redaction/private flags, JSONL append/read, pagination, filtering, and source invalidation markers. Feature modules remain responsible for their domain payloads: receipts describe injected context; telemetry describes recall operations; pre-compact extraction records durable session knowledge; session recall stores raw turns and summary nodes; context transforms shape emitted context only when explicitly requested.

## Design decisions

- **One substrate, typed payloads.** Use a closed `kind` union with kind-specific payload interfaces instead of separate stores per feature. This avoids duplicating redaction, pagination, and source-reference logic while preserving domain-specific validation.
- **Append-only JSONL plus derived helpers.** Store records in `Brain/log/continuity/YYYY-MM.jsonl` so they remain vault-local and inspectable. Indexes or summaries can be rebuilt from JSONL records; tests should not rely on hidden state.
- **Redaction-safe by default.** Receipts and telemetry store hashes, source IDs, snippets, counts, and reason metadata, not raw full prompt text. Any raw debug text requires an explicit local option and must carry `private: true`/redaction flags.
- **Opt-in integration.** Existing `packContext`, `buildPreCompressPack`, and search behavior remain unchanged unless callers pass receipt/telemetry/transform options or invoke new CLI/MCP verbs.
- **Deterministic session DAG first.** Initial session recall summaries are deterministic extractive summaries over imported turns and child nodes, not model-generated summaries. This gives source lineage, pagination, search, and tests without adding model dependencies.
- **Transform metadata is explicit.** Cache-stable ordering and dedup never hide relevance. Moved/deduplicated blocks keep `original_rank`, stable block IDs, previous-reference metadata, and diagnostics.
- **Preset diagnostics never apply.** Context presets expose `show`, `suggest`, and `diff` only. They return proposed config/env changes and override conflicts but do not write config.
- **Forget/source-purge is discoverable.** This release adds source-reference lookup/invalidation markers in the substrate. Destructive purge application remains a follow-up; the important contract is that receipts/telemetry/DAG/extractions can be found by source.

## File changes

Expected new files:

- `src/core/brain/continuity/store.ts` - append/read/filter/paginate continuity records.
- `src/core/brain/continuity/types.ts` - shared record and source-reference contracts.
- `src/core/brain/continuity/redaction.ts` - private-region stripping, snippet hashing, safe serialization helpers.
- `src/core/brain/context-receipts.ts` - receipt builders/list/show filters.
- `src/core/brain/recall-telemetry.ts` - telemetry record builders and summaries.
- `src/core/brain/pre-compact-extract.ts` - deterministic extraction from bounded turn segments.
- `src/core/brain/session-recall.ts` - raw turn ingestion, summary-node build, search/describe/expand.
- `src/core/brain/context-transforms.ts` - cache-stable ordering and repeated-context dedup primitives.
- `src/core/brain/context-presets.ts` - preset catalog, suggestion, diff diagnostics.
- Focused tests under `tests/core/brain/` and CLI/MCP tests as surfaces are added.

Expected modified files:

- `src/core/brain/context-pack.ts` - optional receipt/telemetry/ordering/dedup hooks and structured metadata.
- `src/core/brain/pre-compress-pack.ts` - optional receipt/telemetry hooks.
- `src/cli/brain/*` / verb registry/help - new read-only verbs.
- `src/mcp/brain-tools.ts` - read-only MCP tools for receipts, session recall, presets, and telemetry.
- `src/core/search/*` and/or CLI search wrapper - optional recall telemetry emission without changing results.
- `docs/cli-reference.md`, `docs/mcp.md`, `README.md`, `CHANGELOG.md`, package/manifests for release.

## Risks and open questions

- **Scope pressure:** a full LCM clone would be too large. Keep session summaries deterministic and bounded; model-assisted summarization can be a future extension.
- **JSONL growth:** continuity logs need filters and likely pruning later. This release should include bounded reads and summary filters, not a retention policy overhaul.
- **Privacy:** receipts and telemetry are valuable precisely because they describe prompt boundaries. Tests must assert raw private regions and secret-like content do not persist by default.
- **Search integration:** telemetry should not change search result contracts or cache keys unless explicitly enabled.
- **MCP tool count:** adding several read-only tools may affect tool-surface size. Prefer compact schemas and capability-aware docs; avoid duplicating CLI-only diagnostics unless useful to agents.
