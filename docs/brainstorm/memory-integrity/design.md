# Memory Integrity Suite - canonical entities, conflict-free log, capture hygiene

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Kanban:** epic t_e7eb3224; children t_95d7a31b (entities), t_6d52641f (log shards), t_d0782ab2 (fact extraction), t_0532ed5a (capture boundaries)

## Problem statement

Second Brain trust depends on three properties the vault does not yet guarantee. Named things (people, projects, systems) have no canonical home - facts about them drift across notes and search-time entity strings. The daily Brain log is one shared file per day, so two Syncthing devices writing the same day produce `.sync-conflict-*` copies (observed live 2026-06-01). And everything a runtime emits can become memory: cron chatter, heartbeats, and side-channel sessions enter the same capture path as real operator signals, with no boundary and no real-time structured fact capture for the turns that do matter.

## Scope

- **Canonical entity registry** (t_95d7a31b): `Brain/entities/<category>/<slug>.md` Markdown entities with frontmatter identity (`entity_id`, `category`, `name`, `aliases`, `status`, lifecycle stamps), a rebuildable in-memory identity index over `(category, normalized name)` + aliases, duplicate refusal at write time, typed relations through the existing frontmatter-relations vocabulary, archive/restore semantics, CLI verbs (`entity set/get/list/relate/archive`), a read-only MCP surface, doctor lints (duplicate claims, broken relations), and alias-aware search boost.
- **Per-device log shards** (t_6d52641f): `appendLogEvent` writes `Brain/log/<date>.<deviceId>.jsonl` + `.md`, where `deviceId` is a stable per-install id from the device-local config (`~/.config/open-second-brain/config.yaml`, never the vault). `readLogDay` merges legacy single files plus all shards sorted by timestamp; a new `listLogDates` helper replaces every ad-hoc directory scan (doctor x2, digest x2, digest-agent-summary, temporal index - the last already reads through `readLogDay` but discovers dates from raw filenames).
- **Capture boundaries** (t_0532ed5a): `sessions.ignore_patterns`, `sessions.stateless_patterns`, `sessions.ignore_message_patterns` in `_brain.yaml`; ignored sessions produce nothing, stateless sessions read but never write, suppressed messages never reach marker/fact extraction. Applied at both seams - live (`captureSessionLifecycleEvent`) and batch (`importSession`). Suppression is counted, never stored raw.
- **Regex fact extraction** (t_d0782ab2): deterministic high-precision patterns (preference, possession, identity, location, URL, email, confirmation) over USER turns only, emitting candidate signals through `writeSignal` with a new `source_type: extracted`, dedup-hashed, gated BEHIND the capture boundary (suppressed/ignored/stateless input is never extracted). Extracted identity/possession facts that name a registered canonical entity (or alias) get the canonical `entity_id` stamped into the signal note - the canonicalization kernel shared with the registry.

## Out of scope

