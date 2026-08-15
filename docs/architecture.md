# Architecture

Open Second Brain is organized around a stable core and multiple runtime adapters.

## Layers

```text
Agent runtime
  -> runtime adapter/plugin
    -> skills and commands
      -> CLI/core library
        -> vault files and local config
```

## Core responsibilities

The core (`src/core/`) provides deterministic operations for:

- locating and validating configuration;
- initializing a vault profile (`o2b brain init`);
- recording taste signals, applied-evidence, and narrative milestones into `Brain/log/<YYYY-MM-DD>.md` (plus a JSONL sidecar);
- running the nightly `dream` learning pass (deterministic, no LLM calls);
- exporting redacted config snapshots;
- checking vault health (`o2b brain doctor`);
- querying preferences, signals, and link-graph relationships through the MCP and CLI surface.

The core does not depend on Hermes, Claude Code, Codex, OpenClaw, or Obsidian internals.

## Runtime adapters

### Hermes adapter

The Hermes adapter can be a real runtime plugin:

```text
plugins/hermes/
  plugin.yaml
  __init__.py
```

Possible responsibilities:

- register available hooks;
- check configuration at gateway startup;
- expose readiness diagnostics;
- connect Hermes session metadata to Open Second Brain profiles;
- optionally add event capture hooks when safe and explicit.

The Hermes adapter must not silently change model routing, write secrets, or mutate unrelated vault areas.

### Claude Code adapter

Claude Code support should be packaged through plugin metadata and bundled skills/commands.

The adapter should focus on:

- installing skills;
- exposing slash-command style workflows where supported;
- optionally configuring hooks;
- optionally declaring MCP configuration in later versions.

### Codex adapter

Codex supports plugins as installable distribution units for reusable skills and apps. The Codex adapter should include:

```text
.codex-plugin/plugin.json
skills/
.mcp.json        # later, optional
hooks/           # later, optional
assets/          # later, optional
```

v0 should keep Codex support simple: plugin manifest plus shared skills and scripts.

### OpenClaw adapter

OpenClaw discovers Open Second Brain as a Native plugin via the
`openclaw.extensions` entry in `package.json`. The entry
(`src/openclaw/index.ts`) reads and writes the vault directory
directly with `node:fs` / `node:path`; no subprocess is spawned, so
the OpenClaw security scanner (which blocks `child_process` imports)
accepts the plugin.

Installation (always installs the latest from `main`; do not append `@v...`):

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain
```

The OpenClaw adapter must remain compatible with the Hermes, Claude
Code, and Codex adapters. The `o2b mcp` MCP server is the canonical
way for any runtime to reach the writer / reader tools.

## Configuration model

Open Second Brain separates immutable package code from mutable user configuration and data.

### Machine-local config

Machine-local config points a runtime to a vault and environment profile.

Suggested path:

```text
$OPEN_SECOND_BRAIN_CONFIG
~/.config/open-second-brain/config.yaml
```

Example:

```yaml
version: 1
instance_name: My Second Brain
runtime: hermes
environment_name: <hostname>
vault:
  path: <absolute-path-to-Obsidian-vault>
identity:
  agent_name: <chosen-agent-name>
  user_language: <BCP-47 tag, e.g. en or ru>
policy:
  write_mode: agent-owned-dir
