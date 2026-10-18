# Actionable-now batch - seven verified upstream-inspired cards in one release: entity merge repair, destination write aggregate, cross-agent log catch-up, injection-hardened session lanes, numeric collation, OKF v0.2 export, Hermes entry point

**Status:** draft
**Author:** orchestrator (via feature-release-playbook, host mode)
**Audience:** implementation

## Problem statement

Seven actionable-now kanban cards (t_28a8789d, t_d8e7320f, t_3b44cd9a, t_ba04a81a, t_69fec179, t_ffdb4fac, t_dee22e5d; three at priority 4) passed read-only premise recon on 2026-10-17 against branch `feat/actionable-now-batch` at f6d9f95f. All 7 premises hold, several with corrections that change the shape of the work. They are individually small but mutually independent, so they ship as one coherent release wave: a reviewed repair path for split entity pages, a destination-keyed view over the write ledger, a cross-agent catch-up lane at SessionStart, injection-hardened framing for every hook-injected line, host-stable numeric sort order, OKF v0.2-compliant export/import, and pip-discoverable Hermes memory-provider registration. No card refutes another's files; the batch divides cleanly into four disjoint file-ownership lanes plus an integrator.

## Scope

The 7 cards with their recon-corrected definitions:

1. **t_28a8789d - Preview-and-apply entity page merge repair (priority 4).** `brain entity merge` accepts BOTH doctor subjects (opt-in `entity-alias-candidate` gated on `resolveEntitySemanticDedupConfig().enabled`, and always-on `duplicate-entity` for hard collisions), builds a merge plan (old page becomes an alias on the survivor; body folded or archived behind the destructive snapshot gate), echoes a plan hash, and applies only after `--expect-hash <hash>` verifies or a TTY y/N (with `--force` for agents). Quarantine-lane records are refused or routed explicitly. No bare delete; no claim rewrites.
2. **t_d8e7320f - Locale-aware numeric collation for note listing sort (priority 4).** The single sort site `listVaultPages` (`src/core/vault.ts:692`) switches from bare `localeCompare` to a module-level fixed-locale `Intl.Collator("en", { numeric: true })`, keeping the existing `toLowerCase` pre-pass. "note 2" sorts before "note 10" on every host.
3. **t_3b44cd9a - Cross-agent shared job logbook, session-start catch-up (priority 4).** A new opt-in, read-only SessionStart hook lane hands the agent the log lines other agents appended since its last look: newest 50 plus a count of older ones, filtered to `entry.agent !== self`, with a by-date read for a full day. Cursor is an un-synced `(date, shardId, line)` watermark in the derived store, never a `Brain/log` row; `Brain/log` stays byte-identical.
4. **t_ba04a81a - Injection-hardened framing for SessionStart lanes (priority 3).** The untrusted-source guard (sanitize to a single line + framing header) extends to every currently unguarded injection lane: active-inject assembly, gap-agenda topics, and answer-quote-check annotations. The `untrusted_source_delimiting` flag is NOT flipped; the guard is extended at the lanes.
5. **t_69fec179 - Destination-keyed write ledger aggregate (priority 2).** A query-time, log-derived aggregate answering "which destinations did this write touch", reading BOTH `note-write` and `write-session` log kinds over one shared core reader, exposed as a CLI subcommand of `brain writes` and an MCP tool beside `brain_writes`, with a `kinds` coverage field that honestly states what each destination's rows cover.
6. **t_ffdb4fac - OKF v0.2 export compliance (priority 2).** The exporter emits OKF v0.2 shapes (frontmatter `sources` with required `resource`, per-page `generated: {by, at}`, conservative lifecycle mapping, `okf_version: "0.2"` in the bundle-root index.md frontmatter) while keeping the Open Second Brain manifest dialect `schema: "1"`; the importer dual-accepts v0.2 bundles beside its own dialect and refuses everything else by name.
7. **t_dee22e5d - Hermes memory_providers entry point (priority 3).** One `[project.entry-points."hermes_agent.memory_providers"]` group in `pyproject.toml` targeting module `plugins.hermes`, plus tomllib/loader-contract tests and an install-doc note. The inverted pre-LLM-hook design is refused.

## Out of scope

