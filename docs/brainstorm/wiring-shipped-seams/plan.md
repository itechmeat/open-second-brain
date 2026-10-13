# Wiring shipped seams - implementation plan

Executed by the implement node with PARALLEL IMPLEMENTATION LANES. Lane 3 lands its contract commit first; lanes 1, 2, 3 and 4 then run concurrently over disjoint files; the integrator finishes. Every task is atomic and commit-sized. Every opt-in surface is default off with a byte-identical-off regression proof; failures are typed named errors, never silent fallbacks; no new MCP tools, no new continuity record kinds, no new external dependencies.

## Cross-lane contract

### (a) File ownership - every file has exactly one owner; overlap forbidden

- **Lane 1** (per-source-session pool cap, t_bb6ce095): `src/core/search/pipeline/session-pool-cap.ts` (new), `src/core/search/pipeline/assemble.ts`, `src/core/search/types.ts`, `src/core/search/index.ts`, `src/core/search/pipeline/cache-slot.ts`, `src/core/search/query-cache.ts`, `src/core/search/retrieval-trail.ts`, `tests/core/search/session-pool-cap.test.ts` (new), `tests/core/search/pool-total.test.ts`, `tests/core/search/retrieval-trail.test.ts`, `tests/core/search/config.test.ts`.
- **Lane 2** (usage-ordered skill offers, t_5d1ec8a8): `src/core/brain/skill-usage.ts`, `src/core/surface/skill-attach.ts`, `src/core/config.ts`, `src/mcp/skill-tools.ts`, `tests/core/brain/skill-usage.test.ts`, `tests/core/surface/skill-attach.test.ts`, `tests/core/surface/skill-attach-decision.test.ts`, `tests/mcp/skills-attach-tool.test.ts`, `tests/mcp/skills-attach-decision-tool.test.ts`.
- **Lane 3** (seeded LongMemEval sampling, t_4501c662): `src/core/bench/longmemeval-sample.ts` (new), `src/core/bench/longmemeval.ts`, `src/core/bench/types.ts`, `src/core/bench/phases.ts`, `src/core/bench/run-store.ts`, `src/cli/brain/verbs/bench.ts`, `src/cli/command-manifest.ts` (append-only), `src/cli/brain/help-text.ts` (append-only), `tests/core/bench/longmemeval-sample.test.ts` (new), `tests/core/bench/longmemeval.test.ts`, `tests/core/bench/run-store.test.ts`, `tests/core/bench/phases.test.ts`, `tests/cli/brain-bench.test.ts`. `tests/core/bench/locomo.test.ts` and the committed sample fixtures under `tests/fixtures/bench/` are FROZEN and must stay green untouched.
- **Lane 4** (OpenCode V2 config shape, t_68ae8a53): `src/core/install/jsonc.ts` (new), `src/core/install/adapters/opencode.ts`, `src/core/doctor-readiness.ts`, `tests/core/install/jsonc.test.ts` (new), `tests/core/install/adapters/opencode.test.ts`, `tests/core/doctor-readiness.test.ts`, `tests/cli/bootstrap.test.ts`, `tests/cli/install-json-shape.test.ts`. `plugins/opencode/open-second-brain.ts` and `src/core/runtime/host-facts.ts` are FROZEN for the wave.
- **Integrator**: docs pages (`docs/cli-reference.md`, `docs/how-it-works.md`, `docs/mcp.md`, `docs/observability.md`, `install/opencode.md`, `docs/updating.md`, `README.md` plus `plugins/codex/README.md` via `bun run sync-plugin-mirrors`), `CHANGELOG.md`, `package.json` plus the manifests synced by `scripts/sync-version.ts` (minor bump), census reconciliation. No lane-owned source files.

### (b) The one shared file and its append-only split

- `src/cli/brain/verbs/bench.ts`: Lane 3 owns the file. Lane 1 holds append-only rights strictly limited to one entry in the `BENCH_PIN_NESTED_KEYS.recall` list (the `poolMaxPerSession` knob name), exercisable only after Lane 3's contract commit (L3-T1) has landed. No other region of the file may be touched by Lane 1.

### (c) Pure modules each lane produces, and what waits on them

