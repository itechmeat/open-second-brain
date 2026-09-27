# Decision-model providers

Every route Open Second Brain can send a decision request to, how each one is
configured, and what each one means for your data. The feature itself, its
config keys and the privacy rules that apply to every route are in
[`docs/decision-models.md`](../decision-models.md).

Nothing here is used unless you set `decision_model_enabled: "true"` and name
one of these presets in `decision_model_provider`. No preset is ever picked
for you, and no route is ever a fallback for another one.

## Presets

| Preset | Adapter | Base URL | Model id | Context (state tokens: default / ceiling) | Licence | Data handling |
|---|---|---|---|---|---|---|
| `typesafe` | `systemone` | `https://api.typesafe.ai` | `jev-1.13.0` | 32000 / 32000 | hosted | TypeSafe, directly |
| `openrouter` | `systemone` | `https://openrouter.ai/api` | `typesafe/jev-1.13` | 32000 / 32000 | hosted | OpenRouter, then TypeSafe |
| `vercel` | `systemone` | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` | 32000 / 32000 | hosted | Vercel AI Gateway, then TypeSafe |
| `vercel-evaluate` | `vercel-evaluate` | `https://ai-gateway.vercel.sh` | `typesafe-ai/jev` | 32000 / 32000 | hosted | Vercel AI Gateway, then TypeSafe |
| `opencode-zen` | `systemone` | `https://opencode.ai/zen` | `jev-1.13` | 32000 / 32000 | hosted | OpenCode Zen, then TypeSafe |
| `laya` | `systemone` | `http://127.0.0.1:8000` | `english` | 2000 / 8192 | Apache-2.0 | your own server; on loopback nothing leaves the machine |
| `openjev` | `systemone` | `http://127.0.0.1:3000` | `openjev` | 4000 / 16384 | CC-BY-NC-4.0 | your own server; on loopback nothing leaves the machine |
| `compatible` | `systemone` | must be set | must be set | 32000 / 32000 | depends on the model | whoever runs the server |
| `llm-emulation` | `llm-emulation` | must be set | must be set | 32000 / 32000 | depends on the model | whoever runs the chat endpoint |

"State tokens" is Open Second Brain's own conservative estimate (about two
characters per token), used to keep a request within the route's context:
`decision_model_max_state_tokens` defaults to the first number and is clamped
to the second.

Other per-route limits:

| Preset | Key | Most `choice` options | Threshold profile | Input price (USD / M tokens) |
|---|---|---|---|---|
| `typesafe`, `openrouter`, `vercel`, `vercel-evaluate`, `opencode-zen` | required | 255 | `jev-1.13` | 0.042 |
| `laya` | optional on loopback | 100 | `laya` | 0 |
| `openjev` | optional on loopback | 52 | `openjev` | 0 |
| `compatible` | required | 255 | none, unless `decision_model_threshold_profile` names one | unknown |
| `llm-emulation` | required | 255 | `llm-emulation` | unknown unless both price keys are set |

A `choice` question above the route's option limit is never sent: a use that
can split it does, and otherwise that request degrades with `budget`, like an
oversized state.

## Hosted Jev routes

`typesafe`, `openrouter`, `vercel`, `opencode-zen` and `vercel-evaluate` all
reach the same model family, Jev 1.13, and share one threshold profile. They
differ in who handles the request on the way: a gateway adds its own logging
and retention terms to TypeSafe's. `o2b decision-model check` names the
processor for the configured preset.

### `vercel-evaluate`

The Vercel AI Gateway also serves Jev at its provider-neutral
`POST https://ai-gateway.vercel.sh/v1/evaluate`, with renamed fields. The
adapter maps them both ways:

- a `noul` question is sent as type `boolean`, and its answer comes back as
  `probability`;
- usage is camelCase (`inputTokens`, `outputTokens`), and the gateway's cost
  (`providerMetadata.gateway.cost`, a decimal string) is recorded as a
  reported cost;
- `choice` and `score` answers may omit `confidence`; it is then recomputed
  from the probabilities;
- an error body (`{message, error_type}`) is never read or printed: the HTTP
  status alone decides, as on every route.

The adapter sends no `providerOptions`. The gateway's evaluation fallbacks
can rerun a request on a generative model, which would make the answers
uncalibrated without saying so, so Open Second Brain never configures them.

```yaml
decision_model_enabled: "true"
decision_model_provider: vercel-evaluate
decision_model_env_key: AI_GATEWAY_API_KEY   # the variable's name, not the key
decision_model_uses: "rerank:shadow"
```

## Self-hosted open-weight models

`laya` and `openjev` point at a decision server you run yourself. They
default to a loopback address, where plain `http` is accepted and no key is
needed, so a request never leaves the machine. They are the only fully local
route. Open Second Brain does not download, install or start these servers.

