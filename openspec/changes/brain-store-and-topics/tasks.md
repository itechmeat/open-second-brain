# Tasks

Phases follow design.md D13. Each phase ends in its own release PR, and the version bump, CHANGELOG entry and docs ride inside that PR (CLAUDE.md "Versioning"). Tests are written first for every unit of behaviour.

## 1. Phase 1: store core

- [x] 1.1 Write `FORMAT.md`, covering the envelope, streams, partitions, blobs, fold rules, clock rules, compaction markers and versioning, and ship it into every partition. Verify: a doc test checks that every envelope field, stream and record kind named in code appears in the document.
- [x] 1.2 Add store root, partition and device-local directory resolution in `path-constants.ts`, `paths.ts` and config: a per-user default, refusal of a root inside the vault, and the device-local directory from `platform-dirs.ts`. Verify: unit tests for the default, an override, the refusal and Windows paths.
- [x] 1.3 Implement the record envelope, ULID ids and checksums, and the HLC with both its send rule and its receive rule. Verify: unit tests for monotonicity under a backwards wall clock, and a cross-device reply from a machine with a slow clock that folds after the record it answers.
- [x] 1.4 Implement the shard appender: a single append under a device-local lock, a line-size cap and spill into blobs. Verify: a test with concurrent child processes on one device yields N complete lines; the Windows CI job runs the same test.
- [x] 1.5 Implement the shard reader. It skips an incomplete or checksum-failing last line and retries it later, reports bad middle lines, skips unknown `v`, handles `compacted` markers and marks a missing blob as pending. Verify: fixture tests for a cut line, a corrupt line, a future version, a compacted shard and a blob that arrives late.
- [x] 1.6 Implement folds for preferences, pinned context and settings. Precedence is human > agent > model, then the later clock wins; removals are tombstones. Verify: property tests that shuffle shard delivery order and duplicate lines, and assert an identical folded state.
- [x] 1.7 Implement per-partition state digests with explicit cuts, the roster (30 days, minus retired devices) and the doctor comparison. Verify: tests for an injected fold difference (reported), an offline device (reported as silent, not divergent), a machine without the private partition (no false alarm), and two publishers converging on one identical cut.
- [x] 1.8 Move `brain.sqlite` to device-local state. Add the watermark table with file identity and a verified-prefix hash, the `records` table, the source column and catch-up before reads. Verify:
  - a new record is searchable without a reindex;
  - an unchanged store opens no file (fs spy);
  - a same-size replacement and a truncation are re-read once;
  - the catch-up benchmark with 500 unchanged shards stays under 20 ms;
  - a background rebuild after a schema bump keeps reads working and swaps without a failed read.
- [x] 1.9 Add the change probe: the `brain_changes` MCP tool and `o2b brain changes --since`. Verify: a test returns a neighbour's record id under its topic and scope.
- [x] 1.10 Defect fixes that ride along:
  - prune `.state/anticipatory` by TTL;
  - make every snapshot reason, upgrades included, obey retention ordered by the manifest's creation time;
  - lock `pinned.md` writes;
  - replace the full-file rewrite in `log.ts` with appends.

  Verify: a regression test for each, including a retention test where the newest recovery point survives.
- [x] 1.11 Put dual writes (store plus legacy tree) behind a flag that is off by default, and document the flag in `docs/`. Verify: an integration test with the flag on finds each record in both places with matching content.
- [x] 1.12 Integration. Run the full gate (`bun run test`, `lint`, `typecheck`, `scripts/sync-version.ts --check`, `sync-plugin-mirrors:check`, `check:paths`); it must be green on Linux and in the Windows CI job. Then open the release PR with the version bump and CHANGELOG. Done in #289 without a release by the owner's decision; the release rides with a later phase.

## 2. Phase 2: migration, the vault-free mode and the minimal human view

- [x] 2.1 Add a mapper for every row of `STATE_SURFACES`: stream, blob, device-local state, an explicit backup (secrets, keys, attestations, checkpoints) or drop. Verify: a test fails when a surface has no mapper.
- [x] 2.2 Implement `o2b brain migrate-store --dry-run`. Verify: on a fixture vault with real layout shapes and several device ids, the report lists the roster, counts per surface and unmapped items, and the tree hash is unchanged.
- [x] 2.3 Implement the real migration on the first machine:
  - quiesce through the device-local migration gate and a settle period (design D11 step 2, as built; the synced freeze marker is not used for this);
  - snapshot, plus explicit backups each verified by a test restore;
  - conversion with a journal per item and per line;
  - the final delta pass;
  - verification;
  - the `migration-done` record with its cut.

  Verify with tests for:
  - a clean run;
  - a kill halfway followed by `--resume` (no duplicates);
  - a write attempted during migration (refused);
  - several writer processes with writes in flight when the migration starts (none lost: the settle period, the final delta pass and the transition import pick up what the gate did not refuse);
  - two distinct legacy records with identical content (both kept);
  - a legacy file that grows during conversion (imported by the delta pass);
  - a verification mismatch (legacy tree untouched);
  - a backup failure (nothing moved).
