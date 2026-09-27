# Advisory `answerable` signal

Part of the optional [decision-model support](../decision-models.md). The
recall-adequacy verdict of `brain_recall_gate` and `brain_context_pack` is
score-based: a lexically strong result set that does not answer the question
still reads as `sufficient`. The `answerable` use adds a second, advisory
opinion from the decision model, at no extra request.

## Where the signal comes from

While rerank kind `decision-model` runs and the `answerable` use is `shadow`
or `enforce`, the one rerank request also asks whether the passages together
contain enough to answer the query. The answer is surfaced by search:

```json
"decision_model": {
  "answerable": { "probability": 0.12, "model": "jev-1.13.0", "calibrated": true }
}
```

`brain_search` and `o2b search <query> --json` add this field. It is absent
when the use is `off`, for any other rerank kind, when the feature is not
active (not enabled, no key, invalid config, vault opt-out), when the request
degraded, and when the answer was invalid. A search served from the query
cache carries the signal it was computed with.

Example configuration:

```yaml
search_rerank_enabled: "true"
search_rerank_kind: decision-model
decision_model_uses: "rerank:shadow,answerable:shadow"
```

## Passing it to the gate

Pass the probability to `brain_recall_gate` or `brain_context_pack` as
`decision_answerable`, together with the `scores` (`recall_scores` on the
pack) and `match_quality` of the same search. The argument is refused with
`INVALID_PARAMS` without that pair, or outside [0,1]; the schemas state the
dependency with `dependentRequired`.

With the use on, the verdict gains:

```json
"decision_answerable": { "probability": 0.12, "disagrees": true }
```

`disagrees` is true when the level is `sufficient` but the probability is
below 0.3, or the level is `insufficient` but the probability is above 0.8.
Both edges are strict, and `weak` never disagrees. The deterministic `level`
and `action` never change, in `shadow` or in `enforce`; for this use,
`enforce` only means the field is surfaced. Letting the signal change a level
needs evaluation data and a separate change.

Treat `disagrees: true` as a prompt to search again with other words, or to
say that the vault may not cover the question. A published claim-support
test found decision-model accuracy on par with an LLM judge while about a
quarter of unsupported claims were still let through, so the signal never
replaces the level.

With the use off, a `decision_answerable` the caller passed is ignored and
the response carries one warning,
`decision_answerable_ignored: the decision-model answerable use is off`.
Nothing else changes, and neither tool ever sends a request.

## Records

- The rerank `decision_model_call` record carries `answerable_probability`.
- With `recall_gate_telemetry` on, a gate call that carried
  `decision_answerable` while the use is on adds `adequacy_level` and
  `decision_answerable` (`probability`, `disagrees`) to its `gate_telemetry`
  record.
- A context-pack receipt stores `decision_answerable` next to its `adequacy`
  verdict. The unmet-recall demand log is unchanged.

Records hold numbers and closed values only, never the query or a passage.

## Report

The answerable report (`o2b decision-model report --use answerable`) shows:

- the rerank signal by band: low (below 0.3), mid, high (above 0.8);
- a confusion table of deterministic level against advisory band, over gate
  records and receipts that carried the field;
- for receipts with a `brain_context_pack_outcome` row on the same sample id,
  the share of poor outcomes (not a first-pass success, or a repair was
  required) when the signal disagreed against when it agreed. A clearly higher
  share on disagreements is the evidence a later change would need.
