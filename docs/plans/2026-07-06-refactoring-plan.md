# Refactoring Plan - 2026-07-06

**Goal:** Reduce duplication, fix latent correctness gaps, and shrink the worst
complexity hot spots across `src/` without changing any observable behavior
(CLI output contracts, MCP tool envelopes, on-disk formats stay byte-stable
unless a task explicitly says otherwise).

**How this plan was produced:** four parallel analysis passes over the
codegraph index (src/core/brain, the search stack, MCP + CLI layers,
cross-cutting core/hooks/scripts) plus a `code-ranker` v5.0.0 structural scan
(complexity ranking, coupling, import-cycle detection). Every finding below
was verified against the current source; file:line references are from
commit `4f6b72c`.

**Baseline (must stay green after every task):**

- `bun run typecheck` - green at plan time.
- `bash scripts/test` - green at plan time (5205 pass, 0 fail, 668 files);
  re-run with `bun run lint` per task.
- No version bump in this plan. Per CLAUDE.md the bump rides in the PR that
  ships the work; decide the version once the executed scope is known.

**Tooling for executors:** navigate with codegraph MCP tools
(`codegraph_explore` / `codegraph_callers` / `codegraph_impact`), not
grep+read loops. Caveat: codegraph does not index `src/core/install/adapters/`
reliably - confirm "dead code" verdicts there with grep before deleting.
`code-ranker report .` regenerates the structural snapshot under
`.code-ranker/` (gitignored) for before/after comparison.

---

## Phase 0 - correctness fixes (do first; tiny, independent, user-visible value)

### 0.1 `policy.ts`: forward-compat `known` set is missing 4 valid config blocks

- **Where:** `src/core/brain/policy.ts:1627-1645` (the `known` set) vs blocks
  parsed at 1344 (`health`), 1655 (`hygiene`), 1693 (`anticipatory`),
  1717 (`recall`).
- **Problem:** the unknown-top-level-key loop warns
  `unknown top-level field ignored (forward-compat)` for four keys that the
  same function fully validates and applies. `brain doctor` shows operators a
  false warning for working config; an operator may delete valid blocks.
- **Fix:** add `health`, `hygiene`, `anticipatory`, `recall` to the set.
  Superseded by task 2.1 (registry-derived set) - do this one-liner first
  anyway so the bug does not wait for the big refactor.
- **Test:** config fixture with all four blocks produces zero warnings.
- **Risk:** minimal.

### 0.2 `query-demand.ts`: divergent `clamp01` copy leaks `NaN`

- **Where:** `src/core/brain/query-demand.ts:436`; canonical copies at
  `src/core/search/recency.ts:51`, `src/core/search/relation-polarity.ts:91`,
  `src/core/search/ranker.ts:109`,
  `src/core/brain/continuity/usage-signal.ts:224`.
- **Problem:** 5 hand-copied `clamp01` helpers; the `query-demand` copy omits
  the `Number.isFinite` guard, so `NaN` propagates into scoring instead of
  clamping to 0 like every other copy.
- **Fix:** single `clamp01` in a shared numeric util (new `src/core/math.ts`
  or alongside `src/core/validate.ts`), with the NaN guard; import it in all
  five sites and delete the locals.
- **Test:** unit test `clamp01(NaN) === 0`; existing scoring tests stay green.
- **Risk:** low (behavior change only for the NaN path, which is the bug).

### 0.3 CLI search: numeric flags accept `NaN` silently

- **Where:** `src/cli/search.ts:161-166` (`keyword-weight`,
  `semantic-weight`, `concurrency` via bare `Number(...)`) pass a raw JS
  `number` into `resolveSearchConfig`'s `overrides`.
- **Problem:** `--keyword-weight=hi` becomes `NaN`. Root cause is one level
  deeper than the CLI: `validateIntegerRange` in
  `src/core/search/index.ts:225-232` only compares `n < min` / `n > max`,
  and both comparisons are `false` for `NaN`, so a NaN override for any
  integer knob (`concurrency`, `batchSize`, `dimension`, `timeoutMs`,
  `chunkSize`, ...) silently passes range validation. String-sourced values
  (config file / env) are protected because they already go through
  `parseInteger`/`parseFloat01` (`core/validate.ts`), which do check
  `Number.isFinite` - only the raw-number `overrides` path was exposed.
  `validateWeight` was already guarded (`!Number.isFinite(n)`), so only the
  integer-range path had the gap.
