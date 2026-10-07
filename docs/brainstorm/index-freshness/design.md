# Index freshness on read - the search index keeps itself current while agents work

**Status:** approved design, not implemented
**Audience:** implementation

## Problem statement

Nothing keeps the search index current. No write path updates it: the MCP writers, ingest, dream and the hooks all write Markdown and leave `brain.sqlite` as it was. The only automatic rebuild (`ensureVaultCurrent`) fires on a missing index or an old schema or chunker version, never on changed content. Freshness therefore depends on the operator running `o2b search index`, keeping `o2b search watch` in the foreground, or installing one of the printed cron recipes. On the reference machine the index went six days without a run: 223 new or changed notes were invisible to every search, and nothing reported that the index was behind.

## Measurements (reference vault, 5,811 Markdown files, 16 cores, NVMe)

| Run | Wall | CPU | Peak RSS | Disk write |
|---|---|---|---|---|
| no change | 0.30 s | 0.35 s | ~110 MB | ~0.6 MB |
| one note added or deleted | 0.30 s | 0.35 s | ~110 MB | ~1 MB |
| six days of drift (215 added, 8 updated) | 8.4 s | 5.1 s (60% of one core) | ~160 MB | ~1 GB |

The wall times include a bash start. An incremental run is cheap enough to run often. The catch-up run is cheap in CPU but writes about 1 GB, from two sources: the indexer works in WAL and consolidates to `journal_mode=DELETE` on close (a full checkpoint), and every run, an empty one included, repeats the whole-index post-passes (link and alias resolution, constraint flags, tier guard).

## Goals

1. A note written by an agent, or synced in while an agent works, becomes findable without anyone running a command.
2. Indexing never blocks the caller and does not get in the way of other work on the machine.
3. Only agent activity triggers indexing. No resident process, no OS scheduler, no Hermes cron.
4. How far the index is behind is visible to the operator and, when it matters, to the agent.

## Out of scope

- Any daemon, file watcher or timer that runs while no agent works. `o2b search watch` stays as the opt-in foreground watcher.
- Installing scheduler entries. The print-never-install rule for cron recipes stands.
- Embedding computation in the background by default (it costs money; see Configuration).
- Freshness of other derived state (clusters, bridges, dream). The maintenance lane keeps owning those.

## Chosen approach: refresh on read, plus catch-up at session start

A reader that finds the index older than a threshold answers from the index it has and starts one detached incremental index run in the background; the next read sees the result. `ensureVaultCurrent` (SessionStart hook and MCP server start) applies the same check, so a session starts from a caught-up index. Freshness is paid for where it is needed, at read time, and one seam covers agent writes and external changes (Syncthing, Obsidian) alike.

Rejected alternatives:

- **Catch-up at session start only.** Smallest change, but a session can live for days, and notes written during it stay invisible until the next one.
- **Index after each write.** The agent finds what it wrote, but changes made outside the agent stay invisible, and the trigger has to be threaded through every write path.

## Design

### 1. Trigger and entry points

- New module `src/core/search/freshen.ts` exporting `maybeFreshenIndex(...)`. It decides and, when due, spawns; it never throws and never awaits the run.
- Call sites:
  1. `search()` in `src/core/search/search.ts`, right after the store is opened. Every reading surface goes through it (`brain_search`, the recall tools, `brain_context_pack`, the recall-inject hook, the CLI).
  2. `ensureVaultCurrent` in `src/core/maintenance/ensure-current.ts`, so session start and MCP start catch up before the first read.
- A read-only open (`opts.selfHeal === false`: cross-vault and recall-source search) never freshens: it would write an index into a vault this device does not own. Same rule as self-heal today.
- Due when `last_indexed_at` in `index_state` is older than `search_freshen_interval_s` (default 60). One read of `index_state`; the vault is not walked by the caller.
- The run: a detached `o2b search index --vault <v> --config <c> --freshen <runId>`, spawned like the self-heal reindex (streams ignored, `unref`, `detached` on Windows, `env: { ...process.env }`). Keyword-only unless `search_freshen_embeddings` is on.

