# Brainstorm

## Problem

Four follow-ups queued by the phase 2 review of `brain-store-and-topics`
(tasks 3.17, 3.15, 3.16 and 3.8 there), decided there as work to do; this
brainstorm settles how. 3.17: readers that show store log events to a
caller below local reach without the rule of change `lane-pages-split`
(design D3). 3.15: a shard read only in part fails closed with no doctor
finding and no repair. 3.16: no verb takes a held partition off a machine
on purpose. 3.8: a lane page does not read back verbatim from its
`lane-entry` record (OCR F291). Two executors build it in parallel: Part C
(3.17, 3.15) and Part Z (3.16, 3.8).

## Related work

No other change in flight under `openspec/changes/`. One open pull request
touches the search index's Windows rename, not these modules. The three
store pull requests merged last (core, migration, lane split) are the base.

## Doubts

1. 3.17: whether a filter at the reader seam can stay out of computations
   that write (dream, evidence counters).
2. 3.17: the timeline events and the request view carry no private mark
   today; which surfaces depend on them.
3. 3.17: a guard that stops the next new reader from leaking.
4. 3.15: whether a repair may touch another device's shard; how a
   quarantine travels to the other machines; a newer-format record.
5. 3.15: whether rollback and the late import should wait for a pending
   blob instead of refusing.
6. 3.16: what the verb refuses (`shared`, an identity file still present,
   store files left in the folder) and which device-local state it clears.
7. 3.8: the privacy judge over a raw copy (a frontmatter comment), older
   readers, the line cap, moves and the equality check.
8. Files both parts touch; Windows; the OpenClaw bundle.

## Approaches considered

3.17 (author): a. carry the private mark into timeline events and fix the
request view, then fix each reader; b. a reader option that drops private
events at the seam; c. a per-request reach scope the readers consult.
Guard: a census of log reader call sites. Partner: a, amended; the
`brain_query` preference mode also skips the reference rule its sibling
modes apply, so it leaks shared events naming unreadable records and its
telemetry count; counts, timestamps and sizes moved by a withheld event
are leaks too.

3.15 (author): a. a device-local quarantine ledger keyed by shard and line
hash; b. a synced quarantine record in the shard's partition; c. rewriting
the shard. Doctor: one finding per gap kind. Partner: a, with atomic
ledger writes, list and release, a rule for the index's stale
`corrupt_lines` counter, and no quarantine of this device's own live tail.

3.16 (author): a. remove the held marker only while the identity file is
absent; b. also purge device-local state of the partition; c. refuse while
store files remain. Partner: a, b and c, plus a "partitions left" record,
marker cleanup by marker content on Windows, and a lock against a
concurrent re-mark.

3.8 (author): a. an optional `raw` field on every record; b. `raw` only
when the parts do not reproduce the bytes; c. a canonical serialiser.
Partner: b, keeping the parse-back check, stripping regions from `raw` on
delivery, one privacy rule for write and fold.

## Decision

3.17: approach a. Two roots are fixed: `requestRefView` withholds below
local reach, and `TemporalEvent` carries the mark that `eventAtReach`
honours. `brain_query` preference mode filters like its sibling modes.
The per-surface readers (agent provenance, backlinks, morning brief, idea
discovery, note write logs, the three timeline builders that never filter)
and every counting reader with a remote surface (most-applied, status,
the maintenance flag, the cost meter, the token footprint) ignore withheld
events below local reach. Guard: a closed log-reader census plus one
remote-reach test per surface with one private event that names nothing.
The doctor's orphan-session check stays whole (a computation: withholding
there would report a false orphan and its repair would detach a valid
reference); its finding texts quote no event. Dream and evidence keep
every event; their use of private evidence is queued as task 3.18.

3.15: approach a. One finding per gap, with one finding code per gap kind
(corrupt line, newer format, pending blob), naming the shard, the offset
and the repair command. The
ledger is matched by shard, offset and the hash of the line bytes;
written atomically under a local lock; `o2b store shard
quarantine|list|release`. Never a newer-format line; a pending blob only
past seven days and never in `settings` (it may be a deny rule); a record
whose blob arrives later reads normally; the last line of this device's
own shard is refused. Rollback, the late import, migration and legacy
removal keep refusing on any pending blob, quarantined or not (no wait
loop). The index counter keeps counting; nothing reads it as a gap.

3.16: approaches a, b and c. `o2b store partition leave <partition>`
refuses `shared`, refuses while the identity file is present, refuses
leftover files without `--force`, exits 0 with nothing to leave, removes
the marker by the key function that wrote it, clears the partition's
seen-shard entries and the digest caches, and leaves the index to drop
the rows on its next catch-up (proved by a test). An identity file that
returns is held again by the existing rule.

3.8: approach b. `raw` only when the parts do not reproduce the bytes and
it parses back to them; text writes and moves carry it, structured writes
never do; `sameEntry` compares it; the write-time privacy judge reads it;
a reader serves it only when it parses back. No format version bump.

## Rejected

- 3.17 b, a seam filter: it would also filter dream and the evidence
  counters, and the read-pass cache is keyed by store and vault only.
- 3.17 c, an ambient scope: a remote `brain_dream` would compute a
  different dream per caller, and the pass cache would mix reaches.
- 3.17, splitting the four files past 700 lines first: a change of its
  own (task 3.19); here they get call-site edits only.
- 3.15 b, a synced quarantine: one machine's verdict would drop a line on
  machines that read it correctly (a blob that arrived there).
- 3.15 c, rewriting a shard: it races the owner's next append and sync,
  and moves the index watermark.
- 3.15, quarantine under `brain doctor --repair`: that verb needs a vault;
  the store verb works on a vault-free machine.
- 3.16, a "partitions left" record: no unsafe sequence found. Shards that
  return without `store.json` are not held, as on a machine that never
  held the partition, and the verb refuses while files remain.
- 3.16, marker cleanup by content on Windows: the open checks only the key
  of the configured root, which is the key the verb removes.
- 3.16, a lock against a concurrent re-mark: a writing open re-marks only a
  partition whose identity file is present, which the verb refuses.
- 3.8 a: `raw` on every record doubles every body for no gain.
- 3.8 c: a lossless serialiser changes the shared frontmatter writer.
- 3.8, `raw` in the migration: a changed record sum would re-append every
  already imported entry on the next transition run.

## Process

Partner: an agent of a different model family, read-only, one round. Its
summary reached the author whole and its full report in part. Its claims
were checked in the tree: the two roots, the preference mode leak and its
telemetry count, the morning brief notes, the agent provenance and the
counting readers were confirmed; the claim that the operator snapshot
reads no log events was wrong (its stale count builds the timeline), and
so was the claim that `osb://active` passes no reach (it passes
`restricted`, which `renderActiveForReader` then drops). No open questions
remain.