- **Fix (done):** added a `Number.isFinite` guard at the top of
  `validateIntegerRange`, matching `validateWeight`'s existing style. This
  closes the gap for every integer override, not just the CLI's
  `--concurrency`, with one change. No separate CLI-layer guard was added:
  `cmdSearch`'s catch block already maps `SearchError` with code
  `INVALID_INPUT` to a clean `error: ... [INVALID_INPUT]` / exit 2, i.e.
  the same UX as `CliError` - a second inline check in `cli/search.ts` would
  have been redundant validation of the same value in two places.
- **Test (done):** `tests/core/search/config.test.ts` - "a NaN integer
  override is rejected instead of silently passing range checks"
  (`overrides: { semantic: { concurrency: NaN } }`).
- **Risk:** minimal (turns silent corruption into an error).

### 0.4 Dead export cleanup (verified zero callers)

- `src/mcp/coerce.ts:54` `coerceOptionalNumber` - delete (confirmed dead via
  codegraph_callers + repo grep across `src/` and `tests/`).
- ~~`src/core/search/store.ts` `normalizeAlias`, `WRITER_LOCK_STALE_MS`,
  `WRITER_LOCK_HEARTBEAT_MS` - drop `export`~~ **correction, not applied:**
  all three are imported directly by `tests/core/search/store-aliases.test.ts`
  and `tests/core/search/multi-instance.test.ts` to pin invariants (e.g.
  `WRITER_LOCK_HEARTBEAT_MS < WRITER_LOCK_STALE_MS`). The original finding
  only checked `src/` callers and missed the test-file importers; these
  exports are live and must stay.
- **Risk:** minimal; typecheck catches any missed caller.

---

## Phase 1 - cross-layer DRY: search stack (highest drift risk)

The core/CLI/MCP layers re-implement the same serialization and policy.
These are the places where two surfaces can silently disagree.

### 1.1 Evidence-pack serializer (single source of truth)

- **Where:** `src/cli/search.ts:719-768` (`jsonForEvidencePack`) and
  `src/mcp/search-tools.ts:669-720` (`mcpEvidencePack`) - field-for-field
  identical snake_case mapping (significant terms, records, dropped
  candidates, abstention, coverage blocks).
- **Why:** the evidence-pack contract is safety-relevant (abstention,
  coverage); two copies WILL drift on the next field addition.
- **Fix:** extract `serializeEvidencePack(pack)` into
  `src/core/search/evidence-pack.ts` (the type already lives in core);
  both layers call it.
- **Test:** snapshot test that CLI and MCP emit identical JSON for the same
  pack.

### 1.2 Provider-registry CLI commands are clones

- **Where:** `src/cli/search.ts:344-429` (`cmdSearchProvider`) vs `:433-525`
  (`cmdSearchRerankProvider`) - ~90 duplicated lines; same
  `add|list|show|remove` dispatch, flags, and formatting; only the registry
  functions and the noun differ.
- **Fix:** one `runProviderRegistryCommand(argv, { label, load, add, get,
  remove })` parameterized by the registry ops.
- **Test:** existing provider CLI tests must pass unchanged for both nouns.

### 1.3 Result/card/status JSON shaping shared between CLI and MCP

- Cards: `src/cli/search.ts:700-713` and `src/mcp/search-tools.ts:637-651`
  emit a byte-identical card object - hoist one card serializer.
- Index status: `src/cli/search.ts:1151-1171` (`jsonForStatus`) and
  `src/mcp/search-tools.ts:1287-1302` (`buildSearchStatusBlock`) hand-map the
  same snapshot keys - extract `statusSnapshotToJson(snap)` beside
  `indexStatus` in core; MCP picks its subset from the shared object.
