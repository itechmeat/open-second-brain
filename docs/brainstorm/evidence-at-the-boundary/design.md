# Evidence at the boundary - nine claims the system could not back up

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Nine places in Open Second Brain state something they have not verified, or stay
silent where silence is indistinguishable from an answer. Four are reported on the
public tracker; five were found by mining upstream projects and then grounded
against this code. In every one, the information needed to tell the two cases
apart either exists already and is discarded, or costs a single filesystem call
that nobody makes.

The release is not a theme applied to nine unrelated fixes. Reconnaissance
measured duplication, not resemblance: one segment-wise path predicate written
five times, one wall-clock age computation written five times with three spellings
of a day and two opposite failure policies, four write tools with four hand-built
result shapes, a dozen search degradation signals computed and dropped, and two
typed answers to "why is this empty" each wired to exactly one caller.

## Scope

Three spines, nine units. Each unit is one atomic commit or a short series.

### Spine A: what a write verifies before it lands, and reports after

- **A1 (prerequisite).** A typed collision error owned by the leaf that performs
  the exclusive create, with one predicate for recognising it. Today the atomic
  writer downgrades the native `EEXIST` to a plain `Error` whose errno survives
  only on `.cause`, so no caller can retry without matching a message.
- **A2 (GitHub #161).** One `allocateAndCreate` helper beside `allocateSlug` that
  retries the exclusive create on a typed collision, adopted by all three callers
  that today report a lost race as terminal. The two other copies of
  probe-create-retry are re-keyed on the same predicate: one currently swallows any
  unrelated error, the other is unbounded.
- **A3 (GitHub #160).** Intake trust requires the named source to exist and records
  the hash of the bytes that were claimed. Trust is classified once, inside the
  primitive, instead of twice with an escape hatch that exists only to suppress the
  second classification.
- **A4 (kanban t_0e79f0b3).** One write-result envelope across the four note-write
  tools, carrying ranked lint findings for the pages just written, absent entirely
  when there is nothing to say.

### Spine B: what the system knows about its own scope and state

- **B1 (prerequisite).** One exported segment-wise path-coverage predicate,
  replacing five copies.
- **B2 (GitHub #155).** A positive `vault.include_paths` allowlist. Absent means
  today's behaviour byte for byte. The resolved scope stops being an array of
  ignore rules and becomes a struct with both polarities, so no consumer can
  compile while applying half the policy.
- **B3 (prerequisite).** One exported millisecond-per-day constant and one
  wall-clock age helper, replacing five copies that disagree about whether a stat
  failure means fresh or stale.
- **B4 (kanban t_a3254fe8, first half).** Materialisation staleness becomes a
  three-state verdict with a wall-clock ceiling. The state where no input could be
  stat'ed stops being reported as fresh.
- **B5 (kanban t_a3254fe8, second half).** Readiness gains an unknown state and a
  probe that reads installed state off disk through each adapter's own verify,
  instead of asserting from in-process construction. The install check stops
  exiting zero for a runtime it proved unreachable.
- **B6 (GitHub #130).** The Hermes plugin's vault resolver is made to match the
  contract its own docstring claims, an unreadable config stops reading as
  unconfigured, and a doctor check compares the two resolvers so the mismatch can
  never again be silent.

### Spine C: what the system says about itself to a caller

- **C1 (kanban t_e5f447c1).** A closed channel dimension on recall-delivery
  telemetry, the injecting hook actually emitting, and a doctor check that
  separates an installed-but-silent channel from one that cannot be measured.
- **C2 (kanban t_3309a27a).** One retrieval trail with a closed degradation
  vocabulary reaching both the CLI and the MCP envelope through one function, and
  an empty result that names its cause.
- **C3 (kanban t_e24c6dbb).** A CI guarantee that every advertised parameter is
  documented, and an unknown argument named back to the caller with a suggestion
  instead of being silently ignored.

## Out of scope

- **Host-attributed intake trust.** There is no unforgeable caller identity in the
  MCP surface, and `src/core/write-binding/index.ts:12-22` already records that
  conclusion. It needs a new transport concept and a cooperating host.
- **Per-caller filtering of `tools/list`.** It depends on per-client surface state
  from an unshipped task.
- **Nested `additionalProperties` enforcement.** Fifteen nested object nodes
  declare a closure the new gate will not enforce. Recorded as a limit in the
  module header rather than left as a second unenforced promise.
- **The daemon half of the upstream health release** - heartbeat, migration mutex,
  self-disable hysteresis. This project runs no autopilot daemon.
- **An embedding-provider sunset registry.** The only implementation is a
  hand-maintained table of shutdown dates over an open set of providers, and no
  provider exposes the metadata. An invented date is worse than no date.
- **Unifying the two string-argument readers.** Their blank-string semantics
  diverge (one returns the default, one throws). Documented here, fixed in its own
  unit.
- **Trust classification in `distill-source.ts`.** Same defect class as A3, a
  different entry point, and no reporter. Worth its own issue.
- **`brain_write_session`'s own error channel.** A4 does not reach it, and the plan
  says so rather than implying coverage.

## Chosen approach

Variant 3 of three, with the allowlist moved from the write spine to the
scope-and-state spine. The reasoning and the two rejected variants are in
`variants.md`.

The decision the release turns on: a shared mechanism is extracted exactly where
reconnaissance measured duplication, and nowhere it only found resemblance. A
global evidence kernel was rejected because this project already rejected
cross-cutting kernels once, in the form of forty per-module error subclasses, and
because a kernel whose shape depends on all nine units cannot land incrementally.
A pure review standard was rejected because unit A4 needs one envelope across four
tools and would otherwise build it unnamed.

## Design decisions

- **Typed collision before retry.** A2 cannot be written honestly without A1: a
  retry keyed on an error message is the kind of fallback this release exists to
  remove. The error class lives in the leaf that calls `linkSync`, so nothing has
  to import the vault module to recognise a collision.
- **The retry helper takes an injected create callback.** All three callers derive
  the frontmatter id from the allocated slug, so a helper that re-links
  pre-rendered bytes would ship a file whose id contradicts its own filename. The
  callback also keeps `paths.ts` free of any named write call, which keeps it
  outside the write-site census.
- **A3 states its own limit.** An existence check does not stop the lie: a caller
  forced to name a real file names `README.md`. It removes the free bypass and
  makes the claim auditable. The docstring that justified the omission is rewritten
  on its own terms rather than deleted: this tool asserts that entities were
  extracted from this material, and a path with no bytes behind it cannot have
  produced an extraction.
- **The recorded source hash is an audit record, not a gate.** Nothing reads it
  this release. That is deliberate and documented, mirroring how preference content
  hashes document drift.
- **B2 changes a type rather than adding a field.** `VaultScope.rules` becomes a
  struct carrying both polarities and `matchIgnore` is deleted rather than kept as
  an alias, so every consumer breaks at compile time. A function named for one
  polarity that answers half the scope question is exactly the misleading surface
  this release is about.
- **An empty allowlist is refused.** A list that admits no path is an off switch
  rather than a boundary, which is the wording and the precedent already used for
  write-binding prefixes. `ignore_paths: []` keeps its documented excludes-nothing
  meaning, and the asymmetry is stated in the docblock.
- **The allowlist is templated commented, never live.** It has no default, and the
  template ratchet requires every commented key to resolve identically to an empty
  config.
- **B4 drops a boolean.** A boolean cannot carry unknown, and there is exactly one
  caller, so no compatibility shim is warranted.
- **B6 is fixable without the host.** Two hypotheses are verified from code alone:
  the resolver is a truncated copy of the contract it claims to mirror, and an
  unreadable config silently reads as unconfigured. Both produce the reported
  symptom. The host-side hypotheses stay open, and the release note says which
  question separates them.
- **The resolver parity test is a comparison, not two assertions.** The class of
  bug is that two implementations disagree, so one fixture table is driven through
  both and the results are compared.
- **C1 makes the channel required.** An optional field lets a call site omit it and
  produce a record that reads as no channel, which is the ambiguity being removed.
  Required makes all five call sites fail to compile until each names its channel.
- **The channel set is three members because three exist in code.** No `hermes`
  member: that is a host, not a transport, and there is no Hermes delivery path in
  this repository.
- **C2 seeds its vocabulary from sites that exist.** Every code names a real
  degradation site found in reconnaissance; none is speculative. Where a
  classification already exists and is flattened into prose, the code is the
  classification rather than a new one.
- **C2 does not introduce `_meta`.** The key is unused in this tree, and it would
  be a channel outside the output-contract assertion. The trail is a declared
  sibling key with its enum in the output schema, so an undeclared code fails the
  contract loudly.
- **An empty result is explained by machinery that already exists.** The negative
  recall classifier is lifted out of the recall gate and called only on the
  zero-result path, which keeps the non-empty path byte-identical.
- **C3's two halves interlock.** The runtime gate reads `additionalProperties`
  from the schema rather than assuming it, and the CI guard is what guarantees the
  read never lands on an open schema.
- **No exemption table for missing descriptions.** Fifty-nine gaps get real
  descriptions. An exemption keyed on a property path would be a rule that
  documents nothing.

## File changes

New modules: a typed collision error and predicate in `src/core/fs-atomic.ts`;
`allocateAndCreate` in `src/core/brain/paths.ts`; `pathCovers` in
`src/core/vault-scope/defaults.ts`; a day constant and age helper in
`src/core/brain/time.ts`; `src/core/brain/page-lint.ts`;
`src/core/brain/doctor/recall-channel-coverage.ts`;
`src/core/search/retrieval-trail.ts`; `src/core/text/nearest-name.ts`;
`src/mcp/argument-guard.ts`. The resolver-parity check is a new function inside
the existing top-level `src/core/doctor.ts`, which has no check registry and is a
hand-written sequence, so it does not get its own module.

Modified, by spine. A: `fs-atomic.ts`, `vault.ts`, `paths.ts`, `signal.ts`,
`dead-ends.ts`, `capture/capture-note.ts`, `snapshot-gate.ts`, `dream.ts`,
`intake/source-trust.ts`, `intake/extract-intake.ts`, `entities/registry.ts`,
`mcp/brain/ner-tools.ts`, `ingest/ingest.ts`, `mcp/brain/notes-tools.ts`,
`mcp/brain/write-batch-tools.ts`, `diagnostics.ts`, `registry-guard.ts`.
B: `vault-scope/defaults.ts`, `vault-scope/index.ts`, `policy/blocks/vault-ignore.ts`
(renamed), `notes/note-walk.ts`, `search/walker.ts`, `search/index.ts`,
`search/types.ts`, `notes/create-note.ts`, `config-template.ts`, `types.ts`,
`doctor/config-checks.ts`, `staleness.ts`, `policy/blocks/health.ts`,
`cli/brain/verbs/clusters.ts`, `doctor-readiness.ts`, `install/adapters/_json-mcp.ts`,
`cli/install/install.ts`, `plugins/hermes/config.py`, `plugins/hermes/provider.py`,
`core/doctor.ts`. C: `recall-telemetry.ts`, `continuity/types.ts`,
`context-pack.ts`, `pre-compress-pack.ts`, `mcp/search-tools.ts`,
`mcp/brain/query-tools.ts`, `mcp/brain/recall-tools.ts`,
`cli/brain/verbs/recall-telemetry.ts`, `hooks/recall-inject.ts`, `doctor.ts`,
`doctor-exits.ts`, `search/pipeline/*`, `cli/search/outcome-render.ts`,
`mcp/server.ts`, and the seven tool modules carrying undocumented parameters.

Docs: `CHANGELOG.md`, `README.md`, `docs/mcp.md`, `docs/architecture.md`,
`docs/how-it-works.md`, `docs/cli-reference.md`, `src/cli/vault/help-text.ts`,
`plugins/hermes/_schemas.py` re-vendored if any tool description changes.

## Risks and open questions

- **B2's blast radius.** Changing the resolved-scope type breaks every consumer at
  compile time by design, and `tests/helpers/search-fixtures.ts` is the single
  chokepoint most search tests build rules through. If that helper's signature
  changes, a large number of test files change with it.
- **A3's test blast radius.** Sixteen test files and roughly 186 literal source
  paths name vault-shaped files that are never created; all of them must seed the
  file. Mechanical, but it is the bulk of that unit.
- **The three census tests are the likeliest first failures.** Every new closed
  vocabulary must register in the verdict census, every new doctor code must carry
  a next command or an exclusion reason, and any new direct filesystem write must
  be declared with its exact sorted call list.
- **The OpenClaw bundle.** Several units touch modules reachable from the bundle
  entry point, so the committed artifact must be rebuilt or the byte-diff fails at
  the very end.
- **Open question, deliberately left open.** B6 cannot confirm which signal the
  Hermes host reads for its badge. The two host-side hypotheses stay recorded, and
  the reply to the reporter names the one command that separates them.