### 2. Single flight, throttling and priority

- **Claim.** Before spawning, the caller makes an exclusive create of `<vault>/.open-second-brain/freshen.claim` (`wx`), as the self-heal upgrade lock does. The winner spawns and hands the claim to the child, which removes it when it ends. A claim older than 10 minutes is treated as abandoned and taken over. A held writer lock (`isWriterLockHeld`) skips the spawn: some indexer (manual, self-heal, maintenance) is already running.
- **Throttle.** A successful run stamps `last_indexed_at`, so for the next interval every session's reads find the index fresh and spawn nothing. Under active use that is at most one run per interval.
- **Backoff.** A failed run writes a failure marker next to the claim. Spawns then wait 1 min, doubling up to 1 h, so a broken vault does not spawn a failing process per query. `doctor` reports the streak.
- **Priority.** The child lowers its CPU priority at start with `os.setPriority` (all platforms). On Linux the command is prefixed with `ionice -c3` and on macOS with `taskpolicy -b` when the tool exists; without it the run proceeds at normal I/O priority.
- **Caller cost.** One `index_state` read, one lock probe and one exclusive create: single-digit milliseconds. The run is always in the background.

### 3. Write cost and visibility

- **A no-change run writes nothing heavy.** When a run added, updated and deleted no document, the whole-index post-passes are skipped and only `last_indexed_at` is stamped, in one small transaction. Frequent runs must not wear the disk.
- **Catch-up write volume, measured then fixed.** Per-phase written bytes are recorded during a run (from `/proc/self/io` on Linux; the measurement is skipped elsewhere). The dominant phase is fixed: candidates are the WAL-plus-checkpoint double write, whole-index link and alias resolution where only changed documents need it, and FTS segment merges. Target: a 200-file catch-up writes at most ~100 MB instead of ~1 GB. If the target needs a larger rework than this feature warrants, the work stops and the numbers go back to the owner before going further.
- **Visibility:**
  - `o2b search status` shows the index age, the outcome of the last background run and any active backoff.
  - `o2b doctor --readiness` gains a freshness line and warns on a failure streak.
  - A search whose index is more than 10 minutes old carries the new trail code `index-stale` with `detail.ageSeconds`; a normal lag of under a minute adds nothing.
  - Every spawn decision and outcome is recorded like `self_heal_reindex` (skipped with reason, spawned, succeeded, failed with reason).

### 4. Configuration

Machine config, each key with an `OPEN_SECOND_BRAIN_*` environment override:

| Key | Meaning | Default |
|---|---|---|
| `search_freshen_interval_s` | how old the index may get before a read refreshes it; `0` turns the feature off | `60` |
| `search_freshen_embeddings` | also compute embeddings in the background run | `false` |

On by default: a feature nobody turns on fixes nothing. The CHANGELOG says that a search may now start a short background process and how to turn it off.

## Compatibility

- `o2b search watch`, `o2b search query --auto-refresh` and the cron recipes are unchanged.
- The docs of `o2b search reindex --cron-template` say it is no longer needed for keyword freshness, only for a periodic embedding pass.
- `docs/architecture.md` "no daemon": a short background process started in response to agent work is not a daemon; nothing stays resident.
- `docs/hermes-cron.md`: a Hermes reindex job becomes optional.

## Testing

1. `maybeFreshenIndex` in isolation, with the spawner injected: index age below and above the interval, `0` disables, own and foreign claim, abandoned claim takeover, writer lock held, backoff active and expired.
2. `search()`: a stale index triggers one spawn, a fresh one none, a read-only open never.
3. Indexer: a no-change run skips the post-passes and stamps only `last_indexed_at`.
4. One end-to-end test with a real child: a new note becomes findable after the background run. Runs on Linux and in the Windows shards.
5. Write volume: a measurement script, not a unit test; before and after numbers go into the PR.

## Release

One PR, minor version (next minor after the current `main`), with the bump, the CHANGELOG entry and its compare link, `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/architecture.md`, `docs/hermes-cron.md`, the README release line, and regenerated Codex mirrors if a skill changes.