- Note: CLI results are snake_case, MCP camelCase - that split is an
  intentional output contract; the shared serializer must preserve it
  (either a `casing` option or two thin adapters over one field list).
- **Test:** golden-output tests for both surfaces before and after.

### 1.4 One search-request normalizer; one limit policy

- **Where:** `src/cli/search.ts:604-626`, `src/mcp/search-tools.ts:513-539`,
  and `src/core/search/search.ts:248` - three independent limit bounds
  (CLI 1..100, MCP 1..50, core clamp to 100) and duplicated
  semantic/keyword-only precedence.
- **Done (narrow slice):** exported `SEARCH_LIMIT_MIN`/`SEARCH_LIMIT_MAX`
  from `core/search/search.ts` and pointed the CLI's `--limit` validation
  at them instead of a bare `100` literal that happened to match core's
  clamp by coincidence. MCP's own `MCP_LIMIT_MAX = 50` was already a named
  constant (not a magic number as the original finding assumed) and is
  deliberately lower for its token budget - left as-is.
- **Deliberately not done:** the `normalizeSearchRequest(rawOpts)` unifier
  and "core stops silently re-clamping" behavior change. On inspection the
  CLI/MCP semantic-vs-keyword-only precedence is NOT pure duplication - the
  CLI rejects `--semantic` + `--keyword-only` together (`CliError`), MCP has
  no equivalent conflict check - unifying them is a policy decision (should
  MCP also reject the combination?), not a refactor, and core's clamp is a
  safety net for any caller that does not pre-validate (not yet fully
  audited). Doing this safely needs the boundary-pinning tests the original
  risk note called for; deferred rather than rushed.
- **Risk:** minimal for the done slice; the deferred part stays medium.

### 1.5 Property-filter parsing: share semantics, keep syntax adapters

- **Where:** `src/cli/search.ts:616-638` (`parsePropertyFlags`, KEY=VALUE
  strings) vs `src/mcp/search-tools.ts:335-363` (`parsePropertiesArgument`,
  object argument).
- **Assessed, not extracted:** on inspection the two do NOT share
  extractable validation logic - CLI parses a flat string list and can
  never produce an empty value array by construction (a malformed entry
  throws before accumulation), while MCP iterates an already-object
  argument and must explicitly reject non-array/non-string values and
  empty arrays (failure modes only possible with a JSON object input).
  Each throws its own error type (`CliError` vs `MCPError`) with
  layer-specific messages. What the plan called "identical semantics" is
  really just the shared *output type*
  (`ReadonlyMap<string, ReadonlyArray<string>>`), which both already
  satisfy - there is no meaningful logic left to factor into a
  `buildPropertyFilter(entries)` without adding an indirection that
  doesn't remove real duplication. Left as two independent, correctly
  input-shape-specific parsers.

### 1.6 In-module duplication inside core search

- **Done:** `store.ts` - `xs.map(() => "?").join(",")` was repeated 12
  times; extracted a private `sqlPlaceholders(items)` helper (named to
  avoid shadowing the many local `const placeholders = ...` call sites).
- **Done:** `search.ts` - semantic pool sizing `Math.max(limit * 5, 50)`
  was repeated 5 times; named the policy (`POOL_OVERFETCH`, `POOL_FLOOR`,
  `semanticPoolSize(limit)`); the one wider-cap variant now builds on it
  (`Math.max(semanticPoolSize(limit), limit * 3, 30)`) instead of
  repeating the `5, 50` pair inline.
- **Assessed, not extracted:** snippet rendering. CLI's inline snippet
  (`src/cli/search.ts`, collapse whitespace + `slice(0, 140)` + `…`),
  MCP's `truncateContent` (`src/mcp/search-tools.ts:395-398`, NO whitespace
  collapse, `MCP_CONTENT_MAX = 600`, deliberately larger since it preserves
  fuller content rather than previewing it), `session-recall.ts`'s `snippet`
  (extracts a window CENTERED on a match index - a different algorithm
  entirely, not a leading truncation), and `idea-lineage.ts`'s `snippet`
  (collapse + truncate, but checks the COLLAPSED string's length and slices
  to `SNIPPET - 3` to leave room for a 3-dot `...` - more correct than
  CLI's version, which checks the ORIGINAL uncollapsed length for its
  ellipsis decision). These are four genuinely different operations, not
  one duplicated across four sites; the two that are superficially similar
  (CLI, idea-lineage) already disagree on which string's length gates the
  ellipsis. Unifying would mean either building a parameterized
  `{collapse, anchor, ellipsis}` abstraction for four call sites (more
  machinery than the duplication justifies) or silently changing one
  side's behavior (an unauthorized policy call). Left as-is.