- [x] 2.4 Implement the later-machine path. It waits for the `migration-done` cut, imports its own legacy records the store lacks, moves its device-local state and records `device-switched`. It also imports late legacy writes during the transition, line by line. Verify: two- and three-device fixture tests, including a completion record that arrives before its data and a machine still on the old release that keeps writing.
- [x] 2.5 Implement removal of the legacy tree, gated on the roster (every device switched or retired, or `--force` with a report), into a dated archive in the device-local state. Verify: tests for gate closed, gate open, `--force`, a cohort device offline for longer than 30 days (gate stays closed), and doctor naming the devices still on the legacy layout.
- [x] 2.6 Implement `--rollback`: freeze, restore the snapshot and the backups, replay post-switch records into the legacy layout through legacy exporters (signals, log, preferences, pinned context, notes), and report kinds that have no legacy form. Verify: a test that migrates, writes new records, receives a remote pre-switch record late, rolls back, and finds every one of them in the legacy tree once and in fold order; a resumed rollback duplicates nothing.
- [x] 2.7 Add the view writer: a shared settings record, the first migrating or initialising machine takes the role, `o2b view writer --here`, and a doctor check for a silent writer. Verify: tests for the initial role, two simultaneous first claims (one winner, no pages by the loser), a move with release before sync (no page written by both), a forced move, and the silent-writer report.
- [x] 2.8 Implement the render protocol. It detects edits against the stored base before rendering, merges three ways with the user winning, re-checks before the rename, ingests the sync-conflict copy of a page, and writes only changed bytes. Verify:
  - an idle render changes no mtime;
  - a phone-style whole-file rewrite becomes human records;
  - a racing edit with no conflict copy is recovered from the replaced bytes;
  - a racing edit with a conflict copy leaves no copy behind;
  - `o2b view recover` lists replaced versions.
- [x] 2.9 Render the minimal pages `about-me.md`, `history/<YYYY>-W<ww>.md` and `decisions.md`, with the HTML id comment, no frontmatter, and `view.language` for generated prose. Verify: snapshot tests in English and Russian, where quoted source lines stay in the original language.
- [x] 2.10 Make the store the only write path once migrated, and make the vault optional in config. Generate `.base` files only through the vault adapter. Verify: the whole test suite passes with no vault configured, and `rg 'Brain/' src` lists only legacy-reader, exporter and migration modules. As built, the check is the literal census `tests/core/architecture/brain-literal-census.test.ts`: an allowlist with a reason per module (design D14 items 16 and 17), which also admits record-lane modules, legacy ledgers, text, labels, adapters and note walls.
- [x] 2.11 Add `o2b store path` and the store fields in `second_brain_status`. Rewrite the skills, the MCP instruction segments, hook messages and templates so they name tools and commands only. Regenerate `plugins/codex` with `bun run sync-plugin-mirrors`. Verify: `sync-plugin-mirrors:check` passes, and a grep test finds no `Brain/` path in shipped skill text.
- [x] 2.12 Add doctor checks for:
  - a legacy directory reappearing after removal, with the writer when known;
  - another device's id in the local state;
  - an available migration;
  - devices still on the legacy layout.

  Verify: doctor tests for each.
- [x] 2.13 Write the setup and migration guide in `docs/`. It covers syncing `shared/` and `private/` as separate folders, never the store root or the device-local directory; that phones get only the view; the threat model; and rollback. Verify: the documented commands run as written in a doc test against a fixture, and a test where a server gets only `shared/` works without errors.
- [ ] 2.14 Integration. Run the full gate on Linux and Windows. Then run a manual migration on a copy of a real multi-machine install, which the owner checks: counts, the view, search on two machines and a rollback. Then open the release PR.

## 3. Phase 3: topics, plus reports and sources

- [ ] 3.1 Implement topic records and folds for the canonical event list in design.md D8, with an immutable `topic_id`. Verify: property tests for order independence, and a rename that keeps every reference.
- [ ] 3.2 Render `topics/<date>-<slug>/topic.md` through the phase 2 render protocol, with the fixed section order, the page budget and the companion archive. Also render `reports/` and `sources/`. Verify: snapshot tests, including budget overflow.
- [ ] 3.3 Refuse note-tool writes into the view folder, with a pointer to the topic tools. Verify: a test on `brain_create_note` and `brain_update_note`.
- [ ] 3.4 Add topic planning to dream, run on the view writer only: route unassigned records, create on N records from at least two sessions, propose merges and splits, prompt on quiet topics, write report entries, and support undo as a synced human record. Verify:
  - dream tests for every scenario in `specs/topics/spec.md`;
  - a concurrent dream on two machines, and two dream processes on the view writer, each yield exactly one topic per cluster.
