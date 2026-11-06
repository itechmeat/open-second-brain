# Proposal: brain store outside the vault, human view and topics

## Why

Open Second Brain keeps all of its machine data inside the user's Obsidian vault. On a real install this is about 7.7k of the roughly 8.3k files Obsidian sees, plus about 2 GB of hidden snapshots and ledgers that file sync still ships to every device, phones included. Obsidian mobile chokes while indexing them. The data a person actually reads is a small fraction of that, and a lot of the rest is machine state that only looks readable because it is Markdown. The product also assumes Obsidian is installed, which it should not.

The original values stay: the user owns the data in an open, documented format that is readable without the tool; any agent runtime can take part; evidence is append-only and recoverable; one brain is shared by several machines.

## What Changes

- **New brain store outside the vault.** All machine data (signals, event log, ledgers, metrics, payloads, archives, captures, session continuity) moves to a store directory of its own, configurable, synced as a separate file-sync folder between the user's working machines (workstations, laptops, servers) and never to a phone.
- **One writer device per file.** Streams are append-only JSONL files per partition, stream, device and month (`<partition>/<stream>/<device>/<YYYY-MM>.jsonl`); agents on one device share its file. Records carry a hybrid logical clock and a checksum, mutable entities are folds (human beats agent beats model, then later clock), and machines publish state digests so divergence is detected. File sync cannot create conflict copies, and every machine converges on the same state.
- **Any sync tool, or none.** The store works on a single machine, offline, and over any whole-file sync tool; no server is required.
- **Sensitivity partitions.** Records live in `shared` and `private` partitions, so a user can keep personal material off a server or a work laptop.
- **Local derived index per machine.** The SQLite index (full text, embeddings, rerank inputs) stays per device and is never synced. Before each read it catches up on the new bytes of changed shards; it can always be rebuilt from the store.
- **Human view.** A small set of generated, human-readable Markdown pages (what the brain knows about the user, weekly history, decisions, reports, topics) is written to a configurable folder. That folder can be the Obsidian vault, any Markdown folder, or nothing.
- **Topics.** A new user-facing unit with an immutable id: a folder per initiative, project, sub-project or personal matter, with a fixed readable `topic.md` (status, goal, milestones, decisions, open questions, log, related). The dream pass groups related material into topics automatically (recurring across sessions, undoable), and the user can create, move and close topics on request. Agents never edit `topic.md` directly: they record topic events, and one view writer device, named by a shared setting and moved only by the user, renders pages as a pure function of the records. User edits to the page are merged back as human events and always win.
- **Context economy for many concurrent agents.** At session start an agent gets only the heads of the active topics of its project plus its budgeted rules. Detail is pulled on demand. Fresh events from other agents on the same topic or project are surfaced only when they matter to the current task.
- **Optional decision models.** New decision-model uses (route an event to a topic, classify an event kind, human-readable or machine, new-topic and same-topic verdicts, question resolved, milestone looks done, which topic heads to inject, which neighbour events matter) plug into the existing `off`/`shadow`/`enforce` framework. They are off by default, and the deterministic result stays canonical. A verdict is recorded in the event once, never recomputed per machine.
- **Obsidian becomes optional.** Without a vault the store and the index work on their own. Obsidian-only features (Bases, wikilink audits of the user's notes) become a vault adapter that is active only when a vault is configured.
- **Migration script.** One idempotent, resumable command (`o2b brain migrate-store`) converts an existing brain into the store: dry run, snapshot first, per-item journal, verified checksums, rollback, and import of late legacy files from machines not yet upgraded during a transition window. Skills and plugins stop hard-coding `Brain/` paths and ask the CLI for the store location.
- **Defects fixed on the way.** The prompt context cache that is never pruned, upgrade snapshots that bypass retention, the log append that rewrites the whole day file per event, and unlocked `pinned.md` writes. **BREAKING** for anything that reads `<vault>/Brain/**` directly. The CLI, MCP and skills keep their contracts.

## Capabilities

### New Capabilities

- `brain-store`: the machine-data store outside the vault. Layout, one-writer shards, record envelope, ordering, convergence across machines, retention and compaction, snapshots and rollback.
- `brain-index`: the per-device derived index. Catch-up from shards, rebuild, freshness guarantees for reads, never synced.
- `human-view`: generated human-readable pages and where they are written. Works with an Obsidian vault, a plain Markdown folder or no view at all.
- `topics`: user-facing topics. Lifecycle, page schema, topic events, automatic and requested grouping, rendering by the view writer, human edits merged back.
- `agent-context`: what an agent receives at session start and per turn across many concurrent agents and machines. Topic heads, on-demand detail, neighbour updates, budgets.
- `brain-migration`: moving an existing in-vault `Brain/` into the store and the human view, with dry run, snapshot, verification and a transition window.

### Modified Capabilities

None. The repository has no OpenSpec specs yet. Existing behaviour lives in `docs/` and is updated as part of this change.

## Impact

- **Code:** `src/core/brain/path-constants.ts` and `paths.ts` (store root separate from the vault), every writer of `Brain/**` (signals, log, ledgers, captures, payloads), the index build and search (`src/cli/search`), the dream pass (topic planning on the view writer), snapshots and rollback, doctor and health, the MCP read and write tools, the decision-model uses and thresholds, and the session-start and prompt hooks.
- **Config:** new keys for the store root, the human-view target and the topic decision-model uses; the view writer and thresholds are shared settings records, not config keys. `vault` becomes optional.
- **Integrations:** the Hermes, Codex, Claude Code and OpenClaw plugins, the skills and `plugins/codex` mirrors, and any user scripts reading `<vault>/Brain/**`.
- **Sync setup:** users add one file-sync folder for the store and stop syncing `Brain/` machine data to phones. The docs gain a setup and migration guide.
- **Dependencies:** none new. Bun's SQLite and the existing embedding and decision-model providers are reused.
