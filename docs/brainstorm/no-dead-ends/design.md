# No dead ends - every diagnosis names its exit, and performs it where the fix is mechanical

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain is driven by agents that know only what the last command printed.
A verb that exits zero without saying what to run next is a dead end for such a
caller, and a diagnosis that names a defect without naming its repair costs a
round-trip in which the agent re-derives the fix non-deterministically.

The system already knows the answer in several places. `DiagnosticSignal.nextCommand`
is a populated registry of structural CLI strings, documented as "never prose", with
two consumers. Three Finding-to-apply pipelines already ship, each with a dry run, an
audit trail and the vault-identity write guard. What is missing is not machinery. It
is that the answer does not reach the caller: it is embedded in English prose, or
modelled four incompatible ways, or computed and discarded one call later, or - in two
places found during reconnaissance - reported as complete when it is not.

Reconnaissance against the real code invalidated at least one premise in eight of the
ten selected units. This design is written against the corrected picture. Where a
ticket asked for a subsystem that already exists, the unit is re-scoped to the defect
that actually exists; where it asked for behaviour the codebase deliberately does not
have, the unit refuses by name and says so in the release notes.

## Scope

Ten sources - nine kanban tasks and one external GitHub issue - decompose into eleven
scope items, sharing two seams. The count differs because reconnaissance split the
no-dead-end audit in two: the delivery of next steps, and the repair of the command
manifest those steps would otherwise be enumerated from. The manifest defect was found
during that audit and is not in any ticket.

**Seam 1 - the advisory rail.** A single emission point through which every
forward-pointer line passes. It resolves a payload by code from the existing
`DIAGNOSTIC_SIGNALS` registry rather than carrying prose, and it is the one place that
knows whether advisory chrome is legal on the current output stream. The four existing
next-step shapes keep their types and gain thin adapters into the rail.

**Seam 2 - the applier capability table.** One table stating, per finding code,
whether repair is mechanical (naming the fixer) or refused (naming the reason). The
three existing appliers publish into it rather than each deciding privately.

Units:

- **A. Next-step delivery.** Route `o2b brain doctor` (human and JSON) and MCP
  `brain_doctor` through the rail so every issue carries its structural next command.
  Give `RuntimeNotice` an optional structured command and stop embedding "Run: X" in
  prose. Correct the `search_index_missing` notice, whose text describes a world that
  self-heal removed. Cover the terminal states that print nothing forward, beginning
  with `o2b brain init` - the command that creates the empty Brain.
- **B. Manifest completeness.** Repair the command manifest, which is the source of
  shell completions and `o2b help --json` and is missing two top-level verbs, seven
  search subverbs and fifty-five brain cases. Add a ratchet test enumerated from the
  dispatchers, not from the manifest, so a new verb cannot be added without an entry.
- **C. Applier correctness.** Publish the capability table. Make `planRepair` consume
  the doctor's findings instead of re-scanning the vault independently. Unify the three
  divergent write-guard placements behind one documented rule. Fix the read-path throw:
  `lintConsolidate` asserts vault identity before its apply branch, so the read-only
  `o2b brain actions` verb can fail with a write-path error. Give `brain pending apply`
  the dry run every other applier has. Make `broken-wikilink` and `broken-backlinks`
  machine-actionable, since today the field name and target exist only in prose and the
  backlink issue carries no path at all.
- **D. Config template drift.** Generate `DEFAULT_BRAIN_CONFIG_YAML` from the resolver
  default tables, so the sixteen keys that resolve silently from defaults become
  visible, and add a ratchet test so the drift cannot recur. Create the two Brain
  directories `init` declares but does not make.
- **E. Dream honesty.** Add a per-run gate override so an operator can run a targeted
  pass without editing the vault config and remembering to revert it. Make the workrun
  checkpoints truthful: today three are appended before any preference is written and
  four after every mutation completes, so a crash mid-write leaves a journal claiming
  work that had not started. Add the safeguard checkpoint the docstring already
  promises before finalize. Refuse a request for a phase that is not independently
  runnable, by name, rather than silently running more than was asked.
- **F. Dedup observability.** Persist the exact-hash ingest dedup counts as a
  continuity record so a trend is observable, instead of threading them one call deep
  and discarding them. Report the semantic layers as what they are - nominations, never
  drops - rather than inventing the drop counter the ticket assumed.
