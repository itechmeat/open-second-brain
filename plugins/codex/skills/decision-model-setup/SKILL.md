---
name: decision-model-setup
description: Set up, evaluate or turn off the optional Open Second Brain decision-model feature (typed judgments that rerank search, pick skills, pre-filter extract-signals turns, filter recalled notes and annotate dedup, tension, label and answerable proposals). INVOKE when the user mentions decision models, Jev, TypeSafe, OpenRouter or Vercel decisions, the `decision_model_*` config keys, or after `o2b decision-model check` reports an error, a warning or a hint. SKIP when the user only asks conceptual questions about decision models or compares providers without intent to set up; answer those directly and change nothing.
---

# Decision-model setup

A decision model answers typed questions (yes/no probability, one of a
list, a position on a scale) about text Open Second Brain hands it, and
never generates text. Open Second Brain uses it only to choose among
candidates its own code produced: which search results come first, which
skills to offer, which transcript turns the host should mine, which
recalled notes to inject, and advisory verdicts next to dedup, tension,
label and answerable proposals. It never writes to the vault.

The feature is off by default. Without it Open Second Brain behaves
exactly as it does today and makes no network call. Full reference:
`docs/decision-models.md` (the hub, with the per-use table) and
`docs/decision-models/providers.md` (every route).

