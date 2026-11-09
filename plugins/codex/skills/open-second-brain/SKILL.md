---
name: open-second-brain
description: Use Open Second Brain to read, write, and maintain an agent-owned second brain beside an Obsidian-compatible Markdown vault. The agent reaches its brain memory only through Open Second Brain tools and commands, never through file paths. User-authored notes live wherever the operator names them and are read-only inputs when listed in `notes.read_paths`.
---

# Open Second Brain

Use this skill when a user asks an agent to use, configure, inspect, or maintain Open Second Brain.

## Layout

Open Second Brain keeps everything the agent generates on its own in its brain memory, and stores that memory itself. On a machine switched to the brain store the memory lives in the store; on a machine still on the legacy layout it is a tree inside the vault. Never read, create or edit those files by hand, and never assume where they are: the `store` block of `second_brain_status` says which layout this machine uses (`migration.switched`), and `o2b store path` names the store's location. The exception is the note-lifecycle family (`brain_note_lifecycle`, `brain_scaffold_stub`), which acts on a user-note path the caller names and can move a note to a top-level vault directory, `Archive/`.

- **Brain memory** - agent-writable observing memory. Taste signals, accreted preferences (unconfirmed → confirmed → retired), evidence log, snapshots. Operations go through MCP tools `brain_feedback`, `brain_apply_evidence`, `brain_dream`, `brain_brief`, `brain_query`, `brain_doctor` - see the `brain-memory` skill for the calling protocol. CLI counterparts: `o2b brain *`.
- **User-authored notes** - the operator's daily journal, weekly notes, project notes, etc. Folder names are operator-chosen. The agent reads these paths only when they appear under `notes.read_paths` in the brain settings; the agent never writes to them.
- **Brain settings** - the values every machine of this brain shares (`notes.read_paths`, the dream gates, `primary_agent`, `guardrails.*`, the `decision_model.enabled` opt-out). Read them with `brain_settings` (`action: get` or `list`) or `o2b brain settings get|list`. The operator changes them with `o2b brain settings set|unset`; an agent can use `brain_settings` (`action: set` or `unset`). An agent never overrides a value the operator set: on a machine switched to the brain store the tool refuses with `human_value_in_force`; on a machine still on the legacy layout, where the settings file records no author, a value that differs from the shipped default counts as the operator's and is refused the same way. Operator-only keys are refused with `operator_only_setting` on every machine, whether or not the operator set them: the whole `integrity` block, `notes.read_paths`, `vault.ignore_paths` and `vault.include_paths`, `write_binding.path_prefixes`, the `sessions` capture patterns, the `guardrails` promotion thresholds, instruction-file ceiling and trust and owner-scope toggles, and the `decision_model.enabled` opt-out, which only the operator turns back on. A setting of one machine (snapshots, storage, embeddings, decision-model endpoints) is refused with the machine-config key to set instead.

## Core principles

- Treat the vault as user-owned durable knowledge.
- Write brain memory only through Open Second Brain tools and commands. Never write to user-authored note folders.
- Keep raw operational evidence separate from synthesized knowledge: per-event records go to the brain log (`brain_apply_evidence`, `brain_note`), and preferences are promoted by the dream pass (`brain_dream`).
- Never write secrets, tokens, passwords, private keys, or credential-bearing connection strings.
- Prefer deterministic CLI commands (`o2b brain ...`, `o2b doctor`, `o2b status`, `o2b store path`) over guessing file paths.

## Default workflow

1. Check whether Open Second Brain is configured: `o2b status` or `second_brain_status` MCP tool.
2. Read the machine-local config if available (vault path, agent identity, timezone); `o2b status` prints it.
3. Read the current preferences with `brain_context` (CLI: `o2b brain export --format llms-txt`). When a task needs a location, ask `o2b store path` (store root, partitions, this device's state directory) instead of building a path.
4. Record taste signals as they arrive in dialogue via `brain_feedback` (see the `brain-memory` skill).
5. After producing a durable artifact, check applicable preferences and record evidence via `brain_apply_evidence` (see the `brain-memory` skill).
6. For read access to vault pages by title, use `second_brain_query`.

## Search surfaces

Name the surface a question is shaped for, and route to it explicitly:

- **Generic recall** - `brain_search` runs hybrid keyword + semantic search over raw chunks. Use it for open-ended, topical, or exploratory questions.
- **Summary surface** - for a question that targets a specific source or an artifact kind (a summary, digest, or other declared `schema.page_types` type), reach for the summary surface: search by source or filter by artifact kind rather than running a generic search over raw chunks. `brain_search` detects this structurally and returns `surface: "summary"` on the response as an advisory route hint; a source-targeted query uses a `source:<path>` token and an artifact-kind query uses a `kind:<type>`/`type:<type>` token whose value is a declared page type. The hint never changes ranking - it names the intended surface so the agent asks the right way.
- **Answerable signal** - when `brain_search` returns `decision_model.answerable`, pass its `probability` to `brain_recall_gate` or `brain_context_pack` as `decision_answerable` together with the scores and `match_quality`. `decision_answerable.disagrees: true` on the verdict means search again with other words, or say the vault may not cover the question; the level and action stay as they are.
- **Skill offers** - `skills_attach` offers skills for the current turn; when the operator configured the optional `skills` decision-model use it may be decision-model assisted (the result then carries a `decision_model` field). Cite its `offer_id` on `get_skill` either way.

## Safety

If a write operation might affect anything outside the brain memory, ask for explicit confirmation. When in doubt, record through the brain tools rather than editing a vault file.

Decision-model verdicts (`decision_model` on `brain_hygiene scan` dedup findings, doctor alias candidates and `brain_tension verify`) are advisory only: merges, dismissals and resolutions still need an explicit action.

To label a note, call `brain_labels suggest` before `assign`; `suggest` never assigns, and a null suggestion means no confident value.

## See also

- `brain-memory` skill — when and how to call `brain_feedback` / `brain_apply_evidence`.
- `o2b store path` and the `store` block of `second_brain_status` — where the brain store, its partitions and this device's state live.
- `docs/plans/2026-05-15-brain-observing-memory.md` (in the repo) — full design.
