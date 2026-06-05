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
| `dream_stage` | `o2b brain dream stage|apply`, MCP `brain_dream` (since 1.0.0) | `action` (`stage`/`apply`), `run_id`, `proposals`, `sources`, `changed`; apply adds `new_unconfirmed`, `confirmed`, `retired` counts |

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