---

## Phase 2 - `src/core/brain/policy.ts` decomposition (worst file in the repo)

code-ranker: cognitive complexity 495, maintainability index -85.5, 1934
lines - the repo maximum on both axes. `validateBrainConfigDetailed`
(lines 630-1847, ~1220 lines) inline-validates 19 config blocks; phase 0.1's
bug is a direct consequence (block parsing and the known-key list drifted).

### 2.1 Registry of block validators

- Extract one `validate<Block>(raw, source, warnings)` function per config
  block (~30-60 lines each), registered in a single
  `{ key, validator }` table. Derive the top-level `known` set from that
  table so a new block CANNOT be added without registering it (makes the
  0.1 bug class structurally impossible).
- **Order:** mechanical, block-by-block, one commit per few blocks; the
  existing `validateBrainConfigDetailed` shell keeps its exact signature and
  error/warning texts.
- **Test:** existing policy tests are the safety net; add one test asserting
  `known` === registry keys.
- **Risk:** medium (large mechanical diff) - mitigated by unchanged messages
  and per-block commits.

### 2.2 Shared micro-helpers used by 2.1

- `requireMapBlock(raw, blockKey, source)` - replaces ~11 copy-pasted
  "block must be a map" guards (762, 855, 942, 1076, 1206, 1286, 1355, 1411,
  1485, 1541, 1659, 1697, 1721, 1752) and normalizes their inconsistent
  messages ("must be a mapping" vs "must be a map of keys").
- `warnUnknownKeys(map, known, blockName, source, warnings)` - replaces ~10
  hand-rolled forward-compat loops (834, 918, 971, 1177, 1259, 1333, 1389,
  1462, 1514, 1594, 1795) that currently mix `Set` / chained `!==` /
  `.includes` styles.
- Message normalization is an intentional, documented output change; update
  affected test fixtures in the same commit.

### 2.3 `load*ConfigSafe` factory

- **Where:** `policy.ts:352-403` - `loadNotesConfigSafe`,
  `loadTemporalConfigSafe`, `loadGuardrailsConfigSafe`,
  `loadFeedbackDefaultScopeSafe` are structural clones of
  `try { resolve*(loadBrainConfig(vault)) } catch { DEFAULTS }`.
- **Fix:** `makeSafeLoader(resolveFn, defaults)` factory. The try/catch
  fail-soft itself is a documented contract for un-initialized vaults - keep
  it, factor only the boilerplate.

### 2.4 Doctor: shared brain-file iteration and error classification

- **Where:** `src/core/brain/doctor.ts:702-773` (`checkPreferences`) vs
  `:777-827` (`checkRetired`) - same skeleton and a byte-identical catch
  block classifying parse errors via magic regexes (`/missing field/`,
  `/ISO-8601/i`); `checkSignals` (:666-698) shares the outer skeleton.
- **Fix:** extract `classifyParseError(err, path, kindPrefix, issues)` and a
  `forEachBrainFile(dir, prefix, cb)` iterator. Fragility today: a parser
  error-wording change silently reclassifies issues in one path only.

### 2.5 Signal frontmatter parsing helper

- **Where:** `src/core/brain/signal.ts:360-367, 427-435, 437-445` repeat the
  "present, must be string, trim, keep if non-empty" block for `scope` /
  `dedup_hash` / `session_ref`; `readBiTemporalSlot` (:492-505) is a fourth
  copy already half-extracted.
- **Fix:** generalize into `readOptionalTrimmedString(meta, key, path)` and
  reuse in all four sites.

