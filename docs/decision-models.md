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

## Quick start

1. **Get a key** from a supported provider (see the presets below) and export
   it as an environment variable in the environment that runs Open Second
   Brain, for example `TYPESAFE_API_KEY`. The config holds only the
   variable's name.
2. **Add the minimal config** to the machine config
   (`~/.config/open-second-brain/config.yaml`), outside the vault:

   ```yaml
   decision_model_enabled: "true"
   decision_model_provider: typesafe
   decision_model_env_key: TYPESAFE_API_KEY   # the variable's name, not the key
   decision_model_uses: "rerank:shadow"
   search_rerank_enabled: "true"
   search_rerank_kind: decision-model
   search_rerank_top_k: "30"
   ```

3. **Verify** with `o2b decision-model check --ping`: it shows the status,
   the key variable (never the value), the modes and the processor, and
   sends one synthetic request that names the answering model.
4. **Measure in shadow.** `rerank:shadow` sends and records each request but
   returns today's order. After some use, `o2b decision-model report` shows
   how often the decision order agrees with the heuristic one, and
   `o2b search rerank-eval --dataset queries.json --kind decision-model
   --compare-local` compares rerank off, the decision model and the local
   reranker over labelled queries (see "Measuring before enforcing").
5. **Enforce** only when the numbers justify it: change the use to
   `decision_model_uses: "rerank:enforce"`.

It pays off only with a semantic lane (`embedding_provider` set, `local` is
enough); see "When it pays off". Each request sends the query and the top
candidates, masked, clipped and redacted, never private pages or `<private>`
regions ("Privacy" below). It costs about $0.0003 per query at top_k 30, and
`decision_model_cost_gate_usd` (default `0.50` per UTC day) stops sending once
the day's spend reaches it ("Accounting"). A vault opts out with
`decision_model: { enabled: false }` in `Brain/_brain.yaml` ("Vault opt-out").

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
   default name) is set to a non-empty value. The one exception is a
   self-hosted `laya` or `openjev` server on a loopback address, which needs
   no key because nothing leaves the machine
   ([providers](decision-models/providers.md)).

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
| `decision_model_id` | pinned model id; overrides the preset. A moving alias such as `jev-latest` is refused. It plays the part `search_rerank_model` and `embedding_model` play for those features; the key is named `_id` because the value must pin a version | from preset |
| `decision_model_env_key` | **name** of the env var holding the key (`A-Z`, `0-9`, `_`); anything else, such as the key itself, makes the config invalid and is never printed | from preset |
| `decision_model_allow_insecure_http` | allow plain `http://` to a non-loopback host; config or env only | `false` |
| `decision_model_timeout_ms` | per-request timeout for MCP and CLI paths | `3000` |
| `decision_model_hook_budget_ms` | sub-budget for the `recall_inject` hook use: the request gets `min(this, remaining retrieval budget)` and never extends the hook's 2,500 ms total (see [the recall-inject hook filter](decision-models/recall-inject.md)) | `700` |
| `decision_model_max_state_tokens` | client-side state cap, clamped to the preset maximum | preset, at most `32000` |
| `decision_model_uses` | `use:mode` comma list, mode `off`, `shadow` or `enforce` | every use `off` |
| `decision_model_cost_gate_usd` | stop sending once today's (UTC) spend reaches this; `0` turns the gate off. Named like `embedding_cost_gate_usd` | `0.50` |
| `decision_model_input_price_usd_per_mtok` | price for routes that do not report cost | from preset |
| `decision_model_output_price_usd_per_mtok` | output price, read only for `llm-emulation`, whose cost is `unknown` unless both prices are set | none |
| `decision_model_allow_uncalibrated` | allow an uncalibrated provider in `enforce` | `false` |
| `decision_model_threshold_profile` | the model family a `compatible` server serves (`jev-1.13`, `laya`, `openjev`, `llm-emulation`), so its uses may enforce; ignored for every other preset | from preset (none for `compatible`) |

