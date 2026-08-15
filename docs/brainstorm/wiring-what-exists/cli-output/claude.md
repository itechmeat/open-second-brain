### Variant 1: Nine local wirings, three small vocabularies
- **Approach**: Treat each unit as an independent call-site defect and fix it where it sits — `distill-source` calls `classifySourceOrigin`/`normalizeSourceIdentity` and a shape gate inline, each destructive op wraps itself in `withDestructiveSnapshot`, each export path calls `redactor`, `ranker.ts:502` reads `hyd.authoredAt`, `dream-plan-topics.ts` keys on `normalizeEntityName`, `search check` promotes the ping failure to `fatal`. Only three new closed vocabularies are added where values must leave TypeScript: destructive-op reason tokens (giving `manual` a producer), note-lifecycle verbs for B2, and the dangling-link resolution outcome for B3. Coverage claims ("all ~25 destructive ops", "all six export paths") are established by hand-audit at review time and pinned by per-unit tests.
- **Trade-offs**:
  - Nine small, reviewable diffs; each unit lands and reverts independently, so a problem in B2 does not hold D1 hostage.
  - Byte-identical-when-inactive is easy to measure per unit, because nothing shared moves.
  - Smallest surface for the "no new external dependency, no stub" bar — every edit is a call to something already exported and tested.
  - The release's own argument is left structurally unaddressed: nothing prevents the 26th destructive operation or the 7th export path from shipping unwired. The defect class recurs by construction.
  - The coverage claims are the weakest part and are the ones most worth trusting; a hand-audit of ~25 destructive operations is exactly the artifact that decays silently.
  - B1's "no way to express *recoverability could not be proved* as data" is not solved — the gate keeps throwing untyped `Error`, so `pruneSnapshots` and `deleteBySource --include-originals` (which no snapshot covers) get wired into a mechanism that cannot state its own limits. Same for B2's rename, which cannot honestly qualify its inbound-reference claim.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Three chokepoint funnels
- **Approach**: Rather than wiring N call sites, create three mandatory funnels and route every existing caller through them — a destructive-operation dispatcher that owns snapshotting, count-guarding and the confirmation ladder for all ~25 operations including `restoreSnapshot` and `pruneSnapshots`; a single export writer that every one of the six vault-content-leaving paths must call, deleting the two weaker private redactor copies in `config.ts:1133` and `cli/json-helpers.ts`; and one write-path envelope through which all three claim writers pass, so trust classification is structurally unskippable. B2 and B3 are then built as thin verbs on top of the funnels rather than as new code paths.
- **Trade-offs**:
  - Strongest possible guarantee: after the refactor, the defect class is not merely fixed but unreachable, because the unwired path no longer exists to be taken.
  - Collapses the three duplicate redactors into one, which is a real reduction the codebase is already asking for (18 importers, two shadow copies).
  - Highest blast radius against the byte-identical-when-inactive bar: routing ~25 destructive operations and six export paths through new funnels changes ordering, error shapes and output framing in places the measurement will legitimately flag, and separating intended from unintended differences is the bulk of the work.
  - Real risk of import cycles — the acyclic census counts `import type` as an edge, and a dispatcher that must know about every destructive operation is precisely the module that attracts them; `await import()` escapes are available but are a smell at this density.
  - Poor failure granularity: the units stop being separable, so one funnel that cannot be made byte-stable jeopardises the release rather than one unit.
  - `deleteBySource --include-originals` deletes outside `Brain/`, which no snapshot covers; a funnel that promises coverage uniformly makes that lie more central, not less, unless the funnel can also express partial coverage.
- **Complexity**: large
- **Risk**: high

### Variant 3: Declared registries, census-enforced, with verdict-shaped outcomes
- **Approach**: Keep the call sites where they are, as in Variant 1, but derive the work from three declared registries that architecture census tests check for exhaustiveness in the same idiom the repo already uses for raw `fs` write sites and vault-identity assertions — every destructive operation registered with its reason token and its actual recovery coverage, every path that writes vault content outside the vault registered with its redaction status, every claim write path registered as trust-classifying. Convert the gates' outcomes from throws into frozen verdict objects with sorted token arrays that accumulate, so `pruneSnapshots`, `restoreSnapshot` and `deleteBySource --include-originals` can each say precisely what they could not prove instead of reporting a snapshot path they do not honour, and so B2's rename and B3's materialised stub can qualify their inbound-reference claims rather than overstating them.
- **Trade-offs**:
  - The registries make the coverage claim mechanical instead of narrative: the 26th destructive operation fails the census on the day it is written, which is the only durable answer to the release's argument.
  - Fits the stated conventions exactly — four-piece closed vocabularies, frozen non-throwing verdicts with sorted tokens, census enforcement — so it adds no idiom the codebase has to learn.
  - The verdict shape is what makes several units honest rather than merely wired: B2 can rename while stating that the vault-wide `links` table is only as fresh as the last index pass; B1 can distinguish "snapshot taken" from "recoverability unprovable" for the operations no snapshot covers; C1 can name a path as redacted-in-full versus redacted-with-a-truncation.
  - Larger than Variant 1: three registries, a verdict type per family, and the migration of `withDestructiveSnapshot` off untyped `Error` all land before most of the nine units can.
  - Registry exhaustiveness tests are themselves a maintenance surface, and a badly drawn boundary ("what counts as destructive?") produces either census noise or a registry that quietly under-counts — the failure mode of the thing it replaces.
  - Ordering pressure: the enforcement layer must land first, so the release is front-loaded and the nine units cannot start in parallel the way Variant 1's can.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: The release's argument is that capabilities exist and nothing calls them, so a release that only adds the missing calls (Variant 1) fixes nine instances of a defect whose cause is that no mechanism requires the call — and this codebase already has that mechanism, in the census tests that enforce raw `fs` write sites and doctor-code registration. Variant 3 gets Variant 2's guarantee through declaration rather than through funnelling ~25 destructive operations and six export paths into new shared code, which is the change least compatible with a byte-identical-when-inactive bar measured rather than asserted, and most likely to fight the acyclic-import census. The verdict-object half is not optional polish: without it B1 wires a gate that cannot admit `deleteBySource --include-originals` is uncovered, and B2 ships a rename that cannot honestly qualify what it fixed — both of which the no-misleading-success constraint forbids.
