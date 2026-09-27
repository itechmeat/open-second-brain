# Decision models (optional)

A decision model is a typed judgment model. Given a text `state` and a set of
questions, it returns one typed answer per question with probabilities and
never generates text. Three question types exist: `noul` (probability of yes),
`choice` (one of 1-255 options) and `score` (a position on 2-10 ordered
levels). All questions in one request share one read of the state.

Open Second Brain can use such a model to select more precisely among
candidates its own code produced. The first model of this class is Jev by
TypeSafe; its wire format, `POST <base>/v1/systemone`, is also served by
OpenRouter, the Vercel AI Gateway compatible route, OpenCode Zen and
self-hosted compatible servers.

The feature is **off by default** and stays off unless you turn it on
explicitly **and** provide a key. Without that, Open Second Brain behaves
exactly as it does without the feature: no network request, no record, and no
change in any tool, hook or CLI output. The only exceptions are the explicit
diagnostics that exist to describe the feature: `o2b decision-model check` and
the `decision_model` line of `o2b doctor --readiness`, which reports `skipped`
while the feature is off.

## How it fits "Open Second Brain never calls an LLM"

- **Judgment, not generation.** Every answer is an index into a list Open
  Second Brain built, or a probability. No text is accepted from a decision
  model; the worst failure is a worse selection, never invented content.
- **The deterministic result stays canonical** and is the fallback on every
  failure: timeout, network error, HTTP error (401, 402, 422, 429, 529 and so
  on), an invalid reply, an over-budget state, the daily cost gate, or the
  vault opt-out. A failed request is recorded in the accounting record and
  is otherwise silent: the output is the deterministic one. Inactive paths
  (a use set to `off`, a missing key, the vault opt-out, an invalid config)
  send no request and write no record at all.
- **Decisions never write to the vault.** They filter or reorder what is
  returned. Only an accounting record (identifiers and numbers, never text) is
  persisted.
- **No training on recorded answers.** Nothing in Open Second Brain trains,
  fine-tunes or distils a model on decision records, and the main hosted
  vendor's terms forbid training a model that imitates its outputs. Do not
  build that on the records either.

## When it is active

The feature is active only when **both** of these hold:

1. `decision_model_enabled: "true"` is set in your machine config (or
   `OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED=true`), and
2. the environment variable named by `decision_model_env_key` (or the preset's
   default name) is set to a non-empty value.

Everything else is off. A missing key is a normal state, not an error: it is
reported only by `o2b decision-model check` and the `o2b doctor --readiness`
line, together with how to set it. An invalid value (an unknown use, a bad
number) is also treated as off everywhere else; `check` names the key and
exits 1.

The key is never stored by Open Second Brain. The config holds only the
**name** of the environment variable, as with the embedding and rerank keys.

## Configuration

All keys live in the machine config file outside the vault. Each has an
`OPEN_SECOND_BRAIN_DECISION_MODEL_*` environment override (the key name after
`decision_model_`, upper-cased), which wins over the file.

| Key | Meaning | Default |
|---|---|---|
| `decision_model_enabled` | master switch | `false` |
| `decision_model_provider` | preset name (table below) | none |
| `decision_model_base_url` | overrides the preset's base URL | from preset |
| `decision_model_id` | pinned model id; overrides the preset. A moving alias such as `jev-latest` is refused | from preset |
| `decision_model_env_key` | **name** of the env var holding the key | from preset |
| `decision_model_allow_insecure_http` | allow plain `http://` to a non-loopback host; config or env only | `false` |
| `decision_model_timeout_ms` | per-request timeout for MCP and CLI paths | `3000` |
| `decision_model_hook_budget_ms` | sub-budget for hook uses (reserved for a later use) | `700` |
| `decision_model_max_state_tokens` | client-side state cap, clamped to the preset maximum | preset, at most `32000` |
| `decision_model_uses` | `use:mode` comma list, mode `off`, `shadow` or `enforce` | every use `off` |
| `decision_model_daily_cost_gate_usd` | stop sending once today's (UTC) spend reaches this; `0` turns the gate off | `0.50` |
| `decision_model_input_price_usd_per_mtok` | price for routes that do not report cost | from preset |
| `decision_model_allow_uncalibrated` | allow an uncalibrated provider in `enforce` | `false` |

Uses: `rerank`, `answerable`, `skills`, `extract_prefilter`, `dedup`,
`tension`, `labels`, `recall_inject`. This release implements `rerank` (and
carries the `answerable` question inside the rerank request); the others are
declared so later releases only add behaviour, and setting them has no effect
yet.

Modes:

- `off`: no state is built and nothing is sent.
- `shadow`: the request **is sent** and recorded, and the deterministic result
  is returned unchanged. Shadow mode sends data.
- `enforce`: the use applies the answer within its own limits.

Presets (all speak `POST <base>/v1/systemone` and are calibrated):

| Preset | Base URL | Model id | Default key variable | Input price (USD / M tokens) |
|---|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai` | `jev-1.13.0` | `TYPESAFE_API_KEY` | 0.042 |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` | 0.042 |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | 0.042 (estimate) |
| `opencode-zen` | `https://opencode.ai/zen` | `jev-1.13` | `OPENCODE_API_KEY` | 0.042 |
| `compatible` | must be set | must be set | must be set | unknown |

Example, a hosted route with the reranker in shadow:

```yaml
decision_model_enabled: "true"
decision_model_provider: openrouter
decision_model_env_key: OPENROUTER_API_KEY   # the variable's name, not the key
decision_model_uses: "rerank:shadow"
decision_model_daily_cost_gate_usd: "0.50"
search_rerank_enabled: "true"
search_rerank_kind: decision-model
search_rerank_top_k: "30"
```