---

## Phase 3 - MCP boundary: one validation and error-envelope toolkit

### 3.1 Shared tool-error wrapper (safety-relevant classification)

- **Where:** six modules hand-roll the identical catch cascade
  (validation error to INVALID_PARAMS, MCPError passthrough, else
  INTERNAL_ERROR): `src/mcp/brain/derive-tools.ts:54-61`,
  `ingest-tools.ts:47-54`, `ner-tools.ts:45-54`, `research-tools.ts:82-89`,
  `calendar-tools.ts:94,178`, `entity-tools.ts:81-83`.
- **Why:** "caller's fault vs server fault" is a safety-relevant mapping;
  one module drifting reclassifies client errors as internal (or worse, the
  reverse).
- **Fix:** `wrapToolErrors(tool, fn, { validation: [ErrorClass, ...] })` in
  `src/mcp/brain/shared.ts`; each handler delegates.

### 3.2 Collapse duplicate coercers

- Same-file near-duplicates: `src/mcp/brain/shared.ts:49`
  `coercePositiveInteger` (11 callers) vs `:115` `optionalPositiveInt`
  (6 callers) - keep one positive-integer coercer with an
  `{ optional }` flag or a thin optional wrapper; 17 call sites are split
  arbitrarily today.
- Array-of-string validation exists 6+ times with divergent semantics:
  `src/mcp/coerce.ts:28` `coerceStrList`,
  `src/mcp/brain/hygiene-tools.ts:39` `coerceStringArray`,
  `src/mcp/brain/research-tools.ts:27` `reqStringList`,
  `src/mcp/brain/intake-args.ts:50` `optionalStringArray`, plus inline
  throws in `synthesis-tools.ts:43` and `search-tools.ts:345,365,380`.
  One parameterized `coerceStrList(args, key, { required, nonEmpty, tool })`
  in `coerce.ts`; delete the locals.
- Structural guards duplicated: `intake-args.ts:31-56` (`isRecord`,
  `requiredString`, `optionalString`, `optionalStringArray`) re-implemented
  in `research-tools.ts:23-52` - export from one place, consume in the other.
- Longer term the `shared.ts` coercers should sit on `coerce.ts` primitives
  with a `tool`-prefixing message wrapper; do that only if it falls out
  naturally - message texts are part of the tool contract, pin them in tests.

### 3.3 One ISO-instant parser

- **Where:** three divergent validators: `src/mcp/coerce.ts:100`
  `coerceIsoDate` (anything `new Date()` parses - masks malformed input),
  `src/mcp/brain/shared.ts:18` `coerceIsoTimestampOrDate` (`Date.parse` +
  date-only regex), `src/cli/coerce.ts:57` `parseOptionalIsoDate` (strict
  offset regex).
- **Fix:** single `parseIsoInstant(raw, shape)` in `core/validate.ts`; the
  three call sites keep their layer-specific error wrapping. Tightening
  `coerceIsoDate` is a deliberate contract fix (reject what `new Date`
  merely guesses at), covered by tests.
- Note: the CLI-vs-MCP split of coerce modules (tuple-return vs throw) is
  justified layering - do NOT force-merge the two `coerce.ts` files.

---

## Phase 4 - cross-cutting core cleanups

### 4.1 `config.ts` feature-flag resolver helper

- **Where:** `src/core/config.ts` - seven copy-paste boolean resolvers
  (`resolveSkillsAttachTriggers:310`, `resolveSkillAutoAttach:322`,
  `resolveSearchFocusContextPack:334`,
  `resolvePostCompactSurvivalAudit:347`, `resolveSessionHandoff:358`,
  `resolveRecallGateTelemetry:408`, `resolveGenerationTraceEnabled:484`),
  identical env-then-config, `"true" || "1"` bodies.
- **Fix:** private `resolveConfigFlag(envKey, configKey, configPath)`;
  each resolver becomes a one-liner. Preserves the default-OFF fail-soft
  contract.

### 4.2 Route `config.ts` numeric resolvers through `validate.ts`

