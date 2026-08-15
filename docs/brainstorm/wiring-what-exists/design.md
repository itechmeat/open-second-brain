# Wiring what exists - nine capabilities the code already had and never called

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Nine kanban tasks were selected for this round by priority. Reconnaissance against
the real source, run before any of them was designed, found that they are not nine
different problems. In every one, the capability the task asks for already exists in
this codebase - exported, tested, and used elsewhere - and the defect is that the
site which needs it does not call it.

The strongest instance is the destructive-operation gate. `snapshot-gate.ts:1-30`
states the guarantee in its own header: "no destructive brain mutation runs without a
recovery point on disk first." It has two call sites, against roughly twenty-five
destructive operations. The dream pass takes its own inline snapshot instead, which
that same header names as the anti-pattern it exists to prevent. `restoreSnapshot`
deletes every live top-level entry under `Brain/` without taking a recovery point of
what it is about to discard. The second strongest is the ranker, which reads the
document's authoring instant nine lines after it finished ranking on storage mtime.

So the release has one argument, and it is not a subsystem: **a mechanism that must
be called by hand is a mechanism that will be missed.** Fixing nine call sites fixes
nine instances. What makes the next instance impossible is declaration plus a census
test, which is an idiom this repository already runs for raw `fs` write sites, for
vault-identity assertions on write-capable modules, and for doctor exit codes.

## Scope

Two enforcement layers, then nine units. Unit ids are used throughout `plan.md`.

**Enforcement**

- **R1 - the destructive-site registry and its census.** Every module under
  `src/core/brain/` that removes, renames over, or bulk-overwrites vault content
  either routes through the destructive gate or carries a registry entry declaring
  what recovery coverage it actually has and why. The population rule is structural
  and mechanical - the same shape as the write-site census - so the boundary is not a
  judgment call.
- **R2 - the egress registry and its census.** Every path that writes vault content
  to a destination outside the vault either redacts through the shared redactor or
  carries an entry saying why not.

**Units**

- **A1** (`t_84d0ff47`, p4) - route `distill-source` through `classifySourceOrigin`
  and `normalizeSourceIdentity`, bound its source read to the vault, and treat a
  source with no readable bytes as a verdict rather than a `"missing"` sentinel.
- **B1** (`t_a930c42d`, p4) - a typed recoverability verdict on the destructive gate,
  and the operations with the largest unprotected blast radius routed through it.
- **B2** (`t_ae62fabd`, p4) - note-file lifecycle over MCP and CLI: rename, move,
  delete, archive - gated by B1 and honest about which inbound references it fixed.
- **B3** (`t_783b37f8`, p2) - materialise a stub for an unresolved wikilink target,
  inverting the `skip-missing-target` decision that already exists.
- **C1** (`t_df234a38`, p4) - the shared redactor on the export boundary, and the
  key-name-only copy collapsed into it.
- **D1** (`t_decf83b1`, p4) - the recency prior reads the authoring instant the
  ranker already has in hand.
- **D2** (`t_dd59fc50`, p3) - the consolidation pass folds topic keys with the same
  normaliser the read path uses.
- **E1** (`t_e0ef6011`, p3) - the live provider probe's verdict reaches the exit code
  instead of being downgraded to a warning.
- **E2** (`t_984b8664`, p3) - bank-bundle preferences restore through the audited
  transaction, or the bundle says they did not.

## Out of scope

Each exclusion below is a decision with a reason, not an omission.

- **A pre-commit or pre-push credential scanner for the vault** (the mechanism
  `t_df234a38` asks for by name). The vault has no git transport and deliberately
  never will: "nothing may place a `.git` directory inside the replicated tree"
  appears verbatim in seven design prompts under `docs/brainstorm/`, `.git` is a hard
  skip in nine vault walkers, and `git/reader.ts:1-11` declares read-only a contract.
  Building the requested scanner means first building the git write half the project
  has refused. The task's stated purpose - a gate on bytes leaving the machine - is
  served at the boundary that exists, which is the export surface. Recorded in full
  in `recon/egress-redaction.md`.