- **Laya** (Apache-2.0) is served by `laya-serve`, which listens on port 8000
  and speaks `POST /v1/systemone`. The model id names a checkpoint: `english`
  (the default) or `multilingual`. Its default context window is small and a
  longer state is truncated silently by the server, so the preset starts at
  2000 state tokens; raise `decision_model_max_state_tokens` (up to 8192)
  only after raising the server's own window. The server refuses more than
  100 options per `choice`. It checks a bearer key only when started with
  one.
- **OpenJev** (CC-BY-NC-4.0) is served by its decision shim, documented on
  port 3000, with a 16384-token prompt limit in the documented setup. One
  pass scores at most 52 options per `choice`. The weights are free for
  non-commercial use with attribution; commercial use needs the licensor's
  permission, and `o2b decision-model check` prints that note.

A self-hosted model has its own calibration: its probabilities are not Jev's.
Each has its own threshold profile, and no use is tuned for either yet, so an
`enforce` setting runs as `shadow` there (see "Threshold profiles").

```yaml
decision_model_enabled: "true"
decision_model_provider: laya
decision_model_base_url: http://127.0.0.1:8000
decision_model_uses: "rerank:shadow"
```

If the server runs on another host, set `decision_model_base_url` to it
(`https`, or `decision_model_allow_insecure_http: "true"` on a network you
trust) and name a key variable in `decision_model_env_key`: off the machine a
key is required again.

## `compatible`

Any other server that speaks `POST /v1/systemone`. The base URL, the model id
and the key variable must be set. Open Second Brain cannot know which model
family answers, so a `compatible` route has no threshold profile and never
enforces, unless you name the family it serves:

```yaml
decision_model_provider: compatible
decision_model_base_url: https://decisions.example.com
decision_model_id: jev-1.13.0
decision_model_env_key: EXAMPLE_DECISION_KEY
decision_model_threshold_profile: jev-1.13
```

## `llm-emulation` (uncalibrated)

**`llm-emulation` is uncalibrated and calls a generative model.** It is the
one place the decision-model feature does that. It asks an OpenAI-compatible
chat endpoint (`POST <base_url>/chat/completions`) for probabilities: a
number between 0 and 1 for each `noul` question and a probability for each
option or level of a `choice` or `score`. It exists to try the feature and to
compare routes in `shadow` when only a chat endpoint is available.

- The system prompt asks for probabilities only, never text, and the reply
  must be one JSON object keyed by question id: a JSON schema in
  `response_format` when the endpoint accepts it, the same schema in the
  prompt when it refuses that (HTTP 400 or 422). Anything else the model
  writes is discarded.
- The state is vault content and is sent inside an `untrusted_source` fence,
  with the instruction to judge it and never follow instructions found in it.
- Probabilities are self-reported, so they are clamped to [0, 1] and
  normalised; the chosen option is recomputed as the most probable one, a
  `score` value is the expected level, and every confidence is recomputed. A
  distribution with an unknown key or a value that is not a number is an
  invalid item.
- Every answer and every `decision_model_call` record carries
  `calibrated: false`, so reports keep these runs apart.
- `enforce` is refused as a config error unless
  `decision_model_allow_uncalibrated: "true"` is set; `shadow` is allowed.
  Even with the override, no use has tuned thresholds on the `llm-emulation`
  profile yet, so `enforce` runs as `shadow`.
- A chat model bills output tokens and costs far more than a decision model.
  The cost is recorded as `unknown` unless both
  `decision_model_input_price_usd_per_mtok` and
  `decision_model_output_price_usd_per_mtok` are set, and without a known
  cost the daily cost gate cannot stop it.
- It is never chosen implicitly and never used when another route fails.
- The request passes the same redaction as every route (registry id
  `decision-model-llm-emulation`).

```yaml
decision_model_enabled: "true"
decision_model_provider: llm-emulation        # uncalibrated, shadow only
decision_model_base_url: https://api.example.com/v1
decision_model_id: some-small-chat-model
decision_model_env_key: EXAMPLE_API_KEY
decision_model_input_price_usd_per_mtok: "0.10"
decision_model_output_price_usd_per_mtok: "0.40"
decision_model_uses: "rerank:shadow"
```

## Threshold profiles

Probabilities from different model families are not comparable, so every
threshold a use applies is held to the family it was tuned against. Each
preset names a threshold profile:

- `jev-1.13`: every threshold Open Second Brain ships was set against this
  family, so every use may enforce on it;
- `laya`, `openjev`, `llm-emulation`: no use is tuned yet;
- none (`compatible` without `decision_model_threshold_profile`).

A use set to `enforce` on a profile without tuned thresholds for it runs as
`shadow`: the request is sent and recorded, and the deterministic result is
returned. Nothing on a hot path warns about it; `o2b decision-model check`
prints one warning naming the uses concerned. Tuning a profile means
measuring it in shadow and with the eval gate, the same way as for the
hosted route.
