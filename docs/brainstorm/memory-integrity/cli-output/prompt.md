You are brainstorming architectural variants for the following multi-task scope. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release ("Memory integrity suite") ships four related features for Open Second Brain - an Obsidian-native, filesystem-first, agent-owned second brain written in TypeScript on Bun. The four kanban tasks below are the scope. Variants should address the OVERALL architecture of the suite: how the four features compose, where each one's seam is, and what shared primitives they should reuse.

## Task t_95d7a31b (priority 4): [upstream:Sibyl-Memory] Canonical entity memory with single-source-of-truth registry

**Source**: https://github.com/Sibyl-Labs/Sibyl-Memory
**Upstream files studied**: `sibyl-memory-client/src/sibyl_memory_client/schema.sql`, `sibyl-memory-client/README.md`

## What
Sibyl-Memory separates durable entities from journal events and reference documents. Its WARM tier stores one canonical entity per `(tenant_id, category, name)` and enforces that uniqueness at the schema level. It also has typed `entity_relations` and an archive tier for frozen entities. The important idea is not the SQLite implementation itself; it is the single-source-of-truth contract for remembered people, projects, systems, accounts, and other named things.

## Why useful for OSB
OSB currently has strong preference lifecycle management, typed page relationships, graph export/import, entity-boosted search, and page-level deduplication. It does not have a first-class canonical entity memory where agents can say: "this project/person/system is represented here, this is the current structured state, and duplicates should resolve to this identity." A canonical entity layer would improve Second Brain behavior by making project/person/tool facts stable across sessions, reducing drift between notes, and giving recall a precise anchor that is not just a search-time extracted entity string.

## Current OSB status
- **Verdict**: present_weaker
- **Local evidence**: CodeGraph shows OSB entity handling mainly in search (`src/core/search/entities.ts`, `chunk_entities`, entity boost). Page dedup, typed links, schema packs, and graph export exist, but they do not provide an operator-governed entity registry with uniqueness and archive semantics.
- **Related existing work, not a duplicate**: Page-level deduplication and typed graph semantics work on vault pages/relations. This task is about a canonical memory surface for named entities and their current structured state.

## Proposal
Add a filesystem-first OSB entity registry under `Brain/entities/` with deterministic identity rules, typed relations, archive support, and search/graph integration. The registry should stay Obsidian-native: each entity is still Markdown with frontmatter, but OSB owns an identity index that can detect or prevent duplicate canonical entities.

## Suggested design
- Introduce `Brain/entities/<category>/<slug>.md` or a similarly explicit layout for canonical entities.
- Define frontmatter fields such as `entity_id`, `category`, `name`, `aliases`, `status`, `source_agent`, `confidence`, `updated_at`, and `archived_at`.
- Maintain a rebuildable identity index mapping `(category, normalized_name)` and aliases to the canonical file.
- Add read/write CLI verbs for `entity set`, `entity get`, `entity list`, `entity relate`, and `entity archive`; expose only the safe subset through MCP.
- Connect entity IDs to typed relationships and search ranking so search results can explain when a hit came through a canonical entity rather than only raw text/entity extraction.
- Add conflict reporting when two files claim the same canonical `(category, name)` or alias.

## Acceptance criteria
- [ ] OSB can create or update a canonical entity without creating a duplicate for the same normalized `(category, name)`.
- [ ] Entity files remain plain Markdown and are readable/editable in Obsidian.
- [ ] Aliases resolve to the canonical entity during lookup and search.
- [ ] Entity relations are typed and appear in graph export/search explanation output.
- [ ] Archiving an entity removes it from active lookup while preserving audit/history.
- [ ] Doctor or schema lint reports duplicate entity claims and broken entity relations.
- [ ] Tests cover canonicalization, alias resolution, duplicate detection, relation validation, archive/restore semantics, and search integration.

## Out of scope
- Replacing user-authored vault notes with entity files.
- Moving OSB memory storage into SQLite.
- Importing Sibyl's tenant/account/tier model.

## Task t_6d52641f (priority 3): Brain log: per-device shards to eliminate Syncthing write-conflicts