- Claim/link rewrites on merge: claims are append-only (`truth/store.ts` CLAIMS_STEM, aggregated by `normalizeEntityName`); alias-on-survivor keeps every claim and link resolving with zero rewrites.
- Flipping `untrusted_source_delimiting` (t_ba04a81a): it is a mode switch on context-pack only - it kills detection reporting pinned by `operator-summary.test.ts` and `doctor-trust.test.ts`, invalidates persisted packs via the pack stamp, and does nothing for hook lanes.
- Any persisted table or write-site for the destination aggregate (t_69fec179): log-derived on query; no state-surface row, no maintenance lane. Decision-ledger join (refused destinations) is out of v1.
- A persisted accepted-plan journal for entity merge: apply re-plans and verifies the hash; therefore no state-surface-census row and no progress-census Safeguard.
- Collating the `feedback.ts:160` tie-break (t_d8e7320f adjacent): a reproducibility tie-break wants code-unit order; it deserves its own card.
- MCP write verbs for entity merge: `brain_entity` stays read-only; writes remain CLI-only by convention.
- CHANGELOG entries and version bump: handled later by osb-pr-prepare, not by the lanes.
- Making `listVaultBasenames` / `listVaultNotePaths` or the explorer collated: raw readdir ordering stays as-is.
- External Hermes loader acceptance testing: Hermes is not in CI; only the loader-contract mimicry and tomllib parse are tested.

## Premise verdicts

- **t_28a8789d**: holds-with-corrections - doctor has TWO findings to accept (`entity-alias-candidate` opt-in AND `duplicate-entity` always-on); `guardEntityMerge` guards two texts, not entity pages, so it is reusable inside the verb, not a page-merge primitive; the plan-hash accept gate is NEW surface - the precedent is `dream-stage.ts:362` (`plan_hash: sha256Hex(JSON.stringify(plan))`) and the bench run-store expected-hash gates, not `mergePreferences`.
- **t_d8e7320f**: holds-with-corrections - one sort site only (`vault.ts:692`); a fixed-locale collator additionally closes a latent host-stability gap (bare `localeCompare` is host-locale-dependent); `feedback.ts` tie-break explicitly excluded.
- **t_3b44cd9a**: holds - SessionStart runs exactly four lanes (hooks.json:43-72), none reads `Brain/log`; recon resolved the open choices: config-resolved agent name with device-id fallback, `(date, shardId, line)` cursor watermark, opt-in default-off, own-process lane with a per-lane cap.
- **t_ba04a81a**: holds-with-corrections - the unguarded sweep is larger than the validator's comment: gap-agenda topics and answer-quote-check annotations are additional lanes; the flag flip is REFUSED in favor of lane extension (recall brief and navmap already fence unconditionally without the flag).
- **t_69fec179**: holds-with-corrections - rescope holds; the write-session lane emits NO note-write events, so the aggregate must read both kinds; validator anchor off by 1-2 lines; design recommendation is log-derived on query (matches every existing read aggregate), not a persisted ledger.
- **t_ffdb4fac**: holds-with-corrections - wire spelling RESOLVED by spec fetch: `okf_version: "0.2"` is a MAY declaration in bundle-root index.md frontmatter, NOT a `schema` value change; Open Second Brain keeps its dialect `schema: "1"` manifest and adds the v0.2 declarations beside it.
- **t_dee22e5d**: holds-with-corrections - the inverted pre_llm_call/prefetch design is REFUSED (prefetch is deliberately the single injection lane, pinned by `test_no_pre_llm_call_hook_registered`); the residue is one entry-point line, a header-comment amendment, and tests.

## Chosen approach

Four implementation lanes with disjoint file ownership over their code, running in parallel, plus one integrator pass. Code files are single-owner and cross-lane code dependencies are forbidden; the census and frozen-pin test files are the known shared surface - more than one lane can need a row or a count move in the same file - so those edits were shared across lanes and reconciled by the integrator.

