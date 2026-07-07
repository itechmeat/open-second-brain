# Observability contract

Open Second Brain records what it did - learning events, recall decisions, served context, session activity - across a small set of file-based surfaces inside the vault. This document is the contract for anyone consuming those surfaces: which events exist, when they fire, what correlates them, what safety guarantees their payloads carry, and how the record shapes evolve. Everything here is verified against the source files named in each section.

## Surfaces at a glance

| Surface | Location | Writer | Format |
|---|---|---|---|
| Brain log | `Brain/log/<date>.md` + JSONL sidecar | `appendLogEvent()` in `src/core/brain/log.ts` | Markdown line + JSONL row per event |
| Continuity store | `Brain/log/continuity/<month>.jsonl` | `appendContinuityRecord()` in `src/core/brain/continuity/store.ts` | one JSON record per line |
| Session lifecycle audit | `Brain/log/session-lifecycle/` | `captureSessionLifecycleEvent()` in `src/core/brain/session-lifecycle.ts` | JSONL audit rows |
| Bench runs | `<runs-dir>/<run-id>/` (default `.open-second-brain/bench-runs/`, gitignored) | `runMemoryBench()` in `src/core/bench/phases.ts` | `checkpoint.json`, per-question results, `report.json` |
| Metrics | `Brain/metrics/<surface>.jsonl` | `appendMetric()` in `src/core/brain/metrics.ts` | one run-level JSON record per line (see `docs/metrics.md`) |

The `prompt_prefix` metric surface measures STRUCTURAL prompt-prefix stability (whether the kernel handed the agent a byte-stable, cache-eligible preamble across a generation pass), never a provider's cache-hit rate the kernel cannot observe. It stores only the SHA-256 hash and length of the prefix, never the raw prompt - the same payload-safety rule as `generation_report`. See `docs/metrics.md`.

## Brain log events

`appendLogEvent()` writes one human-readable line to the daily Markdown log plus a structured JSONL sidecar row. These events are always-on: each one is the audit trail of the operation that produced it, never optional telemetry. Kinds (from `BRAIN_LOG_EVENT_KIND` in `src/core/brain/types.ts`):

| Kind | Fires when |
|---|---|
| `dream`, `promote`, `retire`, `noted-redundant`, `signal-suppressed`, `skip-corrupted-frontmatter`, `reconcile` | the deterministic learning pass runs |
| `feedback`, `apply-evidence`, `force-confirmed`, `reject` | a taste signal or evidence event is recorded |
| `pin`, `unpin`, `rollback`, `merge`, `upgrade` | operator-facing vault maintenance |
| `scan-inline`, `import-session`, `import-claude-memory` | capture and import operations |
| `note` | a narrative milestone is recorded (`brain_note`) |
| `session-lifecycle` | a captured lifecycle event also produced Brain writes |

## Continuity record kinds

Every continuity record shares one envelope: `schema`, `id`, `kind`, `createdAt`, `sourceRefs`, `payload`, `private`, `redacted`. The table marks how each kind is gated - this is the always-on vs opt-in matrix, verified against the call sites named in the right column.

| Kind | Gate | Emitted by |
|---|---|---|
| `recall_telemetry` | opt-in per call (`telemetry` option/param) | `packContext` (`mode: context_pack`), `buildPreCompressPack` (`mode: pre_compress`), `brain_search` MCP handler (`mode: search`), `brain_query` MCP handler (`mode: query`, since v0.40.0 - payload carries the query kind only, never the supplied preference id / topic / timestamp) |
| `context_receipt` | opt-in per call (`receipt` option/param) | `packContext`, `buildPreCompressPack` |
| `gate_telemetry` | config key `recall_gate_telemetry` (default off) | `brain_recall_gate` MCP handler |
| `generation_report` | opt-in per call (`enable`) or config key `generation_trace_enabled` (default off) | inbound agent report after a generation handoff (`brain_generation_reports` action `record`, `o2b brain generation-reports record`) |
| `mcp_route_latency` | config key `mcp_route_metrics_enabled` (default off) | the MCP server's tool-call seam (`MCPServer.invokeToolHandler` in `src/mcp/server.ts`) - one record per `tools/call` and per CLI-bridge `callTool`; payload carries the tool name, scope, status, duration, and argument KEY NAMES only, never argument values |
| `session_turn`, `session_summary_node` | always-on within its operation | session-recall import (`src/core/brain/session-recall.ts`) - the write IS the operation |
| `pre_compact_extract` | always-on within its operation | explicit pre-compact extraction (`src/core/brain/pre-compact-extract.ts`) |
| `source_invalidation` | always-on within its operation | source drift detection (`appendContinuitySourceInvalidation`) |

