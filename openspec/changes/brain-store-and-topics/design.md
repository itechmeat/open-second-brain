# Design

## Context

See proposal.md for the motivation and brainstorm.md for the chosen approach. Facts from the code and a live install (2026-11-06) that shape the design:

- **Catalogue.** `src/core/state/surfaces.ts` (`STATE_SURFACES`, about 60 rows) already lists every state location the product keeps in the vault, with its tier and reason. It is the migration manifest.
- **Sharding.** `src/core/brain/ledger-shards.ts` already shards append-only ledgers per device (`<base>.<deviceId>.jsonl`) and merges them on read in order (key, shard id, line). The new store generalises this pattern.
- **Device id.** It lives in device-local config and is never synced (`src/core/config.ts`). Nothing that every machine must agree on can live there.
- **Writes today.**
  - Signals are one Markdown file each (6.6k live).
  - The log append (`log.ts`) takes a directory lock, re-reads the whole day file and rewrites it atomically for every event, about 5k events a day per device.
  - `pinned.md` is written read-modify-write with no lock.
  - Preferences are Markdown files under per-file locks.
- **Index.** `brain.sqlite` can already be relocated (`search_db_path`). It holds vault-relative paths, and 6,655 of its 7,928 documents are signals.
- **Defects the move must fix rather than carry over:**
  - `.state/anticipatory/` is never pruned (3,647 files, 305 MB).
  - Upgrade snapshots bypass retention (911 files, 1.7 GB).
  - The dream pass has not run on the live install since 2026-05-24, which is why 6.6k signals sit unprocessed.
- **Vault assumptions.** Obsidian is required only by `.base` files and by wikilinks used as record identifiers. Note tools (`brain_create_note` and related) already refuse `Brain/` paths.
- **Outside readers.** Skills (`skills/brain-memory`, `skills/open-second-brain` and the `plugins/codex` mirrors), the MCP instruction segments, hook messages and the MCP resources `osb://log/{date}`, `osb://preference/{id}` and `osb://topic/{slug}` hard-code `Brain/` paths or the old meaning of "topic". The Python Hermes shim delegates to the CLI and needs no path logic.

## Goals / Non-Goals

**Goals:**

- No Open Second Brain machine file in the vault after migration.
- One store folder (two with the `private` partition) for the user to sync.
- Same folded state on every machine.
- Reads that see a neighbour's record as soon as file sync delivers it.
- Context injection bounded by budgets.
- A brain that works with no vault at all.

**Non-Goals:**

- A server, relay or real-time channel.
- Encryption at rest. It is documented as the sync or disk layer's job.
- Changing the CLI or MCP tool contracts beyond new verbs and new optional fields.
- Rewriting in Rust. Formats must simply be easy to port.
- Changing how user notes are written.
- Multi-user brains: one user, several machines.

## Decisions

### D1. Store layout

```
<store>/
  FORMAT.md                         format document (versioned, shipped)
  shared/                           partition, synced to every working machine
    events/<device>/<YYYY-MM>.jsonl     signals, evidence, notes, feedback
    log/<device>/<YYYY-MM>.jsonl        operational log, lifecycle, continuity
    ledgers/<name>/<device>/<YYYY-MM>.jsonl   idempotency, audit, metrics, receipts, lineage
    topics/<device>/<YYYY-MM>.jsonl     topic events
    settings/<device>/<YYYY-MM>.jsonl   shared settings (view writer, thresholds, migration records)
    digests/<device>/<YYYY-MM>.jsonl    state digests
    blobs/<sha256[0:2]>/<sha256>        large bodies, immutable
  private/                          same shape, for private-visibility records
                                    shared/ and private/ are synced as separate folders;
                                    the store root itself is never a sync folder
<device-local state dir>/           never synced: index, locks, caches, hook state,
                                    snapshots, maintenance lease, freshen state
```

The device-local directory comes from the platform data directory (`src/core/platform-dirs.ts`), keyed by store id.

Alternatives:
- One shard per writer process, as the author first proposed. Rejected: process ids churn, so the shard count grows without bound.
- One shard per device per day. Rejected: about 30 times more files than monthly shards, with no gain.

