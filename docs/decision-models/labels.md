# Label suggestions for `brain_labels`

Use `labels` of the optional decision model (see
[../decision-models.md](../decision-models.md) for configuration, privacy and
accounting). Controlled-vocabulary labels are declared per dimension in the
schema pack (`schema.labels`) and assigned explicitly with `assign`, which
stays fail-closed. `suggest` classifies a note over the declared vocabulary
and never assigns anything.

## Request

`brain_labels` operation `suggest` with the note `path` and optional
`dimensions` (default every declared dimension), or
`o2b brain label <path> --suggest [--dimensions a,b]`.

One request per note. The state is the note's title (frontmatter `title`, else
the file name, clipped to 200 characters) and body (private regions stripped,
clipped to 4000 characters); the adapter redacts the whole body. Each
requested dimension is one `choice` question `dim_<i>` over its declared
values plus `none` (named `_none` when the vocabulary itself declares a value
`none`, so the two stay apart in `probabilities`). The schema pack declares values without descriptions, so
the options carry the value names only.

- A note whose visibility carries `private` is refused with an error and
  nothing is sent. Through MCP a page reserved against remote reads answers
  as absent, exactly as `show` does.
- An unknown dimension is refused as `assign` refuses it.
- A dimension with more than 254 values is skipped with
  `reason: "too_many_values"` (a question carries at most 255 options,
  `none` included).

## Result

Per dimension: `{ dimension, suggestion, probabilities, confidence, current,
model, calibrated }`, with `current` the value the note carries now (or null)
and `skipped` listing the dimensions that were not asked.

- `off` or no active configuration: `{ available: false, reason:
  "decision_model_off" }`. This is not an error, and nothing is sent.
- `shadow`: `mode: "shadow"`; the request is sent and recorded, and every
  `suggestion`, `probabilities` and `confidence` is null, so the host is not
  steered before the use has been evaluated.
- `enforce`: the chosen value; `none`, or a confidence below 0.6, gives
  `suggestion: null`.
- Any failure: `{ available: false, reason: <degrade reason> }`.

Suggest before assign: read the suggestion, then assign explicitly with
`assign` if it fits.

## Accounting and evaluation

The request writes one `decision_model_call` record with `note_path` and, per
dimension, the current value, the chosen option, the value that would be
suggested (in both modes), its confidence and probability. No note text is
recorded.

The report (`reports/labels.ts`) measures acceptance as is: it compares each
latest suggestion per note and dimension with what the note carries now.
`assign` writes only the note's frontmatter, so the note is the record of
later assignments. `accepted` means the dimension now holds the suggested
value, `overridden` that it changed to something else, `unchanged` that
nothing was assigned since, `already` that the suggestion equalled the value
the note had. Acceptance is accepted over accepted plus overridden, reported
per mode, so shadow data can be evaluated before `enforce`.