Session lifecycle capture (`captureSessionLifecycleEvent`) writes audit rows and Brain log events but ZERO continuity records - that boundary is pinned by a regression test (`tests/core/brain/continuity-emit.test.ts`).

## Schema version and evolution rule

Since v0.39.0 every new continuity record is stamped `schema: "o2b.continuity.v1"` (`CONTINUITY_SCHEMA_VERSION` in `src/core/brain/continuity/types.ts`).

- Records written before the stamp existed carry no `schema` field; every reader treats `undefined` as v1. Existing JSONL files are never migrated.
- Additive optional fields do NOT bump the version. Renames, removals, or semantic changes bump to `o2b.continuity.v2`.
- The record id (`recordId()`, sha-256 over kind + createdAt + sourceRefs + payload) deliberately EXCLUDES the schema field, so identical records keep identical dedup ids across the stamp transition. Locked by a known-answer test.
- Consumers should go through the read-model (`src/core/brain/continuity/read-model.ts`), which absorbs the version dispatch, lifts `session_id`/`turn_id` into first-class fields, and applies the masking policy below.

## Correlation IDs

| Field | Where | Stable join? |
|---|---|---|
| `id` (`ctn_<stamp>_<sha16>`) | every continuity record | yes - content-hash dedup id |
| `createdAt` | every continuity record | ordering key (store sorts by `createdAt`, then `id`) |
| `sourceRefs[].id` / `.path` | continuity records | joins records to vault artifacts |
| `session_id`, `turn_id` | payloads of session-scoped kinds; lifted by the read-model | yes - the cross-surface session join |
| `handoffKind`, `handoffRef` | `generation_report` payload `handoff`; lifted by the read-model | yes - joins a generation report to the write-session / context-receipt / dream run it traced |
| `timestamp` + `agent` | Brain log events | per-event attribution |

Multi-agent vaults attribute writers via per-agent identity (`brain_agent_query`); continuity records do not yet thread parent/child agent ids - if delegated-subagent correlation becomes needed, it lands as an additive payload field (no version bump).

## Payload safety

Every continuity payload passes `safeContinuityPayload()` (`src/core/brain/continuity/redaction.ts`) before it reaches disk:

- `<private>...</private>` regions are stripped and replaced; the record is flagged `private: true`.
- Secret-shaped tokens are redacted to `***REDACTED***`; the record is flagged `redacted: true`.
- The sanitized payload is deep-frozen; nothing mutates it after the flags are computed.
- `gate_telemetry` never stores the raw prompt by construction - only a SHA-256 prefix (`prompt_hash`) and the length (`prompt_chars`). The test suite asserts this against the persisted files, not just returned values.
- `generation_report` follows the same rule: the handoff prompt is hashed and counted but never persisted - only `prompt_hash` (full SHA-256 hex) and `prompt_chars` land on disk, plus token counts. The kernel never calls an LLM; the report is the agent's INBOUND record after it performed a generation for a brain handoff, so the local token estimate (`local_estimate.input_tokens`) is always present while the agent-reported `usage` block is present only when supplied - absent is reported as absent, never fabricated. A grep-guarded regression test pins that no `fetch`/provider HTTP call exists under `src/core` for this feature, and a persisted-file assertion confirms no raw prompt survives.
- `mcp_route_latency` records the route (tool name), MCP scope, status, duration, and the sorted set of argument KEY NAMES only - the tool's own JSON-Schema property names, never operator-supplied argument values - so no prompt, note body, or preference id can land on disk. A persisted-file test asserts key names survive while values never do.
- Read-side consumers (trajectory export, bench) get the masking policy from the read-model: records flagged `private` are dropped by default and kept only on explicit request; masked text is never un-masked.