- Lane 1 produces `src/core/search/pipeline/session-pool-cap.ts` (pure: ranked rows plus a frontmatter cache in, capped rows plus a drop count out; no clock, no fs beyond the passed cache). It is lane-internal; nothing else waits on it.
- Lane 2 produces the pure `skillUsageWeights(usage, knownNames)` export in `src/core/brain/skill-usage.ts` (usage rows plus discovered names in, weight map out; no clock - nowMs arrives inside `usage`). It is lane-internal; nothing else waits on it.
- Lane 3 produces `src/core/bench/longmemeval-sample.ts` (pure: entries plus seed and cap in, selected entries plus a receipt fragment out; own PRNG, no Math.random, no wall clock, no fs). Lane 1's append-only right waits only on L3-T1 (the bench verb contract), not on this module.
- Lane 4 produces `src/core/install/jsonc.ts` (pure: text in, spliced text out, or a named `JsoncEditError`; no fs). It is lane-internal; nothing else waits on it.

### (d) Ordering and the dependency-wait rule

Lane 3 commits L3-T1 first, before any other lane-3 task and before lane 1 needs the bench file. Lane 1's L1-T4 is its final task: if L3-T1 has not landed when lanes 1-3 of lane 1 are done, lane 1 writes the failing pin test against the documented key list (it fails on the missing entry, which is the expected failure), then polls `git log -- src/cli/brain/verbs/bench.ts` every 30 s for up to 12 min; after 30 min of waiting in total, escalate to the orchestrator instead of inventing the surface. Lanes 2 and 4 depend on nothing and start immediately.

### (e) House rules

- Strict TDD: write the failing test first, run it, watch it fail with the expected error, then implement; refactor only with all tests green.
- One conventional commit per task (`feat(search): ...`, `feat(skills): ...`, `feat(bench): ...`, `feat(install): ...`); never bundle two tasks.
- Stage files by name; never `git add -A` or `git add .`; commit with `git commit --only <paths>`.
- Format and lint your own files before every commit; a green formatter and linter are a commit precondition, not end-of-PR cleanup. If the formatter touches files outside your lane, surface it instead of folding it in.
- Run tests with a throwaway HOME: `env HOME=$(mktemp -d) bun test <paths>`.
- Byte-identical-off proofs compare full serialized outcomes against frozen fixtures; a mode-on-but-inert comparison (knob on, no session-ref notes, empty usage vault, sample cap at the population) is part of every byte-identical test.
- Subprocess-spawning tests get explicit 20000 ms budgets; bun's default per-test budget is 5000 ms; order-dependent assertions use sorted listings.
- Hoist repeated literals into named constants; never name a variable anything secret-shaped; docs prose uses the full product name, no exclamation marks.

## Lane 1 - per-source-session pool cap (t_bb6ce095)

### Task L1-T1: Pure session-pool-cap module
- **Files**: `src/core/search/pipeline/session-pool-cap.ts` (new), `tests/core/search/session-pool-cap.test.ts` (new)
- **Seams**: frozen `BrainSearchResult` rows per the `res()` helper pattern in tests/core/search/mmr.test.ts:16-33; `readCachedFrontmatterEntry` (src/core/search/result-filters.ts:60) and `CachedFrontmatter.unreadable` for the read verdict; the `duplicateKey` null pass-through precedent (src/core/search/pipeline/assemble.ts:144-147).
- **Test-first steps**: build a frontmatter cache over temp notes where several paths share a `session_ref`; assert rows keep ranked order, the first `capPerSession` rows per key survive, the rest are dropped and counted; assert rows with `session_id` only group by it; assert no-identity rows and unreadable-frontmatter rows pass through uncapped; assert a non-string or empty frontmatter value counts as absent; assert the function is pure (same inputs, same outputs, no cache mutation beyond reads).
- **Done criteria**: the module exports the cap function and a result carrying results plus `dropped`; every grouped, uncapped and unreadable case above passes; the module imports only from `../result-filters.ts` and `../types.ts` (no upward edges, import-cycles ratchet green).
- **Depends on**: none

