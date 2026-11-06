# Brainstorm

## Problem

Open Second Brain writes all of its machine data into the user's Obsidian vault under `Brain/`. On a real install that is about 7.7k of the roughly 8.3k files Obsidian indexes (6.6k signal files, about 800 log files, 238 preference files), plus about 2 GB of hidden snapshots and ledgers that file sync still ships to every device, including phones. Obsidian mobile chokes while indexing them. The feature must move machine data out of the vault into its own store, keep only human-readable material in a human-facing view, make Obsidian optional, and add user-facing topics, without giving up the product's values: user-owned open data readable without the tool, any agent runtime, append-only recoverable evidence, and one brain shared by several machines.

## Related work

- No OpenSpec specs exist yet in this repository; this is the first change.
- Paths are centralised in `src/core/brain/path-constants.ts` (`BRAIN_ROOT_REL` and the per-lane constants), so relocating the store is a bounded change at the path layer.
- The derived index `.open-second-brain/brain.sqlite` is already per-device and excluded from file sync.
- The decision-model framework (`src/core/decision-model/`, `docs/decision-models.md`) already provides `off`/`shadow`/`enforce` uses, a canonical deterministic fallback, a daily cost gate, local thresholds and local-model routes.
- The existing word "topic" in the dream pass (`dream-plan-topics.ts`, `topicKey`) means a preference slug. The new user-facing topic needs a different name in code.
- Prior art studied: the "office" memory setup of another project the owner uses (fixed `topic.md` schema with Goal, Milestones, Decisions, Open questions, newest-first Log, Related; one owning skill per memory folder; topic heads handed to agents for routing; a gardener pass that archives finished topics). The owner reports it works very well, especially running one area of work or one matter per topic.

## Doubts

1. Ordering and merge rules across machines: which clock orders records from different writers, and how mutable entities (preferences, pinned context, topic fields) resolve concurrent edits deterministically on every machine.
2. Several agent processes on one machine at once: one shard per writer process versus one per device with a local lock, and what happens on Windows where append atomicity differs.
3. File sync delivering a half-written last line of a growing shard; readers must skip it and pick it up later.
4. Index catch-up cost per query when many shards exist (stat every shard before each read?), and how a rebuild is triggered when the record format version changes.
5. The gardener: what happens when it is offline for days, when two devices claim it, and how a user edit to `topic.md` on a phone merges against agent events that arrived meanwhile.
6. Decision-model verdicts must be recorded once in the event; recomputing per machine would break convergence.
7. Migration of a live install without losing evidence, and readers outside the TS core (Hermes plugin, Python bits, skills that point agents at `Brain/...` paths).
8. Snapshot size: 1.7 GB of upgrade snapshots today. Should snapshots stay per device and unsynced, with retention?
9. Privacy: topic events may be personal, so the decision-model uses that read them should default to a local model.

## Approaches considered

1. **Files plus index, refactored (author).** A separate store directory synced between working machines and not to phones. Append-only JSONL shards with exactly one writer each (`events/<device>/<writer>/<YYYY-MM>.jsonl`), Markdown for documents, a per-device SQLite index that catches up from shard byte offsets, and generated human pages. Evidence: the derived index already exists and is per device; paths are centralised; Syncthing never conflicts on a file that has one writer. Cost: we own ordering, merge rules, compaction and format versioning. Risk: silent divergence if a merge rule is not deterministic; mitigated by a fixed reading order, a state digest compared across devices and property tests.
2. **DoltLite, one local database per device with per-device file remotes (research).** SQLite-compatible SQL with commit, branch, diff and merge, and vectors built in. Cost: native addon; the project is young (created 2026-03, beta since 2026-08); file remotes over Syncthing are untested; the data is not readable without its tool.
3. **SQLite session changesets as the sync log (research).** A normal local SQLite per device, with each transaction's changeset saved as an immutable file that file sync carries. Cost: binary changesets are not readable without a tool; Bun exposes sessions only through `node:sqlite` and per-OS support is unverified; we would write conflict handling across schema migrations.
4. **The owner's three candidates (TencentDB Agent Memory, HutchDB, CortexDB).** All three need a central server for several machines, and two are effectively single-author projects. See Rejected.

## Decision

Approach 1, decided by the owner after the research. Elements agreed in the discussion:

