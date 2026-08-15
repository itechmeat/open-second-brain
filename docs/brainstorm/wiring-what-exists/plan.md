# Wiring what exists - implementation plan

Each task is one atomic commit. Tests are written first and must fail with the
expected error before the implementation exists. Formatter and linter run green
before every commit, not at the end.

Baseline for every byte-identity claim in this plan: `9399 pass, 0 fail` across
1031 files, measured on `a6d10dab` with an empty `HOME`.

## Ordering

R1a and R1b are the foundation and land first, because B1, B2 and B3 depend on the
verdict type. Everything else is independent and can proceed in parallel with them.

```
R1a -> R1b -> B1 -> B2 -> B3
A1, C1, D1, D2, E1, E2   (independent)
```

## Tasks

### Task R1a: a recoverability verdict that can say it does not know

- **Files**: new `src/core/brain/gates/recoverability.ts`; modified
  `src/core/brain/snapshot-gate.ts`, `src/core/brain/types.ts`;
  new `tests/core/brain/gates/recoverability.test.ts`.
- **What**: three closed vocabularies in the four-piece idiom - the verdict, the
  coverage a recovery point actually provides, and the blockers that prevent proving
  it. A pure classifier returning a frozen object with a sorted token array.
  `withDestructiveSnapshot` returns the verdict alongside its result instead of
  expressing "could not prove recoverability" as an untyped `throw`. The existing
  throw paths for a genuine snapshot failure stay throws - a failed snapshot is not
  an unproven verdict, and collapsing them would be the fallback the brief forbids.
- **Acceptance**: the three vocabularies pass
  `tests/core/architecture/verdict-vocabulary-census.test.ts` including its `unknown`
  guard probes; an operation whose blast radius leaves `Brain/` produces a verdict
  naming partial coverage rather than a snapshot path alone; the two existing call
  sites (`source-cleanup.ts:591`, `label-hygiene.ts:222`) return byte-identical
  payloads for a fully covered operation.
- **Depends on**: none.

### Task R1b: the destructive-site registry and its census

- **Files**: new `src/core/brain/destructive-sites.ts`; new
  `tests/core/architecture/destructive-site-census.test.ts`.
- **What**: enumerate every module under `src/core/brain/` calling `rmSync`,
  `unlinkSync`, `renameSync`, or an overwrite-mode atomic write. Each is either
  routed through the gate or carries an entry declaring its actual recovery coverage
  and a written reason. Population is syntactic; the census fails on a module that is
  neither routed nor declared.
- **Acceptance**: the census enumerates from source rather than from a hand list, and
  fails when a new `unlinkSync` is added to an undeclared module - proved by a test
  that adds one to a fixture. Vacuity floors, in the idiom of
  `doctor-exit-census.test.ts:280-291`, so the census cannot pass by finding nothing.
- **Depends on**: R1a.

### Task B1: the operations with the largest unprotected blast radius

- **Files**: `src/core/brain/snapshot.ts` (`restoreSnapshot`, `pruneSnapshots`),
  `src/core/brain/dream.ts`, `src/core/brain/source-cleanup.ts`;
  `tests/core/brain/snapshot-gate-coverage.test.ts` and per-operation tests.
- **What**: `restoreSnapshot` takes a recovery point of the live tree before
  discarding it, using the producerless `BRAIN_SNAPSHOT_REASON.manual`. The dream
  pass moves off its inline `createSnapshot` onto the wrapper. `pruneSnapshots` gets
  a floor and a named refusal instead of trimming silently. `deleteBySource` stops
  reporting a snapshot path as though it covered `--include-originals` deletions and
  returns the partial-coverage verdict instead.
- **Acceptance**: a rollback over a modified vault leaves a recoverable archive of
  what it discarded; `--include-originals` produces a verdict naming the uncovered
  files by count and lane; dream output is byte-identical to the previous release
  over a fixture vault, measured with `digestVaultTree`.
- **Depends on**: R1a, R1b.

### Task B2: note-file lifecycle

- **Files**: new `src/core/brain/notes/lifecycle.ts`, new
  `src/mcp/brain/lifecycle-file-tools.ts`; modified
  `src/core/brain/page-dedup.ts` (widen `patchWikilinks` past `Brain/` and past
  id-shaped targets), `src/mcp/brain-tools.ts`, `src/cli/command-manifest.ts`,
  `src/cli/brain.ts`; new CLI verb; `tests/mcp/note-lifecycle.test.ts`,
  `tests/cli/brain-note-lifecycle.test.ts`.
- **What**: rename, move, delete and archive, dispatched on an action under one tool
  in the `brain_lifecycle` pattern. Both the source and the destination path go
  through `resolveNoteTarget`, so the nine-step envelope applies to each. Delete and
  archive run under the B1 gate. Rename and move rewrite inbound references and the
  result names how fresh the evidence was.
- **Acceptance**: renaming a note rewrites inbound `[[links]]` in Brain and in user
  notes; the result reports index staleness when the last index pass predates the
  rename; delete refuses without an explicit confirm and honours `--expect`; the
  frozen `BRAIN_TOOLS` parity list and its docblock are updated in the same commit.
- **Depends on**: B1.

### Task B3: materialise an unresolved wikilink target

