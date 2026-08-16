### Variant 1: Repair the instruments, let the red builds define the scope

- **Approach**: Treat the release as a measurement failure before a product failure. Five of the ten findings are broken auditors — the scope matrix that asserts partition instead of correctness, the egress census whose destination-name lists miss `export`, the hand-rolled lexer that blanks 31% of a module, the ranker that reports pool-relative score where an absolute one already exists and is discarded, and the adequacy threshold pinned to the keyword weight. Fix those instruments first, in dependency order, and ship whatever product fixes the newly-red builds then demand; the ten findings are the entry points, not the deliverable.
- **Trade-offs**:
  - Pro: matches the v1.48.0 thesis lineage directly — that release already discovered a census reading no source, so this is the same move applied at scale, and the argument writes itself.
  - Pro: strongest durability story per unit of work. A repaired census does not just fix finding 7, it fixes every future instance of finding 7, and the positive-control synthetic module from finding 8 is already built.
  - Pro: the discarded `idfWeightedCoverage` and the existing three-value egress verdict mean most instrument repairs are wiring, not invention — squarely on the v1.47.0 precedent.
  - Con: scope is not knowable before the work starts. Turning the scope matrix into a content assertion over 110 tools, or unblanking 9,706 bytes, will surface findings nobody has budgeted, and this must land in one branch.
  - Con: serialises badly. The four lexer copies collapse into one shared module that four test files import; one agent owns that file and three wait on it, which is the opposite of the parallelism requirement.
  - Con: findings 5, 6, 9 and 10 have no instrument to repair and fall outside the organising principle, so they either ride along unexplained or get cut.
- **Complexity**: large
- **Risk**: high

### Variant 2: A boundary census — one new mechanism that holds all ten

- **Approach**: Build an eleventh census in the established idiom: every label-bearing declaration in `src/` — a scope field, a config gate under `integrity.*`, a bucket in a classification, a registry member, a frozen vocabulary — must name the site that enforces it, and the census derives that population structurally from source and fails the build when a declared boundary has no reader, no writer, or no check. All ten findings become rows in one table; each fix is "make this row green". The release ships one artifact and ten entries.
- **Trade-offs**:
  - Pro: a single spine that makes the thesis mechanical rather than editorial, and a genuine guard against the eleventh instance of this defect class, which none of the existing ten censuses covers.
  - Pro: parallelises cleanly once the census exists — ten agents, ten rows, ten separate files, one shared read-only contract.
  - Pro: forces honest dispositions on findings 5 and 10, since "this label has no subject" becomes a recorded verdict rather than silence.
  - Con: the population is not structurally derivable the way write sites or progress emitters are. "A declared boundary" is a semantic category; deriving it from source needs a declaration surface, and a mandatory reason field is a new vocabulary shape beside the existing four-piece idiom — direct tension with "no second registry where one exists, no new vocabulary shape".
  - Con: the census must be designed before any of the ten fixes can start, so the whole branch has a single serialised critical path at its head.
  - Con: high risk of the mechanism itself becoming the next finding — a registry whose membership check is weaker than what it claims to enforce is precisely the defect under review.
- **Complexity**: large
- **Risk**: high

### Variant 3: Disposition triage — enforce, retract, or re-measure; no new mechanism

- **Approach**: Assign every finding exactly one of three verdicts and route it to the census that already owns its class. ENFORCE (1, 2, 4, 7, 9): make the check real — condition the `owner:` emission at the writer, make `coerceAgentScope` resolve rather than echo, put the shared namespace into `listSearchOrigins` and report the dead origin into the `warnings` array instead of dropping it at `:63`, register `--export` and the embedding POST as egress sites, subscribe `SubagentStop`. RETRACT (3's tier multiplier, 5's `off` mode, 10 entirely, and `origin_vault` if no reader is wanted): delete the label, because a mechanism that cannot change an outcome is the defect. RE-MEASURE (3, 6, 8): swap the wrong measure for the right one — `idfWeightedCoverage` in place of the normalised keyword score, the agent name kept on the writer and catalog scopes, one shared lexer with the newline guard restored. Nothing new is registered; each fix extends the existing egress registry, origins enumerator, vocabulary census, or progress contract.
- **Trade-offs**:
  - Pro: satisfies "maximally native integration" by construction — every landing site is an existing registry, and no eleventh census is invented.
  - Pro: best parallelism of the three. The ten units touch largely disjoint files, each is test-first against a specific `file:line`, and only the lexer dedupe has a shared owner.
  - Pro: RETRACT is a first-class outcome, which is the only honest disposition for finding 10 (no git transport exists and the registry's prose says one never will) and for the tier multiplier with no producer.
  - Pro: bounded scope. Every unit's definition of done is a named assertion, not a discovery loop.
  - Con: no single new mechanism guards the eleventh instance; durability is the sum of ten census extensions rather than one guarantee, which is weaker than the v1.46.0/v1.48.0 pattern.
  - Con: the thesis lives in the CHANGELOG and the test names, so the release reads as ten fixes unless the framing is written carefully.
  - Con: volume. Ten units, four hardcoded lists tripped by any tool change, an exact tool count of 110, and byte-identity of the committed bundle all have to stay green in one branch.
  - Con: RETRACT decisions are product calls the operator may want to review individually, which introduces a checkpoint the other variants avoid.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3

**Rationale**: It is the only variant whose critical path is empty — ten agents can start test-first on separate files immediately, which the one-branch parallel-implementation constraint requires, whereas Variants 1 and 2 both serialise behind a shared artifact (the merged lexer, the new census) before any product fix can begin. It also honours "no second registry where one exists" literally, where Variant 2 must invent a declaration surface and a mandatory reason field beside the existing four-piece idiom, and it keeps scope knowable, where Variant 1 explicitly defers scope to whatever the repaired instruments turn red. The instrument repairs Variant 1 is built around survive here as individual RE-MEASURE units — the shared lexer, `idfWeightedCoverage`, the census destination derivation — without buying the unbounded discovery loop that came with them.
