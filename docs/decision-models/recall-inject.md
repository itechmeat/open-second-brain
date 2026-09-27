# Decision models: the recall-inject hook filter

Use `recall_inject` of the optional decision-model feature (see
[Decision models](../decision-models.md)). It asks a decision model which of
the notes the prompt-time recall hook is about to inject would actually help,
and in `enforce` it drops the others or withholds the brief.

**This use adds a network call to every prompt** on which the hook would
inject, with `recall_inject_enabled: "true"` and the use set to `shadow` or
`enforce`. Hosted endpoints report roughly 100-500 ms per request from one
region; operators far from the endpoint see more. The brief is capped at 900
characters, so the token saving per prompt is small. Weigh the added latency
against fewer irrelevant injections before enabling it.

```yaml
recall_inject_enabled: "true"
decision_model_enabled: "true"
decision_model_provider: typesafe
decision_model_hook_budget_ms: "700"
decision_model_uses: "recall_inject:shadow"
```

## When it runs

- Only when the hook would inject. Abstentions (`empty_prompt`, `no_matches`,
  `below_floor`, `unmeasurable_quality`) and errors send nothing.
- One request per prompt. The state is the prompt (its `<private>` regions
  stripped, clipped to 2,000 characters) and the notes of today's brief,
  masked as `N0..Nn`, each clipped to 900 characters. The questions are one
  `helps_<k>` per note and one `inject_any` over all of them.
- Only notes of the active vault whose page visibility resolves without
  `private`, and whose text carries no part of a `<private>` region, are
  sent. Notes from other origins (profiles, recall sources, the shared
  namespace) are never sent. A note that was not sent keeps its place in the
  brief.
- The whole body goes through the same redaction as every decision request.

## Budget

The request gets `min(decision_model_hook_budget_ms, remaining retrieval
budget)`, where the retrieval budget is the hook's fixed 2,500 ms. The
sub-budget is passed to the provider as its timeout and is also enforced
around the call, so it never extends the 2,500 ms total. With no time left
after retrieval, nothing is sent.

The search the hook runs still skips the decision-model rerank kind: with
`search_rerank_kind: decision-model` the hook uses the heuristic order, so a
prompt carries at most this one decision request.

Measured with the real hook entry against a loopback fake server (default
sub-budget 700 ms, including process start): about 90 ms without the use,
about 135-175 ms with a server answering in 50 ms, and about 800 ms with a
server that takes 5 s (the request is cut off at the sub-budget and today's
brief is injected).

## Modes

- `off` (the default), or any configuration that is not active: the hook
  behaves exactly as without the feature. No request, no record, and no
  `decision_model` field in its telemetry or audit line.
- `shadow`: the request is sent and recorded; today's brief is injected
  unchanged. The `decision_model` fields report what `enforce` would have
  done.
- `enforce`:
  - `inject_any` below 0.2 withholds the brief with the abstain reason
    `decision_model_abstain`, but only when every note was sent (a note the
    model never saw cannot be judged by it);
  - otherwise a sent note whose `helps_<k>` is below 0.2 is dropped and the
    brief is rendered again with the same renderer and caps;
  - no note left withholds the brief with `decision_model_abstain`;
  - an invalid answer keeps its note.
  The decision can only drop notes or withhold the brief; it never adds
  material.

## Failure

Any failure (timeout, network, HTTP error, invalid reply, state budget, cost
gate, or the sub-budget running out) keeps today's `inject` decision. The
degrade reason appears only in the local hook audit line; the telemetry
record says `outcome: "degraded"`. The hook's fail-closed behaviour for
retrieval errors is unchanged.

## Accounting

- One `decision_model_call` record per request: `note_paths` (a note that may
  not leave the machine is named `(withheld)`), `helps` (per note, `null`
  when not sent or invalid), `inject_any`, `abstained`, `notes_dropped`,
  `withheld_count`, `budget_dropped_count` and `budget_ms`. Never the prompt
  or note text.
- The hook's `recall_telemetry` record and its local audit line gain an
  optional `decision_model` object (`mode`, `outcome`, `latency_ms`,
  `notes_dropped`, `abstained`); the audit line adds `degrade_reason` on a
  failure. See [Observability](../observability.md).
- In `enforce`, a brief that got shorter writes one `token_impact` sample
  (`method: heuristic`, `source: decision_model:recall_inject`) when
  `token_impact_ledger_enabled` is on.

## Evaluation before enforcing

Keep `recall_inject:shadow` for a while, then read `o2b decision-model report
--use recall_inject`: p50 and p95 added latency, timeout rate, abstain rate
and notes dropped, next to the hook's recall telemetry (decisions, retrieval
timeouts and hook ceiling exits) over the same window.

Move a machine to `enforce` only when both hold:

- p95 added latency is below `decision_model_hook_budget_ms`;
- hook timeouts (retrieval timeouts and hook ceiling exits) did not increase
  compared with the same period before the use was enabled.
