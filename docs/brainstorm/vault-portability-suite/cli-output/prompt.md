You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a "Vault portability + session economy" suite for Open Second Brain (OSB) - 5 deterministic, language-agnostic features. All features must be DETERMINISTIC (injectable clock where time matters; no Date.now()/Math.random() in pure code; byte-identical given inputs, because the vault is synced across devices via Syncthing) and LANGUAGE-AGNOSTIC (no hardcoded natural-language word lists / month names / per-language phrases; handle multilingual structurally).

The 5 features:

1. **Deterministic session codec (lossless round-trip).** A pure compress/expand codec for session-derived prose that reduces tokens while preserving code blocks, URLs, paths, identifiers, and version numbers byte-for-byte. Round-trip (expand(compress(x)) === x) must be guaranteed for structured content. Offline, no network, no LLM. The open question is the integration seam: OSB does NOT persist raw session bodies (it imports sessions into `Brain/inbox/` signals; the source JSONL is external). Candidates: a reusable codec module + CLI utility, and/or an opt-in transform on the session-imported signal `raw` body (expanded on read). Must keep the default install byte-identical.

2. **`o2b brain sources` read-only dashboard.** Aggregate the brain's signals by source - agent / `source_type` / session origin (`session_ref`) - with counts (active inbox vs processed, distinct topics). Read-only; `--json`. NOTE: the upstream inspiration paired this with a parallel multi-source sync worker pool + connection-budget warning; the parallel/worker-pool part is OUT of scope (only the read-only dashboard ships), so the connection-budget warning is moot.

3. **Vault-map token resolution.** Let tools resolve role tokens (e.g. `{{inbox}}`, `{{projects}}`) to user folder names via an optional map, falling back to built-in defaults when absent. The hard constraint: OSB's Brain machinery layout is FIXED via module-level constants in `src/core/brain/paths.ts` (`BRAIN_INBOX_REL`, `BRAIN_PREFERENCES_REL`, ...) consumed widely, and the v0.11.0 design is "one agent-owned Brain root". So the variant must decide WHAT the tokens address - the user's content folders (scan-inline read_paths / where graph-import writes / search scope) vs. relocating the Brain internal dirs - and how invasive that is.

4. **Named multi-vault profiles + switching.** OSB resolves the vault path centrally via `resolveVault(configPath)` (`VAULT_DIR` env -> config.yaml `vault` key). Add a registry of named profiles (name -> vault path + optional per-profile settings), a switch operation, and list/create commands, exposed via CLI and an MCP tool. Symlink-based or pointer-in-config activation are both candidates.

5. **Vault graph export/import via graph.json.** Extend `src/core/brain/export.ts` (which already has `exportPreferencesJson` / `collectExportRows`) to a full vault-graph export (pages + wikilinks + typed relationships) and an importer that reconstructs page stubs with correct frontmatter and wikilinks, with three conflict modes: skip (default) / overwrite / merge. Deterministic, idempotent on re-import with skip.

# Project context

Open Second Brain - TypeScript on Bun. A single-user, file-based "second brain": a vault of markdown files under `Brain/` (preferences, signals/inbox, retired, log) operated by AI agents through an `o2b` CLI and an MCP server. Byte-identical determinism matters for the Syncthing sync contract.

Recent releases (newest first): v0.21.0 Brain lifecycle suite (mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment); v0.20.0 Recall and ranking quality; v0.17.0 Brain Lifecycle Review Suite; v0.14.0 Semantic Brain Health.

Key code facts (verified):
- Vault path resolution is centralized: `src/core/config.ts` `resolveVault(configPath)` reads `VAULT_DIR` env then config.yaml `vault`; CLI wraps it via `src/cli/brain/helpers.ts` `resolveBrainVault`. The MCP server takes a single vault path (`src/mcp/server.ts:53`).
- Brain folder layout is FIXED via constants in `src/core/brain/paths.ts` (`BRAIN_ROOT_REL = "Brain"`, `BRAIN_INBOX_REL`, `BRAIN_PREFERENCES_REL`, `BRAIN_RETIRED_REL`, `BRAIN_LOG_REL`, ...); `brainDirs(vault)` composes absolute paths from them; many modules import the `*_REL` constants directly. `ensureInsideVault` guards every constructed path against traversal.
- `BrainSignal` carries optional `source_type` (`BrainSignalSourceType`), `session_ref`, and `agent` - enough to aggregate a sources dashboard from existing on-disk signals (no new store needed).
- Session import: `src/core/brain/sessions/import.ts` (`importSession`) + adapters (`claude.ts`, `codex.ts`, `hermes.ts`) + `registry.ts`; sessions become signals, raw bodies are not persisted beyond the signal `raw` field.
- Export seam: `src/core/brain/export.ts` `exportPreferencesJson` / `collectExportRows` / `exportPreferencesLlmsTxt`. Frontmatter parse/format via `src/core/vault.ts`; wikilink extraction via `extractWikilinks`; typed relations exist (v0.19.0: `related`/`extends`/`contradicts`/`superseded_by`).
- CLI verbs: one file per verb under `src/cli/brain/verbs/`, dispatched from `src/cli/brain.ts`; shared output helpers in `src/cli/output.ts`. MCP tools registered in `src/mcp/brain-tools.ts` (44 tools currently). Config keys resolved in `src/core/brain/policy.ts` / `src/core/config.ts`.
- Tests: Bun test runner under `tests/`. TDD: watch RED before GREEN.

Conventions / constraints:
- Pure deterministic modules; inject the clock; byte-identical output for Syncthing.
- New behaviour OFF or no-op by default where it could change existing on-disk output; a default install must stay byte-identical.
- Additive schema/config migrations only; tolerate unknown future values on read.
- NO hardcoded natural-language word lists / month names / per-language phrases.
- No new external runtime dependencies unless unavoidable (the session codec must be pure TS, no native deps).
- Do NOT fight the "one agent-owned Brain root" design; do NOT rewrite the proven session-import or dream internals.
- One PR = one CHANGELOG version; full project name in public artifacts; no AI-authorship markers in public prose.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant (esp. how it sequences/sca­ffolds the 5 features and the riskiest seams - the session-codec integration point and the vault-map scope).
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