A self-hosted compatible server on loopback (plain `http` is accepted on
`localhost`, `127.0.0.1` and `::1`):

```yaml
decision_model_enabled: "true"
decision_model_provider: compatible
decision_model_base_url: http://127.0.0.1:8080
decision_model_id: my-local-decision-model
decision_model_env_key: LOCAL_DECISION_KEY
decision_model_max_state_tokens: "4000"
decision_model_uses: "rerank:shadow"
```

## Vault opt-out

A vault can turn the feature off for itself in `Brain/_brain.yaml`:

```yaml
decision_model:
  enabled: false
```

A vault can only narrow. `enabled: true`, a use list, a mode or an endpoint in
that block is ignored with a warning; the machine config alone decides whether
the feature runs. A `_brain.yaml` that cannot be read keeps the feature off
for that vault.

## Privacy: what leaves the machine

Only while the feature is active and a use is in `shadow` or `enforce`:

- **Private pages never leave.** A candidate whose page carries the reserved
  `visibility: private` token, or whose visibility cannot be resolved, is not
  put into the request. `<private>` regions are stripped from every text.
- **Ids and paths are masked.** Candidates travel as `P0..Pn`; the mapping
  stays in memory.
- **Text is clipped** to a per-use limit (900 characters per rerank
  candidate).
- **Redaction.** The whole request body passes the shared egress guard
  (`redactForEgress`, registry id `decision-model-systemone`). Secret-shaped
  strings are redacted; a body the guard refuses is not sent at all.
- **Retention depends on the processor.** TypeSafe states it does not train on
  requests or responses, keeps data "as long as reasonably necessary" on
  standard accounts, and offers zero retention only by enterprise
  arrangement. Gateways (OpenRouter, Vercel, OpenCode Zen) add their own
  logging and retention terms. `o2b decision-model check` names the processor
  for the configured preset.
- Vault text may try to steer an answer. That is acceptable only because no
  decision authorises a write.

## Rerank kind `decision-model`

`search_rerank_kind: decision-model` reranks the top `search_rerank_top_k`
search candidates with one request: one relevance `noul` per candidate, one
injection `noul` per candidate (the passage contains instructions addressed
to an AI assistant), and, only while the `answerable` use is not `off`, one
`answerable` noul over all passages. It reuses the `decision_model_*` config;
`search_rerank_base_url`, `search_rerank_model` and `search_rerank_env_key`
are ignored for this kind, and `check` says so.

- `rerank:off`, or any configuration that is not active: the rerank stage is
  disabled, byte-identical to rerank off.
- `rerank:shadow`: the request is sent and recorded with both orders; the
  search result is the heuristic one, and the candidate pool is not widened.
- `rerank:enforce`: the head is reordered by relevance probability. Candidates
  that were not sent (private, unresolvable, dropped for budget) and
  candidates with an invalid answer keep their exact position. A candidate
  whose injection probability is 0.8 or more moves to the end of the head and
  gets `decision_model_injection_suspected` in its `reasons`. Nothing is
  added or removed; the tail is untouched.
- Any failure: the heuristic order, exactly as with rerank off. The failure
  is recorded; no warning is added to the search output.

### Measuring before enforcing

Keep `rerank:shadow` for a while, then compare with `o2b decision-model report`
(shadow agreement) and the eval gate over a labelled dataset:

```sh
o2b search rerank-eval --dataset queries.json --kind decision-model --compare-local
```

The dataset is a `RecallBenchmarkDataset` (`{"queries": [{"id", "query",
"expected": ["path.md"]}]}`). The command reports hit@k and MRR for rerank off
and for the chosen kind, with deltas and the gate's recommendation (enable
only on lift without a hit@k regression). The decision-model arm always runs
in `enforce`, so every query sends its top candidates to the endpoint. Nothing
is enabled by default whatever the numbers are; switching to `enforce` is your
decision.

## Accounting

While active, each request writes one `decision_model_call` continuity record
(see `docs/observability.md`): use, mode, provider, answering model,
calibration, question and candidate counts, token counts, cost and its source
(`reported`, `estimated` or `unknown`), latency, outcome (`ok` or a degrade
reason) and a sha-256 of the redacted state, plus each use's evaluation
identifiers (for a rerank, the heuristic and decision orders as paths). It
never carries the state, a passage or a question text. The daily cost gate
sums today's recorded `cost_usd`.

Degrade reasons: `no_key`, `disabled_by_vault`, `cost_gate`, `budget`,
`egress_refused`, `timeout`, `network`, `invalid_reply`, `http_<status>`.

## Operator commands

- `o2b decision-model check [--ping] [--json]`: enabled state, provider, base
  URL, pinned model, the key variable's name and whether it is set (never the
  value), per-use modes, vault opt-out, cost gate and today's spend, the
  processor. `--ping` sends one request over a synthetic state with no vault
  content and prints the answering model and latency. Exit 1 only for a
  broken configured provider (invalid config, or a failed ping of an active
  one).
- `o2b decision-model report [--since <date>] [--use <use>] [--json]`: per
  use, calls, outcome mix, p50/p95 latency, input tokens, cost, and for the
  reranker the shadow agreement (top-1 agreement and top-5 overlap between the
  decision and heuristic orders).
- `o2b doctor --readiness` has a `decision_model` line: `skipped` when off,
  without a key, or opted out (with how to proceed), `fail` for an invalid
  config, `pass` when active.

## Turning it off

Remove the use from `decision_model_uses`, set `decision_model_enabled:
"false"`, unset the key variable, or add the vault opt-out above.