### Task L1-T2: Config plumbing exactly like search_mmr_lambda
- **Files**: `src/core/search/types.ts`, `src/core/search/index.ts`, `src/core/search/pipeline/cache-slot.ts`, `src/core/search/query-cache.ts`, `tests/core/search/config.test.ts`
- **Seams**: `DEFAULTS` block (index.ts:264-298, `mmrLambda: 0.7` at :276); the `parseFloat01(envOrConfig(...))` parse at :1182-1186 becomes the pattern for a `parseInteger(envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_POOL_MAX_PER_SESSION", "search_pool_max_per_session"), ...)` parse; `validateResolvedConfig` (index.ts:629) gains the integer-range line; the spread-omission pattern at index.ts:1175-1178 (`relationalRerankPin`); `ResolvedRecallConfig` (types.ts:1540-1542); `SearchOptions.mmrLambda` (types.ts:919) as the per-query override pattern; `configFingerprint` (cache-slot.ts:279-300, `mmr: r.mmrLambda` at :284); the per-query cache key (query-cache.ts:124).
- **Test-first steps**: a failing config test resolves the knob from an env var and from a `_brain.yaml` key, pins the default 0, pins the range refusal for a negative value through `validateResolvedConfig`, pins the resolved field ABSENT at 0 and present at a positive value (exact-shape assertion), and pins both fingerprint folds (a knob change invalidates cached rows: fingerprint string differs; per-query key differs when the override is set).
- **Done criteria**: config tests green; `ResolvedRecallConfig.poolMaxPerSession?` and `SearchOptions.poolMaxPerSession?` documented with doc comments naming the off value; existing exact-shape resolved-config tests untouched and green.
- **Depends on**: none

### Task L1-T3: Assemble wiring - widen, cap phase, drop note, byte-identical off
- **Files**: `src/core/search/pipeline/assemble.ts`, `src/core/search/retrieval-trail.ts`, `tests/core/search/session-pool-cap.test.ts`, `tests/core/search/pool-total.test.ts`, `tests/core/search/retrieval-trail.test.ts`
- **Seams**: the widening disjunction and `Math.max` composition (assemble.ts:249-257); the phase order merge, traversal, floor (:330-338), MMR (:339-342), relevance rerank (:346-348); the assemble result fields (`floorDropped` at :353) and `noteAssemblyNarrowings` (:404-430); the degradation code family (retrieval-trail.ts:159-189, `relevanceFloorDroppedRows` shape); the full-pipeline harness in tests/core/search/pool-total.test.ts:16-45 (`createTempVault`/`makeConfig`/`writeMd` from tests/helpers/search-fixtures.ts, `indexVault`, then `search()`).
- **Test-first steps**: failing test one - a vault where one `session_ref` covers enough notes to fill the window: knob off returns today's crowded order byte-for-byte against a frozen fixture; knob on spreads the window across sessions and reports the new `source-session-capped-rows` degradation with `detail.dropped`; failing test two - the widened pool: with the cap on, `rankLimit` joins the widening composition so a `crossEncoderActive` query keeps its `topK` guarantee; failing test three - no-identity vaults (ordinary notes only): knob on is byte-identical to knob off and adds zero frontmatter reads' worth of behavioral difference; failing test four - the degradation note is emitted once per answer, and the backfill still fires exactly when it does today (the cap never triggers a second assemble, pinning the design decision that `wideCap` cannot exceed the widened `rankLimit`).
- **Done criteria**: the cap runs after the floor and before MMR; drops carry the new code beside `relevance-floor-dropped-rows`; the off path is byte-identical on the full-pipeline fixture; every pre-existing search test passes untouched.
- **Depends on**: L1-T1, L1-T2

### Task L1-T4: Bench pin entry (the wave's one append-only right)
- **Files**: `src/cli/brain/verbs/bench.ts` (append-only: one entry in `BENCH_PIN_NESTED_KEYS.recall`), `tests/cli/brain-bench.test.ts` is lane 3's - lane 1 asserts the pin acceptance through the exported validator or a lane-local test importing the key list.
- **Seams**: `BENCH_PIN_NESTED_KEYS.recall` (src/cli/brain/verbs/bench.ts:176+) already lists `mmrLambda`, `maxHops` and siblings; a `--pin '{"recall":{"poolMaxPerSession":N}}'` is refused until the name joins the list.
- **Test-first steps**: a failing test pins that the knob name is accepted in a recall pin (and a bogus name still refused), then add the single list entry.
- **Done criteria**: the pin accepts the knob; the bench pin identity guard tests stay green; no other line of the bench verb touched.
- **Depends on**: L1-T3, and L3-T1 (contract commit) must have landed

## Lane 2 - usage-ordered skill offers (t_5d1ec8a8)

