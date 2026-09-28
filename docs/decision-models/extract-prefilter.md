# Turn pre-filter before the `extract-signals` envelope

Use: `extract_prefilter`. Surfaces: the plan phase of the MCP tool
`brain_extract_signals` and of `o2b brain extract-signals`. General setup,
privacy and accounting are in [`../decision-models.md`](../decision-models.md).

**Keep this use in shadow until your own vault shows zero regret.** A turn the
pre-filter drops is a turn the host never sees, so a wrong drop is a lost
signal, and nothing downstream can bring it back. Principles are often written
in the operator's own language, while hosted decision models are strongest in
English; a threshold that is safe on an English transcript may drop real rules
from a transcript in another language. Only this vault's shadow evidence can
say whether `enforce` is safe here.

## What it does

The plan phase collects the user turns of an imported session and hands the
host one needs-llm-step envelope that asks it to mine durable taste signals
from all of them. Most user turns are tasks, questions or one-off
instructions; the host pays for each one, and for a whole round trip when the
session states no rule at all.

With the use on, Open Second Brain asks the decision model one yes/no question
per mined turn: does this turn state a rule the operator gave about how work
should be done (a preference, a correction, a prohibition), rather than a fact,
a task or a one-off instruction about this session? That is the envelope's own
definition of a taste signal.

| Mode | What the plan returns |
|---|---|
| `off` (default) | Exactly today's plan. No request, no record. |
| `shadow` | The full envelope and every mined turn, as today, plus one optional `source_turn` line in the envelope's schema hints (it feeds the regret metric). The per-turn probabilities are recorded. |
| `enforce` | Turns whose probability is below the drop threshold (initially 0.1) are left out of the envelope. When every turn is below it, there is no envelope at all. |

The threshold starts low on purpose. Published community measurements of a
similar "drop below 0.1" filter hid about 5% of content with zero regret on a
small labelled sample, while 0.3 produced about 21% regret. Raise it only on
this vault's shadow evidence.

## Plan fields

While the use is not `off`, the plan may carry these optional fields; with the
use `off` none of them appears.

- `turns_dropped` (enforce): ids of the turns left out of the envelope, in
  record order. `turns_mined` then lists only the kept turns, which are the
  turns in the envelope.
- `skipped: { reason: "decision_model_prefilter", turns_dropped: <n> }`
  (enforce) with `llm_step: null`: every mined turn scored below the
  threshold, so there is nothing to mine and no round trip is needed. This is
  a normal outcome, distinct from the refusal of a session with no user turns.
- `decision_model: { degraded: <reason> }`: a request failed (timeout,
  network, HTTP error, invalid reply, cost gate, egress refused). The envelope
  then carries every mined turn, exactly as without the pre-filter.
- The envelope's schema hints also name an optional item field
  `source_turn`: the bracketed id of the turn a rule was stated in. The
  commit accepts it (a non-string value is refused); items without it behave
  as always. It is what makes regret measurable.

Every uncertainty keeps a turn: a turn the model answered invalidly, a turn
that does not fit `decision_model_max_state_tokens` even alone, and a turn
whose text carries part of a `<private>` region are all kept unscored. When the
turns do not fit one request they are split into as few requests as fit; no
turn is dropped because of the budget.

## Privacy

Each request carries the mined user turns, masked as `T0..Tn` (turn ids stay
on the machine), clipped to 2,000 characters, stripped of `<private>` regions
and redacted like every other decision request. Shadow mode sends this data
too.

## Accounting

- One `decision_model_call` record per request: the session id, the turn ids
  and the probabilities, a `correlation_id` shared by the requests of one
  plan with `request_index` and `request_count`, the clipped character count
  of each turn and the threshold. Never turn text.
- One `decision_model_extract_commit` record per commit while the use is not
  `off`: the session id, the mode, `written_count`, the `source_turn` values
  of the written items that name a real turn of the session, and
  `without_source_turn_count`.
- With the `token_impact` ledger on, one sample per enforced plan
  (`source: decision_model:extract_prefilter`): baseline is the envelope with
  every turn, packed is the envelope returned (0 when skipped), and a skipped
  envelope counts as one modeled avoided inference.
- `brain_generation_reports` is unchanged: a skipped envelope is never
  recorded as a generation report.

## Evaluation

`o2b decision-model report --use extract_prefilter` reports:

- **regret**: committed items whose `source_turn` scored below the threshold
  in the latest shadow plan of that session. In shadow the host still saw the
  turn; each such item is a signal `enforce` would have lost. Target: zero.
- **drop share**: scored turns, and their characters, below the threshold.
- **skip share**: plans in which every mined turn scored below the threshold,
  so `enforce` would skip the envelope.

Recommended: at least one week of real sessions in shadow, with hosts that
fill `source_turn`, and zero regret before `enforce`. With any regret, lower
the threshold or stay in shadow.
