# No dead ends - implementation plan

Twenty-four atomic tasks. Tasks 1 and 2 are the shared seams and gate the units that
deliver a next step; tasks 8 and 9 are the applier seam. The remaining tasks are
independent of each other and may be implemented in any order, one commit each.
Each task is one conventional commit, and each must pass the full gate set in the
foreground before the commit: format, lint at the exact baseline of 134 warnings and 0
errors, typecheck, the whole test suite, the version-sync check, and the link ratchet.

Every task carries the same two implicit acceptance criteria, not repeated below:

- **Byte-identical when absent.** With the new field, flag or config key omitted, the
  surface produces byte-for-byte the output it produces on `main`. Asserted by a test,
  not assumed.
- **No stub, no silent fallback.** Anything that cannot be done raises a named,
  specific error. A code path that does nothing and reports success is a defect.

## Tasks

### Task 1: Next-step resolution over the existing registry

- **Files**: `src/core/brain/diagnostics.ts`, a new resolution surface beside it,
  `tests/core/brain/next-step.test.ts`
- **What**: One function that turns a diagnostic code into a structured next step, and
  one record type carrying the code and the structural command. Built over
  `DIAGNOSTIC_SIGNALS`, which already models exactly this. No second registry. A code
  with no registered signal resolves to an explicit absent result, never to a guessed
  or empty command.
- **Acceptance**: Every code in the registry resolves. An unregistered code returns the
  absent result and never throws. A test asserts the returned command is a structural
  CLI string and contains no sentence punctuation, so prose cannot re-enter through
  this door.
- **Depends on**: none

### Task 2: The advisory emission rail

- **Files**: a new rail module under `src/cli/`, `src/cli/json-helpers.ts`,
  `tests/cli/advisory-rail.test.ts`
- **What**: The single point through which every forward-pointer line is emitted. It
  owns the question of whether advisory chrome is legal on the current output stream,
  distinguishing the twelve verbs that own an internal JSON branch from everything else,
  which is wrapped in an envelope. Fix `wantsJsonFlag`, which scans raw argv and so
  misreads a note whose own text contains the JSON flag.
- **Acceptance**: A verb with an internal JSON branch emits nothing advisory to stdout
  under that flag, and its output still parses. A note whose text contains the flag as
  literal content is no longer treated as a JSON request; a regression test pins that
  exact string. Advisory output on the human path is unchanged where it already existed.
- **Depends on**: Task 1

### Task 3: Runtime notices carry a structured command

- **Files**: `src/core/brain/runtime-notices.ts`, `hooks/active-inject.ts`,
  `src/mcp/tools.ts`, `tests/core/brain/runtime-notices.test.ts`
- **What**: Add an optional structured command to the notice record, resolved through
  Task 1 rather than embedded in prose. Correct the search-index notice, whose text
  claims recall returns nothing when the read path self-heals and builds the index. The
  prose field stays for the human surfaces.
- **Acceptance**: A notice with a registered code exposes its command as a field. The
  corrected notice text no longer contradicts the self-heal behaviour that a test
  already pins. The SessionStart injection and the vault-health tool output are
  byte-identical for callers that do not read the new field.
- **Depends on**: Task 1

### Task 4: The Brain doctor names its exits

- **Files**: `src/cli/brain/verbs/doctor.ts`, `src/mcp/brain/health-tools.ts`,
  `tests/cli/brain-doctor-next-step.test.ts`, `tests/mcp/doctor-next-step.test.ts`
- **What**: Route every issue the Brain doctor reports through the rail, so the human
  surface prints the structural next command and the JSON surface carries it as a field.
  The same for the MCP tool. The registry that already maps these codes has two
  consumers today and the doctor is not one of them.
- **Acceptance**: For an issue whose code is registered, the human output names the
  command and the JSON output carries it. For an unregistered code, neither invents one.
  A vault with no issues produces the output it produces today, byte for byte.
- **Depends on**: Tasks 1, 2

### Task 5: Terminal states that print nothing forward

- **Files**: `src/cli/brain/verbs/init.ts`, `src/cli/search.ts`, the empty-state brain
  verbs, `tests/cli/terminal-states.test.ts`
- **What**: Emit a next step from the terminal states that currently exit zero in
  silence, beginning with Brain initialization - the command that creates the empty
  Brain and says nothing about what fills it. Reuse the rail; do not hand-write per-verb
  copy. Leave the search read path alone: it self-heals by design and a hint there would
  regress a pinned behaviour.
- **Acceptance**: Each covered terminal state names a command on the human surface and
  stays clean under the JSON flag. The self-healing search path is untouched, asserted
  by the existing test still passing unmodified.
- **Depends on**: Tasks 1, 2

### Task 6: Command manifest completeness and its ratchet

