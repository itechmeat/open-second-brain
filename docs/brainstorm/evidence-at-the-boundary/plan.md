# Evidence at the boundary - implementation plan

Twelve tasks across three spines. Within a spine the order is prerequisite driven.
Across spines there is no dependency. Every task is test-driven: the test is
written first and observed failing for the expected reason before the
implementation exists.

Per-unit reconnaissance lives in `recon/`; project-wide conventions and the gates
that fail a pull request late live in `recon/conventions.md`. Read the relevant
recon file before starting a task - every file:line in it was verified against
`main` @ 29ea0099.

## Spine A - what a write verifies before it lands, and reports after

### Task A1: a typed collision error
- **Files**: `src/core/fs-atomic.ts`, `src/core/vault.ts`,
  `tests/core/fs-atomic.test.ts`
- **Do**: export a `FileAlreadyExistsError` carrying `code = "EEXIST"`, the path
  and an optional kind, thrown by `atomicCreateFileSyncExclusive`; export one
  `isFileAlreadyExists(err)` predicate that also inspects `.cause`. Make
  `writeFrontmatterAtomic` preserve the class instead of downgrading to a plain
  `Error`, keeping its message wording byte-identical. Fold the hand-rolled
  `path.startsWith(vault + "/") ? slice()` at `vault.ts:462-466` into the existing
  `vaultRelative` helper.
- **Acceptance**: a collision from both call shapes is recognised by the predicate;
  the thrown message is unchanged; no call site anywhere matches on the message.
- **Depends on**: none

### Task A2: retry a lost race instead of dropping the event (GitHub #161)
- **Files**: `src/core/brain/paths.ts`, `src/core/brain/signal.ts`,
  `src/core/brain/dead-ends.ts`, `src/core/brain/capture/capture-note.ts`,
  `src/core/brain/snapshot-gate.ts`, `src/core/brain/dream.ts`,
  `src/core/brain/index.ts`, `tests/core/brain.paths.test.ts`,
  `tests/core/brain.signal.test.ts`
- **Do**: add `allocateAndCreate(opts, create)` beside `allocateSlug`, sharing one
  private candidate-naming function so the naming rule exists once; extract the
  inline `10_000` as a named bound. Adopt it in all three callers. Give
  `writeCaptureNote` the `existsErrorKind` and vault-relative path its two siblings
  already pass. Re-key `createUniqueSnapshot` on the typed predicate so an
  unrelated failure is no longer swallowed and retried, and bound
  `nextAvailableDreamRunId`.
- **Acceptance**: a `create` callback that writes the target itself and throws the
  typed collision on its first invocation lands on the `-2` candidate and is
  invoked twice; a non-collision error propagates from the first attempt; an
  always-colliding callback exhausts a small bound and throws loudly. Eight
  concurrent `brain feedback` subprocesses against one topic and date produce eight
  exit-zeros and eight distinct files.
- **Depends on**: A1

### Task A3: intake trust requires the file to exist (GitHub #160)
- **Files**: `src/core/brain/intake/source-trust.ts`,
  `src/core/brain/intake/extract-intake.ts`,
  `src/core/brain/entities/registry.ts`, `src/core/brain/trust/untrusted-provenance.ts`,
  `src/mcp/brain/ner-tools.ts`, `src/mcp/brain/intake-args.ts`,
  `src/mcp/brain/ingest-tools.ts`, `src/core/brain/ingest/ingest.ts`,
  `tests/core/brain/intake/*.test.ts`, `tests/mcp/ner-tool.test.ts`
- **Do**: export one `normalizeSourceIdentity` handling the wikilink wrapper, the
  alias pipe and the anchor, and use it from both callers so the ingest summary
  stops writing a doubly wrapped link and a divergent identity hash. Replace the
  classifier with one returning the verdict and, when trusted, the content hash
  from the existing `hashFile`. Not a file, or a missing path, means untrusted; any
  other errno rethrows, because an unreadable file is not a trust verdict. Classify
  once inside the primitive: delete the caller-declared trust option and the
  zero-source-means-trusted branch, require at least one source, and return the
  verdict on the result so the tool reads it back. Persist the hash beside the
  untrusted marker under a named key. Rewrite the docstring that justified the
  omission.
