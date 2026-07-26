# No dead ends - variant selection

**Consultant:** Claude Code CLI (`claude -p`), primary consultant per the
feature-release-playbook. Invoked once; the fallback consultant was not needed
because the primary returned three parseable variants and a recommendation.

**Prompt:** [`cli-output/prompt.md`](cli-output/prompt.md). The prompt carries the
CORRECTED problem statement produced by seven parallel reconnaissance passes over
the real code, not the kanban ticket text. Eight of the ten units had at least one
premise invalidated before the consultant saw them.

---

## Consultant output, verbatim

### Variant 1: Registry as the spine

- **Approach**: Promote `DiagnosticSignal`/`DIAGNOSTIC_SIGNALS` to the single next-step source of truth and demote the other three shapes to projections of it — `RuntimeNotice` drops its prose command and resolves by code, `OnboardingStep.command` and `CheckResult.fix` render from the registry, and `o2b brain doctor` (text and `--json`) emits `nextCommand` for every code it raises. The registry entry additionally names its fixer (replacing `coversDoctorCode`) so `Fixer.plan` consumes detector findings instead of re-scanning, and a shared base is extracted across the 15 finding record types to carry `{code, identity, severity, path, line}`. Units C/D/E/F/H/I/J then each register their exits as registry codes rather than inventing local hints.
- **Trade-offs**:
  - Pro: one vocabulary, one place to add a code, and the diagnosis→exit contract is structurally impossible to skip once the registry is the only carrier.
  - Pro: kills the `Fixer.plan` double-scan outright, which is the one undisputed defect in Unit B, and makes blast-radius guards (`assertExpectedCount`) uniform across all three appliers.
  - Pro: the "refuse by name" half becomes a registry field, so frontmatter drops, semantic-health `needs-review`, and the coupled dream phases all refuse from the same table as the ones that fix.
  - Con: a shared finding base collides head-on with `DegradationCode`'s deliberate closure and with three incompatible severity unions; widening them is exactly the reversal the brief forbids without explicit justification.
  - Con: `DoctorIssue.code` is an unenumerated `string` with ~35 literals inline across 1754 lines — enumerating it is a large mechanical refactor with real risk to the byte-identical constraint on `--json` consumers.
  - Con: consumes most of the release on Units A and B, leaving C/D/G/H/I/J as thin follow-ons or deferred; the stale command manifest must also be repaired first or terminal-state enumeration silently misses a third of the surface.
  - Con: three `RuntimeNotice` surfaces (onboarding, SessionStart hook, `vault_health`) change shape at once, so a regression lands in agent context injection rather than in a CLI nobody scripts.
- **Complexity**: large
- **Risk**: high

### Variant 2: One advisory rail, four shapes preserved