1. The store lives outside the vault, is synced between all of the user's working machines (workstations, laptops, servers) and never reaches the phone. Agents on different machines see each other's records with sync delay (seconds, sometimes minutes); the owner accepted that, so no real-time relay is needed.
2. One writer per shard, covering several concurrent agents on one machine.
3. A per-device index, never synced, caught up before reads.
4. The human view is a few generated pages plus topics, written into the vault, a plain Markdown folder or nowhere. Phones see only this view. The owner's test for what belongs there: readable by a person, not machine data that only looks readable.
5. Topics as folders with a fixed readable `topic.md`. They are created automatically during dream and on user request, and can hold any area: project, sub-project or personal matter. Agents write topic events and never the page. A single gardener device renders pages. User edits are merged back as human events and always win.
6. Context economy: agents get topic heads and budgeted rules at session start, pull detail on demand, and see neighbours' fresh events only when they matter to the current task.
7. Optional decision-model uses plug into the existing framework, off by default: route to topic, event kind, human-readable or machine, new topic, same topic, question resolved, milestone looks done, head selection, neighbour relevance. Verdicts are stored in the event once. Human events override them. Personal data goes to a local model by default.
8. Automatic and reversible actions (route an event, create a topic) apply with one-command undo and are listed in the dream report. Merges and splits are proposed and wait for the user. The author made this call because the owner's question was left open; the partner should challenge it.
9. Rust fit is a tie-breaker only. The design should port cleanly to a future Rust core, but TypeScript on Bun is the target now.

## Rejected

- TencentDB Agent Memory: an application built around a central server and an LLM proxy, not a store; devices cannot write offline and merge later.
- HutchDB: a Postgres server under AGPL plus a CLA, one developer, no releases, no vectors.
- CortexDB: a Go engine that needs a central gRPC server to share across machines; effectively one author; it competes with the product rather than serving as a layer under it.
- One SQLite file synced by file sync: a known failure that produced gigabytes of conflict copies on this install.
- cr-sqlite: no release since 2024-01.
- Turso and libSQL sync: offline writes sync only through a vendor cloud.
- ElectricSQL, PowerSync, rqlite, LiteFS: need a central primary or a quorum.
- Automerge, Loro and Yjs as the main store: they hold documents in memory and have no querying. They may still serve small mutable documents later.
- Agent-memory frameworks (mem0, Letta, Graphiti, Cognee, MemOS): built on external database servers; none merges writes from several machines without a server.

## Partner round: what changed

The partner agreed with approach 1 and pointed out that `src/core/brain/ledger-shards.ts` already implements its core. Accepted changes, each checked against the code:

1. Files per partition, stream, device and month, not per writer process. Process ids churn, so per-process shards would explode the file count. Agents on one device share the device file under a device-local lock.
2. No configured gardener. Device config is never synced (`src/core/config.ts`), so "the first device in shared config" has nowhere to live. Rendering is a pure function. The partner proposed an expiring lease; the review then showed that delayed sync cannot make a lease exclusive, so the final design uses one view writer device named by a shared human setting (design.md D7).
3. A hybrid logical clock in every record. Mutable entities fold by authority (human, agent, model), then by clock. Tombstones replace deletion.
4. Snapshots move out of the vault, stay per device and unsynced, and obey retention by manifest order. Upgrade snapshots currently bypass retention.
5. State digests and property tests become explicit requirements, not just mitigations.
6. Skills are the riskiest migration surface (`skills/brain-memory`, `skills/open-second-brain` name `Brain/` paths). Skills ask the CLI for paths, and doctor detects a regenerated legacy tree.
7. Immutable topic ids. Automatic topic creation needs recurrence across sessions. Undo is a synced human record.
8. The new entity owns the word `topic` in code. The preference slug becomes `rule_topic`.

Owner answers after the round: the owner trusts their own server with the full store, but the product is open source and other users may not. That led to the `shared` and `private` partitions and the documented threat model. The owner also asked for an explicit migration script, which is the `migrate-store` command in `specs/brain-migration`.

Calls the author made on the partner's minor questions:
- Topic pages carry no frontmatter, only one HTML id comment.
- The page set is fixed; only its target folder is configurable.
- During the transition window there are no dual writes after migration, only an import of late legacy files.
- The office prior art's four decision groups are left out of version 1 because they fit engineering topics but not personal matters.

## Open questions

None that change the specs. Tuning values are listed in design.md.

## Process

The author ran a discussion with the owner, a storage research pass (GitHub API, crates.io and web search, 2026-11-06) and a code inventory. Partner: an independent agent from another model family, one read-only round (the usual partner was out of quota).