Uses: `rerank`, `answerable`, `skills`, `extract_prefilter`, `dedup`,
`tension`, `labels`, `recall_inject`. Every use is implemented; each one is
`off` until you set it, and each has its own page (see "Uses" below).

Modes:

- `off`: no state is built and nothing is sent.
- `shadow`: the request **is sent** and recorded, and the deterministic result
  is returned unchanged. Shadow mode sends data.
- `enforce`: the use applies the answer within its own limits.

Presets (the hosted and `compatible` ones speak `POST <base>/v1/systemone`
and are calibrated; `vercel-evaluate`, the self-hosted `laya` and `openjev`
and the uncalibrated `llm-emulation` are described with every route's limits,
licence and data handling in [providers](decision-models/providers.md)):

| Preset | Base URL | Model id | Default key variable | Input price (USD / M tokens) |
|---|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai` | `jev-1.13.0` | `TYPESAFE_API_KEY` | 0.042 |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` | 0.042 |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | 0.042 (estimate) |
| `opencode-zen` | `https://opencode.ai/zen` | `jev-1.13` | `OPENCODE_API_KEY` | 0.042 |
| `compatible` | must be set | must be set | must be set | unknown |
| `vercel-evaluate` | `https://ai-gateway.vercel.sh` (`/v1/evaluate`) | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | 0.042 (estimate) |
| `laya` | `http://127.0.0.1:8000` | `english` | none needed on loopback | 0 |
| `openjev` | `http://127.0.0.1:3000` | `openjev` | none needed on loopback | 0 |
| `llm-emulation` | must be set | must be set | must be set | unknown |

`decision_model_base_url` must not carry `user:password@` credentials: the key
travels in a header, and a URL with credentials is an invalid config.

Each preset names a threshold profile. Every threshold is tuned against the
Jev 1.13 family (`jev-1.13`), which the hosted presets use; on any other
profile, and on a `compatible` server without
`decision_model_threshold_profile`, a use set to `enforce` runs as `shadow`,
and `check` says so. Measure a `compatible` model with the eval gate before
naming its family.

Example, a hosted route with the reranker in shadow:

