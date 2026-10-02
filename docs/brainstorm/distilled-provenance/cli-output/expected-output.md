# Expected output, before and after

Illustrative vault: `Notes/talk.md` holds a paragraph ending in ` ^p1` that reads `The index is rebuilt nightly.`

## `o2b brain distill` with a verbatim quote

Claims: `[{"text": "The talk says “The index is rebuilt nightly.”", "block": "p1"}]`

Before (3ec2334a):

```
distilled 1 claim(s) -> Brain/distillations/dist-notes-talk-md-<hash12>.md
```

After:

```
distilled 1 claim(s) -> Brain/distillations/dist-notes-talk-md-<hash12>.md [quotes verified:1 unquoted:0]
```

## `o2b brain distill` with a paraphrase in quotation marks

Claims: `[{"text": "The talk says “The index is refreshed every night.”", "block": "p1"}]`

Before: the same success line; the page shows the paraphrase as a quote.

After (default): the page bullet reads `- The talk says The index is refreshed every night. ([[Notes/talk.md#^p1]])` and the line is:

```
distilled 1 claim(s) -> Brain/distillations/dist-notes-talk-md-<hash12>.md [quotes verified:0 unquoted:1]
```

After, with `--strict-quotes` (exit 1, nothing written):

```
distill: quoted spans failed verification: claim 0: not-in-block
```

`--json` (default mode) adds:

```json
{
  "capture_scope": "full-local",
  "quotes": {
    "checked": 1,
    "verified_in_block": 0,
    "verified_in_source": 0,
    "unquoted": 1,
    "unpaired": 0,
    "findings": [{ "claim": 0, "outcome": "not-in-block", "span": "The index is refreshed every night." }],
    "total": 1,
    "returned": 1,
    "truncated": false
  }
}
```

## `o2b brain distill` from a URL with an excerpt

`o2b brain distill https://example.test/post --claims-file c.json --excerpt-file excerpt.txt`

Before: no `--excerpt-file` flag (usage error, exit 2).

After:

```
distilled 1 claim(s) -> Brain/distillations/dist-https-example-test-post-<hash12>.md [untrusted_source] [bounded-local] [quotes verified:1 unquoted:0]
```

## `brain_distill_source` strict refusal on MCP

After: a JSON-RPC error with `code: -32602`, `message: "brain_distill_source: quoted spans failed verification: claim 0: not-in-block"`, `data: { "code": "quote_unverified" }`. Before: the argument did not exist.

## `o2b brain hygiene scan --json` with a research report that cites only URLs

Before: no finding for the report.

After, one more finding:

```json
{
  "id": "capture-scope:<sha256-prefix>",
  "detector": "capture-scope",
  "severity": "warning",
  "title": "Active knowledge rests on url-only sources",
  "targets": ["Brain/reports/<date>-<slug>.md"],
  "proposed_action": "review",
  "evidence": { "sources": ["https://example.test/a", "https://example.test/b"], "stamped": null }
}
```

A clean vault (every cited source is a vault file) prints exactly what it printed before.