- **Files**: `src/cli/command-manifest.ts`, `tests/cli/manifest-completeness.test.ts`
- **What**: The manifest is the source of shell completions and the JSON help output,
  and it is missing two top-level verbs, seven search subverbs and fifty-five brain
  cases. Repair it, and add a ratchet test that enumerates from the dispatchers, not from
  the manifest, so a verb cannot be added without an entry.
- **Acceptance**: The ratchet lists every dispatcher case with no manifest entry and
  fails while any remains unclassified. Completions and JSON help include the repaired
  set. A deliberately hidden verb, if any exists, is listed with a written reason rather
  than silently skipped.
- **Depends on**: none

### Task 7: Terminal-state census

- **Files**: `tests/cli/terminal-state-census.test.ts`
- **What**: The enforcement artifact for the release. Enumerated from the dispatchers,
  it partitions every terminal state into one of three classes: names an exit, names a
  refusal, or is deliberately silent with a written reason. It fails until a new state
  is classified.
- **Acceptance**: The census names any unclassified state and fails. Every reason string
  is non-empty. The census cannot be satisfied by an empty reason or a placeholder.
- **Depends on**: Tasks 5, 6

### Task 8: The applier capability table

- **Files**: `src/core/brain/diagnostics.ts`, `src/core/brain/hygiene/apply.ts`,
  `src/core/brain/health/remediation.ts`, a new table module,
  `tests/core/brain/applier-capability.test.ts`
- **What**: One table stating, per finding code, whether repair is mechanical - naming
  the fixer - or refused, naming the reason. The three appliers publish into it instead
  of each deciding privately. Unify their three divergent write-guard placements behind
  one documented rule, preserving the stated rationale of whichever placement is chosen.
- **Acceptance**: Every code with a fixer appears as mechanical; every code the code base
  routes to review appears as refused with its reason. A test asserts the table and the
  fixer registry cannot disagree. Guard placement is identical across the three appliers
  and the choice is justified in a docblock.
- **Depends on**: none

### Task 9: The repair planner consumes the doctor's findings

- **Files**: `src/core/brain/diagnostics.ts`, `tests/core/brain/repair-plan-source.test.ts`
- **What**: The one verified true statement in the whole of the fix-applier ticket:
  the planner re-scans the vault independently while the doctor's findings sit unused
  beside it, consulted only for counts. Pass the findings in. This is what makes the
  applier a consumer of the finding contract rather than a parallel detector sharing
  vocabulary.
- **Acceptance**: A test proves the plan is derived from the supplied findings - seed a
  defect, capture the doctor's findings, and assert the plan matches them rather than a
  fresh scan. Plans for existing fixable classes are unchanged. If a fixer covers a
  class the doctor does not report, that is named explicitly, not silently re-scanned.
- **Depends on**: Task 8

### Task 10: A read-only verb must not fail with a write-path error

- **Files**: `src/core/brain/lint-consolidate.ts`, `tests/core/brain/lint-read-path.test.ts`
- **What**: The consolidation pass asserts vault identity unconditionally, before its
  apply branch. The read-only actions verb calls it in report mode and can therefore
  fail with a vault-identity mismatch on a pure read. Move the assertion to the write
  branch, where the guard's own documented contract puts it.
- **Acceptance**: A report-mode call against a vault whose marker would trip the guard
  returns its report. An apply-mode call against the same vault still refuses. The
  vault-guard census test still passes.
- **Depends on**: none

### Task 11: The approval queue gets its preview

- **Files**: `src/core/brain/pending.ts`, `src/cli/brain/verbs/pending.ts`,
  `tests/core/brain/pending-dry-run.test.ts`
- **What**: The pending apply path is the only applier with no dry run. Add one, with
  the same shape as the others: identical report, zero writes.
- **Acceptance**: A dry run reports exactly what an apply would move and leaves the vault
  byte-identical, asserted by digesting the tree before and after. Apply behaviour is
  unchanged.
- **Depends on**: none

### Task 12: Broken-link findings become machine-actionable

- **Files**: `src/core/brain/doctor.ts`, `src/core/brain/types.ts`,
  `tests/core/brain/broken-link-findings.test.ts`
- **What**: The broken-wikilink issue carries its field name and target only inside
  prose, and the broken-backlinks issue carries no path at all. A consumer must regex
  the message. Carry them as fields.
- **Acceptance**: Both issues expose the data as structured fields; the message text is
  unchanged for human readers. A test asserts a consumer can act without parsing prose.
- **Depends on**: none

### Task 13: Generate the Brain configuration template

- **Files**: `src/core/brain/policy.ts`, a generator module,
  `tests/core/brain/config-template-ratchet.test.ts`