- **G. Project scope on session summaries.** Thread the existing `project` scope axis
  through `SessionSummaryInput`, the digest and the MCP tool, reusing the established
  normalization rather than introducing a parallel dimension.
- **H. Install verification you can assert against.** Add expected-output blocks to the
  Verify section of every per-runtime install document, and a test that fails when a
  documented block stops matching what the adapter's `verify()` actually returns. Make
  the POSIX-only configuration path an explicit, named refusal on platforms it does not
  serve, instead of an unconditional assumption.
- **I. Skill contract completeness.** Write prerequisites, rollback, side effects and
  verification on acceptance, and read them back, so they are a contract rather than
  decoration. Resolve a proposal's claimed evidence against the independently recorded
  procedural outcome ledger, joined by a key the accept path already causes to exist.
  Close the three atomicity gaps in the accept sequence.
- **J. Profile registry safety.** Make `createProfile` refuse to overwrite an existing
  entry, validate the target directory at create time rather than only at switch time,
  and serialize concurrent mutations. Every primitive required already exists.
- **K. Issue #149, the cold-start report.** Fix the real defect the report missed - the
  confidence value is written as null, and null ranks below zero on the two surfaces
  that rank on it. Name the exit rather than fabricating evidence: the doctor already
  detects this exact population and needs only its next command. Refuse both proposed
  fixes, by name, with the measured reason.

## Out of scope

- **A shared base type across the fifteen finding record types.** A real debt. It
  collides with the deliberate closure of `DegradationCode`, whose closure is the point,
  and it would change the shape of three context-injection surfaces at once. Not
  required by this release's thesis.
- **Enumerating `DoctorIssue.code`.** Approximately thirty-five string literals inline
  across one large module. A prerequisite for any future applier keyed on doctor codes,
  and worth its own change.
- **Auto-repair of dropped frontmatter lines.** The parser is line based, so a dropped
  line is by definition grammar it has no branch for, and repair requires choosing a
  target grammar per shape. This is a policy choice, not a mechanical fix, and the
  release refuses it by name rather than guessing.
- **Wiring a semantic dedup layer into an ingest path as an auto-drop.** That is the
  only way to make the ticket's exact-versus-semantic drop split real, and it is a
  behaviour change far larger than adding a counter.
- **Per-vault link-format settings.** The two link-style settings live in the machine
  level plugin configuration, not the vault configuration. Moving them is an
  architectural decision that deserves its own change.
- **Convention autofit at init.** Setext-header and filename-case detectors do not
  exist, the two settings a detector would target are not vault-side, and the walker's
  exclusion policy is read from the very file `init` is about to create. The unit is
  re-scoped to the drift that is real and measurable.
- **A dream phase selector for coupled phases.** `planRefresh` and `planAutoRetires`
  mutate each other's accumulators specifically so a preference is never both refreshed
  and retired. Running one alone with writes enabled is a data-correctness bug.
- **Changing the confidence formula.** Measured cost exceeds the benefit; see the
  design decision below.
- **A second install document.** One already exists and is agent-directed.

## Chosen approach

Variant 2 from the consultant, with two grafts. See
[`variants.md`](variants.md) for the full audit trail and the reasoning for each graft.

Unify the emission point rather than the record types. Every next-step line resolves
its payload by code from the registry that already models a structural command, and
passes through one seam that owns output discipline. The four shapes keep their types
and gain adapters, so no closed vocabulary is reopened and no context-injection surface
changes shape. The appliers publish capability rather than each deciding privately, and
the repair planner consumes the findings the detector already produced.

The enforcement artifact is a census test enumerated from the dispatchers: every
terminal state is classified as having an exit, having a named refusal, or being
deliberately silent with a written reason, and the test fails until a new one is
classified. This is the established pattern in this codebase.

## Design decisions

- **The registry is the source of truth for content, not for structure.** Adapters
  cost a little duplication and buy the ability to ship without reopening
  `DegradationCode` or the three severity vocabularies. Structural unification remains
  available later and is cheaper once every consumer already resolves by code.

- **Advisory chrome is decided in one place, not per verb.** Twelve verbs own an
  internal JSON branch; everything else is wrapped in an envelope where a stray line is
  harmless. Only the first family can be broken by an advisory line, and today nothing
  centrally knows which family a call is in. The rail owns that question. This also
  fixes the raw-argv scan that misreads a note whose text happens to contain the JSON
  flag.

