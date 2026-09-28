# Skill selection for `skills_attach` (`skills` use)

The optional `skills` decision-model use lets `skills_attach` choose which
skills to offer with two small decision requests on top of the existing
BM25 ranking. It is off by default. With the use `off`, no key, a vault
opt-out or an invalid config, `skills_attach` is exactly the deterministic
BM25 surface described in [the MCP reference](../mcp.md#skill-surface-since-v0370),
makes no network call and writes no record. The general setup, privacy rules
and accounting are in [Decision models](../decision-models.md).

```yaml
skill_auto_attach: "true"
decision_model_enabled: "true"
decision_model_provider: typesafe
decision_model_env_key: TYPESAFE_API_KEY
decision_model_uses: "skills:shadow"
```

## How a selection runs

1. **Shortlist.** The same BM25 scorer and discriminating-term floor as
   today, cut at 40 candidates instead of `max_skills`.
2. **Stage 1, one request.** The state is the turn text and the shortlist,
   masked as `S0..Sn` (name and one-line description, clipped). Two
   questions: `pick`, a choice over the shortlist plus `none`, and
   `needs_any_skill`, the probability that the turn asks for work a
   specialised skill would help with.
3. **Stage 2, one request, only when stage 1 is confident.** The top
   `min(max_skills, 3)` candidates by stage-1 probability become finalists;
   one yes/no question per finalist over its full description and SKILL.md
   body (clipped): does this skill apply to the turn. Stage 2 is skipped,
   and the BM25 block returned, when too little of `decision_model_timeout_ms`
   is left after stage 1. The whole selection stays within that timeout.
4. **Enforce.** When `needs_any_skill` is low, nothing is offered
   (`offer_id: null`, as when nothing matches today). Otherwise the finalists
   the model accepts are offered by probability, capped at `max_skills`, and
   rendered with the existing renderer and char budget.

Stage 1 is not confident, and the BM25 block is returned, when its answers
are invalid, when `pick` names a key that was not offered, or when it picks
`none` while saying the turn needs a skill.

## Modes

| Mode            | Requests                            | What `skills_attach` returns                            |
| --------------- | ----------------------------------- | ------------------------------------------------------- |
| `off` (default) | none                                | today's BM25 block, no `decision_model` field           |
| `shadow`        | stage 1, and stage 2 when confident | today's BM25 block byte for byte, plus `decision_model` |
| `enforce`       | stage 1, and stage 2 when confident | the decision offer, plus `decision_model`               |

The optional result field is `decision_model: { mode, applied, degraded?, model? }`.
`applied` is true only in `enforce` when the decision offer was returned;
`degraded` names the reason when a stage failed (for example `timeout`,
`http_529`, `invalid_reply`, `budget`, `cost_gate`); `model` is the answering
model when a reply arrived. The field is present only when the use is not
`off`.

Invariants in every mode:

- The decision offer is always a subset or a reorder of the BM25 shortlist.
  An answer naming anything else is ignored and never offered.
- The `offer_id` is computed over what is actually offered, so agents cite it
  on `get_skill` and the `skill_invoked` join works in both modes.
- Any failure in either stage returns today's BM25 block. A partial decision
  is never applied.
- A skill whose SKILL.md has visibility `private`, cannot be read, or carries
  text from a `<private>` region is never sent, and so never offered in
  `enforce`. Its name is masked in the records.

## Accounting

Each stage writes one `decision_model_call` record; the records of one
selection share a `correlation_id`. The record with `final: true` carries the
BM25 offered names (`deterministic_offered`), the decision offered names
(`decision_offered`, absent when the selection fell back), the returned
`offer_id`, `needs_any_skill` and `applied`. Each record also carries
`withheld_count` (skills not sent for privacy) and `budget_dropped_count`
(skills dropped to fit `decision_model_max_state_tokens`). Records carry
names, ids and numbers only, never the turn or skill text; a withheld skill
is named `(withheld)`.

When the `token_impact` ledger is enabled, each selection whose decision
offer was returned (`enforce`, `applied: true`) also writes one
`token_impact` sample with `source: decision_model:skills`: the baseline is
the estimated tokens of the block BM25 would have rendered, the packed count
is the block actually returned. Shadow selections and fallbacks return the
BM25 block and write no sample.

## Evaluation

Keep `skills:shadow` for about a week, then read the `skills` section of
`o2b decision-model report --use skills`:

- **Offer-hit rate:** over selections whose returned offer led to a
  `skill_invoked` record citing its `offer_id`, the share where an invoked
  skill is in the decision set, next to the same share for the BM25 set.
- **Needless-offer rate:** the share of selections that offered something
  while nothing was invoked. Offering nothing is never needless.

Switch to `enforce` only when the offer-hit rate does not drop and needless
offers fall. In shadow the agent only ever sees the BM25 offer, so invocations
come from it; the hit rate then shows how often the model kept the skill the
agent went on to use. The join needs imported session logs
(`o2b brain import-session`); in a vault with few attributed invocations the
numbers stay thin.