- **Repo-visibility verification** (`t_09a3752a`). Same root cause: there is no push
  path to verify a destination for. It is not in this round and the evidence is being
  left on the task so the next round does not re-derive it.
- **Cascade delete of linked memories** (`t_5e338af1`). A cascade is a strictly more
  dangerous operation than the single-note delete B2 introduces, and building it on
  top of a recoverability gate that has not yet shipped once inverts the order of
  risk. It follows B1 and B2, not accompanies them.
- **A trust-classification registry.** The consultant's variant proposed three
  registries; there are exactly three claim-write paths, and a census over three
  items costs more than it protects. A1 wires the third, and `page-lint.ts:28-38`
  already names the non-adopters in prose, which is the honest record at this size.
- **Alias resolution on dream sub-recalls**, as `t_dd59fc50` describes it. The dream
  pass issues no recalls: `dream()` is synchronous and imports no search module. D2
  fixes the asymmetry that is actually there.
- **A doctor check for the embedding probe.** `DoctorCheck.run` is synchronous, so a
  network probe cannot be a doctor check without changing that contract for all
  eighteen checks. E1 stays on `o2b search check`, where the probe already runs.

## Chosen approach

Variant 3 of three, with one documented narrowing.

Keep the call sites where they are and derive the coverage claim from a declared
registry that a census test checks for exhaustiveness, rather than funnelling
twenty-five destructive operations and six export paths through new shared code. The
funnel variant buys the same guarantee but pays for it with the change least
compatible with this project's byte-identical-when-inactive standard, and a
dispatcher that must know every destructive operation is precisely the module the
acyclic-import census will fight.

The narrowing: two registries, not three, for the reason given under Out of scope.

The second half of the variant is not polish. Convert the gate's outcome from an
untyped `throw` into a frozen verdict object carrying a sorted token array, in the
family `retrieval-gate.ts:50` and `self-approval-guardrail.ts:35` already establish.
Without it, B1 wires a gate that cannot admit that `deleteBySource --include-originals`
deletes files no snapshot covers while still reporting a snapshot path, and B2 ships
a rename that cannot qualify which inbound references it actually fixed. Both of
those are the misleading-success the brief forbids, and a boolean cannot express
either.

## Design decisions

- **The destructive-site population rule is syntactic, not semantic.** A module is in
  scope when it calls `rmSync`, `unlinkSync`, `renameSync`, or an atomic write in
  overwrite mode, and can address the vault. "Is this destructive?" is a judgment the
  census must never have to make; "does this file call `unlinkSync`?" is not. This is
  the write-site census's rule with a different call set, and it is why the boundary
  will not rot.
- **Recovery coverage is declared per operation, not assumed from the gate.** An
  operation inside `withDestructiveSnapshot` is covered for `Brain/` and for nothing
  else, because that is what the archive contains
  (`path-constants.ts:116-119`). `deleteBySource --include-originals` removes files
  outside `Brain/` by construction, so its entry declares partial coverage and its
  result says so. A gate that reports uniform coverage over a non-uniform reality
  makes the lie more central, not less.
- **`BRAIN_SNAPSHOT_REASON.manual` gets its first producer.** It is declared and
  documented as "an operator asking for a recovery point with no operation behind it"
  and has had no producer since it was written. B1's proof-of-recoverability path is
  that caller. Nothing new is invented for it.
- **`pruneSnapshots` cannot be gated by a snapshot.** Gating the operation that
  destroys recovery points on taking a recovery point is circular. It gets a floor
  and a named refusal instead: it will not prune below the configured retention and
  it reports what it removed, rather than trimming silently on every dream.
- **A rename states the freshness of the evidence it acted on.** The Brain backlink
  index is a full scan and Brain-scoped; the vault-wide `links` table is only as
  fresh as the last index pass. The rename verdict names both the references it
  rewrote and the staleness of the source it consulted, so an agent is never told
  that every inbound link was fixed when the index has not run since yesterday.