### D2. Appends

A record is one JSON line written with a single append (`O_APPEND`) call, under a device-local advisory lock on the shard. The lock is held only for the write and is never synced. Lines stay under a size cap; larger bodies go to `blobs/`. This replaces the full-file rewrite in `log.ts`.

On Windows the append opens with `FILE_APPEND_DATA` inside the same local lock.

Alternative: lock-free `O_APPEND`. Rejected because Windows append atomicity is not guaranteed for every size, and the local lock is cheap.

### D3. Envelope and clock

Every record has this shape:

```
{ "v": 1, "id": <ulid>, "hlc": "<physical_ms>.<counter>", "device": <id>,
  "agent": <name>, "kind": <kind>, "scope": <scope>, "topic": <topic id|null>,
  "sum": <sha256 of body>, "body": { ... } }
```

- **Fold order** is (hlc, device, id).
- **Clock rules.** Standard HLC.
  - Send: the physical part is the larger of the wall clock and the local clock; the counter increments on a tie.
  - Receive: every catch-up raises the local clock to the largest clock it ingested.
  - So a record written in reply to a remote record always folds after it, even when the replying machine's wall clock is behind. Skew of seconds is harmless at sync latency.
  - As built (phase 2): reading is receiving. Every shard read raises an in-process floor for its store, and the next stamp for that store takes the receive rule over the floor first, so a write that replaces, removes or raises a record the operation read (a replacement, a tombstone, a privacy raise) folds after that record even when its device stamped it minutes ahead of this machine's wall clock. A stamp more than a day ahead is still not adopted.
- **Readers** skip an incomplete or checksum-failing last line and retry it on the next pass. A failing middle line is reported by doctor.
- **Unknown `v`:** the record is skipped and doctor reports it.

### D4. Folds of mutable entities

Preferences, pinned context, topic fields, assignments and settings are folds over records with precedence human > agent > decision model, then the later clock wins within an authority. Removal is a tombstone record.

- Preference counters (applied, violated) are derived in the fold, not written back. This removes the stale-counter class of bugs.
- The existing preference audit trail (`pref-audit.ts`) becomes these records.

### D5. Index

`brain.sqlite` moves to device-local state and gains three things:
1. A watermark table per shard: path, file identity (inode or Windows file id), size, mtime, byte offset and a hash of the verified prefix. A changed identity, a size below the offset, or a prefix hash mismatch resets that shard to offset 0. The re-read is idempotent by record id.
2. A `records` table (id, stream, kind, scope, topic, hlc, device, agent) beside the existing documents and chunks.
3. A source column that separates brain records from user notes.

Catch-up runs before reads: stat each shard, then read only from the stored offset. Stats are throttled to once per second per process, and a directory listing is cached by directory mtime. The phase 1 benchmark (500 shards, nothing changed) must stay under 20 ms. The change probe ("what is new since W") is an index query, not a file read.

A full rebuild uses the existing `brain.sqlite.new` and swap path.

### D6. State digests

Digests are computed per partition over an explicit cut. A cut is a vector of (shard, record count, last record id) for every shard the machine holds in that partition, excluding the `digests` stream itself, so publishing a digest never changes the cut being compared.

After catch-up, a machine writes a digest record carrying the cut and a hash of each fold computed from exactly those records. Doctor compares only digests whose cuts are identical, so idle devices, offline devices and machines without a partition never produce a false alarm or a stall.

Roster: the devices with records in the partition during the last 30 days, minus devices retired by a `device-retire` human record. Doctor reports a roster device that has published no digest for 7 days.

### D7. Human view: one configured writer

**One writer.** The human view and topic-creating dream steps have exactly one writer device, the *view writer*. It is named by a `view-writer` human settings record in the `shared` partition, so every machine agrees on it.

- The first machine that migrates or initialises the store records itself as the view writer.
- `o2b view writer --here` moves the role in two steps:
  1. It records a `view-writer-request`.
  2. The current writer sees it at its next catch-up, finishes any render in progress, and records `view-writer-released`.
  3. The new device renders only after it has caught up on that release record.
