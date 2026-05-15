---
open_second_brain_version: 1
layer: brain-first
---

# Open Second Brain — vault overview

This vault is managed by Open Second Brain. The vault holds three
top-level agent-facing directories, each with a distinct purpose.

## Layers

- **`Brain/`** — observing memory. Signals, preferences, retired
  rules, log, snapshots. Mutated only through `o2b brain *` commands
  and the `brain_*` MCP tools. The full operating manual lives at
  `Brain/_BRAIN.md` — read it before any Brain operation.

- **`AI Wiki/`** — curated knowledge surface. Identity files
  (`identity/`), index and hot list, system snapshots, and the Pay
  Memory subtree (`payments/`, `assets/`, `drafts/`, `reports/`,
  `policies/`). Agents read it via `second_brain_query` and write
  into the Pay Memory subtree via the `payment_*` MCP tools; they
  do not otherwise mutate this area through Brain tools.

- **`Daily/`** — chronological event log and human narrative.
  Visible to `second_brain_query` for cross-referencing past
  activity; Brain operations do not write here.

## Where agents write

- Taste signals and rule applications go through Brain: call
  `brain_feedback` after a stylistic accept/reject, call
  `brain_apply_evidence` after a durable artifact that exercised an
  active preference, and let `brain_dream` (scheduled or manual)
  promote, confirm, and retire rules from that evidence.

- Paid actions go through Pay Memory. `AI Wiki/payments/`,
  `AI Wiki/assets/`, and the spending policy at
  `AI Wiki/policies/spending.json` remain the audit surface for any
  call that costs money. Pay Memory is orthogonal to Brain — both
  layers coexist on the same vault without overlap.

## Where agents read

`second_brain_query` covers the whole vault. Use it to recall an
`AI Wiki/` note, look up a `Daily/` entry, or surface a specific
Brain preference by id. Read-only.

## Conventions

- All notes are Markdown with YAML frontmatter. No databases, no
  daemons. `cp -r` is a full backup.
- Cross-references are Obsidian wikilinks (`[[basename]]`). No
  relative paths.
- Never write secrets, tokens, or credentials into any file.

## Quick start

1. Read `Brain/_BRAIN.md` — the operating manual for the writable layer.
2. Read `AI Wiki/identity/user.md` and `AI Wiki/identity/agents.md` —
   who owns the vault and which agents are registered.
3. When in doubt about a Brain command, see
   `docs/plans/2026-05-15-brain-observing-memory.md` in the repo.
