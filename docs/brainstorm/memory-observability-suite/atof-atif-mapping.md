# ATOF/ATIF mapping for Open Second Brain continuity records

**Status:** assessed - GO
**Task:** t_51959aeb (Memory Observability Suite)
**Specs matched:** ATOF event format (NVIDIA NeMo Agent Toolkit, `packages/nvidia_nat_atif/atof-event-format.md`, version family 0.x); ATIF v1.7 (harbor-framework RFC 0001)

## Why a mapping document first

Open Second Brain is a memory layer, not the agent loop. The trajectory it can faithfully export is not "agent thought, tool ran" but "turn happened, recall gate decided, context pack was served, receipts were written". The question this document answers: do ATOF and ATIF have room for that shape without abusing their vocabulary? Verdict: yes, with the deliberate interpretations listed below.

## Source material: continuity record kinds

| O2B kind | Content | Notes |
|---|---|---|
| `session_turn` | session_id, turn_id, role, text, text_hash | imported conversation turns |
| `session_summary_node` | depth, summary, source_record_ids | derived summary tree |
| `recall_telemetry` | host, mode, status, duration_ms, result_count, top_artifacts, gaps | opt-in per call |
| `gate_telemetry` | host, decision, reason, prompt_hash, prompt_chars | config-gated; raw prompt never stored |
| `context_receipt` | trigger, host, items, budget | opt-in per call |
| `pre_compact_extract` | extracted lines | explicit operation |
| `source_invalidation` | source ref, reason | always-on |

All records share `id` (sha-256 dedup), `createdAt`, `sourceRefs`, `private`/`redacted` flags, and (since this suite) `schema: o2b.continuity.v1`.

## ATOF mapping (JSONL event stream)

ATOF events require `kind` (`scope`/`mark`), `atof_version`, `uuid`, `timestamp`, `name`; scope events add `category` (closed vocabulary) and `attributes`, plus paired start/end sharing one `uuid`.

| O2B kind | ATOF shape | category | Rationale |
|---|---|---|---|
| `recall_telemetry` | `scope` start/end pair | `retriever` | the one record with a duration; start synthesized as `createdAt - duration_ms` |
| `gate_telemetry` | `mark` | `guardrail` | point-in-time decision |
| `context_receipt` | `mark` | `retriever` | snapshot of served context |
| `session_turn` | `mark` | `custom` (`category_profile.subtype: "o2b.session_turn"`) | turns are events to a memory layer, not scopes it owns |
| `session_summary_node`, `pre_compact_extract`, `source_invalidation` | `mark` | `custom` with subtype | derived/maintenance events |

Deliberate interpretations, all marked in event `attributes`:

- **Synthetic scope start**: O2B records one row per recall with `duration_ms`; the exporter back-computes the start timestamp. Events carry `o2b.synthetic_start: true` so consumers can tell recorded facts from interpolation.
- **Flat hierarchy**: `parent_uuid` stays null - the memory layer does not know the agent's call tree. Correlation rides `session_id` / `turn_id` attributes.
- **UUIDs** derive deterministically from the record `id` (UUIDv5-style sha-256 fold), so re-exports are reproducible and diffable.
- `atof_version: "0.1"`; the exporter emits the lowest version whose fields it uses.

## ATIF mapping (one JSON document per session)

ATIF v1.7 requires `schema_version`, `agent`, `steps[]`; steps require `step_id` (1-based), `source` (`system`/`user`/`agent`), `message`.

- One trajectory per `session_id`; records without a session are skipped by the ATIF renderer (they have no step ordering) - the export summary counts them.
- `session_turn` becomes a step: `role: "user"` maps to `source: "user"`, everything else to `source: "agent"`; `message` carries the turn text (already redaction-masked at write time).
- Memory-layer events (`gate_telemetry`, `recall_telemetry`, `context_receipt`) become `source: "system"` steps with `llm_call_count: 0` - the spec's explicit marker for deterministic dispatch - and the full payload under `extra.o2b`.
- `agent`: `{ name: "open-second-brain", version: <package version> }`; the memory layer is the recording agent, the host agent is unknown to it.
- Steps order by `createdAt`, then record id (the store's stable order); `step_id` re-numbers from 1.
- `subagent_trajectories` unused - O2B sessions are flat.
- `schema_version: "ATIF-v1.7"`.

## Privacy and redaction

The exporter consumes the continuity read-model, never the raw store:

- records flagged `private` are dropped before any rendering (the read-model default);
- payload text was redaction-masked at write time (`***REDACTED***`, `***PRIVATE***`) and the read-model never un-masks;
- `gate_telemetry` carries only `prompt_hash`/`prompt_chars` by construction - no raw prompt can reach an export because none is stored.

## Go / no-go

**GO.** Both formats accommodate memory-layer traces without vocabulary abuse: ATOF's `mark` + `custom` subtype carries every kind, scope pairs fit the one duration-bearing kind, and ATIF's `llm_call_count: 0` system steps are exactly the deterministic-dispatch shape O2B produces. The deliberate interpretations (synthetic scope start, flat hierarchy, memory layer as recording agent) are documented above and marked in the output itself.

Golden-file tests pin the exporter's output; this document records the spec revisions matched, so a future spec bump is a conscious re-assessment, not silent drift.
