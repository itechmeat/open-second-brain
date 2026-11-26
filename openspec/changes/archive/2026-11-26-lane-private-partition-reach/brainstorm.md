# Brainstorm

## Problem

On a machine whose lane pages live in the store, a lane entry can be held
in the store's `private` partition with no `visibility:` field in its
frontmatter (the writer's judge placed it there, for example because its
text carries a `<private>` region). The rule that decides whether a caller
below local reach may read a lane page asks the frontmatter and the owner
only, so such an entry is listed, shown, counted and can be written by a
caller below local reach. The reference view already withholds the same
page, so the two rules disagree. Reproduced by
`tests/mcp/lane-private-partition-reach.test.ts` (3 cases fail, 4 controls
pass).

## Related work

`tool-lane-write-keeps-standing` is in flight under `openspec/changes/`
and adds requirements to the same capability (`lane-entry-fidelity`); it
changes the lane writers and the record authority, not the read rule, so
the two changes touch no common file except `CHANGELOG.md` and the version
manifests. No open change touches `src/mcp/brain/reach-readable.ts`. The
reference view's lane rule (`lanePageVisible` in
`src/core/brain/store-record-visibility.ts`) and the exporter
(`src/core/brain/portability/okf.ts`) already ask the partition through
`laneEntryInPrivate`; the private-partition log rule of `remote-log-reads`
is the precedent for withholding by partition below local reach.

## Doubts

1. Whether every reader that binds the shared predicate passes lane page
   paths through it, or reads some lane pages around it.
2. Whether a reader outside the predicate (search, context packs,
   resources, the digest, exports, the Hermes and OpenClaw surfaces)
   returns lane page content below local reach by another rule.
3. The fail-closed cases: an incomplete fold, a store that cannot be
   read, a path the store does not hold.
4. The local caller under the ownership gate: the predicate is built for
   it too, and it must keep seeing its own private entries.
5. The cost of one more store question per page on a list of many
   entries.

## Approaches considered

1. One shared rule (lead decision). The store-lane rule asks the store,
   per page path, whether the entry lives in `private`, and withholds it
   below local reach; it fails closed while the fold is incomplete or the
   question throws. Evidence: both construction sites of the rule already
   read the page from the store; `laneEntryInPrivate` already answers per
   path and fails closed on an incomplete fold; the reference view does
   exactly this. Cost: one function and its two call sites.
2. Carry the partition on the page value. `readLanePage` returns the
   partition beside the frontmatter, and the rule reads it. Rejected:
   `readLanePage` has many callers that do not care, and the partition
   would then be a field every caller can forget.
3. Fix each reader. Rejected: a dozen tool modules, and the next reader
   that binds the predicate would repeat the defect.
4. Synthesize the reserved token. Add the reserved `visibility:` token to
   the fields of every private-partition record when the fold builds them.
   Rejected: it changes what a local reader and an exporter see of the
   entry's frontmatter, and the token would leak into rewrites.

## Decision

Approach 1, as decided by the change's lead: the fix is in
`storeLaneReadable` and its two construction sites in
`src/mcp/brain/reach-readable.ts`, applied only below local reach, failing
closed, memoized per request and path. Every reader that binds the
predicate is covered at once; one table test proves it per reader, so a
reader that bypasses the predicate shows up as a failing row.

## Rejected

1. The partition on the page value: widens a shared read primitive for
   one rule.
2. A fix per reader: repeats the defect for the next reader.
3. A synthesized reserved token: changes local reads and exports.

## Process

Author only, inside the decisions of the change's lead; the reproduction
run that produced the failing test file is the evidence base. No
independent partner round ran in this pass; the independent review
(`review.md`) is the first outside attack on the approach and must run
before implementation.