- **A refusal is a deliverable.** Four units turned out to rest on behaviour this
  codebase does not have. The honest response is a named, specific error or a stated
  limitation, never a silent no-op and never a fabricated success. This is not a
  reduction in scope; naming the boundary is the feature, given a release whose thesis
  is that degradation must not be concealed.

- **Issue #149 is fixed by naming the exit, not by manufacturing evidence.** Option A
  in the report writes an apply-evidence row asserting the rule was applied to an
  artifact when it was not. That row is defined in the codebase as the canonical durable
  signal that a preference was exercised against real work; forging it would corrupt the
  most-applied ranking, the recent-applications section, the outcome-regression ratio,
  and would consume one of the two events the low-evidence doctor warning depends on.
  Option B cannot see the confirmation timestamp it needs, breaks two assertions, and
  introduces permanent churn - a decaying baseline drifts about one ten-thousandth per
  hour against a one-millionth no-op threshold, so every dream pass would rewrite every
  zero-evidence preference forever. Neither is adopted. What is adopted: write the value
  as zero rather than null, because null ranks below zero on the two surfaces that rank
  on the number at all; and give the existing detector its next command, so the operator
  is told that recording real evidence is the exit. Measured: both proposed values sit
  below the medium band threshold, so neither would have moved the preference one
  position in the injected context.

- **Truthful checkpoints beat more checkpoints.** The dream workrun journal currently
  batches its phase markers, claiming reconcile complete before promote has begun. A
  journal that lies is worse than one that is coarse, and this is precisely the failure
  class the release is about.

- **Generate the template, do not re-sync it.** Hand-repairing sixteen keys leaves the
  drift mechanism in place. Generating from the resolver default tables makes the gap
  structurally impossible and the ratchet test makes it visible if the generation is
  bypassed.

- **Byte-identical when absent.** Every new field, flag and config key is additive.
  With it absent, output is byte-for-byte what it is today. This is asserted per unit,
  not assumed.

- **No natural-language word lists.** Detection and classification use structural
  signals, explicit fields and corpus statistics. No unit here requires matching words
  in any human language, and none may introduce it.

## File changes

New modules, expected:

- a next-step resolution surface over the existing registry
- an advisory emission rail owning output discipline
- an applier capability table
- a continuity record kind and aggregator for dedup counters
- a generator for the Brain configuration template

Modified, expected: the doctor CLI verb and its MCP tool; runtime notices; the command
manifest and its dispatchers; the repair planner and the three appliers; the pending
queue; the lint consolidation pass; the Brain bootstrap; the dream pass, its refresh
module and its workrun journal; the ingest counters; the session summary core and tool;
the install documents and the configuration path resolver; the skill proposal accept
path and the procedural memory reader; the vault profile registry; the two
force-confirmed writers and the two ranking surfaces.

Tests: a dispatcher-enumerated terminal-state census; a manifest completeness ratchet; a
configuration-key ratchet; a documented-install-output conformance test; the first CLI
level tests for the lint and hygiene verbs; per-unit regression tests including
byte-identical-when-absent assertions.

Documentation: CHANGELOG, README, the CLI reference, the MCP reference, the
architecture note, and the per-runtime install documents.

## Risks and open questions

- **The manifest repair changes real output.** Shell completions and `o2b help --json`
  gain the verbs they were missing. This is a correction, but it is visible, and the
  release notes must say so.
- **Routing the doctor through the rail touches a surface agents parse.** The addition
  must be additive in JSON and byte-identical when the caller does not ask for it.
- **`RuntimeNotice` reaches the SessionStart injection.** A regression here lands in
  agent context rather than in a script. The structured command is additive and the
  prose remains until each code is migrated.
- **The install conformance test binds documentation to code.** That is the point, but
  it means an adapter change can fail a test in a document. The failure message must say
  which document and which line.
- **Open question, to settle during implementation:** whether the per-run dream gate
  override is expressed as an explicit set of named gates or as a general configuration
  overlay. The narrow form is safer and is the default assumption; the general form is
  only justified if the narrow one turns out to need more than a handful of entries.
- **Open question:** whether the capability table lives beside the fixer registry or in
  its own module. Decide by which produces the smaller import surface, and record the
  reason in the module docblock.
