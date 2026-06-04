# Write-Time Integrity & Governance Suite - declared contracts for every Brain write

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The Brain accepts writes from humans (Obsidian/Vim over Syncthing), agents (CLI/MCP), and its own maintenance passes, but almost nothing about those writes is declared: any frontmatter field can be hand-edited including framework-owned join keys, entity labels are free-form strings that fragment ("High" / "high" / "important"), typed relations connect any two page types, fact extraction captures flat spans with no structured attributes, credentials can only be redacted out of memory but never safely used, and the heavy dream/reindex pass can land on top of a live interactive recall. Each gap is a different face of one missing idea: write-time contracts.

## Scope

- **Schema pack as the single declarative ontology** (additive fields, schema-pack format version stays compatible):
  - `frontmatter_tiers` - per-kind field tier map (t_3f92d3f1, p4)
  - `labels` - controlled-vocabulary enum dimensions (t_7a41f42d, p3)
  - `link_constraints` - allowed (source_type, target_type) pairs per link_type (t_15453235, p3)
  - `attributes` - per-extractable-type attribute fields with natural-language descriptions (t_f5633190, p1)
- **Tier guard**: deterministic tier model (L1 identity / L2 system / L3 business / L4 user) with built-in defaults for framework kinds, a tier-respecting frontmatter merge helper used by framework writers, and an index-baseline drift check that stages L1/L2 violations as ask_user findings with explicit restore.
- **Secret custody satellite** (t_0b134404, p4): AES-256-GCM per-value ciphertext store under the vault's local state dir, 0600 keyfile, set/list/rm/run surface where `run` injects the secret into a subprocess env and pipes output through the redactor; per-secret exec allowlist declared at set time; full no-values audit trail.
- **Quiet-window maintenance lane satellite** (t_166d1226, p3): `o2b brain maintenance run` gates on (a) configured local-time window, (b) recent interactive query rate from existing recall telemetry, (c) a SQLite-backed expiring worker lease; runs registered heavy tasks stale-first and journals every attempt.
- CLI verbs + MCP tools + tests + docs for each capability.

## Out of scope

- Any shared "validateWrite gateway" or governance framework layer (consultant Variant 1 - explicitly rejected).
- LLM-driven extraction: `attributes` descriptors steer agents and validate agent-supplied values; the deterministic core never calls a model.
- OS keychain integration and protection against same-user root processes (threat model documented instead).
- Retroactive re-typing of existing relations or migration of existing labels (lint surfaces violations; nothing rewrites history silently).
- Daemonized watchers; everything stays CLI/MCP invoked.

## Chosen approach

Consultant Variant 2 (Schema-Pack-Centric Ontology + Two Satellites), accepted without override. The four declarative features (tiers, labels, link constraints, attributes) become additive schema-pack fields parsed by the existing `schema-pack.ts` / `schema-vocab.ts` / `schema-mutate.ts` machinery, while enforcement stays at each feature's existing seam: the frontmatter merge in brain writers, the entity/label write path, `relation-polarity.ts` typed-edge materialization, and capture-time attribute validation. Secret custody and the maintenance lane are standalone modules that reuse only existing conventions (node:crypto, append-only JSONL + explicit sweep, `discipline/window.ts` timezone math, recall telemetry). No new runtime layer; a vault whose schema pack declares none of the new fields behaves bit-identically.

## Design decisions

