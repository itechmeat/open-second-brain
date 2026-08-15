### Variant 1: One evidence kernel
- **Approach**: Build a single cross-cutting `src/core/evidence/` module that owns the shared primitive all nine units restate: a verdict envelope that is either a verified value or a named unknown from one root unknown-reason vocabulary, plus the measurement helpers underneath it (wall-clock age from mtime, probe-then-act with typed collision, existence-and-hash attestation). All nine units are then refactored to return that envelope instead of booleans, free-form warnings, or silence, and one census test asserts that every boundary-facing verdict type in the tree derives from the kernel.
- **Trade-offs**:
  - Pro: answers the tension in the strongest form — the recurring argument becomes a type, and the tenth occurrence is prevented rather than reviewed.
  - Pro: collapses the five mtime copies, the three proposed vocabularies and the four write-tool result shapes into one place; maximal DRY.
  - Pro: one census registration point instead of three, and the "uncertain stream" doctor convention gets a natural home.
  - Con: directly contradicts the project's standing decision against a shared error module; forty per-module Error subclasses exist because this exact centralisation was already rejected once.
  - Con: a kernel that nine unrelated seams depend on is a change surface across intake, filesystem, scope, doctor, staleness, telemetry, search, write tools and the MCP registry in a single point release; byte-identical absent-config behaviour becomes very hard to prove per-seam.
  - Con: the units stop landing independently — every unit blocks on the kernel's shape being right first, and the kernel's shape is only knowable after the units are understood.
  - Con: the root unknown vocabulary would have to be general enough to cover "config unreadable", "no input could be stat'ed", "query tokenised empty" and "unknown argument", which pushes it toward meaningless generality.
- **Complexity**: large
- **Risk**: high

### Variant 2: Review standard, leaf helpers only
- **Approach**: Declare that "evidence at the boundary" is a review standard rather than a module, consistent with the three prior releases that made the same argument without leaving a runtime abstraction behind. Each unit ships its own four-piece closed vocabulary and its own verdict shape per existing convention, and the only extraction is of genuinely duplicated executable logic: the typed EEXIST error, the wall-clock age helper, the include-narrowing predicate, and the string-distance helper. The standard is enforced by census tests — new vocabularies register, every new doctor code carries a next command or an exclusion reason, schema descriptions are capped and required.
- **Trade-offs**:
  - Pro: nine units land one at a time with no shared blocking dependency beyond two small prerequisites (typed collision error before unit 2, age helper before unit 5).
  - Pro: matches how this codebase already works — local decisions, local vocabularies, docblocks naming the rejected alternative, census tests as the cross-cutting enforcement layer.
  - Pro: lowest chance of changing absent-config behaviour, since every change is contained to one seam.
  - Pro: cheapest to revert per unit if one turns out wrong under test.
  - Con: leaves three more closed vocabularies alongside the existing five, all answering neighbouring questions, with no statement anywhere about how they relate.
  - Con: unit 8 explicitly needs one envelope across four write tools; treating that as "local" means either attaching findings four times or quietly building the envelope anyway without naming it.
  - Con: a census test can require a description exists but cannot require that a verdict is honest; the standard stays enforced by reviewers where the argument is subtlest.
  - Con: the tenth occurrence is likely, and the release note again describes a discipline rather than a mechanism.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Three seam spines
- **Approach**: Reject a global kernel but accept that the nine units are not nine independent seams — they are three, and each of the three has a real shared mechanism inside it. Write boundary (units 1, 2, 3, 8) gets one write-result envelope carrying per-write findings plus the typed collision error, the attested-source record and the include-narrowing predicate; measurement boundary (units 4, 5) gets one wall-clock age-and-liveness measurement type whose unknown cases are named, with the Python-versus-TypeScript resolver parity expressed as a conformance test over that type; report boundary (units 6, 7, 9) gets typed degradation and channel dimensions on what the system emits about itself. Each spine registers its own vocabulary in the architecture census; nothing spans two spines.
- **Trade-offs**:
  - Pro: gives each unit a shared mechanism exactly where duplication is demonstrated (four write tools, five mtime copies, a dozen discarded search signals) and none where it is only thematic.
  - Pro: units still land one at a time — within a spine the order is prerequisite-driven, and the three spines are independent of each other, so a stalled spine does not block the release.
  - Pro: unit 7's two existing typed answers (recall adequacy, negative-recall vocabulary) get a legitimate second caller inside the report spine instead of a third one-off vocabulary.
  - Pro: honest about the tension: the argument is a review standard across the release, and a module only within a seam where the duplication is measured.
  - Con: three spines means three new vocabularies and three census registrations anyway — the count is the same as Variant 2, only better organised.
  - Con: the spine boundaries are a judgement call; unit 4 arguably belongs with reporting and unit 3 arguably belongs with measurement, and a wrong cut costs a refactor mid-branch.
  - Con: larger than Variant 2 for one point release, and the write-result envelope touches four tool surfaces where absent-config byte-identity must be proven per tool.
  - Con: the Python side of unit 4 makes the measurement spine cross-language, which no existing spine in this tree does.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: Variant 1 relitigates a decision this project already made and lost — the forty per-module Error subclasses are the recorded verdict on cross-cutting kernels here, and a kernel is unlandable as nine incremental units on one branch. Variant 2 is safe but concedes the tension without resolving it, and it cannot honour unit 8's explicit requirement of one envelope across four write tools without building that envelope unnamed. Variant 3 keeps the incremental landing model and the local-decision convention while extracting a mechanism at exactly the three places where reconnaissance measured duplication rather than resemblance, which is the distinction the release is actually about.