- `--force` skips the release when the old writer is unreachable, with a warning that a still-running old writer may write pages once more before it catches up. The old writer always catches up before rendering, so it stops at its first render after the change reaches it.
- When two machines initialise a store at the same time, the claim with the lowest (clock, device) wins once both claims sync. The loser has written no pages, because a fresh writer waits one full catch-up after its claim before its first render.
- Another device never writes view pages, even when the writer is offline. Pages then go stale, but no data is lost.
- Doctor on every machine reports a view writer that has published nothing for 3 days, and names the command to move the role.

Alternative: an expiring lease that passes the role on automatically, as the partner first proposed. Rejected by the review: delayed file sync cannot make a lease exclusive, so two holders could render different record sets into conflicting copies of one page.

**Render protocol on the writer:**

1. Catch up.
2. For every page, compare the file on disk with the checksum in the last render record.
3. A mismatch is a human edit. Three-way merge it with the base (the last rendered text, kept as a blob referenced from the render record), the file on disk and the new render. Store the user's changes as human records before rendering.
4. Render to a temporary file and check the page checksum once more right before the rename; if it changed, go back to step 3.
5. Write a render record (page, checksum, base blob).

**No silent loss.** A phone edit that lands between the last check and the rename could be overwritten, and not every sync tool makes a conflict copy. To keep that edit recoverable:
- Before every rename the writer stores the on-disk bytes it replaces as a blob, kept for 30 days.
- After the rename it re-reads the page. If the replaced bytes differed from the base, it ingests them as a human edit and renders again.
- A sync-conflict copy of a page, when the tool makes one, is ingested the same way and then removed.
- `o2b view recover <page>` lists the replaced versions.

Promise to users: an edit is never silently lost. An edit that races a render may arrive one render later.

**Pages.** `about-me.md` (the profile page), `history/<YYYY>-W<ww>.md`, `decisions.md`, `reports/<slug>.md`, `sources/<slug>.md` and `topics/<date>-<slug>/topic.md`.
- Each page has one HTML comment line with its store id.
- There is no frontmatter and there are no Obsidian-only links.
- Generated prose uses `view.language` (a shared setting); quoted text stays in its original language.

### D8. Topics

A topic is a record family with an immutable `topic_id` (ULID). Topic events:

- `topic-create`, `topic-rename`, `topic-status`, `topic-goal`
- `decision`, `open-question`, `question-resolved`
- `log-entry`, `milestone`, `milestone-done`
- `assign`, `unassign`, `merge`, `split`, `link`, `undo`

Page schema: title, one-line description, status, goal, milestones, decisions, open questions, log (newest first), related. Decisions use one plain list with "serves" links where they help. The office prior art's four groups (Need, Surface, Internals, Method) are left out of version 1 because they fit engineering topics but not personal matters.

Code naming:
- The new entity owns `topic` in code, the CLI and MCP.
- The existing preference slug becomes `ruleTopic` / `rule_topic` in code; the persisted `topic` field on signals keeps its name for compatibility and is read as `rule_topic`.
- The resource `osb://topic/{slug}` becomes `osb://rule-topic/{slug}`. The old name is kept as an alias for one minor version, and the new `osb://topic/{id}` serves topics.

### D9. Automatic and requested topic actions

Only the view writer runs the topic-planning step of dream, under a device-local exclusive lock, so neither two machines nor two processes on the writer create the same topic twice. Dream assigns unassigned events to topics and creates a topic when at least N related unassigned events (default 5) from at least two sessions fall in one scope. Assigns and creates apply at once; each is listed in the dream report and can be undone with one command. Merges and splits are only proposed, in briefs and the digest, until the user confirms.

A topic created by request on another machine gets a fresh id there. If the planner later sees a near-identical topic, it proposes a merge (`topic_same`) and never merges silently.

Requested actions come through MCP tools (`brain_topic`, with actions create, assign, rename, status, merge, split, archive, undo) and the matching CLI verbs. Each is recorded as a human record.

### D10. Decision-model uses

All uses plug into `src/core/decision-model/` with modes `off`, `shadow` and `enforce`; every use is off by default.