## Problem
Brain/log/<date>.jsonl (+ .md) is a single shared per-day file written by every runtime. On one device concurrent writers are serialized by proper-lockfile (no corruption, no conflict - one device = one file). But the vault is Syncthing-synced across devices, so when two DEVICES write the same <date>.jsonl the same day, Syncthing cannot merge and emits a .sync-conflict-* copy (observed 2026-06-01: claude-mac-agent + claude-vps-agent; reconciled manually). No in-process lock/daemon fixes this - the lock cannot span the sync boundary.

Note: agents already do NOT write the log directly - they go through the o2b writer (o2b-hook session-capture script + brain_note/brain_feedback/brain_apply_evidence MCP tools, proper-lockfile). So the fix is the FILE STRATEGY, not adding a serializer/daemon (that would be over-engineering; the lockfile already serializes same-device writers).

## Design (decided)
Shard the log by DEVICE, mirroring the conflict-free pattern inbox/ already uses (one file per signal):
- Writer appends to Brain/log/<date>.<deviceId>.jsonl (+ .md), where deviceId is a stable per-install id stored in the PER-DEVICE config (~/.config/open-second-brain/, NOT in the synced vault - else all devices share one id and the sharding is defeated). Generate the id on first use if absent.
- One device -> only its own shard file -> Syncthing never conflicts. Multiple agents/Claude-Code instances on one device share the device shard via the existing serialized writer (lock), no races.
- Readers (digest, timeline, daily/morning/weekly briefs, anything reading <date>.jsonl/.md) glob <date>*.jsonl across shards and sort by ts. The human-facing <date>.md becomes a derived merged view regenerated on read (or also sharded).
- Migration: existing single-file Brain/log/<date>.jsonl/.md keep working (treat as an implicit shard / fold into the merged read); a one-time reconcile of any leftover .sync-conflict-* copies (union+dedup by ts+content) - see the manual merge done for 2026-06-01.

## Scope / acceptance
- Single writer path appends to a per-device shard; deviceId resolved from per-device config (not vault).
- All log readers merge shards (sorted by ts) and produce the same results as before.
- Concurrent writers across devices produce NO Syncthing conflict; same-device concurrency stays serialized.
- TDD; ship via feature-release-playbook.

## Out of scope
- A logging daemon (the existing lockfile writer is sufficient).
- Excluding the log from Syncthing (loses cross-device visibility).

## Task t_d0782ab2 (priority 3): [upstream:yantrikdb-hermes-plugin] Regex-based fact extraction from conversation turns

**Source**: https://github.com/yantrikos/yantrikdb-hermes-plugin/releases/tag/v0.5.0
**Repo**: yantrikos/yantrikdb-hermes-plugin (27★)
**Released**: v0.5.0 (2026-05-31T07:10:31Z)

## What
YantrikDB v0.5 introduced 7 high-precision regex patterns that automatically extract facts from user conversation turns: preference, possession, identity, location, URL, email, and confirmation patterns. Only USER turns and user-confirmed assistant assertions are extracted (HANDOFF carve-out); bare LLM output is never auto-extracted. A recall filter and yantrikdb_extraction_stats tool allow tuning.

## Why useful for OSB
OSB has brain_pre_compact_extract for structured Decision/Commitment/Outcome/Rule/Open question extraction from session turns, but it is LLM-driven and runs at compaction time. Lightweight regex-based fact extraction would capture structured identity/preference/possession facts in real-time without an LLM call, complementing the heavier pre-compact extraction. The HANDOFF carve-out (only user turns + confirmed assistant assertions) is a sound guard against hallucinated memory.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/brain/pre-compact-extract.ts:29 (ExtractedLine), src/core/brain/pre-compact-extract.ts:110 (extractLines), hooks/lib/transcript.ts:30 (TurnSignal). Pre-compact extraction is LLM-based and runs at session boundary. No regex-based real-time fact extraction exists.

## Notes
Could be implemented as a lightweight hook (PostToolUse or UserPromptSubmit) that runs regex patterns against user turns and produces candidate brain_feedback entries. The extraction_stats tuning tool concept could map to a brain extraction diagnostics command.

