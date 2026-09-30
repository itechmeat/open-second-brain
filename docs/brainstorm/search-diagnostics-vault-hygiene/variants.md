# Variants and settled decisions - search/diagnostics/vault-hygiene wave

**Status:** audit trail (phase 0, step 9)
**Scope source:** the operator chose the full union of three cuts (16 cards) with the wave spine "the brain does not lie, does not stay silent, and does not rot". No external CLI consultant ran for this wave: the variant space came from the three premise-verification reports (live file:line evidence, re-verified 2026-09-30 against worktree HEAD 79a71dad), which supersede the validator comments on the cards. Every open decision below was settled against that evidence; the losing options are recorded with the reason they lost.

---

## 1. Pin surface for the ranking signal (t_f7bef96a)

The premise report corrected both the card and the validator: `src/core/brain/pinned.ts:10` is the ONE curated context file (`PinnedContext`), and the per-note `pinned` flag exists only for preference notes (`parsePinned`, `src/core/brain/preference.ts:1696`, hard default false) and never reaches ranking.

- **Variant A - preference-note flag only.** Reuse `parsePinned`; boost only pref-namespace pages. Zero vocabulary change, but the ranking semantics would be welded to one namespace for no mechanial reason.
- **Variant B - new general frontmatter token on every Brain note.** Semantically the "real" per-note pin, but it mints schema vocabulary nobody writes yet: the boost would be dead code until the schema-author lane adopts the token.
- **Variant C - `Brain/pinned.md` as a seed list.** No frontmatter change, but pinned.md is agent-curated free text; parsing paths out of it is fragile and conflates "context included in prompts" with "operator wants this surfacing".
- **Variant D - drop the pinned half.** Possible, but the wiring is small and the flag carries real operator intent today.

