### Variant 1: One host-facts table

- **Approach**: Introduce a single frozen population — `HOST_FACTS` — keyed by a new closed `INSTALL_TARGET_ID` vocabulary in the house form (frozen object, derived union, members array, guard), where each row carries everything the project claims to know about one runtime: tool-surface ceiling, config file location and format, install mechanism (json-merge / subprocess), session-log roots, and the state surfaces that runtime causes to exist. State surfaces (item 7) are folded in as rows of the same table under a synthetic `vault` target, so `OUT_OF_VAULT_STATE` becomes a projection of `HOST_FACTS` rather than a sibling list. Every consumer — profile selection, install adapters, `sessionPaths()`, session discovery, `second_brain_capabilities`, the inventory verb — reads the table and nothing else; a new `tests/core/architecture/host-facts-census.test.ts` derives the population structurally and fails on any row without a reader or any reader with a literal the table could supply.
- **Trade-offs**:
  - Pro: maximal DRY — one place a maintainer edits when a new runtime appears, and adding Codex (item 5) is one row plus one adapter, not five scattered edits.
  - Pro: the ceiling fact (item 1) and the log-root fact (item 4) sit on the same row, so `discipline/transcripts` and `brain/sessions` are forced to converge on one declaration instead of two half-truths.
  - Pro: a single census can prove the whole substrate; the ratchet is one equality count, easy to review.
  - Con: forces a false union. A tool-surface ceiling, a TOML config path and a writer-lock file are not the same kind of fact; the row type degenerates into a wide bag of optionals, which is exactly the shape that let `sessionPaths?()` (item 3) become declared-and-unread.
  - Con: state surfaces are keyed by surface identity, not by target identity; grafting them onto a target-keyed table needs a synthetic key that carries no meaning.
  - Con: one table with one census makes the units less separable — several of the nine can only land after the table exists, which weakens the atomic-unit constraint.
  - Con: says nothing about provenance (item 6); `envOrConfig` still returns a bare value.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Two closed registries and a provenance spine

- **Approach**: Split the substrate along its two real key spaces and add the missing third dimension. `RUNTIME_FACTS` is keyed by a closed `INSTALL_TARGET_ID` and holds per-host contract knowledge (tool ceiling and the resulting profile floor, config format, install mechanism, session-log roots, the `SESSION_ADAPTER_ID` it maps to — collapsing item 3's orphan `format` union into the live vocabulary rather than adding a sixth one). `STATE_SURFACES` is keyed by a closed surface id and extends `OUT_OF_VAULT_STATE` in place — every row gains a resolver reference, a reachability tri-state modelled on `SearchIndexVerdict`, and the override key that can move it. Cutting across both, `envOrConfig` in `src/core/validate.ts` is widened to return a value plus a declared origin layer (env / user config / `Brain/_brain.yaml` / default), which is what lets install and hook generation finally read the committed vault tier without a stale key winning silently, and what lets a single `o2b doctor`-adjacent inventory verb print, for every runtime and every surface, the value, where it came from, and whether it is reachable.
- **Trade-offs**:
  - Pro: each registry has one honest key space and one reader family, so neither row type degenerates into optionals; the house closed-vocabulary pattern applies cleanly to all three.
  - Pro: provenance is the one addition that makes the other eight verifiable rather than merely declared — a census can assert that every fact printed by the inventory names its origin, which is a much stronger ratchet than "row exists".
  - Pro: separates cleanly into atomic units — the ratchet on the origin type, `RUNTIME_FACTS` plus the ceiling-aware profile floor, the Codex adapter, the surface inventory, the maintenance-task vocabulary (item 8), and the streaming session reader (item 9) each land and test independently, in any order after the vocabularies exist.
  - Pro: `MaintenanceTask.name` and the `ExportFormat` orphan become instances of the same fix — a closed vocabulary with one declaration site — rather than two unrelated cleanups.
  - Con: three new shared constructs to review at once; the widened `envOrConfig` touches roughly fifty-five call sites, and a mechanical sweep that large hides mistakes.
  - Con: two registries can still drift from each other if a future runtime is added to one and not the other; needs a cross-census asserting the mapping between target ids and session adapter ids is total.
  - Con: still declares rather than measures — a wrong ceiling in `RUNTIME_FACTS` is invisible until a user reports dropped tools.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Owner-local obligation plus live probe

- **Approach**: Declare no central table. Instead make the existing `InstallAdapter` interface carry the knowledge as required (not optional) members — a limits descriptor, a session-paths descriptor, a state-surfaces contribution — so each adapter owns the facts about its own host and TypeScript itself refuses an adapter that omits one, which is the structural fix for `sessionPaths?()` being declared with nothing behind it. Proof shifts from declaration to measurement: extend `tests/docs/install-verify-conformance.test.ts` into a per-adapter friction comparison, and give every adapter a `probe()` on the `copilot-cli` precedent (injectable runner, explicit skip reason when the host binary is absent) so `verify()` stops ending in "no MCP handshake attempted" for hosts that can actually answer. The tool-surface ceiling is then not a hardcoded number but a measured, recorded observation with a declared fallback.
- **Trade-offs**:
  - Pro: knowledge lives next to the code that acts on it, which is the strongest anti-drift force available and needs no synthetic key space.
  - Pro: required interface members are compiler-enforced — a stronger guarantee than a census for the completeness half of the problem.
  - Pro: probing produces facts about the machine actually installed on, which is the only thing that can catch a host whose ceiling changed upstream.
  - Pro: fits the re-construction convention and keeps generated payloads byte-identical, since probes inform reporting rather than payload content.
  - Con: does not answer the cross-cutting questions at all. "Which session logs exist and were never imported" and "where does every state surface live" require an inventory across owners; with owner-local declaration only, the reader has to enumerate the registry and can never prove the enumeration is complete for non-adapter surfaces (the search index, the maintenance lease, the hook audit have no adapter to own them).
  - Con: probes are environment-dependent, so CI must exercise the skip path far more often than the live path, which is how "no handshake attempted" reappears under a new name.
  - Con: leaves item 6 untouched — provenance is not an adapter concern — and item 8's vocabulary problem is unaddressed.
  - Con: mandatory interface members are a breaking change to every existing adapter in one commit, which fights the separable-atomic-units constraint.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The nine items drifted for one reason — a fact was declared in one place and read in none, or read in two places from two declarations — and only Variant 2 attacks both halves, because provenance is what converts "a row exists" into "this value won, from this layer, and here is the surface that proves it reachable". Variant 1's single table is more DRY on paper but unions two key spaces that are genuinely different, reproducing the wide-optional shape that produced item 3 in the first place; Variant 3's owner-local obligation is the right instinct for adapters yet structurally cannot answer the inventory questions in items 4 and 7, since the state surfaces with no owning adapter are exactly the ones nobody tracks. Variant 2 also decomposes best against the hard constraint that this ship as separable atomic units on one branch, and it should still borrow Variant 3's probe as one column of `RUNTIME_FACTS` — declared ceiling, measured ceiling, explicit skip reason — so the substrate reports what it knows and how it knows it rather than asserting either alone.
