# Brainstorm

## Problem

Two follow-ups queued by the phase 2 review of `brain-store-and-topics`
(tasks 3.13 and 3.14 there): `src/core/store/lane-pages.ts` is past the
700-line limit, and on a switched machine an OKF export carries log events
of the `private` partition into `log.md` with no privacy marker.

## Related work

None in flight: no open pull request, and no other change under
`openspec/changes/` touches these modules. Both items were decided as
work to do in the phase 2 review; this brainstorm settles how.

## Doubts

1. Hidden dependencies of the moved helpers, and an import cycle.
2. Whether an architecture test pins which file holds which writer.
3. The partition of a log record present in both partitions.
4. Whether counting private events by subtracting two reads is exact.
5. Unreadable log shards in the export.
6. Other egress paths that carry log events.
7. Windows, the OpenClaw bundle, the manifest parser.

## Approaches considered

Part A (author): one store-side module; three modules (paths, fold,
records); a split by reads and writes. Part B (author): leave private
events out and count them; an inline privacy marker per entry; refuse the
export while any private event exists; leave them out unless a flag says
otherwise. Partner: one read of the log counted by partition instead of a
full read minus a shared-only read; private wins for a record in both
partitions; fail closed on an unreadable store log shard, as the legacy
path already does for an unreadable day file.

## Decision

Part A: one module, `lane-entry-store.ts`, with the store side moved
verbatim. `lanePagesInStore` moves too, because `heldInStore` calls it
(the partner found this; leaving it behind makes an import cycle), and
`lane-pages.ts` re-exports it. Every write call stays in `lane-pages.ts`,
so the write-site census must not change.

Part B: private events leave `log.md` and are counted, from one read of
the store log that carries each event's partition; private wins when a
record is in both partitions; the count is taken before the content-class
filter; the export refuses when a store log shard cannot be read. The
manifest gains `log_private_omitted`, carried through every function that
passes the log along (the partner found the `Pick` types that would have
dropped it on the export verb's path), and the verb names the count
whatever its content-class flags.

## Rejected

- Three store-side modules: they separate the record builders from the
  partition test they serve.
- A reads and writes split: it cuts through the rule that keeps an entry
  in its partition.
- A privacy marker per log entry: easy to strip, and no consumer reads it.
- Refusing the export while any private event exists: the operator loses
  the whole bundle over one event.
- A flag that keeps private events: it re-opens the leak.
- Full read minus shared-only read: not atomic, and it reads the log
  twice.
- Shared wins for a record in both partitions: the permissive answer
  when devices disagree.

## Process

Partner: an agent of a different model family, read-only, one round. It
confirmed approach A and B, and corrected the design on the import cycle,
the count, the duplicate rule, unreadable shards, the manifest plumbing
and the notice placement. No open questions remain.