- **The recency fallback keeps byte-identity for every document without an authoring
  instant.** `hyd.authoredAt ?? c.mtime`, both unix seconds, so a corpus with no
  `authored_at` ranks identically to today. The existing tie-break at `ranker.ts:671`
  assumes an exact score tie on equal mtime; feeding `authoredAt` into recency breaks
  that premise by construction, so the tie-break tests are re-derived rather than
  patched to keep passing.
- **`representativeChunks` is either fixed or named.** It does not project
  `authored_at`, so link-expansion candidates would silently keep ranking on mtime.
  Silently is the objection - the projection is added, because the alternative is a
  second unstated exception in the same release that argues against them.
- **Vocabulary values are snake_case**, per the current house default, except where a
  value doubles as a filename prefix - which is why `BRAIN_SNAPSHOT_REASON` is
  kebab-case and any new reason joining it must be too.
- **Every new vocabulary registers in the census** with a guard whose parameter is
  `unknown`, because the census passes `null`, `42` and `{}` at it.
- **Classification stays structural.** The redactor carries no natural-language word
  list - its literals are credential field identifiers, DNS suffixes, file extensions
  and vendor key prefixes - and D2's fold is NFC plus case plus quote variants. No
  unit in this release introduces a word list in any language.

## File changes

New:

- `src/core/brain/gates/recoverability.ts` - the recoverability verdict, its coverage
  and blocker vocabularies, and the pure classifier.
- `src/core/brain/destructive-sites.ts` - the declared registry R1 reads.
- `src/core/brain/notes/lifecycle.ts` - rename / move / delete / archive core.
- `src/core/brain/notes/scaffold-stub.ts` - B3's materialiser.
- `src/core/egress/registry.ts` - the declared registry R2 reads.
- `src/mcp/brain/lifecycle-file-tools.ts` - the MCP surface for B2 and B3.
- `tests/core/architecture/destructive-site-census.test.ts`,
  `tests/core/architecture/egress-census.test.ts`.

Modified, principally: `snapshot-gate.ts`, `snapshot.ts`, `source-cleanup.ts`,
`dream.ts`, `distill/distill-source.ts`, `distill-tools.ts`, `cli/brain/verbs/distill.ts`,
`redactor.ts` consumers across the five unredacted export verbs, `config.ts`,
`search/ranker.ts`, `search/store/chunks.ts`, `dream-plan-topics.ts`,
`search/indexer.ts`, `cli/search/verbs/check.ts`, `portability/bundle.ts`,
`link-graph/repair-lane.ts`, `mcp/brain/notes-tools.ts`, plus the manifest, docs,
CHANGELOG and the seven version-mirrored files.

## Risks and open questions

- **R1 will find operations this design has not counted.** The reconnaissance
  enumerated about twenty-five; a syntactic sweep will find more. That is the point
  of the census, but it means the registry's initial contents are written from the
  sweep's output, not from the recon list, and every entry needs a real reason rather
  than a filler one. If the sweep returns a number that makes per-entry reasons
  impossible to write honestly, the population rule is too wide and gets narrowed
  before the entries are faked.
- **B2's delete is the first MCP verb that removes a user note.** It sits at the top
  of the confirmation ladder: dry-run by default, an explicit confirm, and a count
  guard, matching `deleteBySource` rather than the weaker `--apply` tier.
- **E2 requires a bundle schema bump**, and the current version mismatch is a hard
  refusal with no migration path. Either the bump comes with a reader for version 1,
  or old bundles stop importing - the second is a breaking change and must be named
  as one in the CHANGELOG if chosen.
- **D1 changes default ranking**, so the recall benchmark's pinned thresholds must be
  re-measured and its header comment updated, per the instruction in that file.
- **The dream pass moving off its inline snapshot changes when the snapshot is taken
  relative to the staging directory.** Byte-identity of dream output is measured
  against the previous release rather than assumed.
