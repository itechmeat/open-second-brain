# Silence is not an answer - variant audit trail

**Consultant:** Claude Code CLI (`claude -p`), single pass, exit 0, three parseable
variants plus a recommendation. The fallback consultant (`codex exec`) was not
run: the playbook invokes it only when the primary exits non-zero or returns
fewer than two parseable variants, and neither condition held.

**Question put to the consultant:** not "how do I build unit N", but how to
structure a wave in which eight independently-scoped units each reinvent the
same primitive - a closed verdict vocabulary where "could not check" is a
first-class value distinct from both "checked and clean" and "checked and bad".
The full prompt, including the grounded state of all eight units, is in
`cli-output/prompt.md`; the raw reply is in `cli-output/claude.md`.

---

## Consultant output, verbatim

### Variant 1: Kernel-first — one verdict-and-digest foundation landed ahead of the eight

- **Approach**: Open the branch with two leaf modules before any unit: a `Verdict` kernel (frozen vocabulary where `unverified` is a member alongside checked-clean and checked-bad, each carrying a reason code drawn from a single registered table) and a `digest` module that absorbs the ~10 private SHA-256 copies, the 16 inline sites, the 3 ad-hoc truncation lengths and the 2 canonical-JSON implementations behind named constants. All eight units then express their local vocabulary as a parameterisation of the kernel — U1's `ok`/`modified`/`unverified`, U2's `not_found`/`unknown`/`did_not_happen`, U6's `included`/`excluded_because`/`unknown-because-predates`, U3's `recorded: false` — and every read surface renders through one renderer.
- **Trade-offs**:
  - Pro: the two persisted digest decisions (U1's schema-pack digest, U2's coverage receipt) are made once, by one module, with one truncation constant — under the additive-only rule a divergence here would be permanent across replicated peers.
  - Pro: the reason axis becomes census-enforceable in the existing signal table from day one; a unit that invents an unregistered reason fails the build rather than shipping a private string.
  - Pro: the digest consolidation is a debt the wave has to touch anyway; doing it once at the front is cheaper than eight partial touches.
  - Con: the wide half of the kernel is a god-type risk. U5's `suppressed` is a lifecycle status with a recurrence counter, U7's snapshot reason is a causal vocabulary, U8's truncation notice is a payload naming dropped items — forcing all three into one verdict shape produces a type whose members do not mean the same thing, and that shape survives the release.
  - Con: the largest single-PR blast radius of the three: ~26 pre-existing digest call sites refactored in the same diff as eight features, so an unrelated regression in the digest sweep can block the whole wave.
  - Con: a leaf module consumed by schema, recall, doctor, snapshot, trigger and injection layers is a new central dependency in a codebase that recently spent a release removing all import cycles.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Narrow shared kernel — share the reason axis and the digest bytes, keep every verdict vocabulary local

- **Approach**: Split the primitive along its two axes and share only the one that is genuinely identical across the eight. The reason axis — the named, machine-readable *why-could-not-check* code — is an extension of the existing closed could-not-check condition vocabulary, widened into a leaf registry that the census test already enforces; the digest module is consolidated as in Variant 1 because two units persist digests. The verdict axis stays local to each unit: eight small frozen vocabularies with their own arity and their own exhaustive switches, each obliged to carry a reason code from the shared registry on its unverifiable member.
- **Trade-offs**:
  - Pro: directly satisfies "prefer extending an existing surface to adding a parallel one" — the could-not-check vocabulary and the existing `pass`/`warn`/`fail` mismatch renderer are the precedents, and this widens them rather than standing up a rival.
  - Pro: smallest surface that can still be wrong. If the shared piece turns out wrong halfway, the reason registry is additive by construction and only U1 and U2 depend on the digest module, so rework is two units, not eight.
  - Pro: keeps arity honest. U3 needs `recorded: false` versus `rows: []`, U4 needs a non-zero exit code, U5 needs a status plus a counter — none of these is a tri-state, and none has to pretend to be.
  - Pro: the repeated-constant convention is satisfied where the repetition is real (reason codes, digest algorithm, truncation length) without inventing repetition where it is not.
  - Con: eight local vocabularies means eight exhaustive switches and eight renderer adapters; the family resemblance is enforced by convention and review, not by the compiler.
  - Con: U5's status partition is currently hand-maintained in three copies across core, CLI and MCP — this variant fixes that within U5 but does not give the wave a general mechanism preventing the next such triplication.
  - Con: the boundary between "reason" and "verdict" has to be adjudicated per unit and one or two will be arguable (U6's `unknown-because-predates-the-feature` is arguably a reason wearing a verdict's clothes).
