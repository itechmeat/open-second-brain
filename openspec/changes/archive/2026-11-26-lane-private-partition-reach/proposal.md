# Proposal: private-partition lane entries are withheld below local reach

## Why

On a machine whose lane pages live in the store, a lane entry the store
holds in its `private` partition must not reach a caller below local
reach. The shared readability rule now asks the partition, but readers
that bind no rule, persisted projections, references to store-held
entries, error wording and writes from below local reach still carry or
touch such entries, and receipts naming a private entry are placed in
`shared`. Each is proven by a failing test. A fix per reader would leave
every new reader as one more place to remember, so the change puts one
fail-closed choke point under every lane read and closes the places it
does not reach one by one.

## What Changes

- Done: the shared rule asks the partition below local reach (first part
  of this change). It stays as a second layer, amended: one fold read per
  page, no per-request memo, a `Brain/` path naming no lane entry no
  longer fails the request, the configured config path is used.
- The choke point: under the scope the server already installs for a
  caller below local reach, the lane fold folds `shared` only, cached
  under its own key, and is judged by the fold of every partition: a key
  whose winning record is held in `private` is left out, and while that
  fold may miss a record the caller's fold holds no entry at all. Every
  lane read then answers such a caller as a machine holding only
  `shared` would, a reader that binds no rule included. Work that needs
  every partition (a privacy verdict, a write's placement and version
  checks, a repair, a projection writer, the reference resolver and the
  write-side judge) reads the fold of every partition explicitly.
- Writes below local reach never touch a private entry: an update, a
  transition or a removal finds nothing and answers as for an absent
  entry; a create-style write whose key is live in `private`, or any
  write while the fold may miss a record, is refused before any record
  with one fixed answer that names nothing. A removal reads its reach
  check, the winning value and the tombstone's partition from one fold,
  read as the store write builds its records.
- Persisted projections (the procedural graph and its hints) are filtered
  at read time below local reach; the procedural memory index is read
  whole and filtered; every projection rebuild a tool starts below local
  reach (the claim graph included) builds from every partition and
  answers with what the caller may see; the other projections are
  checked once and listed.
- References to store-held lane entries (by id, wikilink, exact or
  extensionless path) are resolved once, the same way for both reference
  views and both write-side judges, with and without a vault, and judged
  by the entry's record; a reference the store cannot resolve while its
  fold may miss a record counts as private. The write-side judge counts
  a private-partition lane entry as a private page, so NEW records
  naming it (receipts, log events, ledger rows) land in `private`.
  Records written before this change are not moved: their earlier
  `shared` copies remain on peers that hold `shared`, and this machine
  withholds them below local reach when it reads them.
- Errors below local reach name nothing the caller may not read.
- The registry-wide probe seeds every lane through its real writer and
  becomes the regression guard.
- Unchanged: a local caller (with or without the ownership gate), the
  command line, a machine whose lane pages are files, an entry that
  reserves itself in its frontmatter, an ordinary shared entry.
- Release 2.0.4, with `tool-lane-write-keeps-standing` in one pull
  request when that change is ready in time, alone otherwise. This change
  is implemented first.

## Limits of this release

- New records receive the placement fix. Earlier `shared` copies of
  records that name a private-partition lane entry remain on peers that
  already hold `shared`; this machine withholds them below local reach.
- A caller below local reach is refused when it tries to create an entry
  whose exact name is already taken by an entry it may not read. The
  refusal is one fixed answer and carries no content, title or path.
- Review obligations written before this release keep their earlier
  `shared` copy, which carries the title of a private decision; reuse
  does not correct it. They are corrected in the next patch release,
  with the labels the procedural graph derives from a private source
  (two labels may share one synthetic id) and the metadata a write
  session reads from an older file at its target on a switched vault.
- The private-placement refusal covers entity writes; other writers
  (a decision record, for one) place such an entry in `private` and
  answer the caller that wrote it.
- A skill-proposal accept journal whose proposal, archive or procedure is
  private (or any journal while the store cannot be read whole) is left
  for a local recovery.

## Follow-ups (outside this change)

- Keep the keys of the two partitions apart, so a create below local
  reach on a key live in `private` no longer has to be refused (the
  residual: a remote writer can infer that some entry holds an exact key
  it tried to create).
- A pass that re-judges ledger rows already written to `shared` and
  supersedes those that name a private-partition lane entry (rows written
  before this change stay on peers that hold `shared`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `lane-entry-fidelity`: what a lane entry on a store-only machine reads
  back as. It owns the lane entry's privacy verdict, so the read side and
  the remote write side of that verdict are added here: a
  private-partition lane entry is withheld below local reach; lane reads
  below local reach see only `shared`; the verdict fails closed; a write
  below local reach never touches a private entry; persisted projections,
  references and the write-side judge follow the partition; errors name
  nothing unreadable; the registry-wide guard; local readers and
  file-backed lanes are unchanged.

## Impact

- `src/core/store/lane-fold-cache.ts` (the caller's fold and the whole
  fold), `src/core/store/lane-entry-store.ts` (accessors on the right
  fold), the new `src/core/store/lane-reach-guard.ts` (the write guard
  and its error), `src/core/store/lane-pages.ts` (the guard's call sites
  and the whole-fold reads of the writers),
  `src/core/store/lane-dual-moves.ts` (whole fold).
- The guard's call sites outside the store layer:
  `lifecycle/memory-target.ts` (the memory patch writer and the store
  record lookup by id), `decisions/record.ts` (the review obligation
  checked before the decision is written), `entities/registry.ts` (an
  entity that would land in `private`), `knowledge-lane-tools.ts`
  (cluster materialization builds whole).
- `src/core/brain/procedural-memory.ts`, `procedural-graph.ts`,
  `procedural-hints.ts` (rebuilds build whole, the index listing read
  whole and filtered), the new
  `src/mcp/brain/procedural-projection-filter.ts`.
- `src/mcp/brain/reach-readable.ts` (amendments of the done part).
- `src/mcp/brain/procedure-tools.ts` (projection filter).
- `src/core/brain/artifact-ref-resolve.ts` (the one resolution),
  `src/core/brain/artifact-ref-view.ts`,
  `src/core/brain/store-record-visibility.ts`,
  `src/core/store/reference-privacy.ts` (references and the judge;
  `reach-view.ts` and `owner-scope-view.ts` are not edited),
  `src/core/brain/decisions/receipts.ts` (a receipt is judged against
  the store it is appended to).
- `src/mcp/brain/knowledge-claim-tools.ts` (the claim graph rebuild
  builds whole and answers the caller's own build).
- `standing-rules.ts` and `governance/store-unreachable.ts` (store gaps
  read from the caller's fold).
- The OpenClaw bundle (`openclaw/index.js`), rebuilt: it contains the
  reference resolver.
- Tests: the four `tests/mcp/lane-private-partition-reach*.test.ts` files
  (the paths case of the intention set rewritten to the decided contract,
  the probe reseeded through a sibling writer table), two new files, one
  for the fold split and the writes, one for projections, references and
  the judge, with a shared fixture module, and three files of the review
  round (the read boundary, rebuilt projections and the removal binding;
  the one resolution; refusals, gap reporters and projection rows) with
  a store-state fixture module. Two label prune cases of
  `entity-merge-privacy-store-only.test.ts` seed their survivor as a
  writer before this change placed it, and a third case covers the
  survivor that is now private from its creation.
- `package-files.txt` (the two new production modules are packed).
- `CHANGELOG.md`, the version (2.0.4). No format, CLI or manifest change
  beyond the version.