- **Where:** `resolveAdequacyFloor:451` re-implements `parseFloat01`
  (`validate.ts:46`); `resolveAdequacyMinResults:466` and
  `resolveTriggerCooldownDays:390` re-implement `parseInteger` with a min.
- **Fix:** import and use the `validate.ts` primitives; align error phrasing
  (documented output change, fixture updates in the same commit).

### 4.3 Canonical `escapeRegex` (security-adjacent)

- **Where:** canonical at `src/core/strings.ts:14`;
  `src/core/brain/schema-pack.ts:436` redefines a second `escapeRegex` in a
  file that already imports the canonical one; the raw pattern is inlined at
  `heal-enrich.ts:35` and `src/core/brain/secrets/exec.ts:51`
  (`matchesAllowlist` - the secret-exec allowlist matcher).
- **Fix:** import from `strings.ts` everywhere; delete the redefinition and
  inlined copies. The allowlist matcher must have a test pinning metachar
  escaping before the swap.

### 4.4 Shared `isDir` and vault skip-dirs constant

- `src/core/fs-utils.ts:22` `isDir` vs local re-implementations in
  `src/core/partner/codegraph.ts:35`,
  `src/core/brain/portability/recall-sources.ts:40`, `pointer.ts:44`,
  `origins.ts:34` - import the canonical one.
- `src/core/vault.ts:50` `DEFAULT_SKIP_DIRS` vs
  `src/core/graph/mcp-config.ts:32` `SKIP_DIRS` (same four plus two) -
  export the base list, spread-extend in `mcp-config`.

---

## Phase 5 - architecture: import cycles (code-ranker findings, verify first)

code-ranker found 7 strongly-connected components in the file-import graph.
For TypeScript, some edges may be type-only; the fix differs (use
`import type` vs extracting a shared module), so each SCC starts with a
verification step. Ordered smallest-first:

1. `config.ts -> brain/wikilink.ts -> link-graph/format-wikilink.ts -> config.ts`
   (3 nodes) - core config should not depend on brain formatting; likely a
   misplaced helper.
2. `brain/doctor.ts -> trust/instruction-file-ceiling.ts ->
   trust/compute-trust-verdict.ts -> doctor.ts` (3 nodes).
3. `brain/procedural-memory.ts -> procedural-graph.ts ->
   procedural-hints.ts -> …` (3 nodes).
4. `search/embeddings/provider.ts -> openai-compat.ts -> null-provider.ts ->
   local-provider.ts -> …` (4 nodes) - classic interface-vs-implementations
   cycle; the provider interface should not import its implementations
   (Dependency Inversion; likely a factory living in the interface module).
5. `search/types.ts -> structured-query.ts -> session-focus.ts ->
   evidence-pack.ts -> …` (4 nodes) - `types.ts` must stay a leaf.
6. `search/index.ts -> embeddings/provider-resolve.ts -> rerank/provider.ts ->
   rerank/index.ts -> …` (9 nodes).
7. `src/mcp`: 34-node SCC through `capabilities.ts -> tools.ts ->
   watchdog-tools.ts -> skill-tools.ts -> …` - every tool module both
   registers into and imports from the registry. Likely fix: registry
   module stops importing tool modules (pure registration data flows one
   way), or tool modules import only a `types`-level contract.
- **Risk:** medium-high for 6 and 7 (wide diffs); low for 1-5.
  Each SCC is its own commit; `code-ranker check` becomes the regression
  gate (violation count must only go down).

---

## Phase 6 - deferred / explicitly out of scope

- **`search()` orchestrator decomposition** (`src/core/search/search.ts`,
  ~330-line pipeline, cognitive 415): genuinely one cohesive pipeline with
  heavy test-coverage sensitivity. Do NOT split it as part of this plan;
  revisit only after phases 1 and 5.6 stabilize its imports.
- **`config.ts` device-id extraction** (grab-bag SRP concern, lock-guarded
  generator at :218-263): worthwhile but low urgency; do after 4.1/4.2
  shrink the file, as a pure move.
- **`dream.ts` / `doctor.ts` / `digest.ts` full decomposition**: high
  complexity (344/289/191) but no verified low-risk seams beyond 2.4;
  needs its own design pass.