| Use | Question | Deterministic fallback | Where it runs |
|---|---|---|---|
| `topic_route` | which active topic, or none | scope match plus lexical similarity over topic heads | writer, at record time |
| `event_kind` | decision, open question, log-worthy or routine | the kind the agent passed; otherwise routine | writer |
| `human_readable` | belongs in history or not | only records the agent flagged significant | renderer |
| `topic_new` | does this cluster deserve its own topic | count and session threshold | dream |
| `topic_same` | are two topics one topic | none (no proposal) | dream, reuses `pair-verdict` |
| `question_resolved` | does this record answer q{n}, and which one | none | dream |
| `milestone_done` | does the milestone look done | none | dream (proposal only) |
| `head_select` | which topic heads to inject | recency and scope ranking | session start (reuses `recall_inject`) |
| `neighbour_relevant` | does a neighbour's record matter to this task | same topic id and kind decision | before a turn |

- **Verdicts stored once.** A verdict is stored in the record it decides, with model id, version, mode and confidence. Folds read the stored verdict and never call a model, so machines converge.
- **Private data stays local.** Uses that read `private` records refuse a hosted provider unless the user opts in per use.

### D11. Migration

The command is `o2b brain migrate-store [--dry-run] [--resume] [--rollback]`. `o2b upgrade` offers it, and doctor and status report it. It never runs without consent.

Order of work on the first machine:

1. **Preflight.** Config, free disk, no other migration running, store root outside the vault, and the device roster of the legacy tree. The roster is every device id found in legacy shard names during the last 30 days; the report lists them.
2. **Quiesce this machine** through a device-local migration gate, not the synced fleet freeze marker (`freeze-marker.ts` is shared across machines).
   - Every writer takes a shared lock on the gate file in the device-local directory for the length of each write.
   - The migration takes the exclusive lock. It waits until in-flight writes drain, then holds the lock to the end.
   - Writers that find the gate held refuse with a "migration in progress" message.
   - The phase 2 test runs several writer processes against one migration.
   - As built (phase 2): the gate is one device-local file, checked by the vault write guard every content writer passes, so a write that starts while the gate is held is refused. A write already past the guard when the gate closes is not waited for by a lock: a settle period after closing the gate lets it finish, the final delta pass imports what it left, and the transition import (D11a) picks up anything that lands later. No per-write shared lock is taken.
3. **Back up.**
   - Take a snapshot of `Brain/` through the existing snapshot path.
   - Make an explicit backup of every non-rebuildable `.open-second-brain/` surface. `STATE_SURFACES` marks secrets, keys, attestations, ingest and import checkpoints and lockfiles; the snapshot path excludes them today (`path-constants.ts:188`).
   - Each backup is verified by a restore into a temporary directory.
4. **Map.** Walk `STATE_SURFACES`. Each surface maps to a stream, a blob, device-local state, or "drop" (derived caches only). An unmapped surface fails the dry run.
5. **Convert.**
   - Signals become `events` records, using their original `created_at` as the clock's physical part.
   - Log JSONL lines keep their hash chain inside the body.
   - Preferences become seed records plus their audit history.
   - The journal is per item, and per line for append-only files: (device, source path, line or item, checksum, record id). Matching uses the whole key, never the checksum alone, so two distinct legacy records with identical content stay two records.
6. **Final delta pass.** Re-scan every source and import whatever changed or grew since its journal row. Repeat until a pass imports nothing.
7. **Verify** every journal row against the store.
8. **Render the minimal human view** (see D13 phase 2).
9. **Switch.** Record `migration-done` in the shared partition, carrying the per-partition cut of what was imported. Lift the freeze; writers now use the store only.
10. **Leave the legacy tree in place**, read-only to this machine, until every roster device has switched (D11a).

**D11a. Mixed versions.**
- **Upgraded machines import late writes.** A machine still on the old release keeps writing into the legacy tree, and sync delivers those files to upgraded machines. Upgraded machines import them line by line through the journal: new or grown lines only.
- **When the legacy tree leaves the vault.** At preflight the first machine records a durable *migration cohort*: every device id found anywhere in the legacy tree, with no age window. The tree leaves the vault only after every cohort device has written `migration-done` or `device-switched`, or has been retired by a human record, or the user passes `--force` (the report names the devices that will stop receiving data). A device that stays offline for months keeps the tree in place until one of these happens. Then the tree moves to a dated archive in the device-local state directory. It is never deleted automatically.
- **Until then** doctor on every machine lists the devices still on the legacy layout.