- **Files**: new `src/core/brain/notes/scaffold-stub.ts`; modified
  `src/core/search/store/links.ts` (a `listDangling()` over the existing resolution
  SQL), `src/core/brain/link-graph/repair-lane.ts`,
  `src/mcp/brain/lifecycle-file-tools.ts` (the action dispatched from B2's tool);
  `tests/core/brain/notes/scaffold-stub.test.ts`.
- **What**: a verb that materialises a stub for a dangling target, reusing
  `renderStub` and the `if_exists` semantics `brain_create_note` already exposes.
  `skip-missing-target` becomes a decision the caller can invert explicitly; it stays
  the default.
- **Acceptance**: the dangling list is derived from the index rather than a scan, and
  refuses when the index is only partially resolved rather than reporting zero;
  scaffolding is opt-in and never runs as a side effect of a repair pass.
- **Depends on**: B2.

### Task A1: the third write path classifies its source

- **Files**: `src/core/brain/distill/distill-source.ts`,
  `src/mcp/brain/distill-tools.ts`, `src/cli/brain/verbs/distill.ts`;
  new `tests/core/brain/distill/distill-source-trust.test.ts`.
- **What**: `normalizeSourceIdentity` in place of the bare `canonicalNotePath`;
  `classifySourceOrigin` before any write; `untrustedSourceFrontmatter` and
  `source_content_hash` on the page; the source read bounded by the same shape gate
  the intake path uses; the `"missing"` sentinel replaced by an untrusted verdict;
  `trust` on the result and on both surfaces.
- **Acceptance**: a source that does not exist quarantines rather than writing under
  `stated`; `[[Articles/x.md]]` and `Articles/x.md` produce one identity; a
  `../../etc/passwd` source is refused without stat-ing it; an unreadable source
  raises the typed error and leaks no absolute path; a trusted in-vault source
  produces a page byte-identical to today's apart from the added keys.
- **Depends on**: none.

### Task C1: the export boundary redacts

- **Files**: new `src/core/egress/registry.ts`; modified
  `src/cli/brain/verbs/bank-export.ts`, `graph-export.ts`, `okf-export.ts`,
  `export.ts`, `src/cli/main.ts` (`cmdExportConfig`), `src/core/config.ts`;
  new `tests/core/architecture/egress-census.test.ts`,
  `tests/cli/export-redaction.test.ts`.
- **What**: the five unredacted export paths call `redactRawOutput`; the key-name-only
  `redactMapping` is collapsed into the shared redactor; truncation over the 1 MiB
  ceiling is a named refusal on an export rather than a silent pass, because an
  export that scanned only part of its payload cannot claim it is clean.
- **Acceptance**: a vault note carrying a vendor-prefixed key exports redacted
  through all five paths; a payload over the ceiling refuses and says why; an export
  with nothing to redact is byte-identical to the previous release.
- **Depends on**: none.

### Task D1: recency reads the authoring instant

- **Files**: `src/core/search/ranker.ts`, `src/core/search/store/chunks.ts`;
  `tests/core/search/ranker.test.ts`, `tests/core/search/recall-benchmark.test.ts`.
- **What**: `hyd.authoredAt ?? c.mtime` as the age source; `authored_at` projected
  into `representativeChunks` so link-expansion candidates do not silently keep
  ranking on mtime.
- **Acceptance**: a corpus with no `authored_at` ranks byte-identically; a session
  imported today with a year-old turn instant no longer receives the maximum
  freshness boost; the tie-break tests are re-derived against the new premise rather
  than patched; the recall benchmark is re-measured and its pins and header updated.
- **Depends on**: none.

### Task D2: consolidation folds its clustering key

- **Files**: `src/core/brain/dream-plan-topics.ts`;
  `tests/core/brain/dream-topic-folding.test.ts`.
- **What**: key `byTopic` and `prefByTopic` through `normalizeEntityName`, the same
  normaliser `search/entity-alias.ts` uses, while the display form stays the raw
  string.
- **Acceptance**: topics differing only by case, surrounding whitespace, Unicode
  normal form or quote variant cluster together; a corpus with no such variants
  produces a byte-identical dream report; no language-specific rule is introduced.
- **Depends on**: none.

### Task E1: the probe's verdict reaches the exit code

- **Files**: `src/core/search/indexer.ts` (`indexCheck`),
  `src/cli/search/verbs/check.ts`; `tests/cli/search-check-provider.test.ts`.
- **What**: a provider that is configured and proved unreachable becomes a fatal
  finding rather than a warning, so `o2b search check` stops exiting 0 over it. The
  probe becomes opt-out for the case where the network call is unwanted, since it
  currently fires unconditionally.
- **Acceptance**: a configured-and-unreachable provider exits non-zero and names the
  reason; a provider that is not configured is unchanged and still exits 0, because
  absent is not the same as broken; the timeout path is distinguishable from a
  refusal.
- **Depends on**: none.

### Task E2: the bundle restores what it carries, or says it did not

- **Files**: `src/core/brain/portability/bundle.ts`,
  `src/cli/brain/verbs/bank-import.ts`;
  `tests/core/brain/portability/bundle-roundtrip.test.ts`.
- **What**: preferences restore through `writePreferenceTxn`, so the confidence band,
  trial window, revision counter and audit trail are maintained rather than
  overwritten. A per-field round-trip test so a new bundle section cannot be added
  without deciding whether it restores.
- **Acceptance**: every exported preference field either round-trips or is named in
  the result as deliberately not restored; a version-1 bundle still imports; the
  audit trail records the restore as a restore.
- **Depends on**: none.

## Verification before the pull request

- `bun run fmt:check`, `bun run lint`, `bun run typecheck`
- `env HOME=<empty> bun test` compared against the 9399/0 baseline
- `bun run sync-version:check` after the version bump
- `bun run build:openclaw` and the bundle byte-diff
- `bun run check:paths:strict`