- **Acceptance**: the polarity suite is rewritten so a vault-shaped path that does
  not exist is quarantined and the same path with a real file behind it is trusted
  and records the hash; a zero-source intake throws; an unreadable source rethrows
  rather than returning a verdict; a bracketed source produces one summary page.
- **Depends on**: none

### Task A4: a write reports what is wrong with what it wrote (kanban t_0e79f0b3)
- **Files**: new `src/core/brain/page-lint.ts`, `src/mcp/brain/notes-tools.ts`,
  `src/mcp/brain/write-batch-tools.ts`, `src/core/brain/lint-consolidate.ts`,
  `src/core/brain/diagnostics.ts`, `src/mcp/registry-guard.ts`,
  `tests/core/brain/page-lint.test.ts`, `tests/mcp/brain-create-note.test.ts`,
  `tests/mcp/brain-update-append-note.test.ts`, `tests/mcp/brain-write-batch.test.ts`
- **Do**: build the per-page lint on existing detectors only - the artifact
  validator for error-severity codes, the canonical-id resolver for merged links,
  the basename index for broken Brain-artifact links - with a declared finding cap,
  a comparator, and `total`, `returned`, `truncated` and `skipped` always present
  when the key is. Attach through one `noteWriteResult` helper adopted by all four
  handlers. Failure degrades to a named `unavailable`, never to a missing key.
  While here: delete the unreachable empty-path fallback, stop hardcoding the
  success flags, re-point the merged-link rewrite at the canonical-id resolver so
  it converges in one pass, and register the two lint codes so a fix hint resolves.
  Update the four preview-budget exemption reasons, which become false.
- **Acceptance**: a clean write carries no lint key at all; a write with a broken
  wikilink carries one warning finding with a next command; a write of an invalid
  document carries error findings ranked first; a page over the byte cap appears in
  `skipped` rather than vanishing; a two-step merge converges in one pass.
- **Depends on**: none

## Spine B - what the system knows about its own scope and state

### Task B1: one path-coverage predicate
- **Files**: `src/core/vault-scope/defaults.ts`, `src/core/write-binding/prefix.ts`,
  `src/core/vault-scope/index-admission.ts`, `src/core/brain/notes/note-walk.ts`,
  `src/core/search/indexer.ts`, `src/core/brain/manifest.ts`,
  `tests/core/vault-scope.test.ts`
- **Do**: export `pathCovers(prefix, relPath)` from the cycle-safe leaf and
  re-point all five copies at it, keeping each caller's semantics.
- **Acceptance**: the five call sites behave identically; the segment-wise cases
  the write-binding docblock describes are covered by tests at the new home.
- **Depends on**: none

### Task B2: a positive include allowlist (GitHub #155)
- **Files**: `src/core/vault-scope/defaults.ts`, `src/core/vault-scope/index.ts`,
  `src/core/brain/policy/blocks/vault-ignore.ts` renamed to `vault-scope.ts`,
  `src/core/brain/policy/validate.ts`, `src/core/brain/policy.ts`,
  `src/core/brain/types.ts`, `src/core/brain/config-template.ts`,
  `src/core/brain/notes/note-walk.ts`, `src/core/search/walker.ts`,
  `src/core/search/index.ts`, `src/core/search/types.ts`,
  `src/core/brain/notes/create-note.ts`, `src/core/brain/doctor/config-checks.ts`,
  `src/cli/vault/help-text.ts`, `docs/architecture.md`, `docs/how-it-works.md`,
  `docs/cli-reference.md`, `tests/helpers/search-fixtures.ts`,
  `tests/core/vault-scope.test.ts`, `tests/core/brain.policy.test.ts`
