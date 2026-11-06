# Independent review

## Reviewer

Two independent agents that did not write the artifacts, each read-only over the repository:
- the usual reviewer, on a second account;
- an agent from another model family.

Round 1 below. Round 2 is a re-review of the fixed artifacts by the usual reviewer.

## Findings

Reviewer A is the usual reviewer, reviewer B the other-family agent.

### Blockers and majors

1. design D7 (A, blocker): a lease carried by delayed file sync cannot guarantee a single renderer. Fixed: one view writer named by a shared human settings record, moved only by the user, pages stale while it is offline (design D7, specs human-view and topics).
2. design D7 (A, blocker): a render checksum does not keep the merge base, and a phone edit can race a render. Fixed: the last rendered text is stored as a blob, edits are detected before rendering, the page is re-checked before the rename, and the sync-conflict copy of a page is ingested as a human edit.
3. design D11 (A, blocker): migration did not stop legacy writers, so late writes could be lost. Fixed: this machine is quiesced through the freeze marker, the journal is per line, a final delta pass runs, and late legacy writes from other machines are imported until the legacy tree leaves the vault.
4. design D11 (A, blocker; B, major): a later machine would skip its own unsynced legacy records, and a `migration-done` record could arrive before its data. Fixed: a later machine waits for the completion cut, then imports its own missing records by checksum.
5. design and spec rollback (A, blocker; B, major): rollback lost post-migration records. Fixed: rollback replays them into the legacy layout through exporters; kinds with no legacy form are reported.
6. design D13 (A, blocker; B, major): phase 2 needed the renderer that ships in phase 3. Fixed: the view writer, the render protocol and the minimal pages move to phase 2.
7. spec brain-migration (B, major): the mixed-version window could empty the brain of an old machine. Fixed: the legacy tree leaves the vault only after every roster device has switched or been retired, or on `--force` with a report.
8. design D6 (A, major; B, major): the digest watermark had no membership rule and stalled on offline devices. Fixed: per-partition digests over explicit cuts, compared only when the cuts are identical, with a roster of 30 days minus retired devices.
9. design D3 (A, major): the HLC lacked the receive rule. Fixed: every catch-up raises the local clock, with a slow-clock reply scenario and test.
10. design D5 (A, major): size and mtime miss a same-size replacement, and catch-up had no cost bound. Fixed: file identity plus a verified-prefix hash, reset on replacement, and a benchmark of under 20 ms for 500 unchanged shards.
11. design D11 (A, major): the snapshot path excludes secrets and other per-vault state. Fixed: an explicit backup of every non-rebuildable surface, each verified by a test restore.
12. spec brain-store (A, major): the setup rule could sync `private/` to a server. Fixed: `shared/` and `private/` are separate sync folders, the store root is never synced, and a test covers a server holding only `shared/`.
13. tasks 3.x (A, major): concurrent dream runs could create duplicate topics. Fixed: topic planning runs only on the view writer, and a test covers concurrent dream.
14. proposal (B, major): a leftover "gardener device" config key. Fixed.
15. spec human-view (B, major): the lease scenario was unreachable under sync delay. Fixed: the lease was replaced by the view writer.

### Minors

16. spec topics vs design D8 (B, minor): the lists of event kinds disagreed. Fixed: one canonical list in D8, referenced by the spec.
17. spec brain-store compaction (B, minor): file and record tombstones were conflated. Fixed: a `compacted` marker record, with reader behaviour specified.
18. spec brain-store blobs (B, minor): no behaviour defined for a blob that has not arrived. Fixed: the body is shown as pending, filled in on catch-up, and doctor reports blobs still missing after a day.
19. tasks (B, minor): no task covered the background rebuild or the view language. Fixed in tasks 1.8 and 2.9.
20. spec brain-store snapshots (B, minor): "manifest order" was undefined. Fixed: retention orders by the creation time recorded in each manifest.

### Round 2 (usual reviewer, re-review of the fixes)

Resolved as fixed in round 1: 6, 9, 10, 11, 12, 14, 16, 17, 18, 19, 20.

Still open after round 2, and settled by the author:

22. 1 and 15 (blocker): a role move or two simultaneous first claims could overlap writers. Fixed: a move is a request, the old writer records a release, and the new writer renders only after it sees that release. `--force` exists for an unreachable writer, with a warning. Simultaneous claims resolve to the lowest (clock, device), and a fresh writer waits one catch-up before its first render.
23. 2 (blocker): an edit between the last check and the rename could be overwritten, and not every sync tool makes conflict copies. Fixed: the writer keeps the replaced bytes as a blob for 30 days and re-reads the page after the rename; replaced bytes that differ from the base are ingested as a human edit; `o2b view recover` lists versions. The promise is narrowed to "never silently lost; a racing edit may land one render later".
24. 3 (blocker): the fleet freeze marker is shared and does not drain in-flight writes. Fixed: a device-local migration gate (shared lock per write, exclusive for the migration), with a multi-process test.
25. 4 (blocker): a later machine without a partition could wait forever, and checksum-only matching could merge distinct records. Fixed: the wait covers only partitions it holds, and the journal key is (device, path, item or line, checksum).
26. 5 (blocker): rollback missed late remote records and had no order. Fixed: replay every record absent from the restored tree by stable identity, in fold order, idempotently and resumably.
27. 7 (blocker): a dormant device dropped out of the 30-day roster. Fixed: a durable migration cohort with no age limit; removal waits for switch, retire or `--force`.
28. 8 (major): digest records changed their own cut. Fixed: the `digests` stream is excluded from cuts, with a test for two publishers converging on one cut.
29. 13 (major): two dream processes on the writer could create the same topic. Fixed: topic planning runs under a device-local exclusive lock, with a two-process test.
30. tasks (major): verification gaps for the above. Fixed in tasks 1.7, 2.3, 2.5, 2.6, 2.7, 2.8 and 3.4.

The schema allows at most one re-review round, so these fixes were not reviewed again.

## Questions for the owner

Answered by the owner on 2026-11-06:
31. A role move waits for the old writer's release by default, and `--force` is available. Yes.
32. A device stays in the migration cohort until it switches or is retired, even after months offline. Yes.
33. "An edit is never silently lost; one that races a render may appear one render later" is accepted.

## Verdict

Ready for implementation: yes.
