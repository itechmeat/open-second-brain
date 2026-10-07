# Decision models: the recall-inject hook filter

Use `recall_inject` of the optional decision-model feature (see
[Decision models](../decision-models.md)). It asks a decision model which of
the notes the prompt-time recall hook is about to inject would actually help,
and in `enforce` it drops the others or withholds the brief.

**This use adds a network call to every prompt** on which the hook would
inject, with `recall_inject_enabled: "true"` and the use set to `shadow` or
`enforce`. Hosted endpoints report roughly 100-500 ms per request from one
region; operators far from the endpoint see more. The brief is capped at 900
characters by default (`recall_inject_max_chars`), so the token saving per
prompt is small. Weigh the added latency
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
  `below_floor`, `unmeasurable_quality`, `all_already_injected`,
  `all_slices_abstained`) and errors send nothing. The filter sees the brief
  after session dedupe and slice layout (see
  [Session dedupe and slices](#session-dedupe-and-slices)), so it never judges
  a note this session was already shown.
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
budget)`, where the retrieval budget is the hook's time budget (2,500 ms
unless `recall_inject_time_budget_ms` sets another value in 250..6000). The
sub-budget is passed to the provider as its timeout and is also enforced
around the call, so it never extends the total. With no time left
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

## Session dedupe and slices

These behaviours belong to the recall-inject hook itself and apply with or
without the decision-model use. The config keys are listed in the
[CLI reference](../cli-reference.md).

### Per-session dedupe

With `recall_inject_dedupe` on (the default while `recall_inject_enabled` is
on) and a host that sends a non-empty `session_id`, the hook keeps a ledger
of what this session was already shown, under
`.open-second-brain/hook-state/`:

- The key of a recalled note is `<origin>:<path>#L<start>-L<end>`, with an
  empty origin for the primary vault. It is the exact span a brief bullet
  points at, so a different span of a long note is new content and stays
  eligible.
- The hook records the notes actually rendered into the brief (after the
  decision-model filter and the char-budget fit) only after the brief was
  written to stdout. A note cut by the char budget was never shown and is
  not recorded. When that write fails, the audit line carries
  `ledger_recorded: false`, and those notes can be injected again.
- The ledger is per session id. Every entry has a 24 h expiry that is
  refreshed on each write, and the recall set keeps at most the 2000 most
  recent keys, the oldest dropping first. Without a session id, the hook
  reads and writes no ledger, so one host's recall never suppresses
  another's.
- Every SessionStart that emits (startup, resume, clear, compact) starts a new
  injection epoch and clears the recall set. On `resume` a note can therefore
  be injected once more. Only a SessionStart event starts an epoch: a run of
  the same hook on another event (an operator-registered `UserPromptSubmit`)
  injects its payload whole and leaves the recall set alone.
- Dedupe runs after the confidence floor, which is judged on the unfiltered
  retrieval, and before the `recall_inject_max_notes` cut. Nothing is
  over-fetched to refill the brief, because that would change the floor
  verdict for the same prompt.
- When every candidate that cleared the floor was already shown, the hook
  abstains with the reason `all_already_injected`.
- `recall_inject_dedupe: "false"` (or `"0"`) restores the old behaviour,
  where the same notes are injected on every prompt.

### Cross-lane filter against the SessionStart digest

The SessionStart hook (active-inject) records, in the same session ledger,
the vault paths present in the payload it actually emitted. That is the
post-budget text, never the `Brain/active.md` file on disk. It records
`Brain/active.md` when the active body was emitted, `Brain/lessons.md` when
the lessons body was emitted, and `Brain/preferences/pref-<slug>.md` for
each rendered preference bullet (a line that opens with
`` - `pref-<slug>` ``) in the emitted text; a lesson or any other line that
only quotes a `pref-` id does not count. When the payload
came from the last-good cache, any non-empty memory body counts as both
`Brain/active.md` and `Brain/lessons.md`. Under chunked
re-grounding, parts still queued count as emitted. The recall hook drops
any candidate from the active vault whose path is in that set, on any line
span: the digest delivers whole notes, not spans. A candidate from a profile
or a recall source is never dropped by this filter, because the same
vault-relative path there names a different note. The active hook writes this ledger only
when `recall_inject_enabled` or `reground_parts_enabled` is on and a session
id is present.

### Slices

A `recall_inject:` block in `Brain/_brain.yaml` declares named slices (the
block and its contract example are in the
[CLI reference](../cli-reference.md)). With slices declared:

- Every slice retrieves in parallel under the one shared time budget, never
  a budget each. A slow slice fails the whole decision with `timeout`, the
  same way a slow single retrieval does; there is no partial brief.
- The confidence floor applies per slice, on that slice's own retrieval, and
  dedupe applies inside each slice.
- Slices are laid out in declared order inside one fence. Each slice takes
  `min(limit, notes left)` notes and at most `max_chars` of rendered lines.
  The global `recall_inject_max_notes` and `recall_inject_max_chars` (fence
  included) bound the sum, so a later slice is clamped to what the earlier
  ones left.
- A note an earlier slice already placed is not repeated, and a slice that
  places nothing is omitted from the brief.
- When no slice places a note, the hook abstains with the reason
  `all_slices_abstained`. The audit line carries `slices`, one
  `{name, outcome, notes}` per slice, where `outcome` is `inject` or that
  slice's abstain reason.

A `_brain.yaml` that fails to load takes no slice path and is recorded as
`slices_config: "invalid"` on the audit line. The search reads the same
policy file, so the decision then ends in `error` with fault
`retriever_failed` and no brief is injected until the file is fixed.

## Evaluation before enforcing

Keep `recall_inject:shadow` for a while, then read `o2b decision-model report
--use recall_inject`: p50 and p95 added latency, timeout rate, abstain rate
and notes dropped, next to the hook's recall telemetry (decisions, retrieval
timeouts and hook ceiling exits) over the same window.

Move a machine to `enforce` only when both hold:

- p95 added latency is below `decision_model_hook_budget_ms`;
- hook timeouts (retrieval timeouts and hook ceiling exits) did not increase
  compared with the same period before the use was enabled.
