# The ingest manifest

The ingest manifest is the machine artifact that records, per ingested source, the
content digest and the extraction contract the source was last ingested under. It is
how folder ingest stays incremental - unchanged sources are skipped - and how a changed
extraction contract is answered with one owed reprocess instead of being absorbed as
unchanged.

- Location: `<vault>/.open-second-brain/ingest-manifest.json`. It is a machine
  artifact, not curated memory, so it lives beside the search index under
  `.open-second-brain/` rather than under `Brain/`.
- Writes are atomic and idempotent: a rerun over unchanged sources rewrites nothing,
  so the file's bytes and mtime stay stable. Ingesting one source never cancels the
  reprocess another source owes - the contract comparison reads the per-entry
  fingerprints, not a manifest-wide marker.

## What each entry records

Every entry carries the SHA-256 of the source's bytes at ingest time and the
fingerprint of the extraction contract it was extracted under (the schema-extractable
allowlist plus the hand-bumped contract version). Batch planning compares each entry's
fingerprint against the live contract:

- same bytes and same fingerprint - the source is skipped as unchanged;
- same bytes, older fingerprint - the source reprocesses once under the live contract,
  reported under the distinct `contract_changed` status (`contract_changed` and
  `contract_changed_files` on `--json`, an info line in text);
- missing or differing bytes - the source is planned as new.

## Schema history

| `schema_version` | Introduced      | Entries carry                                           |
| ---------------- | --------------- | ------------------------------------------------------- |
| 1                | original format | bare content digests                                    |
| 2                | 1.78.0          | digests plus a manifest-wide extraction-contract marker |
| 3                | 1.79.0          | digests plus a per-entry contract fingerprint           |

## The schema move is one-way (rollback note)

The on-disk format has no write-side downgrade from `schema_version` 2 on. A binary
that predates per-entry fingerprints (before 1.79.0) REFUSES a schema-3 manifest with a
named error (`ingest manifest schema_version 3 not supported ...`) instead of guessing
at it, and a binary older than the manifest-wide contract marker refuses schema 2 and 3
alike. Rolling the binary back therefore leaves ingest and batch planning refusing
until one of two recoveries is made:

- restore a manifest file at or below the version the older binary reads (the file is
  a machine artifact - it carries no curated content and is safe to restore from a
  backup), or
- remove `<vault>/.open-second-brain/ingest-manifest.json`: every read DEGRADES toward
  reprocessing, never toward skipping, so the next ingest or batch plan rebuilds the
  manifest and reprocesses the vault's sources once.

Both recoveries cost one reprocess of the affected sources; neither can silently skip
work extracted under a different contract. The current binary reads every earlier
version it ever wrote; only the forward direction is refused.