- **Do**: make the resolved rules a struct carrying both polarities; replace
  `matchIgnore` with a polarity-free matcher plus one composed `matchScope` and a
  `mayDescend` for walkers, and delete the old name rather than aliasing it. Parse
  the new key through the same normaliser, add it to the known-key list, and refuse
  an empty list with the wording already used for write-binding prefixes. Template
  it commented. Extend the config check with an error-severity code for a dead
  include root. Special-case the vault root as in scope. Make the create-note
  refusal name which polarity refused it. Give the walker-facing verbs the index
  admission filter they omit, so status and inspect stop over-reporting coverage.
- **Acceptance**: absent means byte-identical behaviour on a fixture vault;
  declared means only the named roots are walked, minus exclusions; an empty list
  is refused at parse time; a dead include root is an error-severity doctor
  finding; setting the key and reindexing prunes previously indexed documents; the
  template ratchet passes.
- **Depends on**: B1

### Task B3: one day, one age
- **Files**: new `src/core/brain/time.ts`, `src/core/brain/stale-dependency.ts`,
  `src/core/brain/profile-doc.ts`, `src/core/brain/temporal/stale-watch.ts`,
  `src/core/brain/idea-discovery.ts`, `src/core/brain/deep-synthesis.ts`,
  `src/core/brain/temporal/weekly-brief.ts`, `tests/core/brain/time.test.ts`
- **Do**: export the millisecond-per-day constant and one age helper whose stat
  failure is explicit rather than policy-by-accident, and re-point all copies.
  Where a caller previously returned zero on a stat failure, make the failure
  visible at that caller rather than silently reversing its meaning.
- **Acceptance**: one constant, one helper, no remaining inline day arithmetic in
  the named files; the previously-silent stat failure is observable.
- **Depends on**: none

### Task B4: staleness that can say it does not know (kanban t_a3254fe8, first half)
- **Files**: `src/core/brain/staleness.ts`, `src/core/brain/policy/blocks/health.ts`,
  `src/core/brain/types.ts`, `src/core/brain/config-template.ts`,
  `src/cli/brain/verbs/clusters.ts`,
  `tests/core/architecture/verdict-vocabulary-census.test.ts`,
  `tests/core/brain/staleness.test.ts`
- **Do**: replace the boolean with a three-state verdict plus named stale and
  unknown reasons, all four-piece vocabularies registered in the census. Add the
  wall-clock ceiling as a resolved config key with a commented template entry. The
  caller skips only on fresh, and on unknown recomputes and prints the reason.
- **Acceptance**: an output older than the ceiling with no input moved is stale for
  that reason; inputs listed but unreadable is unknown, not fresh; the census
  passes; the ceiling defaults leave existing behaviour unchanged except for the
  formerly-mislabelled cases.
- **Depends on**: B3

### Task B5: readiness that reads installed state (kanban t_a3254fe8, second half)
- **Files**: `src/core/doctor-readiness.ts`, `src/core/install/adapters/_json-mcp.ts`,
  `src/cli/install/install.ts`,
  `tests/core/architecture/verdict-vocabulary-census.test.ts`,
  `tests/core/doctor-readiness.test.ts`, `tests/cli/install*.test.ts`
- **Do**: add an unknown status with a members list, a guard and a census entry.
  Add a probe reading installed state through each registered adapter's own verify,
  mapping the closed verify vocabulary onto it and reporting an unreadable manifest
  as unknown. Narrow the construction probe's wording to what it actually proves.
  Either implement the declared-but-unimplemented liveness seam for one adapter or
  state in the verify details that no handshake was attempted, and stop the install
  check exiting zero for a runtime proved unreachable.
- **Acceptance**: a machine with nothing installed no longer reports a passing
  runtime probe; an unreadable manifest reports unknown with a reason; the install
  check exit code distinguishes unreachable from not-installed.
- **Depends on**: none

