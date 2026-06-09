### Variant 1: Mechanical Extraction with Compatibility Shims

- **Approach**: Each unit is a pure code move with the old paths kept as thin re-export shims. brain-tools.ts splits into per-domain modules but stays as an aggregator file re-exporting `BRAIN_TOOLS`; fs-atomic.ts becomes a re-export of reliability/atomic.ts wrappers; the seven wikilink regexes are replaced by imports from a new canonical module while the old exported names survive as aliases; CLI verbs gain a `runBrainCommand()` helper but each verb file keeps its own entry function. Layering guard is a grep-based bun test.
- **Trade-offs**:
  - Pro: lowest blast radius — no import path changes outside the touched modules, so tests, plugins/hermes, hooks/, and the openclaw bundle are untouched by construction.
  - Pro: each commit is trivially revertable; diffs are mostly moves, easy to review.
  - Con: shims are new dead weight — DRY violations are hidden behind aliases rather than removed, leaving a second cleanup pass for later.
  - Con: 89 verb files still each contain boilerplate (a call to the wrapper) and divergent flag parsing may survive inside the wrapper callbacks.
- **Complexity**: small
- **Risk**: low

### Variant 2: Canonical Modules with Direct Call-Site Migration

- **Approach**: For every duplication, pick one winning implementation, delete the loser, and migrate all call sites in the same commit — no shims except where an export is verifiably consumed externally (checked by grepping tests, plugins/hermes, hooks/, openclaw imports first). `atomicWriteText` (the richer API with validate hook) absorbs fs-atomic.ts; one `wikilink.ts` in link-graph exports parse/format/regex and all seven sites import it; CLI verbs are rewritten onto a `withBrainContext(flags, handler)` higher-order wrapper that owns config resolution and fail() formatting; policy/dream extractions get explicit input/output interfaces. Layering guard is a bun test that scans src/core for `process.exit`/`stdout`/`console` with an allowlist.
- **Trade-offs**:
  - Pro: actually removes the ~600 duplicated CLI lines and the duplicate atomic/wikilink implementations — the codebase ends smaller, not larger.
  - Pro: unifying divergent wikilink edge-case handling under one tested module surfaces latent inconsistencies now instead of letting them drift further.
  - Con: call-site migration per commit means bigger diffs (the CLI unit touches ~89 files at once), so review and revert granularity within a unit is coarser.
  - Con: merging divergent regex behavior risks subtle behavior change; needs characterization tests for the edge cases before unifying.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Registry-Driven Framework Refactor

- **Approach**: Go beyond extraction to declarative registration: per-domain MCP tool modules export descriptor arrays that an aggregator concatenates with a parity test asserting the frozen v1.0.0 tool-name set; CLI verbs convert to a `defineBrainVerb({flags, run})` factory that centralizes parsing, context, error formatting, and exit codes, with verbs discovered from a manifest; wikilink and atomic-write become a small `src/core/text/` and `src/core/fs/` primitives layer. Layering guard is a hand-rolled AST walk (Bun's transpiler API, no new deps) enforcing import direction as well as the process/console ban.
- **Trade-offs**:
  - Pro: strongest long-term shape — new tools/verbs get the conventions for free, and the parity test mechanically guards the frozen public surface.
  - Pro: the import-direction guard prevents the next god module, not just this one.
  - Con: largest diff and most new abstraction in a "zero behavior change" PR; a verb factory changes flag-parsing code paths for all 89 verbs at once, the hardest place to prove output-identical behavior (error message formatting, exit codes).
  - Con: stretches the release scope — framework design questions (manifest format, descriptor shape) invite bikeshedding and make units less independently revertable since later units depend on the new primitives layer.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: The task's stated goal is removing duplication, and Variant 1 mostly relocates it behind shims while Variant 3 smuggles a framework redesign into a pure-refactor PR with a frozen v1.0.0 surface. Variant 2 deletes the duplicates outright, follows the already-established per-domain split pattern in src/mcp/, and keeps each unit a self-contained conventional commit; its main risk (wikilink behavior drift) is contained by writing characterization tests for the divergent edge cases before unifying, which the 541-test suite and per-unit green requirement already mandate.