## Task t_0532ed5a (priority 2): [upstream:hermes-lcm] Source-aware session and message noise boundaries

**Source**: https://github.com/stephenschoettler/hermes-lcm
**Upstream files studied**: `README.md`, `config.py`, `engine.py`, `session_patterns.py`, `message_patterns.py`, `command.py`, `tools.py`

## What
Hermes-LCM has explicit session and message boundary controls: ignored session globs are excluded from storage, stateless session globs can read carried-over state without writing new rows, and message-level regex patterns suppress noisy content before it reaches the store. The engine tracks foreground versus side-channel sessions, exposes filter state in `lcm_status`, and keeps source lineage (`source`, `unknown`, legacy blank-source normalization) visible in search and diagnostics.

## Why useful for OSB
OSB now captures lifecycle events through hooks and imports sessions from multiple agents. That is powerful, but Second Brain quality depends on what does *not* enter memory: cron chatter, test probes, heartbeat messages, generated progress pings, temporary side-channel sessions, or tool noise that would pollute search and synthesis. OSB has vault ignore paths and private-region stripping, but it does not appear to have a first-class capture boundary for agent sessions and individual messages. Adding one would make long-running multi-agent memory cleaner and easier to trust.

## Current OSB status
- **Verdict**: not_in_osb_useful
- **Local evidence**: OSB has `brain session-hook`, source-agent query/diff, private-region stripping, vault ignore paths, and redaction for secret-shaped content. Existing tasks include lifecycle hooks (`t_9eaebcad`) and privacy-aware capture (`t_c12e0e9c`). CodeGraph/readme/CLI context did not show session glob filters, stateless capture mode, message regex suppression, or foreground/side-channel diagnostics for session ingestion.
- **Related existing work, not a duplicate**: Vault ignore paths decide which vault files walkers read. This task decides which runtime sessions/messages become Brain evidence at all.

## Proposal
Add OSB capture-boundary configuration for session imports and live hooks. Operators should be able to declare ignored sessions, stateless/read-only sessions, and message suppression patterns in `_brain.yaml` or machine-local config. Every skipped item should be counted and diagnosable, but skipped content should not become searchable memory or preference evidence.

## Suggested design
- Add config keys such as `sessions.ignore_patterns`, `sessions.stateless_patterns`, and `sessions.ignore_message_patterns`, with clear source precedence between machine-local and vault-portable config.
- Apply the filters in `brain session-hook` and `brain import-session` before signal extraction or narrative logging.
- Store skip counters and non-sensitive reasons in `Brain/log/<date>.jsonl` or doctor diagnostics; avoid writing the skipped message text itself.
- Add a `brain sources` / `brain doctor` section showing active patterns, match counts, unknown-source counts, and recently suppressed categories.
- Treat stateless sessions as allowed to read `brain_context` / `brain_morning_brief` but not allowed to write signals, notes, extracted decisions, or apply-evidence rows unless explicitly overridden.

## Acceptance criteria
- [ ] Session import and live hook capture both honor ignored session patterns and message-level suppression patterns.
- [ ] Stateless sessions can receive context but do not mutate Brain state by default.
- [ ] Suppression is auditable through counters, pattern names, and source/session metadata without persisting suppressed raw content.
- [ ] Existing imports behave unchanged when no filters are configured.
- [ ] Tests cover ignored sessions, stateless sessions, message regex suppression, source attribution, and malformed pattern handling.

## Out of scope
- Building a general moderation or classification system.
- Deleting already-imported historical Brain records automatically.
- Making regex filtering block the host runtime; invalid or expensive patterns should degrade safely.


# Project context

Open Second Brain: TypeScript, Bun runtime, bun:test, oxlint/oxfmt. MCP server + o2b CLI + lifecycle hooks. Core principle: the Brain core is deterministic - no LLM calls inside core state transitions. All durable state is Markdown with YAML-like frontmatter inside an Obsidian vault; the vault is Syncthing-synced across devices.