## Fail-open rules

Telemetry must never block or fail the primary operation. The guarantee is structural, not conventional: gated surfaces route through `emitGatedTelemetry(gate, build)` (`src/core/brain/continuity/emit.ts`):

- gate off (`undefined`/`false`/`null`): the build thunk is NEVER invoked - no payload object, no hash, no write on the no-consumer path;
- a throwing thunk or store write is swallowed and reported as `null`; the context pack, pre-compress pack, search response, and recall-gate decision all complete normally with the telemetry field simply absent.

No-consumer regression tests cover each gated surface, so a future call site cannot silently regress to eager payload construction. Writers whose continuity append IS the primary operation (session-recall import, pre-compact extract) stay fail-fast on purpose - failing silently there would lose user data, not telemetry.

## Reading the surfaces

- `brain_recall_telemetry` (MCP) and `o2b brain recall-telemetry list|summary|gate-list|gate-summary` aggregate recall and gate records.
- `brain_recall_telemetry` `operation: "cost"` (MCP) and `o2b brain recall-telemetry cost` fold WRITE volume against the read telemetry above: memory-write ops (Brain-log `feedback`/`apply-evidence`/`note` verbs plus `host_memory_write` continuity records) are counted per period and reported alongside reads as a write-vs-read ratio, a `write_heavy` flag, and a rough weighted cost signal. Weights (`--write-cost`/`--read-cost`, default 1 each) model "some tools charge on write, some on read"; `--write-heavy-ratio` (default 1) sets the write-heavy threshold. Read-only; period-scoped by `--since`/`--until`. `brain_create_note` file creation emits no telemetry event today and is not counted.
- `brain_context_receipts` and `o2b brain context-receipts` inspect served-context receipts.
- `brain_route_metrics` (MCP, `operation: "list"|"summary"`) reads route-level MCP tool latency. `list` returns raw `mcp_route_latency` records (filter by `tool`/`status`/`since`/`until`/`limit`); `summary` rolls each tool up into count, error count, and min/avg/max plus p50/p95/p99 latency, ordered slowest-first so an operator can identify which endpoint blocks an agent turn by route rather than by aggregate benchmark. Records are emitted only when `mcp_route_metrics_enabled` is on (default off); read-only.
- `brain_event_trace` (MCP) and `o2b brain event-trace` join the Brain log to the continuity store: given a logged event (by day, `--at` stamp, kind, or `--session-id`), they resolve the continuity records attached to it via the stable correlation ids above (`session_id`, `turn_id`, and artifact `sourceRefs`), so an operator can answer "which context was supplied to this action?" from one surface. Each attached record reports `joinedBy` (`session` / `turn` / `artifact`); open the full record through the per-kind readers (`context-receipts show`, `recall-telemetry`, `generation-reports show`). Read-only; `private` records are dropped unless explicitly kept.
- `brain_generation_reports` (MCP, actions `record`/`list`/`summary`) and `o2b brain generation-reports record|list|summary|show` post and read inbound LLM generation traces. `summary` rolls up call counts, the always-present local token estimate, agent-reported usage where present, and a per-path linkage map so a memory path resolves back to the generation reports that produced or consumed it.
- `o2b brain continuity export --format atof|atif` renders the store as standard trajectory formats (ATOF JSONL event stream; ATIF v1.7 one document per session) for replay and eval tooling. Read-only; `private` records never reach an export file. Mapping decisions: `docs/brainstorm/memory-observability-suite/atof-atif-mapping.md`.
- `o2b brain bench memory` measures recall quality over disposable fixture vaults and reports quality, latency, and context cost as separate families (`o2b.bench.v1` report schema).

Consumers should treat unknown record kinds and unknown payload fields as fine - skip what you do not recognize (the store and read-model already behave this way).