- **Approach**: Leave all four record types and all 15 finding types alone; unify the *emission point* instead. Add a single advisory-output seam that every next-step line must pass through — it resolves payloads by code from the existing `DIAGNOSTIC_SIGNALS` registry, and it is the one place that knows whether advisory chrome is legal on the current stdout (fixing `wantsJsonFlag`'s raw-argv scan and honouring the `COMMANDS_WITH_INTERNAL_JSON` split). Each existing shape gets a thin adapter into that rail, each of the three appliers publishes a capability descriptor (`mechanical` with a fixer id, or a named refusal), and a census test enumerated from the dispatchers — not the stale manifest — fails until every terminal state is classified as *has exit*, *has named refusal*, or *deliberately silent*.
- **Trade-offs**:
  - Pro: gets the whole thesis (machine-readable exit, mechanical fix, named refusal) without touching a single closed vocabulary; `DegradationCode` stays closed and the three severity unions stay separate.
  - Pro: byte-identical-when-absent is cheap to guarantee, because the rail is additive and the existing prose messages remain the fallback until each code is migrated.
  - Pro: leaves budget for the smaller units, which are where most of the verified defects actually live — the `lint-consolidate` guard misplacement on a read path, `createProfile`'s silent overwrite and lock-free write, `pending apply`'s missing dry-run, the `null`-ranks-below-`0` defect on the two topK surfaces, dedup counters persisted as a `ContinuityRecord` kind, `project` on the session summary, skill-acceptance frontmatter joined to `recordProceduralOutcome`, `install --check` expected-output blocks with Windows/WSL2 named as an unsupported-path error rather than an unconditional POSIX assumption.
  - Pro: the census test is the enforcement artifact and matches established precedent, so next release's new verbs cannot silently reintroduce dead ends.
  - Con: four shapes remain four shapes; the registry becomes the source of truth for *content* but not for *structure*, so a fifth shape is still possible.
  - Con: `Fixer.plan`'s independent re-scan is corrected only by making the detector's findings the input to the capability lookup, not by a full findings-contract merge — the double-scan shrinks rather than disappears.
  - Con: the manifest repair is a prerequisite with its own surface (7 missing `search` subverbs, 55 missing `brain` labels, absent `secrets`/`partner`), and it changes shell completions and `o2b help --json` output for real users.
  - Con: adapters are a per-shape cost, so the cheapest-looking unification is not free.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Conformance obligation only — correct each mechanism in place

- **Approach**: Introduce no shared type and no shared emitter; the only new artifact is a conformance census asserting that every diagnosis-emitting site either names a structural exit, names a refusal, or is listed as deliberately silent with written justification. Each unit is then repaired at its own site under that obligation — `doctor` prints the registry's `nextCommand` for codes it already shares, `RuntimeNotice` gains an optional `command?` field and its stale self-heal text is corrected, `DEFAULT_BRAIN_CONFIG_YAML` is generated from the resolver default tables so the 16-key gap cannot recur, `dream --only` accepts the two provably self-contained steps and refuses the mutually-coupled ones by name, and Unit J refuses both proposed fixes by name while fixing the ranking defect and pointing at the existing `low-evidence-confirmed` signpost.
- **Trade-offs**:
  - Pro: lowest risk against the byte-identical and no-silent-fallback constraints; almost every change is additive at one call site with a local test.
  - Pro: the honest answer to the units where the ticket premise collapsed (D's non-existent phase functions, E's non-existent semantic drop, I's non-existent profile artifact, J's non-existent de-prioritization) is a named refusal, and this variant makes refusal the default posture rather than an exception.
  - Pro: fits comfortably in one release with room for the two missing CLI-level tests (`brain lint`, `brain hygiene`) and the dream checkpoint honesty fix.
  - Con: the four incompatible next-step shapes survive intact, so the drift that produced them continues; the next wave inherits the identical Unit A.
  - Con: a census that permits "named refusal" can be satisfied by writing refusals everywhere, which technically passes the thesis while delivering little forward motion.
  - Con: `Fixer.plan`'s re-scan and the three divergent write-guard placements go unaddressed, leaving Unit B's genuine architectural defect for later.
  - Con: without a shared emitter, the JSON-discipline hazard remains per-verb, so a future advisory line on an internal-`--json` verb still breaks `JSON.parse`.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 2

**Rationale**: The verified state says the well-shaped mechanism already exists — `DiagnosticSignal.nextCommand` with a ~20-code registry — and the defect is delivery, not modelling, so unifying the emission point buys the entire thesis while Variant 1 pays for a 15-type findings merge that collides with `DegradationCode`'s deliberate closure and with the byte-identical constraint on three context-injection surfaces. Variant 2 also keeps enough budget for the units where the real, verified bugs are small and local (the read-path vault-identity throw, the silent profile overwrite, the `null`-below-`0` ranking defect, the missing `pending apply` dry-run), which Variant 1 would starve. Variant 3 is safest but leaves Unit A structurally unchanged and lets a census of refusals stand in for the wiring the release is actually about.

---

## Orchestrator decision

**Accepted: Variant 2 (one advisory rail, four shapes preserved), with two grafts.**

The consultant's reasoning holds against the evidence. The well-shaped mechanism
already exists - `DiagnosticSignal.nextCommand` with a populated registry - and the
defect is delivery, not modelling. Variant 1 pays for a fifteen-type findings merge
that collides head-on with the deliberate closure of `DegradationCode` and would put
a shape change into three context-injection surfaces at once; that is a large risk
bought for a small gain, since nothing downstream needs the fifteen types to share a
base in order for a caller to learn its next command. Variant 3 is the safest but
leaves Unit A structurally untouched, and its census would be satisfiable by writing
refusals everywhere - a conformance artifact that passes while delivering nothing.

Two elements are grafted in, because Variant 2 under-serves them:

**Graft 1, from Variant 3: generate the config template from the resolver default
tables.** Variant 2 leaves Unit C as an ordinary repair. But the sixteen-key gap is
not a bug that was introduced once - it is accumulated drift between a hand-written
string constant and a set of resolver default tables that nothing keeps in sync. A
repair that re-syncs them by hand re-arms the same drift. Generating the template
from the tables, with a ratchet test asserting every key the resolver understands is
represented, removes the drift mechanism rather than its current output.

**Graft 2, from Variant 1: the repair planner consumes the doctor's findings instead
of re-scanning.** Variant 2 shrinks this defect; Variant 1 removes it but only as
part of the expensive merge. The removal does not actually require the merge. The
doctor already produces its findings, and `planRepair` already calls it - for counts
only. Passing those findings into the fixers is a narrow change confined to one
module, and it is the difference between an applier that consumes the finding
contract and one that merely shares vocabulary with it. Since "the applier is not
keyed off the findings shape" is the single verified true statement in the whole of
Unit B's ticket, leaving it half-fixed would mean the one real defect survives the
release that was named after it.

**Explicitly not adopted from Variant 1:** a shared base across the fifteen finding
record types, and enumerating `DoctorIssue.code`. Both are real debts. Neither is
required by this release's thesis, and the first reverses a stated policy. They are
recorded in "Out of scope" with the reason.
