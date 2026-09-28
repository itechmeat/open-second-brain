# Advisory dedup and tension verdicts

Uses `dedup` and `tension` of the optional decision model (see
[../decision-models.md](../decision-models.md) for configuration, privacy and
accounting). Both are advisory: they annotate proposals the deterministic
detectors already made, and they never write to the vault.

The detectors propose pairs from similarity and a negation lexicon, which
cannot tell "the same rule in other words" from "a related but different
rule", or "contradicts" from "one note quotes or qualifies the other". A
decision request asks one `choice` question per pair instead.

## What is asked

Each request carries up to 40 pairs as named state fields `pairs.A<i>` and
`pairs.B<i>`, each clipped to 600 characters, and one question `pair_<i>` per
pair. Pairs are packed into as few requests as fit
`decision_model_max_state_tokens` (state and questions together), at most five
requests per listing; a pair that does not fit gets no verdict.

| Use | Pairs | Options |
|---|---|---|
| `dedup` | preference dedup findings of `brain_hygiene scan` (the two principles); entity `entity-alias-candidate` warnings of the doctor (the two names) | `same` (following either would always lead to the same action; for entities, the same entity), `related`, `different` |
| `tension` | persisted tensions checked by `brain_tension verify` (the two quoted spans) | `contradicts`, `compatible` (same subject, both can hold, for example a quote or a qualification), `unrelated` |

A side is never sent when its page carries `visibility: private`, cannot be
read, or its text shares a line with one of the page's `<private>` regions;
its pair then gets no verdict. For a tension, the subject notes are resolved
by their frontmatter `id` or vault-relative path; an unresolved subject is not
sent, and neither is a tension whose own page is private. Everything else
follows the shared rules: masking, clipping, `redactForEgress` over the whole
body, the daily cost gate.

## Modes

- `off` (the default), or any configuration that is not active: nothing is
  read, built or sent; every output is byte-identical.
- `shadow`: the requests are sent and recorded. `brain_hygiene scan` and the
  doctor output are byte-identical to `off`; `brain_tension verify` returns
  `mode: "shadow"` and the rows without verdicts.
- `enforce`: each annotated item gains
  `decision_model: { verdict, probabilities, model, calibrated }`. A confident
  low-priority verdict (`different` for dedup, `compatible` or `unrelated` for
  tensions, probability 0.9 or more) is listed last and marked
  `decision_model_low_priority: true`. Nothing is hidden, merged, dismissed,
  resolved or deleted, and counts do not change.

Any failure (timeout, HTTP error, invalid reply, budget, cost gate) leaves the
field absent and the order unchanged. An invalid answer leaves only its pair
without a verdict. A degraded request stops the remaining requests of that
listing. `brain_tension verify` reports `available: false` with the reason
when no verdict could be obtained at all.

## Surfaces

- `brain_hygiene scan` and `o2b brain hygiene scan`: dedup findings. The
  verdicts exist only in the output; `apply` never reads them, so an apply is
  identical with and without them.
- `brain_doctor` and `o2b brain doctor`: `entity-alias-candidate` warnings
  (the lint itself needs `entity_semantic_dedup_enabled`).
- `brain_tension` action `verify` and `o2b brain tension verify [<slug>]`:
  one tension, or every unresolved tension. Read-only: detection,
  persistence and status transitions are unchanged, and no verdict is written
  into a tension record.

Merges, dismissals and resolutions stay explicit operator actions.

## Accounting and evaluation

Every request writes one `decision_model_call` record with `pair_kind`
(`preference`, `entity`, `tension`), a `correlation_id` shared by the
requests of one listing with `request_index` and `request_count`,
`withheld_count` (pairs not sent for privacy), `budget_dropped_count` (pairs
that did not fit `decision_model_max_state_tokens` or the request cap) and,
per sent pair, its identifier (finding id, entity pair id, tension slug), the
two side identifiers, the verdict and its probability. A withheld pair is not
named. No principle, name or quote is recorded.

The report (`reports/pair-verdict.ts`) joins each pair's latest verdict to
what the operator did afterwards, read from the vault: a preference pair is
`merged` once either preference was retired, an entity pair once either
entity is archived or lists the other as an alias, and a tension carries its
current status (`resolved`, `dismissed`, `confirmed`, `open`). Verdicts are
grouped by verdict and band (`high` at 0.9 or more, `mid` at 0.6 or more,
`low`), so the precision of each band against the operator's own decisions
can be read directly. Any change of a default needs that precision measured
against the deterministic proposal alone.