- **Lane A "entity-write-surface"** (t_28a8789d + t_69fec179): owns `src/core/brain/entities/**` including the new entity page-merge module, the new destination-aggregate projection module beside `src/core/brain/notes/write-log.ts`, `src/cli/brain/verbs/entity.ts`, `src/cli/brain/verbs/writes.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `src/mcp/brain/query-tools.ts`, `src/core/search/visibility-surface-registry.ts`, `src/mcp/registry-guard.ts`, `docs/cli-reference.md`, and their tests.
- **Lane B "session-lanes"** (t_3b44cd9a + t_ba04a81a): owns `hooks/**` (the new catch-up hook entry, `hooks/hooks.json` + the codex mirror via `bun run sync-plugin-mirrors`, `hooks/lib/active-context.ts`, `hooks/README.md`), `src/core/brain/untrusted-source.ts` (promote `neutralizeSingleLine`), `src/core/brain/gaps/gap-loop.ts`, `src/core/brain/recall-inject.ts` and `src/core/brain/navmap.ts` (import refactor ONLY), `src/core/brain/policy/blocks/active.ts`, `src/core/brain/context-receipts.ts`, and hook/core tests for those files. `src/core/brain/notes/write-record.ts` is NOT owned - Lane B must not touch it.
- **Lane C "small-fixes"** (t_d8e7320f + t_dee22e5d): owns `src/core/vault.ts`, `tests/core/vault.test.ts`, `pyproject.toml`, `tests/python/**`, `install/hermes.md`.
- **Lane D "okf-v02"** (t_ffdb4fac): owns `src/core/brain/portability/okf.ts`, `tests/core/brain/portability/**`, `tests/cli/okf-cli.test.ts`.
- **Integrator**: full local gates (`bun run fmt`, `bun run lint`, `bun run sync-plugin-mirrors:check`, targeted suites then full suite), census registration review across lanes (no row double-claimed, no count pin left at a stale value). CHANGELOG and version happen later in osb-pr-prepare, not in the lanes.

Landing order inside lanes is task order in `plan.md`; lanes themselves have no ordering constraints.

## Design decisions

**t_28a8789d (entity merge repair)**
- "Facts" interpretation: add the old name as an alias on the survivor; no claim rewrites (append-only claims; aggregation by normalized name keeps every claim/link resolving).
- The old page is archived behind the destructive snapshot gate (`withDestructiveSnapshot` / `snapshot-gate.ts:374`) or its body folded into the survivor - never a bare delete (registry.ts:444 refusal message).
- Plan-hash accept gate: the preview renders the plan and echoes `sha256Hex(JSON.stringify(plan))`; apply requires `--expect-hash <hash>` verified before any write; interactive TTY gets a y/N prompt; `--force` bypasses the prompt for agents (shape of `cli/brain/verbs/merge.ts:63-79`). This gate is new surface modeled on the dream-stage plan-hash and bench run-store expected-hash precedents, not the mergePreferences flow.
- Both doctor subjects are accepted: `entity-alias-candidate` (opt-in) and `duplicate-entity` (always-on). The `entity-checks.ts:60-65` message text is NOT changed - `entity-alias-verdicts.ts` matches by exact message.
- Quarantine-lane records are refused or routed explicitly; never silently merged.
- Optional `guardEntityMerge` run over the two page bodies (text-level merge guard), bypassable with `--force` (merge.ts:172-187 wiring).
- Deterministic finding ids follow the `hygiene/types.ts:78` template; the destructive-verb template (snapshot, inboundReferences at label-hygiene.ts:257, audit record via `src/core/reliability/audit.ts` + `audit-dirs.ts`) is followed end to end.

**t_69fec179 (destination-keyed write aggregate)**
- LOG-DERIVED on query; no persisted table. Every existing read aggregate is query-time over the log (`listNoteWrites`, `buildTimelineIndex`, today-dashboard); a destination aggregate adds no new fact, so a persisted store would be pure cache plus census burden.
- Read BOTH kinds on one walk: `note-write` (write-record.ts:235-265) and `write-session` audit events (engine.ts:494-509, target at :503). Do NOT reuse `listNoteWrites` - it projects only note-write.
- Default lookback window 7 days (today-dashboard precedent); window is a query parameter.
- Group key is the vault-relative path exactly as recorded (matches all three existing target spellings); rollups are presentation only.
- Every destination row carries a `kinds` coverage field: slug-derived and fully-derived write-binding sites (`write-binding/index.ts:28-44`) emit NEITHER kind, and the aggregate says so instead of implying completeness.
- Exposure over one shared core reader in both surfaces: CLI subcommand under `brain writes` and a new MCP tool beside `brain_writes` (`query-tools.ts:351-443`, registered at :968) with agent/device/path/since/until filters, `limit` + cursor via `pageSlice`/`cursorOffsetArg`, `total_matched`, warnings passthrough, and reach filtering (`reachView` + `view.visible`, :411-421) so a withheld page moves no count.

**t_3b44cd9a (cross-agent catch-up lane)**
- Opt-in first: default-OFF, enabled by a config key (both standalone SessionStart lane precedents, gap-agenda and backlog-nudge, are opt-in). Documented, not automatic.
- "Me" identity: a config-resolved agent name (the agent identity concept already used for log attribution), with the device id as fallback; the hook payload itself carries no agent name.
- Cursor watermark is the `(date, shardId, line)` tuple, not a timestamp alone (same-second cross-shard collisions), stored in the derived store `<vault>/.open-second-brain/` following the `backlog-nudge-state.ts` precedent: overwrite-only, atomic write, derived-dir-symlink guard, fail-soft read, un-synced. Never a row in `Brain/log`; per-session hook-state is the wrong lifetime.
- The lane is read-only and distinguishable from session-capture's lifecycle event. Its self-filter has two clauses: an entry whose `agent` equals the self identity is self, and in device-fallback mode - no configured agent name, so the identity is the device id - every entry from the device's own shards is self too, because writers stamp `agent` with an agent name and never the device id (the device id survives only as the shard id); a name-only check there would replay the device's own lines back at it. When neither an agent name nor a device id resolves, the lane stays silent instead of guessing. "newest 50 + count of older" is native to `buildActivityTimeline` (limit truncates newest-first, `total` = pre-truncation count).
- Own process like gap-agenda (budget-independent), but still with a per-lane line/char cap constant.
- Registration is name-based: one `hooks/hooks.json` SessionStart entry, the codex mirror regenerated with `bun run sync-plugin-mirrors` (CI gate `sync-plugin-mirrors:check`), one `hooks/README.md` "What the hooks do" row; no dispatcher registry edit.
- Attribution, if reported, flows through context receipts (`RECEIPT_ITEM_*` in `src/core/brain/context-receipts.ts`, `SOURCE_*` in `hooks/lib/active-context.ts:60-63`).

**t_ba04a81a (injection-hardened lanes)**
- Do NOT flip `untrusted_source_delimiting` (guardrails.ts:86; single reader `context-pack.ts:748`). Extend the structural guard to the SessionStart lanes instead - the precedent is recall-inject and navmap, which fence unconditionally without the flag.
- Promote `neutralizeSingleLine` into `src/core/brain/untrusted-source.ts` (today duplicated private at recall-inject.ts:1091 and navmap.ts:66); both refactored to import it; framing constant placed beside `UNTRUSTED_SOURCE_TAG`.
- Apply the guard at the active-context assembly chokepoint (`hooks/lib/active-context.ts:213-237`) BEFORE the meter push: `active-inject.ts:388-412` attributes by exact string match, so guarding after the push breaks attribution. Fence/header overhead is charged to `inject_budget_chars` (recall-inject.ts:972 fenceOverhead precedent) or the tier ladder evicts sections.
- Lighter framing header (not a full fence) for the active body and lessons blocks to avoid tier-ladder eviction; a full fence is fine for the small gap-agenda block. Gap topics route through `neutralizeSingleLine` (`gap-loop.ts:387`) plus a framing header on the agenda block.
- answer-quote-check: route annotation spans through `neutralizeUntrustedText` before collapse (:730-732) and add a framing line in the annotation (:771-784).
- Standing and scoped rules stay trusted-with-precedence-header (operator-authored; `standing-rules.ts:88-92`); runtime notices stay trusted (machine-generated).

**t_ffdb4fac (OKF v0.2)**
- Keep the Open Second Brain manifest `schema` field as-is (dialect); ADD `okf_version: "0.2"` to the bundle-root index.md frontmatter (renderIndex :382; the only frontmatter an index file may carry per spec).
- Per-page `sources:` list translated from citations (`collectCitations` :210-218): `resource` REQUIRED - URL as-is; wikilink resolved to a bundle-relative path via the `bundle_path` map (:276-283); neither -> DROP the dangling source (conservative producer choice, allowed by spec); ambiguous basename resolutions are dropped rather than guessed. Optional stable `id` when the body cites the source.
- Per-page `generated: { by: "open-second-brain/<version>", at: <instant> }` - ONE shared `isoSecond()` value for the whole bundle so the determinism test holds.
- Conservative lifecycle map to the spec enum draft|stable|deprecated, read off the frontmatter `status:` value only - the system-managed `_lifecycle` axis is deliberately not consulted (its verified/disputed values have no OKF counterpart): `status: draft` -> draft; deprecated/retired/superseded/archived/terminal -> deprecated; done/closed/resolved and any other or absent status -> stable (never deprecated).
- Importer dual acceptance: own-dialect `schema: "1"` OR index.md `okf_version: "0.2"`; the returned manifest preserves the on-disk schema value (:615 must not hardcode); everything else refused by name with the existing message shape. Sealed knowledge-pack halves (sha256 over okf.json) stay importable via dual acceptance.
- `redactForEgress` stays in the verb module so the egress registry entry (registry.ts:129-143 keys on the verb module) is untouched; `export-redaction.test.ts` and `export-identifier-integrity.test.ts` must stay green.

**t_dee22e5d (Hermes entry point)**
- Module target per the loader contract (`hasattr(loaded, "register")`): `[project.entry-points."hermes_agent.memory_providers"]` with `open-second-brain = "plugins.hermes"`; amend the pyproject header comment that says "no CLI entry points".
- The inverted design (pre_llm_call hook doing prefetch-style injection) is refused: prefetch (provider.py:796-811) is deliberately the single injection lane and `test_no_pre_llm_call_hook_registered` pins it.
- No mirror obligations for `plugins/hermes` (mirror machinery covers only the codex README); sync-version is unaffected (PYPROJECT_RE matches only the version line).

**t_d8e7320f (numeric collation)**
- Module-level `const COLLATOR = new Intl.Collator("en", { numeric: true })` near the `listVaultPages` site (vault.ts:635); line 692 becomes `COLLATOR.compare(a.title.toLowerCase(), b.title.toLowerCase())`. Keep `toLowerCase` (minimal delta; `sensitivity: "base"` changes more than promised). Local const in vault.ts - one consumer, `src/core/strings.ts` not needed. Update the doc comment at vault.ts:651 to state host independence.
- Not listings: explorer.ts:160-180 and the raw readdir helpers stay untouched; search scoring untouched (the search pipeline never calls `listVaultPages`).

## Census obligations

- **Lane A**: destructive-site-census - every renameSync/unlinkSync/rmSync inside `withDestructiveSnapshot` or a DESTRUCTIVE_SITES row with reason >= 60 chars; write-site-census - shared writers (`writeFrontmatterAtomic`/`atomicWriteFileSync`) or a categorised exclusion; vault-guard-census - `assertVaultIdentityForWrite` at the entry of every new write path; entity-read-census - `buildEntityIndex`/`parseEntityFile` plus the shared status predicate; manifest-completeness - the `brain entity` row and help text stay truthful. VISIBILITY_SURFACE_REGISTRY entry for the new MCP tool plus the two-way visibility-surface-census pin; registry-guard bounded-summary; frozen-surface pins (`tests/mcp/mcp.test.ts`, `tests/mcp/brain-tools-parity.test.ts` frozen name-set, `tests/helpers/tool-probe-catalogue.ts`, `tests/core/install/tool-ceiling.test.ts`, `agent-scope-matrix.test.ts`). No new doctor code; no state-surface row (nothing persisted); no progress-census (no Safeguard); brain-tools-parity naming rules respected.
- **Lane B**: write-site-census - register the cursor write site under `<vault>/.open-second-brain/` (or a categorised exclusion); this is a file Lane A's census rows land in too, so the census/pin test files were shared across lanes and reconciled by the integrator rather than owned outright; `tests/hooks/hooks-json-shape.test.ts` pins the `$CLAUDE_PLUGIN_ROOT` wrapper + `exit 0` shape; `bun run sync-plugin-mirrors` regenerates the codex mirror and `sync-plugin-mirrors:check` stays green; `hooks/README.md` table row; context receipts `RECEIPT_ITEM_*` / `SOURCE_*` if attribution is reported.
- **Lane C**: plugin_guard scanner reads every tracked file including `pyproject.toml` and the new Python tests - wording stays clean; sync-version unaffected.
- **Lane D**: egress census unaffected - `redactForEgress` stays in the verb module, no new registry entry; `egress-census.test.ts:491-506` untouched unless the verb is split (it is not).

## File changes

**Lane A** - new: entity page-merge module under `src/core/brain/entities/` (plan builder, alias application, archive/fold, snapshot gate, audit record); destination-aggregate projection module beside `src/core/brain/notes/write-log.ts`; tests for both. Extended: `src/cli/brain/verbs/entity.ts`, `src/cli/brain/verbs/writes.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `src/mcp/brain/query-tools.ts`, `src/core/search/visibility-surface-registry.ts`, `src/mcp/registry-guard.ts`, `docs/cli-reference.md`; test files `tests/cli/brain-entity.test.ts`, the entities suites, `tests/core/brain/notes/write-log.test.ts` (template), the MCP pin suites listed above.

**Lane B** - new: catch-up hook entry under `hooks/`; `tests/hooks/log-catchup.test.ts`; `tests/core/brain/untrusted-source.test.ts` extensions. Extended: `hooks/hooks.json` (+ codex mirror via sync script), `hooks/lib/active-context.ts`, `hooks/README.md`, `src/core/brain/untrusted-source.ts`, `src/core/brain/gaps/gap-loop.ts`, `src/core/brain/recall-inject.ts` and `src/core/brain/navmap.ts` (import refactor only), `src/core/brain/policy/blocks/active.ts`, `src/core/brain/context-receipts.ts`, `tests/hooks/active-inject.test.ts`, `active-inject-meter.test.ts`, `gap-loop.test.ts`, `answer-quote-check.test.ts`. NOT touched: `src/core/brain/notes/write-record.ts`.

**Lane C** - extended: `src/core/vault.ts` (collator), `tests/core/vault.test.ts`, `pyproject.toml` (entry-point group + header comment), `tests/python/test_hermes_plugin.py` (or a sibling test module), `install/hermes.md`.

**Lane D** - extended: `src/core/brain/portability/okf.ts`, `tests/core/brain/portability/okf.test.ts`, `tests/core/brain/portability/knowledge-pack.test.ts`, `tests/cli/okf-cli.test.ts`.

**Integrator** - no file edits beyond collision resolution; runs the gates and reviews census registrations across lanes.

## Risks and open questions

- **Three review contexts per lane pair-up**: lanes pair two cards each (A and B) or ship singles (C, D); reviewers see two premises per diff. Mitigation: task-level commits keep each card's diff separable inside the lane.
- **Determinism test vs generated.at**: the okf determinism test does whole-bundle byte equality except `generated_at`; per-page `generated.at` MUST share the single bundle `isoSecond()` value, or the test must normalize both. Decide at D1 implementation and pin whichever holds.
- **Meter attribution coupling**: the active-inject meter attributes by exact string match; guarding text after the meter push silently breaks attribution. The guard must run before the push and `active-inject-meter.test.ts` must assert guarded-text byte attribution.
- **Coverage asymmetry honesty**: slug-derived and fully-derived write-binding sites emit no log events of either kind; the `kinds` field must state this and PR prose must not overclaim "every write". Underclaiming is acceptable; overclaiming is not.
- **Wheel-vs-checkout caveat for the entry point**: the wheel contains only `plugins/hermes/*.py`, but the entry-point target IS `plugins.hermes`, so discovery resolves; the provider bridge still needs the `o2b` binary on PATH or a checkout (`provider.py:555-596`). `install/hermes.md` must say "zero-config" only for checkout/PATH contexts.
- **Observable output change from collation**: `o2b index` bytes and `second_brain_query` ordering change for multi-digit titles; flag in the PR body.
- **Open question (Lane A)**: whether an accepted-plan journal is ever wanted for audit replay; refused for v1 (re-plan + hash verify is the seal). Revisit only if an operator asks.