```

Machine-local config may contain absolute paths. It must not contain secrets.

### Vault-portable config

Vault-portable config lives at `<vault>/Brain/_brain.yaml` and travels
with backup/sync. It describes:

- schema version + dream / retire / confidence / snapshot thresholds;
- optional `notes.read_paths` (user-authored folders the agent may read);
- optional `temporal:`, `link_graph:`, `guardrails:`, `discipline_report:` tuning blocks;
- an optional `health:` block tuning the semantic lints, the remediation
  step cap, the `silence_before` watermark, and the derived-page freshness
  ceiling (`materialize_max_age_days`, default 30 days). Its day and count
  keys must each be a positive integer; a zero or a fraction is an explicit
  config error at load, never a clamped default;
- optional `integrity:` gates (`owner_scope_delivery`, `embedding_abi`,
  `pack_validity_seconds`) that decide where a mismatch is reported and
  where it is refused;
- `vault.ignore_paths` (exclusion policy for every vault walker) and the
  optional `vault.include_paths` allowlist. A path is in scope when it is
  not excluded AND, if an allowlist is declared, under one of its roots;
  absent, the allowlist changes nothing. The two compose in that order —
  an allowlist narrows, it never re-includes an exclusion. An empty
  `include_paths` is refused at parse time (it would be an off switch on
  indexing, not a boundary); an empty `ignore_paths` keeps its meaning of
  "exclude nothing". Both keys share one grammar: no slash is a bare name
  matched at any depth, a slash is a vault-relative path matched exactly;
- optional `write_binding.path_prefixes` (where a CALLER-NAMED write may
  land: `brain_create_note`, `brain_update_note`, `brain_append_note`,
  `brain_write_batch`). This is a write boundary over caller-named paths,
  not a security boundary and not per-agent — its authority is this file,
  which no tool call can rewrite, and it reads no caller identity. Writes
  whose destination is derived rather than named are outside it; the
  boundary is recorded in `tests/core/architecture/write-site-census.test.ts`.

It must not contain secrets.

## Backup model

Open Second Brain should assume the vault is the primary portable backup unit.

Recommended behavior:

- vault-portable config is backed up with the vault;
- machine-local config can be regenerated with `o2b init --adopt-vault`;
- `o2b export-config` writes a redacted machine snapshot into the vault;
- secrets are excluded and represented as `***REDACTED***` only when needed.

## Vault layout

The agent owns one directory in the vault for its own artefacts:
`Brain/`. User-authored notes (daily journals, weekly notes) live
wherever the operator names them; the agent reads those paths only when
they are listed in `notes.read_paths`.

Two operations reach user space, both of them operator-invoked and named
here rather than implied. `brain_note_lifecycle` moves, renames, archives
and deletes a note at a path the caller supplies, and rewrites inbound
`[[wikilink]]` references to it across the vault. Its `archive` action
moves the note to `Archive/<original path>` — a second top-level
directory, because the note is user content and `Brain/` is refused for
every note path, source and destination alike. **An operator whose backup
rule covers only `Brain/` should extend it to `Archive/`.** The rewrite
pass never writes outside the vault, never writes a path `vault.ignore_paths`
or `vault.include_paths` excludes, and never rewrites `Brain/log/`, which
is an append-only record of what was said at a time.

An export refuses in two cases rather than writing something misleading.
A payload the redactor could only partially scan refuses, because a file
that was scanned in part cannot claim to be clean. And a secret-shaped
**identifier** — a filename, an id, a mapping key — refuses rather than
being redacted, because redacting an identifier does not hide it, it
renames it: two notes whose names both redact to the same placeholder
collapse onto one path and one of the bodies is lost. A placeholder in a
payload is a redaction; a placeholder in an identifier is a lost identity.

```text
Brain/
  _brain.yaml              # schema + thresholds + notes.read_paths (validated by o2b brain doctor)
  _BRAIN.md                # operating manual for agents (rendered by o2b brain init)
  active.md                # derived digest, auto-regenerated
  inbox/                   # raw taste signals, sig-<date>-<slug>.md
    processed/             # signals already folded into a preference
  preferences/             # active rules: pref-<slug>.md, status unconfirmed | confirmed
  retired/                 # ret-<slug>.md with retired_reason
  log/                     # YYYY-MM-DD.md, append-only event log (dream / apply-evidence / etc.)
  .snapshots/              # <run_id>.tar.zst, pre-run snapshots for o2b brain rollback
                           # plus hygiene-<date>/ archives (pages moved, never deleted)
  .state/                  # machine state, excluded from indexing (since v1.3.0):
                           #   session-lineage.jsonl (compression-chain ledger)
                           #   anticipatory/<root>.json (hook-warmed context cache)
```

This layout is intentionally agent-owned: every artefact Open Second
Brain generates lives under `Brain/`. User-authored content elsewhere in
the vault stays under operator control and is read-only to the agent's
own passes; the note-lifecycle verbs above are the one surface that
writes it, and they act only on a path the caller named.

## Brain layer

Three architectural invariants:

- **Filesystem-first.** No database, no daemon. Every artifact is plain Markdown with YAML frontmatter; backup is `cp -r` or `tar`.
- **Deterministic core.** The `dream` algorithm is a pure function of inputs (signals, preferences, log, configuration, current time). No LLM calls inside the core. Semantic merging, if needed, is delegated to external agents via the same CLI / MCP surface. External judgment (the bench judge, the hygiene conflict resolver) goes through one sanctioned fail-open boundary: the operator-configured command bridge (`src/core/reliability/command-bridge.ts`).
- **Pre-run snapshot + atomic per-file writes.** Each `dream` run takes a `.snapshots/<run_id>.tar.zst` before any state change; per-file writes go through `fs-atomic` (temp + rename). Combined with retention of the most-recent N snapshots, this gives reversible, audit-friendly mutation.

The layered diagram from the top of this document still holds — `Brain/` sits at the same level as the vault files in the bottom layer:

```text
Agent runtime
  -> runtime adapter/plugin
    -> skills and commands (brain-memory skill, open-second-brain skill)
      -> CLI/core library (src/core/brain/*)
        -> vault files: Brain/ (observing memory)
```

Full design: [`docs/plans/2026-05-15-brain-observing-memory.md`](plans/2026-05-15-brain-observing-memory.md).

As of v0.10.10 the always-loaded `open-second-brain-writer` MCP
server hosts one read tool (`brain_context`) alongside the three
writers (`brain_feedback`, `brain_apply_evidence`, `brain_note`).
The reader exists for runtimes without a `SessionStart` hook
(Cursor, Aider, raw Claude API) — they call it once at session
start to pull the same `Brain/active.md` content the hook-aware
runtimes get auto-injected. The MCP server name is preserved for
backward compatibility with existing client `.mcp.json` entries;
renaming is deferred until a second reader joins the always-load
scope.

## Event log

The Brain event log is append-only. It records operational events,
not polished knowledge.

Storage: `<vault>/Brain/log/<YYYY-MM-DD>.md` (Markdown for human
reading) plus a JSONL sidecar at `<vault>/Brain/log/<YYYY-MM-DD>.jsonl`
(machine-friendly for downstream tooling). Each event kind is one
line per row, written through atomic temp+rename. The shared
redactor strips secret-shaped tokens before write.

## Security rules

Open Second Brain must not store:

- API keys;
- tokens;
- passwords;
- private SSH keys;
- credentials;
- connection strings containing secrets.

If secret-like content appears in input, tools should redact it as `***REDACTED***` before writing.

Every path that writes vault content to a destination OUTSIDE the vault - the
export verbs and `o2b export-config` - goes through `src/core/egress/guard.ts`
and is declared in `src/core/egress/registry.ts`, with
`tests/core/architecture/egress-census.test.ts` deriving the population from
source so a new export path cannot ship undeclared. A payload the redactor
could only partially scan refuses the write rather than producing a file that
claims to be clean.