### Task B6: the two resolvers must agree (GitHub #130)
- **Files**: `plugins/hermes/config.py`, `plugins/hermes/provider.py`,
  `src/core/doctor.ts`, `tests/python/test_memory_provider.py`,
  new `tests/python/test_resolver_parity.py`
- **Do**: bring the Python resolver up to the contract its docstring claims -
  pointer resolution, profile resolution, tilde expansion, last-duplicate-key
  semantics - and raise a named error for a present-but-unreadable config instead
  of returning none. Make `save_config` verify its own effect and refuse loudly
  when the effective value differs from what was written, and stop skipping falsy
  values so a cleared field can be unset. Derive the config schema and the key
  tuple from one ordered structure. Add a doctor check comparing the vault the
  TypeScript core resolves with the one the plugin resolves. Add the module logger
  the silent handlers lack.
- **Acceptance**: one fixture table driven through both resolvers agrees on every
  row across environment override, tilde, active and dangling profiles, duplicate
  keys, and absent, present, unreadable and directory configs; an unreadable config
  raises rather than reporting unconfigured; the doctor check fails when the two
  disagree.
- **Depends on**: none

## Spine C - what the system says about itself to a caller

### Task C1: which silence is this (kanban t_e5f447c1)
- **Files**: `src/core/brain/recall-telemetry.ts`,
  `src/core/brain/continuity/types.ts`, `src/core/brain/context-pack.ts`,
  `src/core/brain/pre-compress-pack.ts`, `src/mcp/search-tools.ts`,
  `src/mcp/brain/query-tools.ts`, `src/mcp/brain/recall-tools.ts`,
  `src/cli/brain/verbs/recall-telemetry.ts`, `hooks/recall-inject.ts`,
  `src/core/brain/path-constants.ts`, new
  `src/core/brain/doctor/recall-channel-coverage.ts`, `src/core/brain/doctor.ts`,
  `src/core/brain/doctor/check.ts`, `src/core/brain/doctor/report.ts`,
  `src/core/brain/diagnostics.ts`, `src/core/brain/doctor-exits.ts`,
  `tests/core/brain/recall-telemetry.test.ts`, new doctor-check test
- **Do**: declare the three-member channel vocabulary and convert the two existing
  open ones to the same shape, deriving the three stale prose and enum copies from
  the frozen arrays. Add `channel` as a required field on the input and options,
  protect it from payload clipping, and extract the correlation envelope the five
  emit sites duplicate. Make the injecting hook emit, mapping its three decisions
  onto the status vocabulary. Add the doctor check whose install state is a switch
  with no default arm, add the config path to the check context, and register both
  codes on the correct side of the exit census.
- **Acceptance**: a filter and a summary by channel; the hook writes a record for
  each of its three decisions; an enabled hook with no deliveries is a warning and
  an unreadable install side is uncertain rather than clean; the exit census
  passes; the previously unfilterable mode is filterable.
- **Depends on**: none

### Task C2: an empty result that names its cause (kanban t_3309a27a)
- **Files**: new `src/core/search/retrieval-trail.ts`,
  `src/core/search/pipeline/outcome.ts`, `src/core/search/search.ts`,
  `src/core/search/store/trigram.ts`, `src/core/search/pipeline/semantic-phase.ts`,
  `src/core/search/pipeline/semantic-lane.ts`,
  `src/core/search/pipeline/keyword-lane.ts`,
  `src/core/search/pipeline/assemble.ts`, `src/core/search/pipeline/pool-filters.ts`,
  `src/core/search/cross-vault.ts`, `src/core/search/fts.ts`,
  `src/mcp/search-tools.ts`, `src/cli/search/outcome-render.ts`,
  `src/core/brain/negative-recall.ts`,
  `tests/core/architecture/verdict-vocabulary-census.test.ts`,
  `tests/core/search/*.test.ts`, `tests/cli/search*.test.ts`