**Settled: A, generalized mechanically.** The indexer reads the `pinned` frontmatter field wherever present (exporting the preference parser's coercion rather than duplicating it), persists it in `documents.pinned`, and the ranker boosts it as a bounded always-on layer (`PINNED_BOOST_CAP = 0.05`, reinforce pattern). Today only preference notes carry the flag, so behavior is identical to Variant A; if other namespaces adopt the token later, the ranking picks it up with no further work - and that adoption is a schema-author decision, deliberately not made here. Revision-stability is OUT per the operator (no per-note revision signal exists; `INDEX_REVISION_STATE_KEY` is index-level).

## 2. `?`-sentinel fix mechanism (t_2fbdaf70)

The bug: `NULL_FIELD = "?"` (`src/core/search/embeddings/signature.ts:25`, null branches :39-40) makes two unknown-identity configs render identical signatures, so signature-equality treats them as compatible.

- **Variant A - make the rendering unique per instance.** Breaks determinism: signatures must be stable across processes for staging resume and state comparison; a per-instance discriminator would make every resume rebuild.
- **Variant B - keep the rendering, fix the equality layer.** Export `signatureIdentityKnown(sig)`; unknown identity is never compatible with anything, including another unknown. The staging consumer renders an unknown-identity component as a non-resumable marker (rebuild, never resume). Deterministic, honest, testable.
- **Variant C - flip the default to unknown-is-incompatible everywhere (the card's ask).** The premise ruled this wrong for this tree: `embedding_abi: warn` is a reasoned default (`src/core/brain/policy/blocks/integrity.ts:66-70` - vec_version is not stable across environments and refusing risks a rebuild loop on synced vaults).

**Settled: B.** Consumers decide warn vs refuse per the standing `embedding_abi: warn` default; the equality layer simply stops lying. The named->null model transition gets a warning line (visible, not silent) and never clears - under the new verify-before-replace gate's own logic, rebuildability cannot be verified with no model configured, so the clear must not happen.

## 3. Verify-before-replace gate shape (t_2fbdaf70)

- **Variant A - gate only on chunks-row presence.** Catches the empty-corpus case but not a provider that cannot compute embeddings.
- **Variant B - gate on chunks presence AND provider capability.** Reuses `resolveSemanticCapability` (the resolver `vector-backfill.ts:116` already uses) - a blocked tier cannot rebuild, so the clear is refused.
- **Variant C - run a dry-run backfill as the gate.** Most faithful to "verify", but it duplicates vector-backfill's job inside the clear path and turns a cheap decision into an expensive probe.

**Settled: B.** The gate asserts what is cheaply provable (source material exists, provider can compute) and refuses by name; the rebuild itself remains vector-backfill's dry-run-default job.

## 4. Maintenance "errored" exit number (t_9d155d0e)

The lane's rows already distinguish `timed_out` / `refused` / `error`; the verb collapses every attempted failure into `failed: 1` (`maintenance.ts:377-381`).

- **Variant A - fresh number 8 for "errored".** Fragmenting: the maintenance docblock (:60-84) explicitly anchors 6 as "the probe could not find out" across `DOCTOR_EXIT` and `SEARCH_CHECK_EXIT`, and 7 as "the run found out precisely" - a safeguard timeout is the textbook 6 case (the task was killed mid-run; its outcome is unmeasurable).
- **Variant B - reuse 6, member named `probeIncomplete`.** One vocabulary, no new numbers, and the docblock's own reasoning extends verbatim. Deterministic task failures stay 1 (a proved failure).
- **Variant C - no change; keep collapsing into 1.** The card's honest-reporting point lost: a nightly cron cannot distinguish "a pass is broken" from "a pass was killed by its safeguard and the outcome is unknown".

**Settled: B.** Precedence `failed(1) > probeIncomplete(6) > refused(7) > ok(0)`: an attempted-but-unmeasured pass outranks a refusal (something ran); a proved failure outranks both. Wave table: 5 = proved unreachable, 6 = probe/run incomplete, 7 = refusal - no new numbers anywhere this wave (the self-test harness reuses `DOCTOR_EXIT` for the same reason).

## 5. Composite hybrid deadline default and behavior (t_bdc24171)

- **Variant A - upstream's 8s default.** Sits BELOW OSB's own 10s embedding budget, so the deadline would fire before the embed lane's timeout and quietly become the effective embed timeout - two knobs racing.
- **Variant B - 15000 default (= embed 10s + rerank 5s).** Normal paths never reach it; both budgeted lanes keep their own earlier timeouts; the deadline bounds exactly what is genuinely unbudgeted (semanticTopK, the second-pass coverage retry) and pathological sums.
- **Variant C - default off.** Dead-by-default protection; the failure mode (host hook timeout) hits users who never tuned anything.
- **Behavior on expiry:** error (breaks the degrade-don't-stall invariant the tree already ships) vs keyword-only partials (byte-shaped like the provider-unavailable degrade, plus a typed code).

**Settled: B + keyword-only partials**, with `RETRIEVAL_DEGRADATION.hybridDeadlineExceeded` carrying `{ elapsedMs, budgetMs }`. The deadline spans embed -> semanticTopK -> rerank -> second pass, enforced at `search()` with plumbing through `pipeline/request.ts` over the AbortSignal seam that already threads the providers.

## 6. Lexical-vote definition and gate semantics (t_d9f863e9)

- **Vote definition:** (a) keyword lane returned >= 1 hit (pre-boost BM25 result non-empty) - simple, already in `RankerInputs`, matches "did any query term match the index"; (b) FTS match of any query term evaluated separately - re-derives what the keyword lane already computed. **Settled: (a).**
- **Gate semantics:** damp (proportional shrink) vs zero. **Settled: zero** - deterministic, explainable in one reason string ("gated: no lexical vote"), and it cannot half-apply differently across the nine layers.
- **Relational pin mechanism:** a second floor beside `minScore` (parallel mechanism - the premise warned against it) vs a protect rule at the cross-encoder hand-off (rerank may promote, never sink relational-origin candidates below their pre-rerank heuristic order). **Settled: the protect rule**, expressed through the existing `minScore` stage's site in `pipeline/assemble.ts`, leaving `minScore` itself untouched.
- **Defaults:** both guards config-gated OFF (`search_metadata_boost_gate`, `search_relational_rerank_pin`). The pins that must not move (`DEFAULT_KEYWORD_WEIGHT`, `FRESH_KEYWORD_ONLY_TOP_SCORE`, `BM25_LEAD`/`BM25_FLOOR`) are asserted by existing tests that stay green.

## 7. Near-duplicate report: seam, threshold, normalization (t_d30c0548)

- **Seam:** a third write-advisory (`adviseIncomingNote`, per-family log events) vs a `page-lint.ts` detector. **Settled: page-lint** - the report must be universal to note writes; page-lint already rides every MCP note receipt, never gates, and has the skip/truncate/exclusion pattern. The advisory shape stays where its log-event semantics belong.
- **Threshold mechanism:** config key vs named constant. `contradiction_jaccard = 0.5` (`policy/blocks/health.ts:54`) answers "same subject"; near-DUPLICATE claims near-identity. **Settled: `NEAR_DUPLICATE_JACCARD = 0.8` as a named constant** (the tree's dedup-adjacent defaults are deliberately high - `ENTITY_DEDUP_EMBEDDING_THRESHOLD = 0.92`), evidence carrying the score so tuning is informed; promoting it to config later is a one-line change if noise appears.
- **Candidate set:** all vault pages (unbounded per write) vs same directory + same scope bucket. **Settled: the bounded set** - deterministic, cheap, and the same-scope rule mirrors `adviseIncomingFeedback`'s bucket logic.
- **Body normalization:** the card's second half. **Settled: dropped.** No demonstrated-safe normalization set exists; every candidate (whitespace collapse, trailing-space trim, smart-quote folding) changes authored bytes that receipts, dedup and byte-stability tests pin; page-lint's scope is authored-content-only. A normalization half without a concrete defect is risk without a customer.

## 8. Hub-candidate design (t_23bd347d)

The premise report proposed a deterministic hub-selection rule and asked the design to adopt or reject it. Source reading confirmed every seam (`moc-audit.ts:104-121`, `src/core/graph/unique-match.ts:32`, `src/core/scope-key.ts:86`, `repair-lane.ts:150-157,218-222`, `inbox-drain.ts:43,173`), so it is adopted in full. The alternatives considered:

- **Trigger:** `brain capture` staging (pre-corpus; an edge there would dangle when the note is archived) vs the inbox-drain idea route (the moment the capture becomes a corpus page). **Settled: drain, apply-mode, idea route only.** Obligations and source-reference routes are excluded this wave - recorded as the extension point.
- **Hub selection:** title/vocabulary detection (moc-audit explicitly refuses it), degree-based tie-breaking among multiple hubs (makes the target depend on index state at drain time - breaks determinism/auditability), auto-creating a missing hub (`materializeClusterNotes`' gated job), vs the exactly-one structural rule. **Settled: structural pool (`isHubBody` shared with `auditMoc`) restricted to the routed page's scope bucket, decided by `resolveUniqueMatch`; zero hubs -> `skip-no-hub`, multiple -> `skip-ambiguous-hub`, unique -> candidate.** Ambiguity is surfaced, never resolved silently.
- **Strength tier:** reuse `explicitReference` with lower confidence (muddies a tier defined by textual mention) vs a new `areaMembership` tier between `sameTopicEvidence` and `inferred`. **Settled: the new tier** - area membership is structural evidence, stronger than opt-in inference, weaker than a textual mention.
- **Transport:** call `runRepairLane` directly at drain with apply (an ungated write - contradicts the lane's whole apply-gate discipline) vs persist candidates for the lane to consume. **Settled: append-only JSONL under `Brain/.state/`** (the internal machinery dir) that `o2b brain repair-lane` merges; refusals ride `collectedRefusals` verbatim. Zero new write paths; idempotence free from the lane's forward scan.

## 9. Tags detector scope (t_c8508241)

- **Fold into t_11ee559f vs standalone.** The validator recommended folding; the operator's handling rule keeps it standalone in this wave with the overlap recorded as a coordination note (t_11ee559f is not in this wave; the shared module becomes that task's input). **Settled: standalone.**
- **Where the shared regex lives:** export `TAG_RE` from `search/links.ts` (brain->search import direction risk) vs move `TAG_RE` + tag extraction to a new `src/core/tags.ts` both layers import. **Settled: the move** - the incumbent regex remains THE one definition (links.ts re-imports, `tests/core/search/links.test.ts` stays byte-green) and no new dependency direction is created.
- **Malformed half:** widen TAG_RE to the looser Obsidian rule (index-semantics change + reindex gate - does not ride a hygiene wave) vs hold the Obsidian-side rule in the detector and report the diff. **Settled: report the diff; TAG_RE not widened.**
- **Frontmatter `tags:` arrays:** in (different reader, "vault-wide" oversold) vs out. **Settled: out**, stated in the report header.
- **Default sweep:** the tags detector is registered but excluded from the default scan (noisy on loose-tag vaults, per the card) via the new `DEFAULT_SCAN_IDS` mechanism; slug-collisions (low-noise) joins the default sweep. One mechanism, two explicit policies.

## 10. Slug-collision detector decisions (t_7bad7ad8)

- **Premise refutation accepted:** there is no silent clobber (exclusive-create ladder + caller-named refusals), so the detector is informational (`severity: "info"`, `proposed_action: "review"`) - not a correctness gate.
- **Grouping scope:** vault-wide stem identity vs per-directory. **Settled: per-directory** - OSB never flattens paths on write, so cross-directory same-stem is not a collision and reporting it would be noise.
- **Lost-race `-2` pairs:** suppress (assume legitimate) vs report at info with mtimes in evidence. **Settled: report** - the detector cannot distinguish a lost race from an accidental duplicate; the operator decides.
- **Unicode folding as an extra edge case:** rejected - folding already lands as `topic.md` + `topic-2.md`, which the detector reports; touching `slugify` would break allocation regression tests.

## 11. Registered-command probe surfacing (t_3477c9e8)

- **Surfacing:** plain `doctor()` CheckResult (breaks the byte-stable contract + openclaw bundle import policing), readiness probe (carries pass/fail/skipped/unknown + per-probe budgets + the `DOCTOR_EXIT.probeIncomplete` wiring), or both. **Settled: readiness probe only.**
- **Bare-name stance:** fail when not on the doctor's PATH (false alarms - the client's spawn PATH may differ) vs unknown with detail. **Settled: unknown** - only a proves-absent absolute/relative/script path is a `fail`.
- **Grok's `bun run <repo path>`:** two finding classes (bun missing vs script missing) vs one class with detail. **Settled: one class**, detail distinguishes; `cliArgs` strips the `cmd /d /c` prefix.
- **`config_path: null` entries:** silence vs an explicit `skipped` verdict. **Settled: skipped** - nothing-to-probe is a verdict, not silence.
- **Machine-readable code:** none minted - this is a core-readiness finding, not a brain-doctor code, so the DIAGNOSTIC_SIGNALS/exit-census regime does not attach.

## 12. Dangling merged_into registration (t_ff8bb8a8)

- **Structural command vs exclusion row:** the census demands one of the two. A repair is a content judgement (re-point, un-merge, or restore the canonical), so no command can be named honestly. **Settled: exclusion row** with that reason.
- **Over-deep chains:** a second doctor code vs none. **Settled: none** - the DEPTH class already surfaces in `o2b brain lint`'s unresolved list; a doctor code would duplicate a visible finding.
- **Walk helper:** export `walkMergeChain` directly vs a purpose-built report function. **Settled: the report function** - `resolveCanonicalId`'s throw-based contract stays untouched for lint, and the check gets outcomes, not exceptions.
- **retired/ pages:** in scope - the pointer namespace is pref-/ret- (`page-id.ts:120`); excluding ret- would leave half the pointer population unaudited.

## 13. Self-test harness shape (t_c00cc548)

- **Readiness probe vs CLI verb.** A full store roundtrip is the heaviest probe imaginable; the per-probe timeout/`unknown` semantics would need a budget that defeats the design. **Settled: CLI verb `o2b doctor selftest`**, never imported by `doctor()` (bundle constraint).
- **Migration coverage:** the store's real migration path (what a user machine actually runs) vs a synthetic old-schema DB (a fixture that can drift from real migrations). **Settled: the real path.**
- **Concurrent writes:** always vs only when WAL is enabled. **Settled: always run, and report the mode actually measured** - `lifecycle.ts:74-96` downgrades on network filesystems, and a result that does not say which mode it measured overclaims.
- **Exit codes:** reuse `DOCTOR_EXIT` (0/1/6) - wave table, no new numbers.

## 14. Write-back contract audit shape (t_7c01bb39, check-only)

- **Per-adapter VerifyResult vs workspace-level probe.** Per-adapter multiplies by 11 registered adapters and requires extending the closed `VerifyStatus` union cross-adapter (guarded by the exhaustiveness check in `probeInstalledRuntimes`). **Settled: one workspace-level readiness probe** - the card's own open question (AGENTS.md only vs every adapter) dissolves at workspace level.
- **Verdict vocabulary:** file absent -> `skipped` (nothing installed is not a violation); present-without-gate -> `fail`; unreadable/symlink -> `unknown` (evidence about the probe, not the surface).
- **Gate contract:** semantic assertion (unverifiable) vs regex/keyword contract over the extracted managed block, worded in the `marker-writeback.ts:70` guardrail vocabulary so check and runtime refuse in the same words. **Settled: the latter.**
- **Symlink policy for reads:** refuse (upstream posture; the guard does not exist anywhere on this lane and is written here even though the write lane belongs to t_af5e252f).
- **Repair lane:** not built. The settled marker contract is recorded as t_af5e252f's input.

## 15. Event-time persistence decisions (t_9e1a4b3f)

- **Granularity:** per-document (every resolver input is document-scoped) vs per-chunk (a join for zero information). **Settled: per-document** - the premise answered the card's own open question.
- **What to store:** the resolved window under the full rung order (frontmatter validity > event anchor > null/mtime fallback), via a pure helper shared with the query-side resolver - not a re-implementation that could drift from what queries actually apply.
- **Census shape:** extend `StoreCounts` (changes a shape tests pin) vs a separate `eventTimeWindowCensus` helper beside it. **Settled: the separate helper** - `{ documents, declared, intersecting, mtimeFallback }`, one SQL aggregate, and the unmeasured bucket named rather than hidden.
- **Backfill:** eager (a full re-scan on migrate) vs lazy (bounds persist on each document's next content change). **Settled: lazy** - consistent with prior migrations and with the mtime+size fastpath the index already uses.

## 16. t_4bccd70a residue: feature or verdict

- **Plan the "move-following provenance" feature** (old->new log event at `noteLifecycle` apply + reader resolution through it): real but modest value; the reader half is a feature (the log's append-only history is honest today - a write event records the then-current path and does not become a lie when the file later moves), and it needs its own design (event kind, reader resolution, retention).
- **Record the narrowed verdict.** Chosen: the two self-healing halves (docId re-derivation, IndexEvidence staleness reporting) need nothing; the provenance half is deferred with its future shape written down (design.md). The `documents.reid_map` alternative is REFUSED - a schema change purely for provenance when docId re-derivation already keeps the index self-consistent.

## 17. t_5f7e0dcd: not planned

REFUTED - CJK-aware chunking shipped in v1.58.0 (commit 6f33c424, #197, 2026-09-26), two weeks after the card's triage; pinned by `tests/core/search/chunker-dense-scripts.test.ts`. Planning it would re-implement shipped behavior. The residual cost-surface half (`estimateTokens` chars/4 vs the already CJK-aware store census, `brain_token_impact`) is recorded as a future lane with its open decision (adopt the census's two-sided bound or a CJK-aware point estimate) - deliberately not widened into this wave.

---

## Consultant-note

The skill's default phase-0 flow (external CLI consultant producing three variants) was not run for this wave: the operator's scope decision fixed the variant space to the union of three premise-verified cuts, and every open decision above was settled against live-source evidence with the losing options recorded. This file is the audit trail that file exists for.