For a conceptual question ("what is Jev", "is this worth it", "which
route is cheaper") answer from the docs and change nothing. Walk the
steps below only when the user wants to set it up, measure it or turn it
off.

## Step 1: always start with `check`

```bash
o2b decision-model check
```

It prints the status (`disabled`, `no_key`, `disabled_by_vault`,
`invalid`, `active`), the provider and processor, the key variable's
NAME and whether it is set (never the value), every use with its
configured mode, the threshold profile, the uses whose `enforce` runs as
`shadow`, the daily cost gate, and a `hint:` line naming only what is
missing. Exit 1 means an invalid config or a failed ping; fix the named
key first.

## Step 2: pick a route

Ask the user which route they want; never pick one for them.

- **TypeSafe** (`typesafe`): the model vendor, directly.
- **OpenRouter** (`openrouter`): the same model through OpenRouter.
- **Vercel AI Gateway** (`vercel` for the compatible route,
  `vercel-evaluate` for the gateway's own evaluate endpoint).
- **OpenCode Zen** (`opencode-zen`).
- **Self-hosted on loopback** (`laya`, `openjev`, or `compatible` with
  `decision_model_base_url` on `localhost`, `127.0.0.1` or `::1`):
  nothing leaves the machine. `laya` and `openjev` need no key on
  loopback. Check the model's licence (`check` prints a licence note
  where the weights carry a restriction). Installing the server is the
  user's job; this skill does not download weights.
- **`llm-emulation`**: a generative chat endpoint asked only for
  probabilities. Uncalibrated, costs far more, and meant for `shadow`
  evaluation only. Never suggest it as the default.

A `compatible` server enforces nothing until
`decision_model_threshold_profile` names the model family it serves;
until then every `enforce` runs as `shadow`, and `check` says so.

## Step 3: the key, by name only

The key lives in an environment variable of the environment that runs
Open Second Brain (a shell profile, the host's env file, a secrets
manager). The machine config holds only the variable's **name**:

```yaml
decision_model_enabled: "true"
decision_model_provider: <preset>
decision_model_env_key: <VARIABLE_NAME>   # the name, never the key
decision_model_uses: "<use>:shadow"
```

- Never write the key into the config, the vault, a tracked file or the
  chat. Never echo it. Ask the user to set the variable themselves, then
  rerun `check`.
- The config lives outside the vault (the machine config); a vault's
  `Brain/_brain.yaml` can only turn the feature off, never on.
- Plain `http://` is accepted only on loopback. For another host without
  TLS, explain what `decision_model_allow_insecure_http` means (text and
  key cross the network unencrypted) before the user sets it.

Then verify connectivity with one synthetic request that carries no
vault content:

```bash
o2b decision-model check --ping
```

## Step 4: one use in shadow

Start with ONE use in `shadow`. Shadow sends and records every request
but returns today's result unchanged, so the user sees no difference yet.
Pick the use that matches what the user wants to improve:

- `rerank`: search ordering (needs `search_rerank_enabled: "true"` and
  `search_rerank_kind: decision-model`; pays off with a semantic lane).
- `answerable`: an advisory "can these results answer the question"
  signal, carried by the rerank request.
- `skills`: which skills `skills_attach` offers.
- `extract_prefilter`: which user turns the extract-signals envelope
  carries.
- `recall_inject`: which notes the prompt-time recall hook injects. It
  adds a request to every prompt that injects; mention the latency.
- `dedup`, `tension`, `labels`: advisory verdicts on proposals the
  deterministic detectors made (`brain_hygiene scan`, `brain_tension
  verify`, `brain_labels suggest`).

Each use has its own page under `docs/decision-models/`.

## Step 5: measure, then decide

After about a week of normal use, read the numbers:

```bash
o2b decision-model report --use <use>
o2b search rerank-eval --dataset <queries.json> --kind decision-model --compare-local   # rerank only
```

`report` prints the calls, outcomes, latency, tokens and cost, plus the
use's own evaluation metric. Recommend `enforce` only when that metric
shows a gain against the deterministic baseline without a regression.
For `extract_prefilter`, `enforce` needs zero regret (no committed signal
from a turn the filter would have dropped); otherwise stay in shadow.
Switching to `enforce` is the user's decision, one use at a time:

```yaml
decision_model_uses: "<use>:enforce"
```

## Turning it off

Any one of these:

1. remove the use from `decision_model_uses` (or set it to `off`);
2. set `decision_model_enabled: "false"` in the machine config;
3. add the vault opt-out to `Brain/_brain.yaml`:

   ```yaml
   decision_model:
     enabled: false
   ```

Unsetting the key variable also stops every request, except to a keyless
loopback `laya` or `openjev` server, which needs none.

## Privacy and terms: tell the user before the first shadow run

- **Shadow sends data.** Every request in `shadow` or `enforce` carries
  vault text (candidates, turns or notes) to the processor `check` names.
- **Private pages never leave.** Pages with `visibility: private` and
  `<private>` regions are never sent. Everything else is masked, clipped
  and passed through the shared secret redaction, but names, e-mail
  addresses or paths inside a non-private note are sent as they are;
  mark such text `<private>` if it must stay on the machine.
- **Retention depends on the processor.** The model vendor offers zero
  retention only by enterprise arrangement; gateways add their own
  logging and retention terms. Point the user to the processor's terms:
  TypeSafe <https://typesafe.ai/legal/privacy-policy>, OpenRouter
  <https://openrouter.ai/privacy> and
  <https://openrouter.ai/docs/guides/privacy/provider-logging>, Vercel AI
  Gateway <https://vercel.com/docs/ai-gateway/security-and-compliance/zdr>,
  OpenCode Zen <https://opencode.ai/legal/privacy-policy>. A loopback
  self-hosted server keeps everything local.
- **No training on recorded answers.** Open Second Brain never trains,
  fine-tunes or distils a model on the `decision_model_call` records, and
  the main hosted vendor's terms forbid training a model that imitates its
  outputs. Tell operators not to build that on the records.
- **Non-English vaults.** Hosted decision models are strongest in
  English. Evaluate each vault on its own shadow data, consider a
  multilingual self-hosted model, or stay in shadow.

## What this skill does NOT do

- Does not write, paste or echo a key. The user sets the variable.
- Does not switch a use to `enforce` without the user's decision and the
  shadow numbers.
- Does not install servers or download model weights.
- Does not edit a vault's `_brain.yaml` except to add the opt-out when
  the user asks for it.
