# Stability policy

Since 1.0.0, Open Second Brain follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the
contracts below treated as the public API. Anything not listed here is
an internal detail and may change in any release.

## Frozen contracts

### MCP tool surface

Every tool advertised by `tools/list` (77 tools at 1.0.0) is frozen:
the tool name, its input schema's existing parameters, and the
documented meaning of its response fields. New optional parameters and
new response fields are additive (minor); removing or renaming a tool,
making a parameter required, or changing a response field's meaning is
breaking (major). Since 1.0.0 the advertised list and the callable
surface are the same set - there is no hidden alias layer. Removed
tools answer `tools/call` with an INVALID_PARAMS tombstone naming the
replacement for at least one major cycle.

### CLI verb tree

The verb tree in `o2b help` / `src/cli/command-manifest.ts` is frozen:
existing verbs, their positional forms, their documented flags, their
exit-code contract (0 success or fail-soft skip, 1 operational
failure, 2 usage error), and the shape of their `--json` output. New
verbs, new optional flags, and additive JSON fields are minor.

### Configuration keys and environment variables

Every documented config key and its env mirror keeps its name, type,
default, and resolution order (environment beats config file).
Examples frozen at 1.0.0: `vault`, `agent_name`, `timezone`
(`VAULT_TIMEZONE`), the `search_*` family
(`OPEN_SECOND_BRAIN_SEARCH_*`), `safeguard_timeout_seconds` and its
per-operation variants (`OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT`), and
`report_snapshots_enabled` (`OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS`).
Unknown keys remain warnings, never errors.

### Search index schema

The SQLite search index migrates forward only, one numbered step at a
time (v7 at 1.0.0). Opening a newer-schema index with an older build
fails with `SCHEMA_MISMATCH` instead of corrupting it. Removing a
migration step from the ladder is breaking.

### On-disk format schemas

Every persisted machine-readable format carries an explicit schema
string, and the reader for version N keeps reading N for at least one
major cycle after N+1 ships:

| Schema string | File | Since |
| --- | --- | --- |
| `o2b.metrics.v1` | `Brain/metrics/<surface>.jsonl` | 0.45.0 |
| `o2b.tuning.v1` | `Brain/search/tuning.json` | 0.45.0 |
| `o2b.dream-stage.v1` | `Brain/dream/staged/<run-id>/manifest.json` | 1.0.0 |
| `o2b.report-snapshot.v1` | `Brain/reports/<surface>/<date>.json` | 1.0.0 |
| continuity records (versioned envelope) | `Brain/continuity/` | 0.39.0 |

Evolution rule (mirrors the metrics contract in
[`docs/metrics.md`](metrics.md)): adding optional payload fields is
compatible; renaming or retyping a field, or changing a record's
identity semantics, requires a new schema string.

### `Brain/` layout conventions

Generated artifacts carry a frontmatter `kind` plus `generated_at` and
are regenerated whole per run; hand-written files inside agent-owned
directories are never modified or deleted by generators. Storage
timestamps are canonical UTC everywhere (frontmatter, log headings,
run ids); timezone conversion is strictly a presentation-layer
concern.

## What counts as breaking

- Removing or renaming anything listed above.
- Changing a default in a way that alters behavior for an unchanged
  config file.
- Tightening validation so previously accepted input is rejected.
- Changing the meaning (not just the set) of an emitted field.

Breaking changes ship only in a major release, with tombstones or
documented migrations, and are listed in the upgrade guide
([`docs/updating.md`](updating.md)).

## What is explicitly NOT frozen

- The exact wording of human-readable (non-JSON) CLI output and error
  messages.
- The internal module layout under `src/`.
- Lint/test tooling, internal scripts, and development workflows.
- The contents of `docs/brainstorm/` (historical design records).