**Later machines.**
- A later machine waits until its catch-up holds every record of the `migration-done` cut for the partitions it holds, which protects against the record arriving before its data. A partition it does not hold is skipped and named in its report.
- It then runs the same pipeline over its own legacy files, because they may hold records the first machine never saw. The journal skips anything already in the store by checksum.
- It backs up and moves its own device-local surfaces, then writes `device-switched`.

**Rollback** (`--rollback`, per machine, until the legacy tree leaves the vault):
1. Freeze this machine.
2. Restore the snapshot and the explicit backups.
3. Replay into the legacy layout every store record whose stable identity (record id, or the legacy key for imported records) is absent from the restored tree. That includes remote records that arrived after the snapshot. Replay runs in fold order through legacy exporters for signals, log events, preferences, pinned context and notes, is idempotent, and can be resumed through its own journal.
4. Record kinds with no legacy form (topics, view renders, digests) stay in the store and are listed in the report.
5. Switch config back to the legacy layout and lift the freeze.
- As built (phase 2): a rollback is per migrated vault. The backup records the vault it was taken of (identity marker, else the real path), and a rollback for any other vault is refused before any file is touched. A vault a switched machine only imported through the transition (D11a) has no backup of its own and needs none: the transition never writes into its legacy tree. The transition binds such a vault only when nothing was held back and its operator settings, `_permissions.yaml` included, were imported without a conflict with the stored document.
- As built (phase 2): the same held-back rule gates the removal of the legacy tree (D11a). While the transition import holds an item back for a partition this machine does not hold, the removal refuses, names the count and the partition, and `--force` does not override it, because a rollback is refused once the tree has left the vault. A migration killed after its switch record is finished only for the vault it migrated (compared as a rollback compares it); a vault configured since stays unbound and goes through the transition's own checks.
- As built (phase 2): the journal keys every import by the vault it came from as well (identity marker, else the real path, compared as a rollback compares them; the store holds only a hash of the path), so an identical item at the same path of a second vault gets its own record. Rows and records written before carry no vault and count for the first vault this machine migrated, never for another. The migration, and the transition that binds a vault, record the automatic import's legacy-file watermark from the stamps taken before their final delta pass; with no watermark the automatic import runs and the journal decides what it still lacks.
- As built (phase 2): a dual-written copy stands in only for an item of the vault it was dual-written from. The content match leaves the vault out, so the pool checks it: a copy whose `vault_id` names a marker counts only for the vault with that marker, and a copy with none counts only on the device that wrote it, for the vault that device migrated. An identical item of another vault, or one whose unmarked copy another device wrote, gets a record of its own: a duplicate, never a merge.
- As built (phase 2): a path is device-local, so the migration (first and later machine) gives a vault without an identity marker its marker before it writes any journal mark, and the marker reaches the other machines by sync. A mark from another device proves a vault only by its marker id; a mark that names a path alone, or no vault, counts only on the device that wrote it and only for the vault at that path. A later machine whose vault has no marker, while another device's migration named its vault by one, waits for the marker to arrive instead of minting a second one; for a vault that is a different one, `o2b brain init` gives it its own. The transition on a switched machine writes nothing into a vault's legacy tree (item 1 of D14), so it creates no marker: a vault it imports without one gets path-only marks, and another device imports its own copy of those items rather than merge them with another vault's.
- As built (phase 2): a data path that ends in a step a later run cannot take back reads the store completely or not at all. While any held shard (the `digests` stream aside) is unreadable, gone since this machine read it, or read only in part, the rollback refuses before it touches anything and again before its restore, names the shards, and keeps the switch; the removal of the legacy tree refuses (a partial shard only without `--force`, as for a `settings` shard); the transition imports a vault configured after the switch but does not bind it and names the shards; and the migration refuses in its preflight and again before its switch steps, so the machine stays on the legacy layout.
- As built (phase 2): the rollback matches what the restored tree already holds per vault, by the journal's rule: a `migrated` mark counts as restored only when it names this vault, and a dual-written copy stamped with another vault's marker is never matched by content. Another vault's occurrence of an identical item is written back beside this vault's. A copy that names no vault keeps the content match, so a peer's dual write from before the marker is not written back twice.