- **Complexity**: medium
- **Risk**: low

### Variant 3: Local-first with an enforced census — eight private vocabularies, one ratchet, harvest in a later wave

- **Approach**: Ship each unit with its own frozen vocabulary, its own reason strings and its own digest call, sharing nothing new; the only cross-cutting addition is a census/ratchet test that requires every new verdict member and every reason code to be registered in the existing diagnostic signal table, plus a written refusal in the release notes naming the shared kernel as deliberately not built and why. The eight then serve as the eight real call sites a later refactor wave needs in order to design the kernel from evidence rather than from anticipation.
- **Trade-offs**:
  - Pro: maximum unit independence — the eight can be built and reviewed in any order, and a stalled unit blocks nothing else in the branch.
  - Pro: zero wrong-kernel cost. There is no shared piece that can turn out wrong halfway.
  - Pro: the refusal is shippable release content in the project's established style, so the decision is recorded rather than silently deferred.
  - Con: two units persist a digest, independently choosing algorithm and truncation length. Under additive-only on persisted formats, two divergent digest encodings in one release are permanent for replicated peers — this is the one place where the repetition is not merely untidy.
  - Con: leaves the ~10 SHA-256 copies and 2 canonical-JSON implementations at 12 and 18, in a wave whose stated theme is that duplicated silence-handling is the defect.
  - Con: sits against two written conventions at once ("anything repeated goes into a named constant", "no new subsystem where an existing one can carry the capability") — the census test makes the duplication visible but does not make it legal.
  - Con: the later harvest wave has to touch all eight units again, and by then their vocabularies are released and additive-only.
- **Complexity**: small per unit, large in aggregate
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The eight units genuinely share the *reason* axis and the digest bytes, and they genuinely do not share the verdict axis — a suppression status with a recurrence counter, an exit code and a coverage receipt are not the same type, and a kernel that claims they are would outlive the release under the additive-only rule. Variant 2 shares exactly the two things whose divergence would be permanent and unfixable across replicated peers (one digest encoding, one registered reason vocabulary), extends existing precedents instead of standing up a parallel one, and confines mid-wave rework to the two digest consumers if the shared piece proves wrong — whereas Variant 1 bets the whole wave on a wide type designed before its call sites exist, and Variant 3 buys independence by shipping two irreconcilable persisted digests.

---

## Orchestrator decision

**Variant 2 is adopted, with one override.**

The recommendation is correct about where the sharing is real. Two of the eight
units persist a digest, and the vault is replicated peer-to-peer: two divergent
digest encodings shipped in one release cannot be reconciled later without
breaking a guarantee for peers that already wrote records under the old one.
That is the single place in this wave where duplication is not untidiness but
permanence, and it is the reason the digest module lands before the units rather
than beside them.

The recommendation is equally correct that the verdict axis is not shared. A
suppression status carrying a recurrence counter, a process exit code, a
coverage receipt bound to a document set, and a snapshot-inclusion decision are
four different types. A kernel asserting they are one type would have to be
widened for every arity it did not anticipate, and under the additive-only rule
it would outlive the release that introduced it.

**The override:** the consultant proposes carrying the shared reason axis by
widening the existing could-not-check condition vocabulary. Grounding shows that
vocabulary is consumed by exhaustive switches with `never` defaults, so adding a
member is a compile-breaking edit for consumers that have nothing to do with
this wave - it is the wrong host precisely because it is well-typed. The reason
codes are also disjoint in meaning across the eight: an absent config file, a
divergent coverage set, and an over-size-ceiling refusal are not members of one
concept, and a union of disjoint sets is a namespace, not an abstraction.

So the reason axis is shared as a **shape and a census**, not as a vocabulary.
Each unit owns a frozen object plus a companion `Set` plus a type guard, which
is already the project's convention; one census test imports all of them and
fails when the trio is incomplete, when the `Set` and the object disagree, when
the guard admits a non-member, or when one vocabulary carries a duplicate value.
That buys the property the consultant valued - no unit ships a vocabulary whose
members and guard can drift apart - at the cost of one test file instead of one
central type. It does not require codes to be unique across vocabularies:
an absent config file and an absent store file are both honestly named `absent`.

**What this costs if it is wrong:** the digest module has exactly two persisted
consumers, so a wrong encoding is a two-unit rework, and it is caught by their
own round-trip tests before anything is released. The census test is a test; if
it proves to be the wrong shape it is deleted without touching a single shipped
byte. Neither failure mode can stall the other seven units.