- [ ] 3.5 Add the `brain_topic` MCP tool and the `o2b topic` CLI verbs. Rename the preference-topic internals to `ruleTopic` and the resource to `osb://rule-topic/{slug}`, with an alias for one minor version, and add `osb://topic/{id}`. Verify: MCP contract tests, an alias test and a CHANGELOG note.
- [ ] 3.6 Write the topics guide in docs: what a topic is, the page schema, how to ask an agent, and undo. Verify: a doc test runs the listed CLI verbs.
- [ ] 3.8 Keep a lane page's raw text in its `lane-entry` record (an optional `raw` body field, FORMAT.md), so a store-only machine reads back staged bytes verbatim (OCR F291). Verify: a round-trip test of text without frontmatter and of quoted values.
- [ ] 3.9 Make lane entry ids a bijection with legacy paths (every extension, `x.json` vs `x.json.md`, folders that are not lane names), or refuse the names that do not round-trip (OCR F295). Verify: a round-trip test over the lane path table.
- [ ] 3.10 Keep the procedural graph and hint counters as device-local state instead of re-appending whole `lane-entry` records on every usage tick (OCR F360). Verify: a usage tick appends no store record, and a migration test moves the counters into the device-local state.
- [ ] 3.11 Write the schema-apply audit row in the partition of the pack records it attests (`shared`), with one privacy verdict over the batch and its reason, or have the schema integrity check accept the newest settings records as attested (OCR F394). Verify: a machine that holds only `shared` reports a schema apply from another device as attested, not `modified`.
- [ ] 3.12 Settle the cross-device merge of the schema field lists (a set merge rather than last writer wins on the whole list), personas as files or records, and whether the shared namespace gets a store of its own; the mirror into this machine's own store refuses until then (OCR F397, F464, F398). Verify: a concurrent edit test on two devices for the field lists, and a test per decision taken.
- [x] 3.13 Keep private-partition log events out of the OKF `log.md`, or carry a privacy marker for them: a log entry has no frontmatter for the `visibility: [private]` stamp pages from the private partition now get (OCR F333, log side). Verify: an export test on a switched machine with one private and one shared log event. Done in change `lane-pages-split`.
- [x] 3.14 Split the store side of `src/core/store/lane-pages.ts` (fold accessors, partition keep-rule, lane-entry writers) into its own module: the file is over the 700-line limit after the replace-keeps-private fix. Verify: no behaviour change, the lanes and store suites pass unchanged. Done in change `lane-pages-split`.
- [ ] 3.15 Name a shard that reads only in part (a corrupt middle line, a record of a newer format, a blob that never arrives) in a doctor finding with its path, and add a repair that quarantines the bad line, so a protection read that fails closed on it can be released without a hand edit. Also decide whether rollback and the late import wait for a pending blob rather than leave its record out. Verify: a doctor test per gap kind, a quarantine test that reopens capture.
- [ ] 3.16 Add an operator verb that takes a partition off this machine on purpose (for example `o2b store partition leave private`): held partitions are sticky per machine since the phase 2 review, so a machine that stops syncing `private/` refuses every store operation until the verb clears it from the held list. Verify: leaving `private` turns the machine shared-only with no refusal, and a lost `private/store.json` without the verb still fails closed.
- [ ] 3.17 Audit every reader that renders store log events to a caller below local reach without `logEntryAtReach` or `logEntriesAtReach` (the active-preferences digest's most-applied counts, the morning brief, temporal citations, status, backlinks, analytics, anything else built on `logDayReader`, `storeLogDays` or `readStoreLogEvents`), and make each withhold events marked `fromPrivatePartition` (change `lane-pages-split`, design D3). Verify: a remote-reach test per reader with one private event that names nothing.
- [ ] 3.7 Integration. Run the full gate on Linux and Windows. Then the owner checks topics by hand on two machines and in a phone view, including a phone edit. Then open the release PR.

## 4. Phase 4: decision-model uses and agent context

- [ ] 4.1 Register the uses `topic_route`, `event_kind`, `human_readable`, `topic_new`, `topic_same`, `question_resolved`, `milestone_done`, `head_select` and `neighbour_relevant` in the decision-model framework. Each is off by default and has a deterministic fallback. Verdicts are stored with model, version, mode and confidence. A private-data guard blocks hosted providers. Verify: per-use tests for off, shadow (recorded, no effect) and enforce, plus a test that folds never call a model.
- [ ] 4.2 Build the session start digest: topic heads within budget, rules, pinned context and a "more available" line. Verify: hook tests with 30 topics and a 12-head budget.
- [ ] 4.3 Add neighbour updates before a turn, using the change probe, the relevance gate and a small budget, and never echoing the agent's own records. Verify: hook tests for the related and unrelated cases in `specs/agent-context/spec.md`.
- [ ] 4.4 Report budget cuts in every injection. Verify: tests assert the dropped-count line.
- [ ] 4.5 Extend `docs/decision-models.md` with the new uses, their privacy defaults and the shadow-then-enforce path. Verify: a doc test checks that every registered use is documented.
- [ ] 4.6 Integration. Run the full gate on Linux and Windows. Then the owner checks by hand with several concurrent agents on two machines. Then open the release PR.

## Workflow follow-up

- Archive the change only after every phase is released, works end to end and the owner has checked it by hand.
- Verify the archived specs under `openspec/specs/`.
