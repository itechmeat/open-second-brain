# Workspace Insight Suite - reach the Brain from anywhere; the Brain says what needs attention

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Epic:** t_618c7bd8 (children: t_5f31b5f1, t_1375e69f, t_72a22658, t_323a9a83, t_04e94382, t_cd1fee79, t_8722a62a, t_65036e02)

## Problem statement

Open Second Brain works only when an agent runs inside the vault or a directory with a configured pointer; cross-project use needs a manually pasted prompt snippet, and recall never crosses vault boundaries. At the same time the Brain is entirely reactive: its reports (health, retention, stale, brief) rediscover the same findings every run with no memory of what the operator already saw, dismissed, or acted on, and nothing proactively surfaces contradictions, orphaned research, or next directions.

## Scope

Two theme clusters, eight kanban tasks, one PR, target v0.38.0.

Cluster A - Workspace Reach:

- **A1 wikilink path format** (t_5f31b5f1): a pure link-format kernel with three modes - `preserve` (default, no change), `full` (rewrite to full vault-relative key path), `short` (shortest unambiguous suffix) - plus a `wiki_link_format` config key and an `o2b brain links normalize` verb that rewrites wikilinks in Brain-owned notes.
- **A2 project links + read-only sources** (t_1375e69f): `o2b brain project link|list|remove|status` writes/inspects a JSON pointer file in any project directory; `resolveVault` walks up from cwd and honours the pointer (after env, before profiles). `o2b brain source add|list|remove` registers external vaults as read-only recall sources with alias, duplicate/self/circular validation, and broken-target detection.
- **A3 cross-vault search** (t_72a22658): explicit per-call union mode (`o2b search query --global`, `brain_search { global: true }`) that fans the query out over the active vault, registered profile vaults, and read-only sources, merges by score, and labels every result with its origin. Writes stay scoped to the active vault.
- **A4 shell-native surface** (t_323a9a83): `o2b brain profile` materializes a compact `Brain/profile.md` digest (with stale-by-age regeneration), `o2b brain sgrep <query> [path]` is a grep-shaped semantic search wrapper (path scoping, `--json`), and a `.o2bfs` marker file lets shell wrappers detect a Brain root safely.

Cluster B - Proactive Insight:

- **B1 deep vault synthesis** (t_04e94382): `o2b brain deep-synthesis <topic>` + `brain_deep_synthesis` assemble a deterministic topic dossier - matched notes, typed-relation contradictions, stale claims (superseded or aged), and knowledge gaps (linked-but-missing targets, unanswered open questions) - as evidence for an external synthesizer. Contradiction and gap findings become trigger candidates.
- **B2 trigger queue** (t_cd1fee79): `Brain/triggers/<id>.md` records with frontmatter lifecycle (`pending`, `delivered`, `acknowledged`, `acted`, `dismissed`, `expired`), urgency, source artifacts, context snippets, and a stable cooldown key. `o2b brain trigger scan` generates candidates from existing health/retention/stale data; `list|ack|dismiss|act|history` manage the lifecycle; one consolidated `brain_trigger` MCP tool mirrors it. Morning brief shows pending triggers (marking them delivered) and never repeats dismissed ones inside their cooldown window.
- **B3 idea discovery** (t_8722a62a): `o2b brain ideas` + `brain_idea_discovery` rank next-direction candidates from orphan notes (low inbound link count), open questions, and aging unresolved inbox signals; `--triggers` enqueues them into the B2 queue.
- **B4 recall-gate telemetry** (t_65036e02): the `brain_recall_gate` handler emits a `gate_telemetry` continuity record (decision, reason, prompt hash - never the raw prompt) when `recall_gate_telemetry` is on (default off); `brain_recall_telemetry` and the CLI gain a gate-decision summary section.

## Out of scope

