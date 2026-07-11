# Metrics layer - the dashboard data contract

Since v0.45.0 every run-level pass in Open Second Brain reports its
numbers into one uniform, machine-readable layer under
`Brain/metrics/`. This document is the stable on-disk contract for
consumers - in particular the upcoming dashboard plugin - so they can
read metrics without importing Open Second Brain internals.

## Layout

One append-only JSONL file per surface:

```
Brain/metrics/
├── index.jsonl
├── bridge_discovery.jsonl
├── communities.jsonl
├── recall_benchmark.jsonl
├── self_tuning.jsonl
└── dream_stage.jsonl
```

Surface names are lowercase snake_case (`[a-z][a-z0-9_]*`, max 64
chars). A consumer reads only the files it renders; unknown files in
the directory must be ignored.

## Record envelope

Every line is one JSON object:

```json
{
  "schema": "o2b.metrics.v1",
  "surface": "recall_benchmark",
  "run_at": "2026-06-05T12:00:00Z",
  "payload": { "hit_at_k": 1, "mrr": 0.958 }
}
```

- `schema` - envelope version. Evolution rule mirrors continuity
  records: additive optional payload fields do NOT bump the version;
  renames, removals, or semantic changes bump to `o2b.metrics.v2`.
- `surface` - matches the file name.
- `run_at` - ISO-8601 UTC timestamp of the run the record describes.
- `payload` - surface-specific object (fields below).

Records are RUN-LEVEL: one line per index run, discovery pass,
benchmark, or tuning run. Per-query retrieval events stay in recall
telemetry (`docs/observability.md`). Writes are O_APPEND single
lines, so concurrent writers interleave instead of racing; readers
must skip torn or non-object lines (the bundled `listMetrics` reader
does). Keep payloads small (well under the platform pipe-buffer
size, ~4 KiB) - O_APPEND atomicity is only guaranteed for short
writes, and a metric record is a summary, not a report.

## Surfaces and payload fields (v0.45.0)

| Surface | Writer | Payload fields |
| --- | --- | --- |
| `index` | every non-empty index run | `added`, `updated`, `deleted`, `alias_resolved`, `relation_violations`, `tier_drift` |
| `bridge_discovery` | `o2b brain bridges discover`, MCP `brain_bridges`, maintenance lane | `proposals`, `scanned_candidates`, `vec_available`, `dismissed_total`, `min_similarity`, `max_proposals`, `lane` (lane runs) |
| `communities` | `o2b brain clusters run`, MCP `brain_clusters`, maintenance lane | `communities`, `sizes`, `written`, `removed`, `min_size`, `lane` (lane runs) |
| `recall_benchmark` | `o2b brain benchmark run`, MCP `brain_benchmark` | `total`, `k`, `expand`, `hit_at_k`, `mrr`, `misses` |
| `self_tuning` | `o2b brain tune run`, MCP `brain_tune` | `chosen`, `evaluated`, `best_mrr`, `dataset_hash` |
| `dream_stage` | `o2b brain dream stage` / `apply`, MCP `brain_dream` (since 1.0.0) | `action` (`stage`/`apply`), `run_id`, `proposals`, `sources`, `changed`; apply adds `new_unconfirmed`, `confirmed`, `retired` counts |
| `prompt_prefix` | decision-panel commit (opt-in `promptPrefixMetric`), context-pack consume (opt-in `promptPrefix`) | `kind` (`write_session`/`context_pack`), `prefix_hash` (sha-256 of the stable preamble), `prefix_chars`, `call_count`, `stable_count` |
| `vault_vitals` | `o2b brain vitals` | `preferences_scanned`, `domain_diversity`, `connectivity_index`, `orphan_count`, `gap_pressure` |

Payload fields marked "(lane runs)" appear only on maintenance-lane
emissions. All fields are additive-optional from a consumer's point
of view: render what is present, ignore what is unknown.

## Reading

- Newest records sit at the end of each file; the bundled reader
  (`listMetrics(vault, {surface?, since?, limit?})` in
  `src/core/brain/metrics.ts`) returns newest-first and merges
  surfaces when none is specified.
- External consumers (dashboards, scripts in other languages) should
  read the files directly: split on newlines, `JSON.parse` each line,
  skip lines that fail to parse or lack a string `surface`/`run_at`.
- Metric emission is fail-soft everywhere: a metrics-layer problem
  never fails the pass that produced the numbers, so gaps in a file
  mean the run failed or predates the layer - not data corruption.

## `prompt_prefix`: stability, not provider cache-hit rate

The `prompt_prefix` surface measures STRUCTURAL prefix stability - how
many generation handoffs in one pass led with byte-identical preamble
bytes (`stable_count` of `call_count`). It deliberately does NOT claim
to measure a provider's cache-hit rate: the kernel never calls an LLM,
so it cannot observe whether a provider actually reused a cached prefix.
What it can guarantee, and what this metric reports, is that the kernel
handed the agent a stable, cache-eligible prefix across the pass - the
precondition a provider prefix cache rewards. The raw prompt is never
stored; only the sha-256 hash and the code-point length of the prefix.

The genuine multi-call pass is the decision panel (every persona step
and the synthesis share the `Decision topic:` frame, so a fully stable
pass reports `stable_count == call_count == personas + 1`). A
context-pack consume is a single-call pass over its stable request
preamble. Both surfaces are opt-in and default off; the pass output is
byte-identical when the gate is unset.