Recent commits:
5066e71 feat: Token Diet - budgeted injection, reminder cadence, consolidated MCP surface (#65)
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)
23ff4fb refactor(hermes): single intentional self-bootstrap for the plugin entrypoint (#63)
0952dfc feat: become a native Hermes memory provider (#62)
6fbab0b feat: hands-off post-upgrade migration (v0.31.2) (#61)
496dd2d fix: make plugin updates self-healing (v0.31.1) (#60)
09c0592 chore(release): v0.31.0 (#59)
b81335c Feat/procedural attention suite (#58)
1f3a218 Feat/self learning skill proposals (#57)
0162d13 feat(brain): add context continuity and receipts suite (#56)

Related files (verified seams):
- src/core/brain/log.ts:237 appendLogEvent - the ONLY write point for Brain/log/<date>.jsonl + .md; per-day directory lock via proper-lockfile; JSONL written first (machine-authoritative), markdown second (human view).
- src/core/brain/log-jsonl.ts:47 readLogDay - the single reader entry point (JSONL preferred, markdown fallback). Used by morning-brief, digest, timeline.
- src/core/brain/doctor.ts:905 readAllLogRecords - reads the Brain/log/ DIRECTORY listing directly (not via readLogDay); temporal/build-index.ts collectLogEvents similar. Directory-scanning readers must stay correct under any new file layout.
- src/core/config.ts - per-device config chain: OPEN_SECOND_BRAIN_CONFIG env -> XDG_CONFIG_HOME -> ~/.config/open-second-brain/config.yaml. This is the per-device (NOT synced) store.
- src/core/brain/session-lifecycle.ts captureSessionLifecycleEvent - live hook capture seam (hooks/session-capture.ts feeds it; fail-soft, never blocks runtime).
- src/core/brain/sessions/import.ts:127 importSession - batch session import seam; adapters claude/codex/hermes normalise to SessionTurn {turnId, timestamp, role, text, toolCalls}.
- src/core/brain/pre-compact-extract.ts - precedent for regex-label extraction (LABELS table, sanitize, dedupe_key, continuity records).
- src/core/brain/signal.ts writeSignal - the one way signals are born; supports source_type, dedup_hash, session_ref.
- src/core/brain/policy.ts - _brain.yaml config parsing (vault.ignore_paths, notes.read_paths, active.inject_budget_chars precedents); 1789 lines, strict per-key validation with warnings.
- src/core/search/entities.ts extractEntities - deterministic, language-agnostic entity extraction used as a ranking boost (entityMatchByChunk in src/core/search/ranker.ts).
- src/core/graph/frontmatter-relations.ts extractFrontmatterRelations - typed relation edges from frontmatter fields.
- src/core/brain/paths.ts brainDirs - all Brain/ subdirectories composed here; ensureInsideVault guards.
- src/core/brain/doctor.ts - lint surface for new integrity checks.
- src/mcp/brain-tools.ts + src/mcp/tools.ts - MCP tool definitions (300-char description cap, preview budgets by default, registry guard contract tests).

Conventions:
- TDD; every feature lands with failing tests first. 3,198 tests green on main.
- Determinism: given the same vault bytes + injected clock, every core function returns identical output. No Date.now() in core paths - callers inject.
- Append-only logs; atomic writes (atomicWriteFileSync); idempotent operations with dedup hashes.
- Conventional commits; one PR = one CHANGELOG version bundling the suite.
- Contract tests pin public behavior (tool counts, description caps, hook allowlists).
- Everything in the vault must remain readable/editable in Obsidian (plain Markdown + frontmatter).
- Per-feature config lives in Brain/_brain.yaml (vault-portable) or ~/.config/open-second-brain/ (device-local). The split matters: device identity MUST NOT sync; policy SHOULD sync.

Constraints:
- No new external dependencies unless unavoidable (proper-lockfile, sharp etc. already present).
- No LLM calls inside core; extraction must be deterministic regex/structural.
- Syncthing safety: two devices must never write the same file on the same day.
- Existing readers (digest, timeline, morning brief, doctor, temporal index) must keep producing the same results over merged data after the log-shard change.
- Backward compatibility: existing single-file logs keep working without migration; existing MCP tool names stay callable.
- The entity registry must stay rebuildable from the Markdown files alone (the index is a cache, not a source of truth).
- Fail-soft hooks: a hook crash must never block the host runtime.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
