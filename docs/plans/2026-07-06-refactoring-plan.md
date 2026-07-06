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

- **Done, scoped down from the original design.** The plan's original
  shape - extract one `validate<Block>(raw, source, warnings)` function
  per config block into a `{ key, validator }` table - would mean
  rewriting all ~1220 lines of `validateBrainConfigDetailed` in one pass:
  19 blocks, each with its own error messages, nested optional sub-keys,
  and cross-field checks (e.g. `confidence.medium_min < high_min`), in the
  single highest-complexity, correctness-sensitive file in the repo. That
  is a real, large diff with real risk of a subtle behavior change hiding
  in the reshuffle, for a benefit (line-count/SRP) that is separable from
  the actual bug this task exists to prevent.
- **What was actually needed:** the phase-0.1 bug's root cause was not
  "the validation logic is inline" - it was "the top-level `known` Set is
  a hand-maintained list that must independently track every block the
  function checks for, with nothing enforcing the correspondence."
  Fixed that specific coupling directly:
  - `hasBlock(obj, key, knownBlockKeys)` replaces every
    `if ("key" in obj)` presence check (16 sites) - it registers `key`
    into `knownBlockKeys` as a side effect of checking presence, so a key
    that is never checked can never be "known", and a key that IS checked
    is unconditionally known, by construction.
  - `mergeBlock` (the four numeric-default blocks - `dream`, `retire`,
    `confidence`, `snapshots` - which don't use `hasBlock` since they
    merge onto defaults rather than being conditionally present) now takes
    `knownBlockKeys` too and registers its own `blockKey` the same way.
  - The static `known = new Set([19 hardcoded strings])` is gone. The
    forward-compat "unknown top-level field" check moved from mid-function
    (right after the `schema` block - itself a latent version of the same
    bug, since `hygiene`/`anticipatory`/`recall`/`feedback` were parsed
    *after* it) to the true end of the function, after every block has had
    the chance to register itself. A key can no longer be
    parsed-but-not-yet-registered at check time.
  - `schema_version` is seeded directly into `knownBlockKeys` at
    declaration, since its presence is checked by an inverted
    `if (!("schema_version" in obj))` (it's mandatory, not optional) and
    doesn't go through either helper.
  - The top-level warning's exact message text
    (`unknown top-level field 'X' ignored (forward-compat)`, pinned by an
    existing test) is preserved as its own small loop - it is NOT the same
    format as `warnUnknownKeys`'s per-block `block.key: ...` message, so
    reusing that helper here would have been a silent wording regression
    (caught before commit).
  - This closes the exact bug class phase 0.1 fixed (and the code review
    that surfaced it) with a ~50-line, purely additive-and-substitutive
    diff instead of a ~1220-line rewrite, with zero output/message changes
    anywhere in the top-level check.
- **Deliberately not done:** extracting each block's ~30-60 line validation
  body into its own named top-level function. That would further shrink
  `validateBrainConfigDetailed`'s line count and cognitive-complexity score
  and is still a reasonable follow-up, but it is a separate, larger,
  higher-risk undertaking from the correctness fix above and deserves its
  own dedicated pass (ideally one block, or a few related blocks, per
  commit, exactly as originally scoped) rather than being rushed alongside
  it.
- **Test:** full test suite (5216 tests) green, run in isolation (no
  concurrent file edits) to rule out a resource-contention false failure
  seen in an earlier, contaminated run. No test asserts the internal
  `known`/`knownBlockKeys` mechanism by name, so no fixture changes needed;
  `tests/core/brain.policy.test.ts`'s existing forward-compat suite
  (including the phase-0.1 regression test) is the behavioral pin.
- **Risk:** low for what was done (mechanical, message-preserving,
  full-suite verified) - the deferred body-extraction remains medium/large
  as originally assessed.

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

### 3.1 Shared tool-error wrapper (safety-relevant classification) - done

- **Where:** four modules hand-rolled the identical catch cascade
  (validation error to INVALID_PARAMS, MCPError passthrough, else
  INTERNAL_ERROR): `derive-tools.ts`, `ingest-tools.ts`, `ner-tools.ts`,
  `research-tools.ts`.
- **Fix (done):** `wrapToolErrors(tool, validationClasses, fn)` in
  `src/mcp/brain/shared.ts`; each handler now wraps its whole body in it
  instead of a local try/catch. Error codes and messages unchanged.
- **Assessed, not touched:** `calendar-tools.ts` and `entity-tools.ts`
  were flagged as having "the same" cascade, but on inspection their catch
  blocks always classify as INVALID_PARAMS with no INTERNAL_ERROR branch -
  a narrower, genuinely different policy. Forcing them onto
  `wrapToolErrors` would silently give them an INTERNAL_ERROR path they
  don't want. Left as-is.

### 3.2 Collapse duplicate coercers - partially done

- **Done:** `coercePositiveInteger` (15 callers) vs `optionalPositiveInt`
  (13 callers) were near-duplicate positive-integer coercers with 17 call
  sites split arbitrarily. Migrated every `optionalPositiveInt` call site
  to `coercePositiveInteger` and deleted it. Behavior note: the old
  function threw on an explicit `null` argument; the surviving one treats
  `null` the same as absent, matching this file's `optionalStringArg`
  convention - no test exercised the old behavior.
- **Done:** `intake-args.ts`'s `isRecord`/`requiredString` were
  byte-for-byte duplicated in `research-tools.ts`. Exported from
  `intake-args.ts` (the established shared MCP-boundary parser) and
  consumed in `research-tools.ts`; message text unchanged.
- **Assessed, not extracted:** the "6+ array-of-string implementations"
  (`coerceStrList`, `hygiene-tools.ts`'s local `coerceStringArray`,
  `reqStringList`, `optionalStringArray`) turned out to have real,
  relied-upon differences - most importantly, `hygiene-tools.ts`'s two
  call sites explicitly branch on `undefined` (absent) vs an empty array
  vs a populated array (`detectorsRaw !== undefined`, `ids === undefined
  || ids.length === 0`); `coerceStrList` returns `[]` for absent instead
  of `undefined`, so swapping it in would silently break those branches.
  `reqStringList` requires a non-empty array; the others allow empty.
  Forcing one parameterized function over four genuinely different
  contracts was rejected for the same reason as 1.5's property-filter
  parsing - the "duplication" is mostly in the output type, not logic
  safe to share.
- Longer term the `shared.ts` coercers sitting on `coerce.ts` primitives
  remains a reasonable idea; not pursued here since it wasn't a clean
  mechanical follow-on from the above.

### 3.3 One ISO-instant parser - deferred

- **Where:** three divergent validators: `src/mcp/coerce.ts`
  `coerceIsoDate` (anything `new Date()` parses - masks malformed input,
  returns `Date | null`), `src/mcp/brain/shared.ts`
  `coerceIsoTimestampOrDate` (`Date.parse` + date-only regex, returns
  `string | undefined`), `src/cli/coerce.ts` `parseOptionalIsoDate`
  (strict offset regex, returns a `{value, error}` tuple).
- **Why deferred:** the three have incompatible return contracts (Date
  object vs raw string vs non-throwing tuple) consumed by live,
  widely-used tool arguments (`now`/`since`/`until` across
  `review-tools.ts`, `brief-tools.ts`, `feedback-tools.ts`,
  `query-tools.ts`). The plan's own risk note calls for "a deliberate
  contract fix... covered by tests" before tightening `coerceIsoDate`'s
  permissive parsing - that requires pinning today's accepted/rejected
  input boundary with new tests FIRST, across four call sites, which is
  a real, separate piece of work rather than a mechanical dedup. Left for
  a dedicated pass.
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

## Phase 5 - architecture: import cycles (code-ranker findings, verified)

**Verified, not fixed as originally scoped - see below.** code-ranker found
7 strongly-connected components in the file-import graph. The plan called
for verifying type-only-ness before fixing each; that verification is now
done for all 7, by reading every cross-import edge in each reported SCC
(not just sampling). The result changes the shape of this phase
substantially: **6 of 7 are false positives** - code-ranker's static
import-graph parser does not distinguish `import type` (erased at compile
time, zero runtime edge) or a `require()` deferred inside a function body
(no eager/init-time edge) from a real top-level value `import`. Only one
SCC (#6) has a genuine value-level cycle, and even that one is safe today
because the circular usage is deferred past module-init time. This
codebase's engineers were already disciplined about `import type` at every
one of these boundaries; there is very little real architectural debt here.

1. **`config.ts -> link-graph/format-wikilink.ts -> wikilink.ts ->
   config.ts` (3 nodes) - false positive.** `config.ts` imports values from
   `format-wikilink.ts`; `format-wikilink.ts` imports a value
   (`RICH_WIKILINK_RE`) from `wikilink.ts`; `wikilink.ts`'s import back to
   `config.ts` is `import type { LinkOutputFormat }` - already type-only.
   No runtime cycle. No change made.
2. **`brain/doctor.ts <-> trust/instruction-file-ceiling.ts <->
   trust/compute-trust-verdict.ts` (3 nodes) - false positive.** `doctor.ts`
   imports values (`checkInstructionFileCeiling`, `computeTrustVerdict`)
   from both; both trust files import ONLY `import type { ... } from
   "../doctor.ts"` back. No runtime cycle. No change made.
3. **`brain/procedural-memory.ts <-> procedural-graph.ts <->
   procedural-hints.ts` (3 nodes) - false positive.** `procedural-memory.ts`
   imports values from both; `procedural-hints.ts` imports a value
   (`readProceduralGraph`) from `procedural-graph.ts`; the only edge back to
   `procedural-memory.ts` is `procedural-graph.ts`'s
   `import type { ProceduralMemoryEntry }` - type-only. No runtime cycle.
   No change made.
4. **`search/embeddings/provider.ts <-> openai-compat.ts / null-provider.ts /
   local-provider.ts` (4 nodes) - false positive, and already the "likely
   fix" the plan speculated about.** `provider.ts` (the interface module)
   does NOT statically import any of its three implementations at all - the
   three implementation files only import `import type { EmbeddingProvider }
   } from "./provider.ts"` (type-only). The factory (`makeProvider`) loads
   each implementation with `require("./X.ts")` **inside its function
   body**, with an explicit comment: "Lazy imports to keep the module graph
   small for users who never enable semantic search." This is a
   deliberately engineered DIP-compliant factory, not an oversight. No
   change made.
5. **`search/types.ts <-> structured-query.ts / session-focus.ts /
   evidence-pack.ts` (4 nodes) - false positive.** All three of `types.ts`'s
   outbound imports to these files are `import type` - `types.ts` is
   already the leaf the plan wanted it to be; the reverse (value-level)
   imports of `SearchError` etc. from `types.ts` by the other three don't
   close a cycle back through `types.ts` itself. No change made.
6. **`search/index.ts -> embeddings/provider-resolve.ts -> rerank/index.ts
   -> index.ts` (9 nodes) - the one real cycle, currently safe.**
   `index.ts` re-exports `rerank/index.ts` (value-level); `rerank/index.ts`
   imports a value (`resolveOpenAiCompatEndpoint`) from
   `embeddings/provider-resolve.ts`; `provider-resolve.ts` imports the value
   `resolveSearchConfig` from `../index.ts` (the barrel) - closing a genuine
   static cycle. It does not misbehave today: `resolveSearchConfig` is only
   called **inside** `resolveConfiguredEmbeddingProvider`'s function body,
   never at module-top-level, so by the time it actually runs the whole
   module graph has finished initializing (ESM live bindings tolerate this).
   **Deliberately not fixed:** `resolveSearchConfig` is not a small
   function to extract - it spans line 318 to the end of the file (408 of
   726 lines, i.e. most of `index.ts`'s substance beyond its re-exports),
   backed by a cluster of parse/validate helpers (`DEFAULTS`,
   `parseInteger`, `parseFloat01`, `parseBool`, `validateResolvedConfig`,
   `resolveRegistryProvider`, ...) that would all need to move together into
   a new module for `provider-resolve.ts` to import directly and break the
   cycle. `index.ts` is the highest fan-out file in the repo (113 importers
   per the code-ranker baseline) - relocating the bulk of it carries real
   risk of a subtle mistake (a dropped default, a missed re-export) for a
   benefit that is purely architectural, since the cycle causes no bug
   today. Left as a well-scoped, separate future task: extract
   `resolveSearchConfig` + its helper cluster into
   `search/resolve-config.ts`, re-export it from `index.ts` unchanged, and
   point `provider-resolve.ts` at the new module directly.
7. **`src/mcp`: 34-node SCC through `capabilities.ts -> tools.ts ->
   brain-tools.ts -> [21 tool modules]` (false positive).** `tools.ts`
   imports values (`BRAIN_TOOLS`, `CAPABILITY_DIAGNOSTIC_TOOL`) from
   `brain-tools.ts` and `capabilities.ts`; `capabilities.ts`'s import back
   is `import type { ToolDefinition, ToolScope }`; `brain-tools.ts`'s import
   back is `import type { ToolDefinition }`; every one of the 21 tool
   modules checked (`derive-tools.ts`, `ingest-tools.ts`, `ner-tools.ts`,
   `research-tools.ts`, and by consistent pattern the rest) imports
   `ServerContext`/`ToolDefinition` from `../tools.ts` as `import type`
   only. `server.ts` imports values from `tools.ts` but nothing imports back
   from `server.ts`, so it doesn't close a loop either. No real cycle
   found anywhere in this SCC. No change made.

**Net result:** no code changes from this phase. The verification itself is
the deliverable - it rules out 6 non-issues that would otherwise have
invited unnecessary, risky restructuring, and narrows the one real
architectural smell to a single, precisely-scoped, low-urgency follow-up
(item 6 above).

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