Doctor reports legacy directories that reappear after the tree left the vault, with the writer when known.

### D12. Path discovery

`o2b store path` (JSON: store root, partitions, device state dir, view target) and an MCP field in `second_brain_status` replace hard-coded paths. Skills are rewritten to name tools and commands only, and `plugins/codex` mirrors are regenerated with `bun run sync-plugin-mirrors`.

### D13. Phasing

The change ships in four releases, each one PR carrying its own version bump, CHANGELOG entry and docs:

1. **Store core:** layout, envelope, appends, folds, digests, index catch-up. Writes go to both the store and the legacy tree behind a flag that is off by default. The defect fixes (cache prune, snapshot retention, log append, pinned lock) ship here.
2. **Migration, the vault-free mode and the minimal human view:** the view writer, the render protocol and the pages `about-me.md`, `history/` and `decisions.md`, so the preferences that leave the vault have a readable replacement on the same day.
3. **Topics, plus reports and sources pages.**
4. **Decision-model uses and agent-context budgets.**

### D14. Store-only mode: answers the phase 2 inventory raised

The inventory for task 2.10 (316 modules reach the legacy tree) raised questions the decisions above did not settle. They are settled here so the work can split into parallel packages.

1. **Switch.** A machine is store-only once it holds its own `device-switched` record (D11, D11a); a fresh install with no legacy tree is store-only from the first write, and `o2b init` runs `o2b store init`. In store-only mode a store failure fails the operation with the reason and the remedy; nothing is skipped silently. Hooks and other fail-open paths log the failure to the device-local hook audit and continue.
   As built (phase 2): the switch is sticky per machine. The migration and the fresh-install switch record it in a device-local marker as they switch the device, and from then on the marker alone answers switched: a `settings` shard that is absent or unreadable while sync delivers it never sends the machine back into the legacy tree, and every check of whether this device switched (the migration's preflight, the rollback, the automatic import, the status block, doctor) reads the same marker. Only a rollback clears it. The removal of the legacy tree refuses while any `settings` shard of `shared` cannot be read, since a cohort record or a peer's switch in it would be missed.
2. **Record lanes with no record kind** (decisions, obligations, pledges, theses, tensions, gap tasks, attention flows, entities, procedures, procedural memory, skill proposals and benchmarks, captures, clusters, bridge proposals, triggers, handoffs, dead-ends, personas, write sessions, foresight, dream staging, architect projects, the profile page, report snapshots): one generic kind, `lane-entry`, with the lane name, a stable entry id, the structured fields the page carried in frontmatter and the Markdown body. Entries fold by id under D4. Their tools read the fold and work with no vault. Pages for people come from the view (phase 2 `decisions.md`, later phases for the rest), never from these records' old files.
3. **Settings.** Each `_brain.yaml` key is classified once: keys about one machine belong in device config; keys every machine must agree on become shared settings records (D1, `fold-settings`). Migration imports the changed shared keys of `_brain.yaml` as records and writes the changed device keys into the machine config as `<key>: <JSON value>` lines, never over a key the config already sets (the user's value stays), and reports what it wrote and what it kept, so a device key does not fall back to its default on the switched machine. A single reader returns the folded settings with defaults; the 39 readers call it. `_permissions.yaml` is a shared setting too: `permissions.document` holds its text, only the operator (human authority) sets it, the migration imports the file, and every gate reads the setting first and falls back to the file only on an unswitched machine where the setting is unset; doctor warns (`permissions-legacy-only`) when deny rules sit in a legacy file no gate reads.
4. **Standing rules** are human-authored: `lane-entry` records in lane `standing-rule` with authority `human`. A view page for them comes in a later phase; until then the CLI and MCP tools edit them.
5. **Signal lifecycle.** Moves between inbox folders become `signal-state` events (consumed, archived, retired, expired, staged, approved, rejected) keyed by signal id; the signal fold gives the current state.
6. **Backup-class surfaces** (secrets, signing keys, checkpoints, lockfiles) live in the device-local state after migration and are never synced; migration backs them up explicitly (D11). Attestation records are shared records; the keys that sign them stay device-local.
7. **Digests.** `active.md` and `lessons.md` are rendered on demand for hooks and MCP resources, with a cache in the device-local state. They are not view pages.
8. **Vault adapter.** One module, active only when a vault is configured, owns everything Obsidian-specific: `.base` files for user notes, wikilink audits and the note tools' vault requirement. No `.base` file queries store data; view pages carry no frontmatter for one to query.
9. **Snapshots** after migration cover the device-local state. The store needs none: shards are append-only with per-record sums and partition digests (D6). The migration snapshot (D11) covers the legacy tree until removal.
10. **Integrity.** Legacy day-file hash chains stay verifiable by the legacy reader. Store integrity is the record sums plus partition digests over cuts; there is no per-record chain.
11. **Derived ledgers** (rollup ladder, cross-topic) are device-local and recomputable; machines need not agree on them.
12. **Exports** (`export`, knowledge pack, OKF, bundle) read the folds and may keep the legacy layout as an interchange format. They are exporter modules for the 2.10 grep.
13. **Write guard.** In store-only mode the vault identity guard is replaced by the store identity check (store id and device id bound in the device-local state); the freeze marker is device-local. Note tools keep the vault identity guard through the adapter.
14. **Vault filtering.** Store reads do not filter by `vault_id` (one brain across vaults, D1); `vault_id` stays as provenance. The search index lives in the store's device-local state, one per vault (keyed by a hash of the vault's real path), and is keyed by the store id when no vault is configured.
15. **MCP tokens** move from per-vault files to device config, so a server with no vault still enforces them; migration copies them. As built in 2.10 only the read side has moved: the transport reads `mcp-tokens.json` beside the machine config when it exists (with or without a vault) and otherwise the per-vault file (`src/mcp/token-source.ts`). The migration copies the per-vault file there (never over a device copy already present), and a rollback removes that copy again (or sets it aside when it changed since), so the per-vault file is the token map once more. On a switched machine minting, rotation and revocation write the device-config copy too (starting from the per-vault map when no copy exists yet), with the custody audit in the store, so a token minted after the switch authenticates with or without a vault.
16. **The 2.10 checks.** The test preload configures no vault; tests that need one create it. The grep is an architecture test with an allowlist and a reason per entry, covering the `Brain/` literal and `"Brain"` path segments in code, not comments; comments are updated by the package that owns the file.
17. **Note-tool walls** that refuse `Brain/` paths stay until the legacy tree is removed (D11a) and count as legacy modules.
18. **Privacy judge.** Once switched, reference privacy reads the preference and signal folds, not legacy pages; a reference the folds cannot resolve still counts as private (fail closed).
   As built (phase 2): a write that replaces an existing store-backed entry (a lane page or file, a tension transition, an entity merge or label prune, an exact-state aspect) keeps the strictest partition of the entry it replaces: an entry that lives in `private`, or whose fields reserve it, stays private whatever the new content says. No agent overwrite lowers a partition; an entry becomes shared only by removing it and writing it anew.
   As built (phase 2): a tombstone carries no content, so it goes to the partition of the entry it removes whatever the rest of its operation is, and no enclosing verdict raises it; this is the one exception to one partition per operation. A folder move or removal places each entry and its tombstone in that entry's own partition (a moved entry can still be raised, never lowered), so a device that holds only `shared` sees a shared entry leave a mixed folder. A write that raises a shared entry to `private` (a lane page or file, an exact-state aspect) writes the entry's shared tombstone first in the same store write, so a device that holds only `shared` sees the entry go and a device that holds both reads the private value.
   As built (phase 2): a store read whose answer decides a protection fails closed when it cannot see a shard it should consider. A shard counts as unseen when it cannot be read, or when this machine read it before and it is gone now: every stream listing records the shards it saw in a device-local ledger per store (`seen-shards-<root hash>.json`), and a shard the ledger names that the listing no longer finds is reported as unreadable, unless a `compacted` record replaced it or a human retired the device that wrote it. On an unseen shard a lane or exact-state write is judged private (refused on a machine without `private`), an exported lane entry counts as private, the capture boundary captures nothing, the permissions gates refuse, an agent settings write is refused (`settings_unreadable`), a signal removal refuses, the brain settings readers throw instead of answering defaults, and the decision ledger throws instead of answering "never gated". Doctor reports each unseen shard by its path (`store-shard-unreadable`). A shard read only in part counts as unseen too: one that holds a record whose body blob has not arrived, or a bad line in the middle (a checksum or envelope that does not verify, a record of a newer format). Its readable records are still read, and no fold cache keeps a read over an unseen shard, so the fold is read again once the blob arrives even though the shard did not change. Two cases are not gaps: the last line held back while an append is still arriving (the existing reading rule), and a line torn by a crash and closed by the next append, recognised as a JSON object cut short and never a record any machine read. The removal of the legacy tree refuses on a `settings` shard read only in part unless `--force`, since such a line may never read again; doctor's shard check does not report a partial read as an unreadable shard. On a machine the sticky marker names switched, a store that cannot be opened (`store.json` missing or corrupt) or that no longer shows its `shared` partition is unseen as a whole, never "no store, no rules": the permissions gates refuse, the brain settings readers throw and capture closes, an agent settings write is refused (`settings_unreadable`), lane and exact-state privacy is judged private, a signal removal refuses, and the decision ledger and the attestations refuse to read as empty. A machine that never switched still reads "no store" as nothing stored. The partitions a machine holds are sticky the same way: opening a store for writing and `o2b store init` record, in a device-local list per store root, every partition this machine holds, and a listed partition whose `store.json` is now missing makes the store unopenable by name. On every store-only machine (switched, or with no legacy tree) every protection reader then fails closed as for an unopenable store, so a private lane entry is never read as shared because its partition's identity file went away; every store write refuses, and doctor names the partition (`store-partition-lost`, an error). A machine that never held a partition (set up with `--partitions shared`) keeps working with the partitions it has. No command takes a partition off the list: the remedy is to restore its `store.json` from sync or a backup.

## Risks / Trade-offs

- [A fold bug makes machines diverge silently] → state digests with doctor alerts (D6), property tests that shuffle delivery order and duplicate lines, and a rebuild command.
- [Clock skew orders two concurrent edits against the user's intent] → authority precedence decides most conflicts before the clock does, and the losing edit stays in history.
- [The view writer is offline for a long time] → pages go stale but no data is lost; doctor on every machine reports it after 3 days and names `o2b view writer --here`.
- [A phone edit races a render] → re-check before the rename, and ingestion of the resulting sync-conflict copy as a human edit (D7).
- [Legacy writers on other machines keep writing during migration] → per-line journal, final delta pass, imports during the transition, and the legacy tree stays until every roster device has switched (D11, D11a).
- [Rollback after new writes] → replay into the legacy layout through exporters (D11).
- [Skills still tell agents to use `Brain/` paths] → skills rewritten in phase 2 and legacy-tree detection in doctor (D11, D12).
- [Large migration on a slow disk is interrupted] → per-item journal, `--resume`, and no source removal before verification.
- [Users sync the device-local directory by mistake] → it lives outside the store root by default, and doctor reports another device's id inside it.
- [A cloud-drive sync tool changes whole files under a writer] → one writer device per file; doctor reports conflict copies and torn middle lines.
- [The private partition is missing on a server agent's machine] → writes of private records refuse with a clear message; reads work on what is present.
- [Phase 1 dual writes double disk use for a release] → the flag is off by default and documented as a trial.

## Migration Plan

D11 is the plan, including rollback. The transition window ends per install when the legacy tree leaves the vault (D11a). Code for legacy reads and rollback stays for two minor releases after the release that ships the migration.

## Open Questions

- The roster window (30 days), the digest silence alert (7 days) and the view-writer silence alert (3 days) are to be tuned with real multi-machine data. They do not change the specs.
- The weekly history page budget (lines per week) is to be tuned once the `human_readable` use has shadow data.