- FUSE/NFS mounts, hosted sync, or a grep-intercepting shell wrapper (A4 ships the sgrep verb and marker only; an interactive wrapper can layer on later).
- Indexing external vaults implicitly: union search reads an existing `<vault>/.open-second-brain/brain.sqlite` per source and fail-softs (with a warning naming the missing index) when absent. Operators index sources explicitly.
- LLM synthesis inside core: B1 produces the dossier; prose synthesis stays with the calling agent.
- Push notifications, valence tracking, or LLM-generated triggers (B2 task's explicit out-of-scope list).
- Claude Code / Codex host-hook gate wiring beyond what lives in this repo; the telemetry kernel is host-agnostic and hooks adopt it when their surfaces land.

## Chosen approach

Consultant Variant 1 - two cluster-aligned kernels (see `variants.md`).

**Kernel A - source resolution + origin tagging** (`src/core/brain/portability/`): one pointer/marker discovery util (walk-up file search shared by project pointers and the `.o2bfs` marker), one `recall-sources` registry module (validation lives in exactly one place), and one `listSearchOrigins` enumerator that returns `{alias, vault, kind: "active" | "profile" | "source"}` consumed by cross-vault search and `project status` (which also reports malformed pointers and broken sources; a doctor integration can adopt the same enumerator later). Origin labels ride the existing `reasons[]` mechanism (`origin:<alias>`) plus one additive optional `origin?: string` field on `BrainSearchResult`.

**Kernel B - candidate-to-trigger pipeline** (`src/core/brain/triggers/`): one `InsightCandidate` record (kind, urgency, reason, suggested action, source artifacts, context snippets, cooldown key) produced by report adapters (health, retention, stale) and by the B1/B3 generators; one Markdown-first trigger store with lifecycle transitions and cooldown dedup that is the single consumer. B4 reuses the existing continuity-record telemetry kernel rather than inventing a new sink.

A1 and B4 are deliberately smaller satellites: A1 is a pure formatting kernel the generators adopt, B4 is an emission point on an existing kernel. The consultant flagged this as the variant's main concession; we accept it - forcing them into a kernel they do not need would be the Variant 3 mistake in miniature.

## Design decisions

- **Pointer resolution order: env → pointer walk-up → profile → config.** `VAULT_DIR` stays the strongest (explicit per-process override); a pointer file is the most specific durable artifact, so it beats the profile pointer. Pointer files only exist when the operator created one - resolution is artifact-gated, no config key needed.
- **Pointer file is JSON (`.o2b-vault.json`), not Markdown.** Operational metadata follows the `profiles.json` precedent (stable key order, atomic writes, tolerant reads); Markdown stays the record for knowledge, not plumbing.
- **Read-only source registry lives beside the config (`recall-sources.json`), not inside the vault.** Sources are a device-level concern like profiles; keeping them out of the synced vault avoids leaking one machine's filesystem paths to every replica.
- **Union search is per-call explicit, not a config default.** `--global` / `global: true` changes recall results, so it must be a visible per-query decision; there is no key that silently widens every search.
- **Cross-vault scores merge as-is with origin labels.** Scores from identical ranking pipelines are comparable enough for a first version; the origin label and per-origin warnings make any skew diagnosable. Per-origin score normalization is a future tunable, not a v1 requirement.
- **Trigger records are Markdown files with JSON-quoted frontmatter** (intentions/handoff pattern), one file per trigger, filenames from the existing content-hash util over the cooldown key. History is a status change, not a file move - `history` lists terminal-status files; nothing leaves `Brain/triggers/`.
- **Cooldown dedup checks ALL existing triggers (any status) by cooldown key**: an active (pending/delivered/acknowledged) twin always blocks recreation; a dismissed twin blocks until `dismissed_at + cooldown_days`; acted/expired twins block until `expires_at`. This is what makes repeated `scan` runs idempotent.
- **Trigger generation is pull, not push**: `scan` is an explicit command (and the brief integration only surfaces already-persisted pending triggers). No report generator gains a write path - adapters read their existing frozen report shapes.
- **Gate telemetry stores a prompt hash, never the prompt.** Continuity records sync with the vault; raw prompts may contain anything. SHA-256 prefix is enough for duplicate analysis.
- **All eight features are additive**: no existing CLI verb, MCP tool shape, or search result field changes; new MCP tools (`brain_trigger`, `brain_deep_synthesis`, `brain_idea_discovery`) extend the contract test list; full/writer scopes stay byte-identical apart from the deliberately added tools.

## File changes

New (core): `src/core/brain/portability/pointer.ts` (walk-up discovery + pointer read/write), `recall-sources.ts` (registry + validation), `origins.ts` (enumerator); `src/core/brain/link-graph/format-wikilink.ts`; `src/core/brain/profile-doc.ts`; `src/core/brain/triggers/{types,store,scan,adapters}.ts`; `src/core/brain/deep-synthesis.ts`; `src/core/brain/idea-discovery.ts`; `src/core/brain/gate-telemetry.ts`; `src/core/search/cross-vault.ts`.
New (CLI): `src/cli/brain/verbs/{project,source,links,profile,sgrep,trigger,deep-synthesis,ideas}.ts` + registration in `verbs/index.ts`, `brain.ts`, `command-manifest.ts`; `--global` flag in `src/cli/search.ts`.
New (MCP): three tools in `src/mcp/brain-tools.ts` (or a dedicated module), additive `global` input on `brain_search` in `src/mcp/search-tools.ts`, gate-telemetry emission in the `brain_recall_gate` handler, gate section in `brain_recall_telemetry`.
Modified: `src/core/config.ts` (resolve helpers: `wiki_link_format`, `recall_gate_telemetry`, trigger cooldown days; pointer hook in `resolveVault`), `src/core/search/types.ts` (+`origin?`), `src/core/brain/morning-brief.ts` (pending-trigger section), `src/mcp/registry-guard.ts`, `tests/mcp/mcp.test.ts` (contract), docs.
Tests: one suite per new core module + CLI/MCP integration suites + one e2e suite for the release theme.

## Risks and open questions

- **resolveVault now consults the filesystem walk-up on every call.** Mitigation: the walk stops at the filesystem root, reads at most one small JSON per level, caches per-process, and short-circuits when `VAULT_DIR` is set; behaviour without pointer files is byte-identical.
- **External vault index may be stale or schema-mismatched.** Union search opens each source read-only inside a try/catch; a failed origin contributes a warning, never an error.
- **Deterministic contradiction/gap detection is conservative by design** - typed `contradicts` relations, supersession, link-graph dangling targets, unanswered open questions. The dossier states what it checked so the absence of findings is interpretable.
- **Trigger volume**: adapters cap candidates per kind per scan (documented constant) so a neglected vault cannot flood `Brain/triggers/` in one run.
- **Morning-brief growth**: the trigger section is capped (top N pending by urgency) and only renders when pending triggers exist.