- **What**: The template is a hand-written constant emitting seven top-level keys; the
  resolver understands twenty-three. Sixteen resolve silently from defaults because
  nothing keeps the constant and the resolver default tables in sync. Generate the
  template from the tables and add a ratchet asserting every key the resolver understands
  is represented, or is listed as deliberately omitted with a written reason.
- **Acceptance**: The generated template contains every resolver key. The ratchet fails
  when a new key is added to the resolver without appearing. An existing vault whose
  configuration omits keys still resolves exactly as before; adding the keys explicitly
  at their default values produces identical behaviour, asserted by comparing resolved
  configurations.
- **Depends on**: none

### Task 14: Initialization creates what it declares

- **Files**: `src/core/brain/init.ts`, `tests/core/brain.init.test.ts`
- **What**: The bootstrap declares ten Brain directories and creates eight; the missing
  two are created lazily by downstream writers. Create them. The created-file count is
  pinned by a test and must be updated deliberately, not incidentally.
- **Acceptance**: All declared directories exist after initialization. The pinned count
  test is updated with the new expected value and a comment saying why it changed.
  Initialization remains idempotent.
- **Depends on**: none

### Task 15: Dream tells the truth about its own progress

- **Files**: `src/core/brain/dream.ts`, `src/core/brain/dream-workrun.ts`,
  `src/core/brain/safeguard.ts` consumers, `tests/core/brain/dream-checkpoints.test.ts`
- **What**: Three things. Move the workrun phase markers to where the work actually
  completes, instead of two batches that claim reconcile finished before promote began.
  Add the safeguard checkpoint the options docstring already promises before finalize,
  covering the log writes, the ledger write, snapshot pruning and digest regeneration
  that currently run unguarded. Add a per-run override for the dream gates so a targeted
  pass needs no vault-config edit and no remembering to revert.
- **Acceptance**: A run interrupted mid-write leaves a journal whose last marker names
  work that genuinely completed, asserted by injecting a failure between two phases. The
  new checkpoint fires, asserted with an already-tripped guard. An override applies for
  one run and leaves the stored configuration untouched, asserted by re-reading it. With
  no override supplied, behaviour is byte-identical.
- **Depends on**: none

### Task 16: A phase request that cannot be honoured is refused by name

- **Files**: `src/core/brain/dream.ts`, `tests/core/brain/dream-phase-refusal.test.ts`
- **What**: The five phase labels are a reporting layer, not callable units, and two
  planning steps mutate each other's accumulators specifically so a preference is never
  both refreshed and retired. A request to run such a phase alone must raise a named
  error stating which phases are independently runnable and why the requested one is not.
  Silently running more than was asked is the failure mode this release exists to remove.
- **Acceptance**: A request for a coupled phase raises the named error and writes
  nothing. A request for an independently runnable step performs exactly that step. The
  error names the coupling, not a generic message.
- **Depends on**: Task 15

### Task 17: Dedup counts become observable

- **Files**: `src/core/brain/continuity/types.ts`, the ingest counter call sites, an
  aggregator, `src/mcp/brain/analytics-tools.ts`,
  `tests/core/brain/dedup-telemetry.test.ts`
- **What**: The exact-hash counters exist and reach a response, then die one call deep,
  so a spike cannot be observed. Persist them as a continuity record of a new kind and
  read them back through an aggregator on the existing analytics surface, following the
  generation-report model. Report the semantic layers as nominations, which is what they
  are; do not invent a drop counter for a mechanism that never drops.
- **Acceptance**: An ingest that dedupes writes a record; the aggregator returns a
  trend over records. An ingest that dedupes nothing writes no record rather than a zero
  row. The semantic figure is labelled a nomination count in every surface that shows it.
- **Depends on**: none

### Task 18: Project scope on session summaries

- **Files**: `src/core/brain/session-summary.ts`, `src/mcp/brain/synthesis-tools.ts`,
  `tests/core/brain.session-summary.test.ts`, `tests/mcp/session-summary-tool.test.ts`
- **What**: Thread the existing project scope axis through the summary input, the digest
  and the tool schema, reusing the established normalization and the shared optional-string
  coercion. Do not introduce a parallel dimension; one already exists and is wired into
  search, dedup keys and activation decay.
- **Acceptance**: A digest written with a project carries it, normalized by the shared
  rule; listing filters by it. A digest written without one is byte-identical to today,
  including its dedupe key. The tool rejects a malformed value by name rather than
  silently ignoring it.
- **Depends on**: none

### Task 19: Install verification you can assert against, and a named platform boundary

- **Files**: `install/*.md`, `src/core/config.ts`,
  `tests/docs/install-verify-conformance.test.ts`, `tests/core/config-path.test.ts`