- A logging daemon or any serializer beyond the existing per-directory lockfile (the lock already serializes same-device writers).
- Excluding `Brain/log/` from Syncthing.
- Moving entity or log storage into SQLite; importing Sibyl's tenant/tier model.
- Replacing user-authored notes with entity files; auto-creating entities from extracted facts (extraction only ANCHORS to existing entities, creation stays operator/agent-explicit).
- Extracting facts from assistant turns (the HANDOFF carve-out's conservative core: user turns only in v1).
- Automatic deletion of already-imported historical records.
- A general moderation/classification system; LLM calls anywhere in these paths.

## Chosen approach

Variant 2 of the consultant round (see `variants.md`): a capture-boundary pipeline plus a canonicalization kernel. The two regex-over-turns features compose into one ordered, deterministic pipeline at both ingestion seams - classify/suppress first, extract second, route third - so suppressed input can never become evidence and the turn walk/pattern-compile/malformed-pattern handling exists once. The entity registry is its own subsystem, but its canonicalization primitive (normalize, identity key, alias resolution) is exported and reused by the fact router. Log sharding stays a fully independent write-layer change, as its decided design expects.

## Design decisions

- **Identity index is built on read, never persisted.** Entity counts are small (tens to low hundreds); walking `Brain/entities/` per operation is cheap, deterministic, and avoids a cache file that could itself sync-conflict. The acceptance criterion "rebuildable" is satisfied trivially: there is nothing to rebuild.
- **Entity name normalization = NFC, lowercase, whitespace-collapse** - the same shape `extractEntities` already produces, so search alias expansion and fact anchoring compare like with like.
- **Duplicate policy: refuse at write, lint at rest.** `entity set` refuses to create a second file claiming an existing `(category, normalized name)` or alias (update goes to the canonical file); doctor reports duplicates that arrived by hand-editing or sync.
- **Entity relations reuse the frontmatter-relations vocabulary** (`relates_to`, `part_of`, ... exactly the fields `extractFrontmatterRelations` already maps), so graph export and relation polarity pick entities up without new edge plumbing.
- **MCP surface is read-only and single-tool**: `brain_entity` with `view: get | list` (registry-guard caps respected). Writes stay on the CLI where the operator drives them; this honours the task's "safe subset" requirement and the Token Diet tool-count discipline.
- **Device id lives in device-local config** (`device_id:` in `~/.config/open-second-brain/config.yaml`), generated once (8 hex chars from crypto randomness) on first write-path use, validated as `[a-z0-9-]{1,32}`. Putting it in the vault would defeat sharding (all devices would share one id).
- **Shard merge order: timestamp, then shard id, then line order** - deterministic across devices regardless of read order; two events in the same second on different devices have a stable total order.
- **Legacy files are implicit shards.** `<date>.jsonl` / `<date>.md` (no device id) keep being read forever; no migration. The writer simply stops appending to them once sharding ships.
- **Markdown shards mirror JSONL shards** (`<date>.<deviceId>.md`). A regenerated merged `.md` view would itself be a cross-device write target - the exact conflict class this task removes. Obsidian users see one file per device per day; each is valid standalone.
- **`listLogDates` becomes the only way readers discover log days.** It returns sorted unique dates from any known filename shape (`<date>.jsonl`, `<date>.<id>.jsonl`, `.md` variants), and the five direct `readdirSync` scans in doctor/digest/digest-agent-summary route through it plus `readLogDay`-based merge reads. `parseLogDay` (markdown parser) gains a shard-aware sibling used by doctor's markdown lint so warnings still carry exact paths/lines.
- **Boundary config is vault-portable policy; matching is glob for sessions, regex for messages.** Session globs match against `session_id` and (when present) the transcript path; message regexes compile defensively - an invalid pattern degrades to a doctor warning and is skipped, never thrown. Machine-local config may ADD patterns (union semantics); it cannot remove vault policy.
- **Stateless sessions write nothing, read everything.** The gate sits at the top of `captureSessionLifecycleEvent` (and per-file in `importSession`): ignored -> return early with counters only; stateless -> skip signal writes, lifecycle log writes, and fact extraction but still return success so hosts keep functioning; suppressed message -> the text never reaches marker or fact extraction, only a counter survives.
- **Extraction patterns are a closed, ordered table** (same shape as `pre-compact-extract.ts` LABELS): 7 pattern families, English-first with structural cues, each capturing a single fact span. Only `role === "user"` turns are scanned. Every emitted signal carries `source_type: extracted` (new closed-enum member), a dedup hash over `(family, normalized fact)`, and the session ref - so re-imports and repeated prompts dedup exactly like markers do today.
- **Extraction counters ride existing result surfaces** (`CaptureSessionLifecycleResult`, `ImportSessionResult` gain `facts_extracted` / `facts_deduped`; capture results also gain `suppressed_messages`, `ignored_session`, `stateless_session` as applicable). The audit JSONL row carries the same counters - no new diagnostics file.
- **No new dependencies.** Globs are matched with a tiny anchored-translate helper (the codebase already avoids minimatch); randomness via `node:crypto`.

## File changes

New:
- `src/core/brain/entities/types.ts` - entity record, category/status enums, frontmatter contract.
- `src/core/brain/entities/canonical.ts` - normalize, identity key, alias resolution (the shared kernel).
- `src/core/brain/entities/registry.ts` - read/walk/upsert/relate/archive + duplicate refusal.
- `src/core/brain/entities/index-builder.ts` - in-memory identity index from a vault walk.
- `src/core/brain/capture-boundary.ts` - config matcher (session globs, message regexes), decision type, counters.
- `src/core/brain/fact-extract.ts` - pattern table + `extractFacts(turnText)` + router (`writeSignal` + entity anchoring).
- `src/cli/brain/verbs/entity.ts` - `o2b brain entity set|get|list|relate|archive`.
- `tests/core/brain/entities.*.test.ts`, `tests/core/brain/capture-boundary.test.ts`, `tests/core/brain/fact-extract.test.ts`, `tests/core/brain/log-shards.test.ts` (+ reader-merge, doctor, CLI, MCP tests).

Modified:
- `src/core/config.ts` - `device_id` accessor with first-use generation.
- `src/core/brain/log.ts` - `appendLogEvent` writes shard paths; `paths.ts` gains shard path helpers.
- `src/core/brain/log-jsonl.ts` - `readLogDay` merges shards; new `listLogDates`.
- `src/core/brain/doctor.ts` - scanners -> `listLogDates`; new lints: `duplicate-entity`, `broken-entity-relation`, `invalid-capture-pattern`, `sync-conflict-log`.
- `src/core/brain/digest.ts`, `digest-agent-summary.ts`, `temporal/build-index.ts` - date discovery via `listLogDates`.
- `src/core/brain/policy.ts` + `types.ts` - `sessions:` config block; `BRAIN_SIGNAL_SOURCE_TYPE.extracted`.
- `src/core/brain/session-lifecycle.ts` - boundary gate + fact extraction stage + counters.
- `src/core/brain/sessions/import.ts` - boundary filters + per-turn fact extraction + counters.
- `src/core/search/search.ts` (+ `entities.ts` seam) - alias-aware entity expansion at query time; `why_retrieved` notes canonical-entity hits.
- `src/mcp/brain-tools.ts` - `brain_entity` read tool (view: get|list).
- `src/cli/brain.ts`, `command-manifest.ts`, `help-text.ts` - verb registration.
- `README.md`, `CHANGELOG.md`, `docs/` - phase 5.

## Risks and open questions

- **Reader refactor regression risk** (highest): five scanners change date discovery; mitigated by golden tests asserting merged reads equal pre-shard reads on legacy fixtures, plus mixed legacy+shard fixtures.
- **Pattern precision**: the 7 fact families must stay high-precision (upstream reports precision-first design); each family ships with negative fixtures (assistant turns, code blocks, quoted text) proving non-matches.
- **Hot-path cost**: capture gate + extraction run per prompt event; both are regex-over-one-prompt with compiled-once patterns - measured in microseconds, and the whole hook stays fail-soft.
- **Glob semantics**: kept deliberately small (`*`, `?`, `**`); documented in the config template so operators do not expect full minimatch.
- **`.md` shard naming vs Obsidian daily-note plugins**: shard files keep the `YYYY-MM-DD` prefix so date-sorted views stay usable; documented in README.