- **Tier semantics (OSB mapping of EverOS L1-L4)**: L1 `identity` (id/kind/schema-version join keys - framework-owned, hand-edit = corruption), L2 `system` (framework-written timestamps/counters - hand-edit = drift), L3 `business` (agent-written domain fields via verbs), L4 `user` (freely editable). Built-in `DEFAULT_TIER_MAP` covers framework kinds (brain-preference, brain-active, brain-dead-end, signals, receipts...); `frontmatter_tiers` in the schema pack extends/overrides per kind. Unknown kinds and undeclared fields default to L4 - never block a user's own vault.
- **Tier enforcement is two-sided but never a write-deny on humans**: (a) framework writers merge through `mergeFrontmatterTiered()` so they cannot clobber L4 fields a human added and cannot silently accept hand-edits to L1; (b) `o2b brain tiers check` compares each file's L1/L2 fields against the last-indexed baseline already stored in SQLite and stages mismatches as findings (`ask_user`), restorable via `--apply` per finding. Humans keep full file ownership; the framework detects and offers repair instead of fighting the editor.
- **Secrets live outside synced markdown**: ciphertext store + keyfile under the vault-local state dir (alongside `brain.sqlite`), never under `Brain/`. Honest threat model in docs: protects against secret values entering agent context, vault sync/export leakage, and casual reads; does NOT protect against root or same-user processes (no daemon, no TPM - platform constraint).
- **Capability = exec allowlist declared at set time**: `o2b brain secret set NAME --allow "curl *" --env-var API_KEY` (value via stdin or env, never argv). `secret run NAME -- cmd...` refuses commands not matching the allowlist; MCP `brain_secrets` exposes list/exists/run (run still allowlist-gated), never get. Subprocess stdout/stderr pass through `redactRawOutput` extended with the resolved value before reaching the caller.
- **Audit trail follows the log discipline**: every secret operation appends a no-values line to `Brain/log/<date>.md` + JSONL sidecar (`secret_set`, `secret_resolved_for_exec`, `secret_exec_denied`...), making custody auditable from inside the vault without exposing material.
- **Label canonical form** is `label:<dimension>:<value>` written into the entity registry and a `labels` frontmatter map; validation is fail-closed (`unknown dimension` / `value not in vocabulary` reject the assignment with the allowed list in the error). Search gains a deterministic `label:` filter.
- **Link constraints constrain materialization, not authoring**: a typed relation whose endpoint kinds violate `link_constraints` falls back to an untyped link and surfaces in `schema_lint` with the violated pair; existing edges are linted, never deleted.
- **Attributes are agent guidance + validation, not extraction magic**: descriptors render into the agent-facing schema surfaces (`schema_explain_type`, capture instructions) and validate agent-supplied `--attr field=value` pairs at capture; regex fact-extract is unchanged.
- **Lease is SQLite, not a lockfile**: `INSERT ... ON CONFLICT` claim with expiry timestamp in `brain.sqlite` survives crashes (expired leases are reclaimable) and is visible cross-process (CLI + MCP). Query-rate gate reuses the existing recall-telemetry counters (last N minutes threshold); window gate generalizes `discipline/window.ts` local-time math to an `[start_hour, end_hour)` daily window.
- **Maintenance journal is bounded JSONL** (`maintenance-runs.jsonl`, newest-N explicit sweep) plus a `maintenance status` verb; every attempt is journaled including gate-refusals (`skipped:window`, `skipped:busy`, `skipped:lease`).
- **One coordinated schema-pack change**: all four new fields land in a single parser/renderer/mutate change set with one round-trip test (parse -> render -> parse identity), avoiding four divergent mini-formats.

## File changes

New core: `src/core/brain/frontmatter-tiers.ts`, `src/core/brain/secrets/{store,crypto,exec,audit}.ts`, `src/core/brain/maintenance/{lease,lane,journal}.ts`, `src/core/brain/labels.ts`.
Extended core: `schema-pack.ts`, `schema-vocab.ts` (if shared validation helpers move), `schema-mutate.ts`, `src/core/search/relation-polarity.ts`, `src/core/brain/fact-extract.ts` (attr validation only), `src/core/redactor.ts` (value-set extension hook), `src/core/search/search.ts` (label filter), doctor/lint integration points.
New CLI verbs: `tiers`, `secret`, `label`, `maintenance` (+ schema verb extensions); registered in the 5 standard places.
New MCP tools: `brain_tiers`, `brain_secrets`, `brain_labels`, `brain_maintenance` (or folded ops where a surface already exists) with previewBudget + pinned-list/count updates in `tests/mcp/mcp.test.ts`.
Tests: per-module unit suites, CLI suites, MCP suite, one cross-feature e2e integration test.
Docs: README surface sentence, CHANGELOG `[0.44.0]`, `docs/cli-reference.md`, `docs/how-it-works.md` chapter.

## Risks and open questions

- **Index baseline coverage for tier drift**: the check can only compare fields the indexer already persists; if some L1 fields are not in SQLite today, the indexer gains them additively (risk: index schema migration - keep additive and recomputable).
- **`.open-second-brain/` sync exposure**: if an operator syncs the state dir, the keyfile travels with the ciphertext. Docs must state the assumption (state dir is machine-local, as for `brain.sqlite`) and `brain_doctor` gains a permissions check (keyfile 0600).
- **Allowlist bypass creativity**: `--allow "bash *"` defeats the gate; docs recommend narrow patterns and the audit trail records the exact command line (values excluded).
- **Query-rate gate cold start**: a vault with no telemetry treats rate as zero (lane runs); acceptable because the window + lease gates still hold.
- **Schema pack growth**: four new fields in one release; mitigated by the single coordinated change set + round-trip property test.