### Task L2-T1: Usage map builder with the name-normalization rule
- **Files**: `src/core/brain/skill-usage.ts`, `tests/core/brain/skill-usage.test.ts`
- **Seams**: `deriveSkillUsage` (skill-usage.ts:105-149) and `SkillUsage.weight` in (0, 1]; the store keying on the raw `payload["skill"]` string (skill-usage.ts:88); the plugin-qualified arrival path (`resolveInvokedSkill`, src/core/brain/sessions/import.ts:883-897, returns the `Skill` tool's command string unmodified).
- **Test-first steps**: failing test - `skillUsageWeights(usage, knownNames)` joins exact names first; a usage key `open-second-brain:codegraph-partner` joins discovered `codegraph-partner` through the suffix-after-colon rule (longest matching suffix wins when several colons exist); keys matching nothing are dropped and the docblock states the rule; the map values are the decay weights unchanged; an empty usage list yields an empty map.
- **Done criteria**: the helper is pure, exported beside `deriveSkillUsage`, its docblock documents the join rule and the drop; existing skill-usage tests pass untouched (no record rewriting anywhere).
- **Depends on**: none

### Task L2-T2: The composite fold in rankSkillCandidates and the amended invariants
- **Files**: `src/core/surface/skill-attach.ts`, `tests/core/surface/skill-attach.test.ts`
- **Seams**: `BuildSkillAttachmentOptions` (skill-attach.ts:48-62); the `Pick` in `rankSkillCandidates` (skill-attach.ts:120); the floor filter at :127 and the invariant comment at :126; the module docblock at :4-8; the local structural input shape (no core/brain import - the import-cycles ratchet counts `import type`); the stable-output tie-break convention (skills.ts:198, skill-usage.ts:147).
- **Test-first steps**: failing test - with `usageWeight` absent, output order and content are byte-identical to today's fixture (the off proof); with a map present, a lexically slightly-hotter one-off drops below a daily-used skill under the composite `score * (1 + SKILL_USAGE_ORDERING_MAX_BOOST * weight)` with the constant at 0.5; equal composites resolve by name ascending; a non-matching skill can never cross the discriminating-term floor regardless of weight; the returned `score` field stays the lexical score; the composite ordering is deterministic across repeated calls.
- **Done criteria**: ordering tests green; the docblock at :4-8 and the comment at :126 amended in the same commit to state the gated contract (absent usage input, ranking stays the scorer's); the constant exported with its rationale; every pre-existing skill-attach test passes untouched on the off path.
- **Depends on**: none (the map shape is a local `ReadonlyMap<string, number>`; L2-T1 is lane-internal sequencing, not a blocker)

### Task L2-T3: Config flag and per-turn tool wiring
- **Files**: `src/core/config.ts`, `src/mcp/skill-tools.ts`, `tests/mcp/skills-attach-tool.test.ts`
- **Seams**: `resolveConfigFlag`/`isFlagOn` (config.ts:779-786) and the resolver family (:795-811); `toolSkillsAttach` (skill-tools.ts:164-187): the gate at :170, triggers at :173, discovery at :174, both build calls at :177 and :179-186; the tool description string (:229-231).
- **Test-first steps**: failing test - `resolveSkillsAttachUsageOrdering` reads env and `_brain.yaml` key `skills_attach_usage_ordering`, default off; with the flag off, `skills_attach` output is byte-identical on a vault with usage records (off proof at the tool level); with the flag on and usage records present (append `skill_invoked` records via the test helper in tests/core/brain/skill-usage.test.ts:23-28), the offer reorders per the composite, offer_id recomputed over the rendered order; with the flag on and an empty vault, the offer is byte-identical to off (mode-on-but-inert); `deriveSkillUsage` is called exactly once per attach call when on and zero times when off (assert through a module-level counter or spy).
- **Done criteria**: flag resolver beside its siblings with the same docblock posture; the tool passes the same map to both build paths; the tool description mentions the ordering knob in one clause; pre-existing skills-attach tool tests green.
- **Depends on**: L2-T1, L2-T2

### Task L2-T4: Decision-model coherence
- **Files**: `tests/mcp/skills-attach-decision-tool.test.ts`, `tests/core/surface/skill-attach-decision.test.ts`
- **Seams**: `buildSkillAttachmentWithDecision` (skill-attach-decision.ts:243+): the BM25 baseline via `buildSkillAttachment` (:246), the shortlist via `rankSkillCandidates` (:257), inheritance through `DecisionSkillAttachmentOptions` (:117), the `deterministic_offered`/`deterministic_offer_id` record fields (:293-294).
- **Test-first steps**: failing test - with the flag on, the decision path's shortlist and its deterministic fallback offer reflect the same usage map (the deterministic record matches what deterministic mode would have offered); with the flag off, decision-path output is byte-identical to today's fixture; a fixture pinning an offer id pins the usage input and nowMs with it.
- **Done criteria**: both modes coherent on one map; pre-existing decision tests green; no changes to skill-attach-decision.ts source required (options inheritance carries the input) - if implementation finds otherwise, the change stays inside lane 2's file list after orchestrator sign-off.
- **Depends on**: L2-T3

## Lane 3 - seeded LongMemEval sampling (t_4501c662)

### Task L3-T1: Contract commit - loader options, capability, CLI flags, refusals
- **Files**: `src/core/bench/types.ts`, `src/cli/brain/verbs/bench.ts`, `src/cli/command-manifest.ts` (append-only), `src/cli/brain/help-text.ts` (append-only), `tests/cli/brain-bench.test.ts`
- **Seams**: `BenchSuiteRegistration`/`BenchSuiteLoad` (types.ts:176-196); the registry entries (bench.ts:55-81) and `registerBenchSuite` compatibility (:84-92); the capabilities precedent `{ embeddings: boolean }`; the `--recall-floor` trace: parse spec (:292-300), `parseRecallFloorFlag` (:279-288), threading into `runMemoryBench` (:338-352); the USAGE string (:29-31); the report printer (:365-376); fixture path resolution (:386-391).
- **Test-first steps**: failing CLI tests - `--sample-seed` alone is refused by name; `--sample-cap` alone is refused by name; a non-positive or non-integer cap is refused naming the value; both flags together with a suite whose capabilities lack `sampling: true` (locomo, surfacing-replay, no-suite default) are refused naming the suite; both flags with `--suite longmemeval` reach a stub loader registered through `registerBenchSuite` carrying `BenchSuiteLoadOptions { sample: { seed, cap } }`; omitting both flags leaves today's CLI behavior byte-identical (existing brain-bench assertions untouched, including `quality.total === 6` on the tiny fixture); a third-party registration without the capability still registers and loads unchanged (the loader's second parameter is optional).
- **Done criteria**: the type surface (`BenchSuiteLoadOptions`, `capabilities.sampling`) and the flag pair land with all refusal paths named; the registry's three built-in entries updated (longmemeval `sampling: true`, others false); the USAGE and help-text strings name the flags; pre-existing CLI tests green untouched.
- **Depends on**: none (this is the wave's contract commit and must be lane 3's first)

### Task L3-T2: Pure stratified sampler module
- **Files**: `src/core/bench/longmemeval-sample.ts` (new), `tests/core/bench/longmemeval-sample.test.ts` (new)
- **Seams**: `LongMemEvalEntry` and `isLongMemEvalAbstention` (longmemeval.ts:116-131, 163-170); `LONGMEMEVAL_QUESTION_TYPES` (:201-204); the `entry()` population builder pattern (tests/core/bench/longmemeval.test.ts:38-54); `canonicalJson` + `sha256Hex` (src/core/integrity/digest.ts); the named-error convention (`LongMemEvalParseError`, longmemeval.ts:149).
- **Test-first steps**: failing tests - abstention entries (both spellings) are excluded before selection and their count flows through; strata are the distinct present `question_type` values sorted ascending; largest-remainder apportionment of the cap proportional to population is exact (sum equals the cap when the population allows), clamped to the population, remainder ties broken by stratum name; the same seed and cap select the same subset twice and across calls (no Math.random, no wall clock - assert by selecting under differing fake clocks if the module takes none at all); a different seed or cap selects a different subset; dataset FILE ORDER cannot change the subset (shuffle the input array, same selection); a cap at or above the population selects everyone; a zero population after abstention exclusion raises the named `LongMemEvalSampleError`; the receipt fragment carries per-stratum population and selected counts.
- **Done criteria**: the module is pure, network-free, imports no fs, exports the sampler plus the receipt type plus the named error; every determinism and edge case above passes; the egress and verdict-vocabulary censuses stay green.
- **Depends on**: none for the module itself (L3-T1 for the types it references if declared there; declare the sampler's own option and result types in the sampler module to keep this independent)

### Task L3-T3: Loader wiring and receipt
- **Files**: `src/core/bench/longmemeval.ts`, `src/core/bench/types.ts`, `tests/core/bench/longmemeval.test.ts`
- **Seams**: `loadLongMemEvalFixture` (longmemeval.ts:648-658); the conversion receipt (`abstention_excluded` at :139-142, :644); `BenchSuiteReceipt` (types.ts:182-185); the report family field (`abstention_excluded: number | null`, types.ts:281) and its print site (bench.ts:371-375).
- **Test-first steps**: failing tests - the no-options loader path returns today's fixture and receipt byte-identically (frozen assertion); with `sample` options, abstention is excluded first, the sampler runs on the survivors, the selected entries convert, the receipt carries `sample_population`, `sample_selected` and `sample_strata` beside `abstention_excluded`; an end-to-end `runMemoryBench` with sampling over a synthetic dataset (explicit 20000 ms budget) reports the sampled count through the longmemeval family and the CLI line.
- **Done criteria**: sampling provably happens pre-conversion (the converted fixture's question count equals the sampled count); receipt fields mirror the abstention precedent; unset options leave every existing longmemeval test green untouched.
- **Depends on**: L3-T1, L3-T2

### Task L3-T4: Run identity and checkpoint fold
- **Files**: `src/core/bench/phases.ts`, `src/core/bench/run-store.ts`, `src/core/bench/types.ts`, `tests/core/bench/phases.test.ts`, `tests/core/bench/run-store.test.ts`
- **Seams**: `BenchRunOptions.recallFloor` and the named pre-run refusal (phases.ts:99-111, 214-221); the identity fold (:223-234); `benchRunIdentityHash` (run-store.ts:49-61) and create/load opts (:73-100, 102-138); the resume guard (:117-136); `BenchCheckpoint` (types.ts:360-374, `pinned_knobs` precedent).
- **Test-first steps**: failing tests - the canonical identity record spreads `sample` in ONLY when sampling is set, so a no-sampling run's id equals the pre-change id byte-for-byte (pin the hash against a frozen value); two runs differing only in seed, or only in cap, get different run ids even when both fixtures are identical (cap at the population); a resumed run whose sampling options changed fails the identity guard with the existing named error; the refusal fires before any run state exists when options are invalid at the phases layer.
- **Done criteria**: identity, checkpoint and refusal tests green; the identity guard's loud-failure docblock updated to name sampling options among the guarded inputs; pre-existing run-store and phases tests green.
- **Depends on**: L3-T1, L3-T2, L3-T3

## Lane 4 - OpenCode V2 config shape (t_68ae8a53)

### Task L4-T1: Vendored minimal JSONC editor
- **Files**: `src/core/install/jsonc.ts` (new), `tests/core/install/jsonc.test.ts` (new)
- **Seams**: the plain-JSON round-trip it must not regress (src/core/install/json-merge.ts:44-102, BOM strip at :91, indent sniffing at :119-126); the leaf-module discipline and import-cycles ratchet; the atomic write path (src/core/fs-atomic.ts) stays the caller's concern - the editor transforms text only.
- **Test-first steps**: failing tests - the tokenizer parses JSONC with line comments, block comments, strings containing comment-like content and escapes, trailing commas; a comment-free file round-trips byte-identically through the editor's read; inserting one entry under a nested object splices at token offsets and leaves every comment and the file's formatting outside the splice untouched (byte-compare the untouched regions); replacing an existing entry splices exactly its value range; removing an entry closes the hole without disturbing neighbors; duplicate top-level keys raise the named `JsoncEditError` mentioning the key; a BOM is stripped on read and restored on write; malformed input raises the named error rather than emitting partial text.
- **Done criteria**: the editor is pure text-in/text-out with one named error type; the test matrix above passes; no new dependency in package.json; import-cycles green (the module imports nothing from src/).
- **Depends on**: none

### Task L4-T2: Adapter shape detection, `.jsonc` path, JSONC-aware writes, verify symmetry
- **Files**: `src/core/install/adapters/opencode.ts`, `tests/core/install/adapters/opencode.test.ts`, `tests/cli/install-json-shape.test.ts`
- **Seams**: `configPath` (opencode.ts:44-46) and `legacyConfigPath` (:48-50); `migrateLegacyMcpJson` (:72-95) as the migration template; `serializeOpencodeEntry` (:58-65); the `createJsonMcpAdapter` base with `topLevelKey: "mcp"` (:116-124) and its apply/verify/uninstall body (_json-mcp.ts:314-418, verify reconstruction :429-525); the user-modified-block guard (_json-mcp.ts:328-351); `owned_keys` (`${topKey}.${KEY}`, :374); the test harness (tests/core/install/adapters/opencode.test.ts:31-83, the legacy-migration describe block :190-239, the conflict aged via `utimesSync` in tests/cli/bootstrap.test.ts:714+).
- **Test-first steps**: failing tests - shape detection: a config carrying an `mcp.servers` object (with or without our entry) targets `mcp.servers`; a config without it targets top-level `mcp` (today's behavior byte-identical on a V1 fixture, the off proof); both apply and verify derive the shape from the same function, so a fresh V2 install verifies clean against itself (apply then `--check` equivalent reports no drift); the manifest records `owned_keys: ["mcp.servers.<entry>"]` for a V2 write and uninstall removes exactly that key; when only `opencode.jsonc` exists it is the resolved config path and edits preserve its comments (build a JSONC fixture with header and inline comments, apply, assert the comments survive byte-for-byte and our entry landed under `mcp.servers`); duplicate top-level keys surface the named `JsoncEditError` as an apply refusal naming the file; a V1 install with an existing top-level entry is NOT migrated when `mcp.servers` appears without operator re-apply until the next apply, and that first re-apply after the shape change reports the documented one-time drift through the existing guard behavior; the legacy `mcp.json` migration is untouched and green.
- **Done criteria**: V1 fixtures byte-identical through apply/verify/uninstall; V2 fixtures get native-shape registration with comments preserved; verify symmetric with apply by construction; manifest, uninstall and the plan notes shape-aware; the existing opencode adapter suite green plus the new cases.
- **Depends on**: L4-T1

### Task L4-T3: Doctor registered-command probe learns the nested key
- **Files**: `src/core/doctor-readiness.ts`, `tests/core/doctor-readiness.test.ts`
- **Seams**: `JSON_MCP_TOP_LEVEL_KEYS = ["mcpServers", "mcp"]` (doctor-readiness.ts:641) and `extractFromJsonConfig` (:888-922); the existing opencode extraction test (doctor-readiness.test.ts:521-539); `probeRegisteredCommands` (:723-777).
- **Test-first steps**: failing test - a config with our entry only under `mcp.servers` is extracted and probed exactly as a top-level entry is today (command, args, environment); the dotted key joins the key list without changing the flat keys' behavior (existing tests green untouched); a config with neither shape still reports the current skipped wording.
- **Done criteria**: a healthy V2 install passes `o2b doctor`'s registered-command probe; the flat-key behavior is pinned unchanged; pre-existing doctor tests green.
- **Depends on**: none for the probe logic (L4-T2 for the end-to-end story; the test can be written immediately)

## Integration

### Task INT-T1: Integration gate - censuses, docs, version, full local gates (integrator)
- **Files**: `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/mcp.md`, `docs/observability.md`, `install/opencode.md`, `docs/updating.md`, `README.md` plus `plugins/codex/README.md` via `bun run sync-plugin-mirrors`, `CHANGELOG.md`, `package.json` plus the manifests synced by `scripts/sync-version.ts`, census registration fixes
- **Acceptance**: the CI validate job's gates pass locally in CI order on the merged branch: format check, lint, the full test suite with a throwaway HOME, and manifest version sync (`sync-version.ts --check`, minor bump with the CHANGELOG entry and its compare link reference inside this pull request). Docs carry: the new config key row and env var beside `search_mmr_lambda` (cli-reference.md:2388 pattern) and the how-it-works ranking paragraph (:1234); the `skills_attach_usage_ordering` key in the docs/mcp.md opt-in list (:1218-1227 pattern) with the normalization and cost notes; the bench flags in cli-reference.md:571-576 and observability.md:223 with the sampling semantics and the resume-guard consequence; install/opencode.md V2 shape and the docs/updating.md one-time drift note following the 1.50.0 convention; the README release paragraph plus the mirror sync. Census pins green: host-facts 10-target equality, write-site and destructive-site censuses, continuity reader/envelope censuses, import cycles, the tool ceiling; `tests/core/bench/locomo.test.ts` and the committed fixture hashes untouched. The CHANGELOG entry names each knob, flag, env var, default and the byte-identical-off guarantee with a trailing Docs bullet enumerating every doc file touched.
- **Depends on**: L1-T1 through L4-T3