- **What**: Every per-runtime install document tells the agent to run the check and
  never shows what success looks like. Add an expected-output block to each Verify
  section, and a test that fails when a block stops matching what the adapter's verify
  actually returns - binding the documentation to the code. Separately, the
  configuration path is unconditionally POSIX with no branch for platforms that do not
  use it; make that an explicit named refusal rather than a silent wrong answer.
- **Acceptance**: Each document's expected block matches real output, asserted by
  constructing the adapter with an injected environment. The failure message names the
  document. On an unsupported platform the resolver raises a named error naming the
  platform, instead of returning a path that cannot exist.
- **Depends on**: none

### Task 20: The skill contract is written and read

- **Files**: `src/core/brain/skill-proposals.ts`, `src/core/brain/procedural-memory.ts`,
  `src/mcp/brain/procedure-tools.ts`, `tests/core/brain/skill-contract.test.ts`
- **What**: Acceptance writes prerequisites, rollback, side effects and verification, and
  the procedural memory reader reads them back so they are a contract rather than
  decoration. Resolve a proposal's claimed evidence against the independently recorded
  outcome ledger, joined by a key derived from the slug that the accept path already
  causes to exist. Close the three atomicity gaps: the window between the two writes, the
  unguarded removal of the pending copy, and the unguarded projection rebuilds.
- **Acceptance**: An accepted proposal carries the contract fields and a reader returns
  them. A proposal whose recorded outcomes are failures is distinguishable from one whose
  outcomes are successes, and from one with no recorded outcome at all - three distinct
  states, none conflated. A failure injected at each of the three gaps leaves no
  duplicate and no orphan. Accepting a proposal with no contract data supplied produces
  today's output.
- **Depends on**: none

### Task 21: The profile registry refuses to lose data

- **Files**: `src/core/brain/portability/profiles.ts`,
  `tests/core/brain/portability/profiles.test.ts`
- **What**: Creating a profile silently overwrites an existing entry, performs no
  directory check at create time although switching does, and does a lock-free
  read-modify-write so two concurrent creates lose an update. Refuse the overwrite,
  validate at create, serialize the mutation. Every primitive needed already exists and is
  conventional in this codebase.
- **Acceptance**: Creating over an existing name raises a named error and leaves the
  registry byte-identical. Creating against a path that is not a directory is refused at
  create time with the same error shape switching already uses. Two concurrent creates
  both land, asserted without sleeping.
- **Depends on**: none

### Task 22: Issue #149 - fix the real defect, name the exit, refuse the rest

- **Files**: `src/mcp/brain/feedback-tools.ts`, `src/cli/brain/verbs/feedback.ts`,
  `src/core/brain/doctor.ts`, `tests/core/brain/force-confirmed-cold-start.test.ts`
- **What**: Write the confidence value as zero at force-confirm time in both writers,
  matching what the dream pass already does for new unconfirmed preferences, because the
  absent value is read back as null and null ranks below zero on the two surfaces that
  rank on the number. Give the existing low-evidence detector its next command through
  the rail, so the operator is told that recording real evidence is the exit. Do not
  fabricate an evidence row and do not change the confidence formula; record both
  refusals and their measured reasons in the release notes.
- **Acceptance**: A force-confirmed preference carries an explicit zero, and the two
  ranking surfaces order it above an entry with no value rather than below. The detector's
  output names the command. No new evidence row is written anywhere. The two existing
  confidence assertions are untouched, proving the formula did not move.
- **Depends on**: Tasks 1, 2

### Task 23: The first CLI-level tests for lint and hygiene

- **Files**: `tests/cli/brain-lint.test.ts`, `tests/cli/brain-hygiene.test.ts`
- **What**: Neither verb has a CLI-level test today; both are write-capable and both are
  touched by this release. Establish the tier: dry run reports and writes nothing, apply
  writes exactly what it reported, the JSON surface parses.
- **Acceptance**: Dry run leaves the vault tree digest unchanged. Apply changes exactly
  the reported set. Both surfaces parse under the JSON flag.
- **Depends on**: Tasks 8, 10

### Task 24: Documentation and version

- **Files**: `CHANGELOG.md`, `README.md`, `docs/cli-reference.md`, `docs/mcp.md`,
  `docs/architecture.md`, `package.json`, the mirrored manifests
- **What**: One CHANGELOG entry under the new version. A README paragraph on the new
  capability with the previous release compressed to a pointer. Reference entries for
  every new flag, argument and configuration key. Bump the version in the single source
  of truth and propagate with the sync script, inside this pull request, per the
  repository rule.
- **Acceptance**: The sync check passes. The CHANGELOG heading and the package version
  agree. Every new surface introduced by tasks 1 through 23 appears in exactly one
  reference document.
- **Depends on**: all