- **Do**: one module owning the closed vocabulary, the trail type, the single
  English mapping behind an exhaustive switch with no default arm, and the envelope
  function. Thread a typed sink parallel to the existing warnings array; each lane
  pushes a code beside the sentence it already pushes. Seed the vocabulary only
  from sites reconnaissance found, preferring codes where a classification already
  exists and is being flattened. Surface the two dead payloads. Spread the envelope
  at the two existing surface seams and declare the enum in the output schema.
  Explain an empty result from the trail when it is non-empty, and otherwise from
  the negative-recall classifier lifted out of the recall gate and called only on
  the zero-result path. Re-point the telemetry gap strings at the trail rather
  than leaving a second vocabulary.
- **Acceptance**: a degraded lane names its code on both surfaces; an empty result
  with a degraded lane names the cause; an empty result over a healthy index says
  so with a state and a reason; the non-empty path is byte-identical to before by a
  frozen-outcome comparison; the census passes; an undeclared code fails the output
  contract.
- **Depends on**: none

### Task C3: a catalog that documents itself, and an argument that is answered (kanban t_e24c6dbb)
- **Files**: `src/mcp/registry-guard.ts`, new `src/core/text/nearest-name.ts`,
  new `src/mcp/argument-guard.ts`, `src/mcp/server.ts`, `src/mcp/search-tools.ts`,
  `src/mcp/brain/ingest-tools.ts`, `src/mcp/brain/generation-tools.ts`,
  `src/mcp/brain/memory-bridge-tools.ts`, `src/mcp/brain/query-tools.ts`,
  `src/mcp/brain/knowledge-tools.ts`, `src/mcp/brain/calendar-tools.ts`,
  `src/mcp/brain/context-tools.ts`, `plugins/hermes/_schemas.py`,
  `docs/mcp.md`, `tests/mcp/registry-guard.test.ts`, `tests/mcp/mcp.test.ts`,
  new `tests/core/text/nearest-name.test.ts`
- **Do**: generalise the schema walker into a node stream carrying node kind so
  both audits share one traversal, and add a completeness audit under a closed rule
  vocabulary, including an explicit violation for a composition keyword the walker
  cannot follow rather than a silent skip. Backfill the fifty-nine descriptions.
  Add a pure edit-distance helper with a declared suggestion threshold and
  deterministic tie-breaking. Add the argument gate reading the schema's own
  closure, throwing with structured data naming every undeclared argument and a
  suggestion where the distance supports one, wired as the first statement of the
  single handler-invocation seam. Delete the duplicated whole-table assertion and
  extract the magic minimum-reason length. Re-vendor the Hermes schema copies if
  any description changed.
- **Acceptance**: the completeness audit is red before the backfill and green
  after, and a hand-built undocumented tool proves it can fail; an unknown argument
  produces an invalid-params error naming it with a suggestion; the anti-drift
  gate passes.
- **Depends on**: none

## Release tasks

### Task R1: docs, version, changelog
- **Files**: `CHANGELOG.md`, `package.json`, the seven mirrored manifests via the
  sync script, `README.md`, `docs/mcp.md`, `docs/architecture.md`,
  `docs/how-it-works.md`, `docs/cli-reference.md`
- **Do**: one changelog version for the whole release in the project's voice, the
  version bump inside this pull request per the repository's own override of the
  playbook default, and the documentation for the new config key, the new doctor
  codes, the new tool-argument contract and the new response key.
- **Acceptance**: `bun run sync-version:check` clean; the changelog entry names
  what was deliberately not shipped and why.
- **Depends on**: every implementation task

### Task R2: the gates nothing local catches
- **Do**: rebuild the OpenClaw bundle, run the link ratchet, run the full
  TypeScript and Python suites with an empty `HOME` so the bare-runner condition is
  reproduced locally, and run format, lint and typecheck.
- **Acceptance**: every gate in `recon/conventions.md` passes locally before the
  first push.
- **Depends on**: R1
