# MCP context economy - preview-budget tool results + recall hints

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain exposes ~27 `brain_*` MCP tools. Several return large payloads when the vault is dense (`brain_search`, `brain_context_pack`, `brain_digest`, `brain_timeline`, `brain_concept_synthesis`, `brain_operator_summary`, `second_brain_status`, the weekly/monthly synthesis tools). The full payload is serialized into the MCP envelope's `content[0].text`, which the calling agent's host injects into the model context - flooding the context window with content the agent often does not need beyond the first few records. There is no way to get a bounded preview with the full result reachable on demand.

Separately, `brain_search`/`brain_query` return ranked results with no top-level cue about how the recalled set should be read, leaving the agent to infer relevance from raw rows.

## Scope

- A per-tool, opt-in `previewBudget` (character count) on `ToolDefinition`. Over-budget tool results, **on the MCP JSON-RPC path only**, return a bounded, valid-JSON preview envelope in `content[0].text` plus an `artifact_id`.
- A vault-local artifact store under `Brain/.artifacts/<run-id>/` that holds the full serialized payload (atomic write, secret-redacted, path-safe), with best-effort TTL pruning of stale run directories.
- A new read-only MCP tool `brain_artifact_get(artifact_id)` that returns the full stored bytes.
- A computed-at-recall-time `recall_hint` string on `brain_search` derived from result counts via a single English template - no stored text, no per-language tables. (Scoped to `brain_search` only: `brain_query` is a preference/topic aggregation, not a ranked result set, so the ranked-hint shape - searchType / score / top hit - does not fit it.)
- Budgets wired onto the known-large tools; agent-facing `instructions` updated to describe the preview/fetch protocol.

## Out of scope

- Semantic / projected previews (Variant 2) and a generalized budget middleware (Variant 3) - explicitly deferred; the chosen seam can host them later without rework.
- Cursor pagination of large results.
- Trimming `structuredContent` (kept full to preserve `outputSchema` contracts and programmatic consumers).
- Any budgeting on the CLI bridge - operator CLI output stays full.

## Chosen approach

Variant 1 (single-seam byte budget), refined per the orchestrator decision in `variants.md`:

The MCP dispatch path (`MCPServer.handleToolsCall`) validates the handler's full output against `outputSchema` (unchanged), serializes it, and if the serialized text exceeds the tool's `previewBudget`, it (a) writes the full text to the artifact store, and (b) returns an envelope whose `content[0].text` is a valid-JSON object `{preview_truncated: true, artifact_id, full_chars, bytes_preview, note}` where `bytes_preview` is the head slice of the full text capped to the budget (a string field, so the envelope always parses) and `note` is a fixed English instruction pointing the agent at `brain_artifact_get`. `structuredContent` remains the full, schema-valid object. The CLI bridge (`callTool` -> `toolResult`) is untouched and always returns the full payload.

`brain_artifact_get` resolves `artifact_id` through path-safety validation and returns the stored full text. Unknown / expired ids return a tool-level error envelope.

`recall_hint` is produced by a pure `deriveRecallHint(results, total)` helper and added as an optional top-level field (additive, non-breaking schema change).

## Design decisions

- **Seam at the MCP dispatch, not `toolResult`.** Budget is an agent-context concern; the CLI must print full output. Putting the wrap in `handleToolsCall` cleanly separates the two consumers of `toolResult`.
- **Preview is a JSON envelope with a string head-slice**, not a raw mid-record cut - always parseable, satisfies the "valid JSON" expectation of MCP text content.
- **`structuredContent` stays full** - zero `outputSchema` breakage, programmatic consumers unaffected. The artifact exists for text-only agents that only saw the preview.
- **Opt-in per tool.** A tool with no `previewBudget` behaves exactly as today (constraint). Budgets are applied only to the enumerated large tools.
- **Artifact id = short SHA-256 of the full text.** Deterministic, dedupes identical payloads, trivially testable, no clock/RNG dependence in the id itself.
- **Run id is per server process.** Generated at `MCPServer` construction (injectable for tests). Artifacts grouped under `Brain/.artifacts/<run-id>/` so a process's outputs prune together.
- **TTL pruning is best-effort at store construction** - delete run directories whose mtime is older than the TTL (default 24h). No daemon, matches the "no hidden process" convention. `Brain/.artifacts` is a dot-directory, so the vault walker already excludes it from indexing/search (same treatment as `Brain/.snapshots`).
- **Redaction reuses `redactRawOutput`** so stored artifacts never persist secret-shaped tokens that a tool happened to surface.
- **Recall hint built from numbers + a single English template.** Language-agnostic by construction; no locale tables. Absent (field omitted) when there are zero results.

## File changes

New:
- `src/mcp/artifact-store.ts` - write/read/prune, content-hash id, path-safety, redaction.
- `src/mcp/preview-budget.ts` - `buildPreviewEnvelope(fullText, budget, artifactId)` and the over-budget decision.
- `src/core/search/recall-hint.ts` - `deriveRecallHint`.
- Tests: `tests/mcp/artifact-store.test.ts`, `tests/mcp/preview-budget.test.ts`, `tests/mcp/artifact-get.test.ts`, `tests/mcp/preview-budget-dispatch.test.ts`, `tests/core/search/recall-hint.test.ts`.

Modified:
- `src/core/brain/paths.ts` - `BRAIN_ARTIFACTS_REL` + dir constructor + run-id/artifact-id validation.
- `src/mcp/tools.ts` - `previewBudget?: number` on `ToolDefinition`; register `brain_artifact_get`.
- `src/mcp/server.ts` - budget wrap in `handleToolsCall`; artifact store on the server instance.
- `src/mcp/brain-tools.ts` - `brain_artifact_get` handler; budgets on large brain tools.
- `src/mcp/search-tools.ts` - `recall_hint` on `brain_search` output + schema; budget.
- `src/mcp/pay-memory-tools.ts` - budgets where outputs can be large.
- `src/mcp/instructions.ts` - document the preview/fetch protocol for agents.
- `README.md`, `CHANGELOG.md`, `docs/` as needed.
- Existing tests touching tool tables / envelope shape, updated for the new tool + optional field.

## Risks and open questions

- **Risk: an over-budget envelope confuses an agent that expected the full text.** Mitigated by `instructions.ts` describing the protocol and by keeping `structuredContent` full.
- **Risk: artifact directory growth.** Mitigated by TTL pruning at construction; dot-dir excluded from sync/index. Acceptable since artifacts are ephemeral session scratch.
- **Open question: default budget value.** Start at 2000 chars per the source issue; confirm against real tool outputs during QA.
- **Open question: which exact tools opt in.** Resolve by measuring serialized sizes during implementation; enable on the demonstrably-large ones, leave small status/echo tools unbudgeted.