```yaml
decision_model_enabled: "true"
decision_model_provider: openrouter
decision_model_env_key: OPENROUTER_API_KEY   # the variable's name, not the key
decision_model_uses: "rerank:shadow"
decision_model_cost_gate_usd: "0.50"
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

## Uses

Each use has its own mode in `decision_model_uses`, its own failure policy
and its own evaluation metric in `o2b decision-model report --use <use>`.
Context uses change what the host receives in `enforce` and fall back to
the deterministic result on any failure. Advisory uses only add a field
next to a deterministic proposal and omit it on any failure. No use ever
blocks a write or an answer, and no use writes to the vault.

| Use | Surface | Kind | What `enforce` changes | On failure | Page |
|---|---|---|---|---|---|
| `rerank` | search rerank stage (`search_rerank_kind: decision-model`) | context | reorders the head by relevance; unsent and invalid candidates keep their position | the heuristic order | below |
| `answerable` | `brain_search`, `brain_recall_gate`, `brain_context_pack` | advisory | nothing is reordered: the signal is surfaced and the verdict gains `decision_answerable`; the level and action never change | the field is absent | [answerable](decision-models/answerable.md) |
| `skills` | `skills_attach` | context | offers the decision subset or reorder of the BM25 shortlist | the BM25 offer | [skills](decision-models/skills.md) |
| `extract_prefilter` | `brain_extract_signals` and `o2b brain extract-signals` plan phase | context | leaves turns below the threshold out of the envelope; no envelope when every turn is below it | every turn is sent | [extract pre-filter](decision-models/extract-prefilter.md) |
| `dedup` | `brain_hygiene scan` dedup findings, doctor entity alias candidates | advisory | adds a verdict; a confident `different` is listed last, never hidden | the field is absent | [dedup and tension](decision-models/dedup-tension.md) |
| `tension` | `brain_tension verify`, `o2b brain tension verify` | advisory | adds a verdict; a confident `compatible` or `unrelated` is listed last | the field is absent | [dedup and tension](decision-models/dedup-tension.md) |
| `labels` | `brain_labels suggest`, `o2b brain label --suggest` | advisory | returns a suggestion per dimension; never assigns | `available: false` with the reason | [labels](decision-models/labels.md) |
| `recall_inject` | the prompt-time recall-inject hook | context | drops notes that would not help, or withholds the brief; never adds material | today's brief | [recall-inject hook filter](decision-models/recall-inject.md) |

In `shadow` every use sends and records its request and returns today's
result; for `labels` the suggestions are null and for `dedup` and `tension`
the listings are unchanged. `enforce` on a threshold profile without tuned
thresholds for the use runs as `shadow` (see [providers](decision-models/providers.md#threshold-profiles)).

Moving a use to `enforce` needs evidence from that use's report: a gain
against the deterministic baseline without a regression, and for
`extract_prefilter` zero regret. The `decision-model-setup` skill walks an
agent through setup, shadow measurement and turning a use off.

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
  put into the request.
- **`<private>` regions never leave.** They are stripped from every text. A
  rerank candidate is a search chunk, and a long region can be split across
  chunks, so a chunk may hold private text without either tag. The page's own
  regions are read, and a chunk that still shares a line with one of them
  after stripping is withheld, as is a chunk whose page cannot be read.
- **Ids and paths are masked.** Candidates travel as `P0..Pn`; the mapping
  stays in memory.
- **Text is clipped** to a per-use limit (900 characters per rerank
  candidate). A rerank candidate also carries its note title (clipped to 160
  characters) and, when the note declares them, its `status` and `updated`
  frontmatter values (40 characters each); no other frontmatter field is
  sent, and these fields pass the same private-region checks as the text.
- **Redaction.** The whole request body passes the shared egress guard
  (`redactForEgress`, registry id `decision-model-systemone`). Secret-shaped
  strings are redacted; a body the guard refuses is not sent at all. Nothing
  else is rewritten: e-mail addresses, home paths and names inside a
  non-private note are sent as they are. Mark such text `<private>` or the
  page `visibility: private` if it must stay on the machine.
- **Retention depends on the processor.** TypeSafe states it does not train on
  requests or responses, keeps data "as long as reasonably necessary" on
  standard accounts, and offers zero retention only by enterprise
  arrangement. Gateways (OpenRouter, Vercel, OpenCode Zen) add their own
  logging and retention terms. `o2b decision-model check` names the processor
  for the configured preset. The terms: TypeSafe
  <https://typesafe.ai/legal/privacy-policy>; OpenRouter
  <https://openrouter.ai/privacy> and its provider logging page
  <https://openrouter.ai/docs/guides/privacy/provider-logging>; Vercel AI
  Gateway <https://vercel.com/docs/ai-gateway/security-and-compliance/zdr>;
  OpenCode Zen <https://opencode.ai/legal/privacy-policy>. A self-hosted
  server on loopback keeps every request on the machine.
- **Shadow mode sends data.** A use in `shadow` sends exactly what it would
  send in `enforce`; only the returned result differs.
- **Non-English vaults.** Hosted decision models are strongest in English,
  while principles and notes are often written in the operator's own
  language. Evaluate each vault on its own shadow data, consider a
  multilingual self-hosted model, or keep the uses in `shadow`.
- Vault text may try to steer an answer. That is acceptable only because no
  decision authorises a write.

## Rerank kind `decision-model`

`search_rerank_kind: decision-model` reranks the top `search_rerank_top_k`
search candidates with one request: one relevance `noul` per candidate, in
`enforce` one injection `noul` per candidate (the passage contains
instructions addressed to an AI assistant), and, only while the `answerable`
use is not `off`, one `answerable` noul over all passages (see
[answerable](decision-models/answerable.md)). Each passage carries the note
`title`, its `status` and `updated` when declared, and the chunk `text`, so
an archived or older copy can be told from the current one. A chunk that
holds only a page's frontmatter has no body to judge: it is not sent and
keeps its position. The injection questions cost roughly 15-20 percent of a
request's input tokens; `shadow` does not ask them, because only an
enforced order surfaces the tag. It reuses the `decision_model_*` config;
`search_rerank_base_url`, `search_rerank_model` and `search_rerank_env_key`
are ignored for this kind, and `check` says so.

- `rerank:off`, or any configuration that is not active: the rerank stage is
  disabled, byte-identical to rerank off.
- `rerank:shadow`: the request is sent and recorded with both orders; the
  search result is the heuristic one, and the candidate pool is not widened.
- `rerank:enforce`: the head is reordered by relevance probability. Candidates
  that were not sent (private, unresolvable, part of a private region,
  frontmatter only, dropped for budget) and candidates with an invalid relevance answer keep
  their exact position. Nothing is added or removed; the tail is untouched.
- A candidate whose injection probability is 0.8 or more gets
  `decision_model_injection_suspected` in its `reasons`, also when its
  relevance answer is invalid. The flag is **advisory**: it never moves the
  candidate. Notes that discuss prompt injection are flagged about as often
  as real injection attempts, and real attempts already get a low relevance,
  so demoting flagged candidates made the ranking worse in measurement. The
  flag is per chunk, not per page.
- `search_rerank_min_score` applies to the relevance probability (0 to 1)
  for this kind, a different scale from the cross-encoder's score. Candidates
  below it keep their relative order under the ones above it.
- Any failure: the heuristic order, exactly as with rerank off. The failure
  is recorded; no warning and no `rerank_degraded` line is added to the
  search output. A search whose decision rerank degraded is not written to
  the query cache (`search_cache_enabled`), so the next search asks again
  instead of being served the heuristic order as the enforced one.

### When it pays off

The reranker can only reorder what search found. With a semantic lane
(`embedding_provider` set, `local` is enough) the candidate pool is wide and
the gain is large: on a 233-note test vault with 70 labelled queries, hybrid
search with the local embedder and `search_rerank_top_k: 30` went from MRR
0.500 to 0.887 and hit@1 0.357 to 0.871 (the bundled local reranker: 0.613
and 0.471), with p50 latency about 290 ms and about $0.0003 per query. With
keyword-only search the pool is usually 1 to 7 candidates and the gain is
near zero. `search_rerank_top_k: 30` is the recommended setting; 50 cost 66%
more with no gain, 5 was markedly weaker.

### Hooks

The recall-inject hook never runs the decision-model rerank kind; its own
use, `recall_inject`, with the sub-budget `decision_model_hook_budget_ms`, is
described in [the recall-inject hook filter](decision-models/recall-inject.md).

### Measuring before enforcing

Keep `rerank:shadow` for a while, then compare with `o2b decision-model report`
(shadow agreement) and the eval gate over a labelled dataset:

```sh
o2b search rerank-eval --dataset queries.json --kind decision-model --compare-local
```

The dataset is a `RecallBenchmarkDataset` (`{"queries": [{"id", "query",
"expected": ["path.md"]}]}`). The command reports hit@1, 3, 5 and 10 (up to
`--k`), hit@k and MRR for rerank off and for the chosen kind, with deltas,
per-query wins, losses and ties against off, and the gate's recommendation
(enable only on lift without a hit@k regression). For the decision-model kind
it also reports the run's `decision_model_call` records by outcome, their
cost and p50/p95 latency, so an arm whose requests all failed (and so equals
off) shows as failing. The decision-model arm always runs in `enforce`, so
every query sends its top candidates to the endpoint. Nothing
is enabled by default whatever the numbers are; switching to `enforce` is your
decision.

## Accounting

While active, each request writes one `decision_model_call` continuity record
(see `docs/observability.md`): use, mode, provider, answering model,
calibration, question and candidate counts, token counts, cost and its source
(`reported`, `estimated` or `unknown`), latency, outcome (`ok` or a degrade
reason) and a sha-256 of the redacted state, plus each use's evaluation
identifiers. For a rerank in `shadow` those are the heuristic and decision
orders as paths (the report's agreement needs them; a private page is named
`(withheld)`); in `enforce` only the permutation of head positions, so an
enforce record stays a few hundred bytes. Both carry `head_size`,
`withheld_count` (withheld by the privacy rules), `budget_dropped_count`
(dropped to fit `decision_model_max_state_tokens`) and `injection_suspected`.
A shadow record with `search_rerank_top_k: 30` is about 2 KB. A record never
carries the state, a passage or a question text.

Requests made by the eval gate carry `origin: "eval"` and the `--ping`
request is recorded as use `ping` with `origin: "ping"`. Both count toward
the daily cost gate (they are real spend) and toward the report's call and
cost totals, but never toward the shadow agreement.

The daily cost gate sums today's recorded `cost_usd` plus the estimated cost
of requests still in flight in the same process, so concurrent requests in
one process cannot all pass against the same spend. The day's total is read
from the log once and then kept current by the process's own records; it is
read again after a minute, so other processes' spend shows up with that
delay. Separate processes share only the recorded spend, so the gate is a
soft limit that the requests in flight elsewhere can pass by a few requests.
If the log cannot be read, the gate treats the spend as over the limit and
sends nothing; if a record cannot be written, the request still returns and
that spend is missing from the total.

A request only has a cost when the route reports one or a price is known.
With the `compatible` preset and no `decision_model_input_price_usd_per_mtok`,
a route that reports no `cost` never adds to the total, so the gate never
fires; `check` warns about it.

Degrade reasons: `cost_gate`, `budget`, `egress_refused`, `timeout`,
`network`, `invalid_reply`, `http_<status>`. An inactive configuration (no
key, the vault opt-out, an invalid value) is not a degrade: it sends nothing
and writes no record.

A retry happens at most once, on 408, 409, 429 or any 5xx, within the
timeout. A reply body larger than 1 MiB is an `invalid_reply`.

## Operator commands

- `o2b decision-model check [--ping] [--json]`: enabled state, provider, base
  URL, pinned model, the key variable's name and whether it is set (never the
  value), per-use modes as configured (with a warning when the feature is
  disabled, since every use then runs `off`), vault opt-out and any ignored
  `decision_model:` field in the vault's `_brain.yaml`, cost gate and today's
  spend, the processor. The hint names only what is missing. `--ping` sends
  one request over a synthetic state with no vault content, prints the
  answering model and latency, and records the request. Exit 1 only for a
  broken configured provider (invalid config, or a failed ping of an active
  one).
- `o2b decision-model report [--since <date>] [--use <use>] [--json]`: per
  use, calls, outcome mix, p50/p95 latency, input tokens, cost, and for the
  reranker the shadow agreement (top-1 agreement and top-5 overlap between the
  decision and heuristic orders, over ordinary `shadow` records only). With
  `--use`, the use's own evaluation report follows (JSON: `use_report`):
  offer-hit and needless-offer rates for `skills`, regret, drop and skip
  shares for `extract_prefilter`, verdict bands against the operator's later
  decisions for `dedup` and `tension`, acceptance for `labels`, level against
  advisory band and outcomes for `answerable`, and added latency and hook
  timeouts for `recall_inject`. Each use's page describes its metric.
- `o2b doctor --readiness` has a `decision_model` line for every install:
  `skipped` when off, without a key, or opted out (with how to proceed),
  `fail` for an invalid config, `pass` when active. It also names an ignored
  `decision_model:` field in the vault's `_brain.yaml`.

## Turning it off

Remove the use from `decision_model_uses`, set `decision_model_enabled:
"false"`, unset the key variable (a keyless loopback `laya` or `openjev`
server needs one of the other ways), or add the vault opt-out above.