- **`openclaw/index.js` duplication**: committed build bundle, not source -
  packaging concern, not refactoring.
- **Documented fail-soft contracts** (hooks never crash the session,
  `load*ConfigSafe` defaults, best-effort pruning/maintenance): deliberate
  design, verified as such during analysis; not "meaningless fallbacks",
  do not touch.

---

## Appendix - structural baseline (code-ranker v5.0.0, commit 4f6b72c)

Reference point for before/after comparison; regenerate with
`code-ranker report . --ignore 'node_modules/**' --ignore 'openclaw/index.js'
--ignore '__pycache__/**'` (snapshot lands in `.code-ranker/`, gitignored).
TS plugin: 627 source files, 644 nodes, 2948 import edges.

Worst files by cognitive complexity (`cog` cognitive, `cyc` cyclomatic,
`MI` maintainability index, `bugs` Halstead estimate; tests excluded):

| File | cog | cyc | MI | SLOC | bugs |
|---|---|---|---|---|---|
| src/core/brain/policy.ts | 495 | 332 | -85.5 | 1433 | 11.2 |
| src/core/search/search.ts | 415 | 319 | -80.8 | 1162 | 12.1 |
| src/core/brain/dream.ts | 344 | 216 | -54.6 | 970 | 10.1 |
| src/cli/search.ts | 303 | 282 | -67.8 | 1110 | 12.3 |
| src/core/brain/doctor.ts | 289 | 202 | -49.0 | 954 | 7.3 |
| src/core/brain/preference.ts | 216 | 223 | -52.6 | 865 | 8.7 |
| src/mcp/search-tools.ts | 210 | 199 | -48.5 | 1175 | 9.2 |
| src/core/search/store.ts | 194 | 252 | -67.2 | 1444 | 12.1 |
| src/core/brain/digest.ts | 191 | 165 | -36.4 | 808 | 8.6 |
| src/core/search/indexer.ts | 170 | 145 | -29.8 | 748 | 7.3 |

Files with negative MI: 35 of 627 - the complexity debt is concentrated,
not spread. The search vertical appears three times (core/CLI/MCP), matching
the phase 1 cross-layer duplication findings.

Coupling hubs (fan-in = number of dependent files): `src/mcp/brain/helpers.ts`
117, `src/core/brain/paths.ts` 113, `src/core/brain/types.ts` 85,
`src/core/config.ts` 85, `src/core/vault.ts` 71. Contract changes in these
ripple across the repo. Notable hazard: `policy.ts` combines fan-in 37 with
the worst complexity in the repo. Highest fan-out (orchestrators, expected):
`src/core/search/search.ts` 36, `src/cli/main.ts` 29,
`src/mcp/brain/knowledge-tools.ts` 28.

Import-cycle violations (`code-ranker check`): 7 SCCs - the phase 5 list.
The 34-node MCP component contains `capabilities.ts`, `tools.ts`, the
top-level tool modules (`watchdog-tools`, `skill-tools`, `search-tools`,
`schema-tools`, `hydrate-tool`) and 21 `src/mcp/brain/*-tools.ts` modules
plus `shared.ts` - the registry imports every tool module while tool modules
import the registry/shared back. The 9-node search component runs through
the `index.ts` barrels (`search/index.ts`, `rerank/index.ts`), i.e. members
import siblings via the barrel instead of directly.

## Execution notes

- One branch off `main` (e.g. `refactor/dry-and-decomposition`); one commit
  per numbered task (2.1 may be several); `bun run validate` after each.
- Phases 0-4 are independent of each other at the task level and can be
  parallelized across agents; phase 5 tasks touch wide import graphs - do
  them serially, last.
- Any error-message or warning-text change is called out in its task as a
  documented output change with fixture updates in the same commit; nothing
  else may alter observable output (add golden tests before extracting
  serializers in phase 1).
- CHANGELOG entry and version bump happen in the shipping PR per CLAUDE.md
  (bump `package.json`, run `bun run scripts/sync-version.ts`).
