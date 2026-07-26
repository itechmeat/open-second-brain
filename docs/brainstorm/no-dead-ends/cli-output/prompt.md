You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release for Open Second Brain under a single thesis: **nothing stops at a diagnosis.** The system must tell the caller what to do next in a machine-readable form, and where a fix is provably mechanical, be able to perform it — and where it is not, refuse by name rather than pretend.

Ten units were selected: nine kanban tasks plus one external GitHub bug report. Reconnaissance against the real code invalidated at least one premise in eight of the ten. What follows is the CORRECTED problem statement, with `path:line` evidence. Treat the corrections as ground truth; the original ticket text is given only where it explains intent.

A note on what makes this brief unusual, and what the variants must therefore reckon with: in almost every unit the mechanism the ticket asks for already exists, and the defect is that it is unwired, prose-only, duplicated three ways, or actively lying. Variants that propose building new subsystems will be wrong. The design space is about which existing seam becomes the single source of truth, and how much unification is worth paying for in one release.

## Unit A — The next-step channel is four incompatible shapes, and the best one is unwired

Verified state:

- `RuntimeNotice` (`src/core/brain/runtime-notices.ts:32-36`) has exactly `{code, severity, message}`. The next command is embedded in English prose inside `message` — e.g. `"Search index is not built yet, so recall returns nothing. Run: o2b search index"` (`runtime-notices.ts:122`). A consumer must regex `/Run: (.+)$/`. Three of its five codes carry no command at all.
- `DiagnosticSignal` (`src/core/brain/diagnostics.ts:66-76`) HAS a structured `nextCommand: string`, documented "Exact next command to run (a structural CLI string, never prose)". Its registry `DIAGNOSTIC_SIGNALS` (`diagnostics.ts:88-231`) holds ~20 codes. It has exactly two consumers (`operator-snapshot.ts:88`, `diagnostics.ts:514`).
- `OnboardingStep.command: string | null` (`src/cli/onboarding.ts:33`) is a third shape.
- `CheckResult.fix?: string` (`src/core/types.ts:27`) is a fourth.
- `o2b brain doctor` — the verb the ticket names — prints `[ERROR] <code>: <message> (<path>)` and never touches the registry (`src/cli/brain/verbs/doctor.ts:100-110`). Under `--json` it emits `{warnings, errors, uncertain?}` with no command field.
- Terminal states that print nothing forward: `o2b brain init` (`src/cli/brain/verbs/init.ts:59-63`) — the command that creates the empty `Brain/`; `o2b search index` on success (`src/cli/search.ts:1057`); `o2b search query` with zero hits on an existing index (`src/cli/search.ts:892`); and a family of `brain` empty-state verbs (`pending.ts:64`, `intent-review.ts:31`, `intention.ts:51`).
- Counter-examples proving the pattern is achievable but hand-written per verb: `o2b brain git status` (`src/cli/brain/verbs/git.ts:60`) and `o2b brain bridges` (`src/cli/brain/verbs/bridges.ts:88,123`).
- Premise CORRECTED: the ticket claims `o2b search` with no index is a dead end. It is not — `openReadOrSelfHeal` (`src/core/search/search.ts:166-184`) silently builds the index and retries, pinned by `tests/cli/search.test.ts:170-178`. Designing a "run `o2b search index`" hint there would regress a deliberate feature. Relatedly, the `search_index_missing` notice text is now stale — it describes a world self-heal removed.
- Premise CORRECTED: "OSB has no interactive/TTY mode" is false. `o2b init --interactive` is a stdin wizard (`src/cli/install/init-interactive.ts`) and six brain verbs gate destructive applies on `process.stdin.isTTY`.
- Premise CORRECTED: notices are not init-only. They reach three surfaces: the onboarding checklist, the SessionStart hook (`hooks/active-inject.ts:292`), and the `vault_health` MCP tool (`src/mcp/tools.ts:224`). What is init-only is `writeSearchInitBlock`, whose own docblock says so (`src/cli/main.ts:202-203`).
- Discovered, not in any ticket: the CLI command manifest is materially stale, and it is the source of shell completions and `o2b help --json` (`src/cli/completions.ts:24-27`). It models 130 entries. The dispatchers handle more: `secrets` and `partner` are absent at top level; 7 of 14 `search` subverbs are missing; 55 of the `brain` dispatcher's 139 case labels have no entry. Any plan that iterates the manifest to enumerate terminal states silently skips a third of the real surface.
- Discovered: `wantsJsonFlag` (`src/cli/json-helpers.ts:5-7`) scans raw argv, so `o2b brain note "see --json for details"` is misread as a JSON request.
- JSON discipline: 12 verbs own an internal `--json` branch (`COMMANDS_WITH_INTERNAL_JSON`, `src/cli/main.ts:891-904`); everything else goes through `withJsonFallback`, which buffers stdout into an envelope. A stray advisory line breaks `JSON.parse` only on the first path. There is no shared "should I print advisory chrome?" helper today.

## Unit B — The fix applier is not keyed off the findings contract

Verified state:

- Premise CORRECTED: `brain lint` is NOT read-only. Its docblock reads "read-only structural drift scan **with optional `--apply` mode that rewrites the smallest possible fix per finding**" (`src/cli/brain/verbs/lint.ts:2-4`); `--apply` writes via `atomicWriteFileSync` (`src/core/brain/lint-consolidate.ts:216,227`).
- Premise CORRECTED: the two cited "findings with no fix consumer" lines are string literals in MCP schemas — `src/mcp/brain/review-tools.ts:198` is a tool `description`, `src/mcp/brain/health-tools.ts:207` is `enum: ["markdown","json"]`. The `brain_doctor` `repair`/`apply` arguments sit eight lines above at `health-tools.ts:194-203` and dispatch to `applyRepair`.
- Three Finding→apply pipelines already ship, each with dry-run, audit and the write guard: `applyHygienePlan` (`src/core/brain/hygiene/apply.ts:137`), `applyRepair` (`src/core/brain/diagnostics.ts:564`), `applyRemediation` (`src/core/brain/health/remediation.ts:336`). A blast-radius primitive `assertExpectedCount` (`src/core/brain/count-guard.ts:48`) is wired into the hygiene CLI and MCP paths.
- The one true statement in the ticket: `Fixer.plan(vault)` (`diagnostics.ts:504`) **re-scans the vault independently**; `runDoctor` supplies only counts of classes no fixer covers (`diagnostics.ts:506-511`). The applier shares codes with the detector via `coversDoctorCode` but does not consume its findings.
- There are 15 independent finding record types with no shared base. They disagree on the identity field (content hash vs `::`-joined tuple vs none), on severity vocabulary (three different unions), and on whether a code exists at all. `DoctorIssue.code` (`src/core/brain/types.ts:1743-1750`) is an unenumerated `string` with ~35 literals inline across 1754 lines of `doctor.ts`. `DegradationCode` (`src/core/integrity/degradation.ts:105`) is deliberately closed so that adding a member breaks every exhaustive consumer — folding it into a wider union reverses a stated policy.
- Nothing vault-side carries a structured line number. The frontmatter-drop notice interpolates its line into prose (`src/core/vault.ts:268`), and that number is **1-based within the frontmatter block, not the file**; the offending text is **truncated at 120 chars** (`vault.ts:139-140,311-315`). `DegradationNotice` has four fields: `code, site, path?, detail`.
- `broken-wikilink` puts the field name and target in prose only (`doctor.ts:1174-1179`); `broken-backlinks` is pushed with no `path` at all (`doctor.ts:1209-1216`). Neither is machine-actionable.
- Discovered bug: `lintConsolidate` calls `assertVaultIdentityForWrite` unconditionally at `lint-consolidate.ts:172`, before the `apply` branch. `o2b brain actions`, a read-only ranking verb, calls `lintConsolidate(vault, {apply:false})` (`src/cli/brain/verbs/actions.ts:32`) and can therefore throw `VaultIdentityMismatchError` on a pure read.
- Discovered inconsistency: three appliers place the write guard three different ways — after the dry-run return (hygiene, with a stated rationale at `apply.ts:152-155`), before it (repair), unconditionally including dry-run (remediation).
- Discovered gap: `brain pending apply` (`src/core/brain/pending.ts:126-135`) has no dry-run — the one approval-queue path lacking the preview every other applier has.
- Which findings are provably mechanical is already answered by the code: six classes have fixers (merged-link rewrite, stale-stable demotion, wal-gap, orphaned `_evidenced_by` reference, content-hash restamp, wide permissions). Frontmatter drops are NOT mechanically fixable — the parser is line-based, so a dropped line is by definition grammar it has no branch for, and repair requires choosing a target grammar per shape. Semantic-health findings are hard-coded `needs-review` with a stated rationale (`health/remediation.ts:15-18,228-254`). "Stale scope keys" (from the ticket) does not exist as a finding kind anywhere.
- Hard constraint: `tests/core/brain/vault-guard-census.test.ts` walks `src/core/brain/`, and fails naming any module that calls a write primitive without `assertVaultIdentityForWrite` or `brainDirsForWrite`, unless listed in `UNGUARDED_WITH_REASON` with a written justification.
- Coverage gap: neither `o2b brain lint` nor `o2b brain hygiene` has a CLI-level test today.

## Unit C — `brain init` writes a template that hides 16 of 23 config keys

Verified state:

- `DEFAULT_BRAIN_CONFIG_YAML` (`src/core/brain/policy.ts:596-640`) emits 7 top-level keys. The resolver understands 23. Sixteen resolve silently from defaults: `active, lessons, discipline_report, guardrails, rollup, link_graph, temporal, health, integrity, notes, sessions, schema, hygiene, anticipatory, recall, feedback`. Two sub-keys inside templated blocks are likewise invisible (`dream.heal_enrich_enabled`, `retire.confirmed_evidence_min_threshold`). The `integrity:` block from the previous release is not the exception the ticket frames it as — it is the newest member of a 16-key set, so the ticket understates the surface roughly eightfold.
- The template is a hand-maintained string constant; the defaults live in separate resolver tables (`BRAIN_GUARDRAIL_DEFAULTS` `policy.ts:143`, `BRAIN_INTEGRITY_DEFAULTS` `policy.ts:346`, and peers). Nothing keeps the two in sync — the 16-key gap is the accumulated drift.
- Premise CORRECTED: the two link-style settings the ticket wants to autodetect are NOT in `_brain.yaml`. `wiki_link_format` (`src/core/config.ts:580-590`) and `link_output_format` (`src/core/config.ts:370-375`) live in the machine-level plugin config. A per-vault autofit needs either a move or a vault-side override — an architectural decision the ticket does not acknowledge.
- No `_brain.yaml` key exists for date format, frontmatter key naming, or path/case convention. Date format is hard-coded (`src/core/brain/time.ts:18,25`).
- Detectors the ticket assumes: setext headers — does not exist anywhere in `src/`. Filename-case collisions — does not exist. CRLF — only ever tolerated, never reported. Unresolved links — `normalizeWikilinks` reports `ambiguous[]` only; a target resolving to nothing is silently left alone (`src/core/brain/link-graph/format-wikilink.ts:155`).
- Chicken-and-egg: `resolveVaultScope` reads `<vault>/Brain/_brain.yaml` (`src/core/vault-scope/index.ts:107`) — the file init is about to create. Detection at init time runs under `DEFAULT_SCOPE`, i.e. against the wrong exclusions on the very run meant to learn the vault's conventions.
- Precedent for surgically writing one key into an existing `_brain.yaml` without disturbing the rest: `applyHealthSilenceBeforeToYaml` (`src/core/brain/health-baseline.ts:81`) — a pure string transform preserving CRLF, indent width and unrelated blocks byte-for-byte, committed under `withFileLock` + `atomicWriteText`.
- Preview precedent: `o2b brain links normalize` is already dry-run-by-default over the whole vault with per-file change counts, applying only on `--write` (`src/cli/brain/verbs/links.ts:83-85,102-111`). Note its write is `writeFileSync`, not atomic — an existing bug not to replicate.
- Discovered: `o2b brain init` does not create `Brain/pending/` or `Brain/entities/` although both are declared in `BrainDirs` (`src/core/brain/paths.ts:168,172`); the mkdir loop covers 8 of 10 (`init.ts:232-241`). Downstream writers create them lazily.

## Unit D — Dream's five "phases" are a reporting label, not an execution architecture

Verified state:

- The ticket asks to run one dream phase ad-hoc. There are no phase functions. `DREAM_PHASE` (`src/core/brain/dream-phases.ts:19-26`) names five labels (`close, reconcile, synthesize, heal, log`) whose metrics are assembled at `dream.ts:896-919` **after** all work is done, by reading counters out of objects computed by entirely different functions. The module's own comment says it "only names the existing seams".
- `planRefresh` and `planAutoRetires` are two-way mutably coupled: `planRefresh` pushes into `plan.retires` (`dream-refresh.ts:225-231`), and `planAutoRetires` deletes entries from `refresh.updated` (`dream.ts:1486,1535,1557`) so a preference is never both refreshed and retired. Running `planRefresh` alone with writes enabled is a data-correctness bug, not a missing feature.
- Only two steps are genuinely self-contained: `scanBrain` (a pure read) and the opt-in `runHealEnrichment`.
- The ticket's stated motivation is precise and achievable: "without the stateful, error-prone dance of toggling phase gates and remembering to revert them." The gates are real config booleans (`dream.heal_enrich_enabled` and peers) that an operator edits in `_brain.yaml` and must remember to revert.
- Discovered: the workrun checkpoints lie. Three (`cluster_complete, close_complete, reconcile_complete`) are appended in one burst at `dream.ts:465-471` **before any preference is written**; four more (`promote_complete, synthesize_complete, retire_complete, heal_complete`) in another burst at `dream.ts:681-690` **after every mutation completed**. A crash during the actual writes leaves a journal claiming "reconcile complete" while promote/retire/heal were mid-flight. `scanDanglingWorkruns` reports it as forensic evidence and nothing resumes or rolls back.
- Discovered: the `DreamOptions` docstring (`dream.ts:273-278`) claims safeguard checkpoints at "pre-mutation, post-promote, pre-finalize". The code has one call at `dream.ts:680` doing double duty; nothing checkpoints before `workrun?.finalize()` at `dream.ts:889`, leaving log writes, rollup ledger persistence, snapshot pruning and active/lessons regeneration unguarded.
- `dryRun` is honoured completely: every planning step runs unconditionally, every filesystem mutation is inside `if (!dryRun)`. No exceptions found.
- 12 call sites pass either nothing, `{dryRun:true}`, or a safeguard. A new optional field is additive for all of them, but there is no existing precedent for a partial-pipeline call to model a contract on.

## Unit E — Dedup counts exist, die one call later, and the semantic half of the ticket describes nothing

Verified state:

- Premise CORRECTED: semantic dedup never drops anything, anywhere. Two embedding-cosine layers exist — `detectSemanticDedup` (threshold 0.97, `src/core/brain/hygiene/detectors/dedup.ts:119,32`) and `detectEntityAliasCandidates` (threshold 0.92, `src/core/brain/entities/semantic-dedup.ts:298,37`) — and both are explicitly opt-in, proposal-only nomination systems by design comment. The ticket's rationale ("a spike in semantic dedup means knowledge is being silently discarded") describes a mechanism this codebase does not have.
- Every path that actually drops an item during ingest uses only an exact sha256: `emitSignal` (`src/core/brain/session-lifecycle.ts:597-603`), `scanInline` (`src/core/brain/inline-scan.ts:152-165`), `routeFacts` (`src/core/brain/fact-extract.ts:180-184`).
- Those counters already exist (`signals_deduped`, `facts_deduped`, `deduped`) and already reach CLI text, `--json` and MCP responses — but they are **ephemeral**: threaded exactly one call deep and then gone. Nothing is persisted, so a spike over time cannot be observed. That is the real gap.
- Premise CORRECTED: the ticket's hint file (`DedupReport` at `src/core/brain/page-dedup.ts:51-55`) is the wrong target — it belongs to the unrelated page-merge nomination flow.
- The native persistence pattern for a queryable counter is an append-only `ContinuityRecord` of a fixed `kind` (`src/core/brain/continuity/types.ts:59-74`), emitted through `emitGatedTelemetry` (`continuity/emit.ts:27-37`), read back through a `summarize*` aggregator and exposed via `brain_analytics`. `generation_report` (`src/core/brain/generation-reports.ts:82-113,165-181`) is the closest working model.

## Unit F — Project scope on session summary already has a home

Verified state:

- Premise CORRECTED: the project dimension is already fully built. `SCOPE_AXES = ["owner", "session", "project"]` and `CompositeScope` (`src/core/scope-key.ts:26-34`); read from the literal frontmatter key `project` (`scope-key.ts:59`); normalized by the same slug rule as `session` (`session-scope.ts:26-41`); already folded into the page-dedup key; already an MCP filter `project_scope` on `brain_search` (`src/mcp/search-tools.ts:183-186,549-556`); already in the activation half-life table (`src/core/search/activation/decay.ts:35`).
- Premise CORRECTED: `buildSessionSummaryDigest` does not exist. The real write path is `appendSessionSummary` (`src/core/brain/session-summary.ts:64-112`), which validates, refuses an all-empty digest, computes a dedupe key and appends a `session_summary_digest` continuity record.
- `SessionSummaryInput` (`session-summary.ts:32-44`) and `SessionSummaryDigest` (`:46-55`) indeed have no project field.
- A distinct, unrelated concept shares the word: `o2b brain project link|list|remove|status` links a code-project directory to its owning vault at the config level. Do not conflate.
- The `brain_session_summary` MCP tool (`src/mcp/brain/synthesis-tools.ts:307-353`) validates optional args ad hoc rather than through the shared `coerceStringOptional` helper that `search-tools.ts` uses for `project_scope`.

## Unit G — The install runbook and its verification already exist; the gap is different

Verified state:

- Premise CORRECTED: verification is the best-developed part of the system, not the missing one. All 9 registered adapters implement `verify(env): VerifyResult` (interface-mandated, `src/core/install/types.ts:139-148`), wired to `o2b install --check` with documented exit codes (0 clean, 3 drift, 4 user-modified-block) at `src/cli/install/install.ts:238-270`, JSON output, drift detection against the canonical payload, and an optional live MCP handshake probe for the four JSON-MCP adapters.
- Premise CORRECTED: an agent-followable runbook already exists — `install.md` (router, with a readiness checklist at `:88-113` explicitly telling an agent what "not done" means) plus `install/prerequisites.md` plus one `install/<runtime>.md` for each of 9 adapters and 4 pipeline-hosted runtimes. Building a new runbook would ship a second competing document.
- The genuine gaps, narrowly: (a) no doc shows a literal expected-output block for `o2b install --check`, so the agent has nothing to pattern-match against — the docs say "run this" but never "and this is what success looks like"; (b) Windows/WSL2 is absent from both code and docs. `defaultConfigPath()` (`src/core/config.ts:45`) is unconditionally POSIX `~/.config/open-second-brain/config.yaml` with no `%APPDATA%` branch, and no code translates between a WSL2 `/mnt/c/...` mount and a native `C:\...` path. A repo-wide grep for windows/wsl across the docs returns zero matches.
- Adapters are constructor-injected with `home`, `vault`, `env`, `cwd`, `now` (`types.ts:56-62`) rather than reading the real environment, so tests never touch host config — that same injection makes a documented-output assertion testable.

## Unit H — Skill acceptance writes a contract with no prerequisites, no rollback, no verification

Verified state:

- `acceptSkillProposal` (`src/core/brain/skill-proposals.ts:272-351`) writes two files: an accepted-proposal archive and a materialized procedure at `Brain/procedures/proc-<slug>.md`. Neither frontmatter object contains `prerequisites`, `rollback`, `side_effects` or `verification` — verified by full read and grep. The procedure body is templated boilerplate (`renderProposalBody`, `:724-746`).
- Evidence provenance: the accept path copies `evidence_count`/`confidence` straight from the candidate's own pattern-match support. Nothing resolves that against an independently recorded outcome.
- Decisive finding — a real, joinable outcome source EXISTS, so no stub is needed. `recordProceduralOutcome` (`src/core/brain/procedural-memory.ts:176-209`) records host-supplied `success`/`failure` (never inferred), persisted as `successCount`/`failureCount` on a `ProceduralMemoryEntry` plus a `usage.jsonl` sidecar, written through the `brain_procedural_memory` `mark_outcome` MCP operation. The join key is derived from the slug with no lookup: `pmem-<sha256("Brain/procedures/proc-<slug>.md").slice(0,12)>` (`procedural-memory.ts:296-298`). `acceptSkillProposal` itself already causes that entry to exist, by calling `reconcileProceduralMemory` immediately after writing the procedure (`skill-proposals.ts:339-341`).
- Ruled out as evidence sources with evidence: the lineage ledger from the previous release (session identity, not outcome — its own docblock says it exists for one consumer); `context_pack_outcome` (no skill/procedure reference); `brain_eval` (aggregate benchmark); `brain_recall_feedback` (search relevance). `recall_observed_use` and `brain_apply_evidence` join only incidentally through a free-text path nobody is required to populate.
- Note the trap: `skill-usage.ts:10` says the dream pass ranks skills "on real evidence", but that evidence is invocation frequency and recency from `skill_invoked` records — not success or failure. Citing it as outcome evidence would be citing the wrong source.
- Would new fields be write-only decoration? `collectEntries` (`procedural-memory.ts:223-240`) reads `triggers`, `tags`, `permissions`, `source`, `version` from procedure frontmatter and nothing else. New fields are inert until it is extended — a one-line-per-field additive change matching the existing pattern.
- Atomicity: each file write is exclusive-atomic, and there is a compensating rollback if the procedure write throws. Three gaps remain: a crash (not an exception) between the two writes; an uncaught `unlinkSync(pendingPath)` at `:338` leaving both pending and accepted copies; and uncaught projection rebuilds at `:339-343` leaving stale indexes. The risk class is duplicate/orphaned state and stale projections, not torn files.

## Unit I — The profile scaffolder ticket points at an artifact that does not exist

Verified state:

- Premise CORRECTED, twice over. The repository has **five** unrelated concepts named "profile", and the ticket's two hints point at different ones. `ProfileDoc` (`src/core/brain/profile-doc.ts:26-29`) is `{text, generatedAt}` — a rendered-document envelope for a machine-generated digest whose own body says "Auto-generated digest. Do not edit" (`:62`). There is no entity, no id, no schema. `profile init <id> --entity <type>` has no target, and the ticket's motivation ("profiles are authored in-vault by hand") is false.
- The real bug of exactly the shape the ticket asks for lives in the file it did not name. `createProfile` (`src/core/brain/portability/profiles.ts:99-106`) **silently overwrites** an existing registry entry (`data.profiles[trimmed] = {vault}`), performs no directory check at create time (only `switchProfile` does, `:126-128`), and does a lock-free read-modify-write of `profiles.json` — so two concurrent creates lose an update. That is "refuses to overwrite" plus "serializes concurrent mutations", verbatim.
- Every primitive the ticket asks for already exists and is conventional: `atomicCreateFileSyncExclusive` (`src/core/fs-atomic.ts:127`) is race-free refuse-to-overwrite via `link(2)`; `writeFrontmatterAtomic(..., {overwrite:false, existsErrorKind})` (`src/core/vault.ts:388`) is its ergonomic wrapper; `withTempFile` already unlinks partial output on failure; `withFileLock` (`src/core/reliability/lock.ts:22`) and `acquireLockSync` (`src/core/brain/sync-lockfile.ts:65`) cover async and sync serialization. `src/core/brain/entities/registry.ts:170-173` is a working end-to-end example of validate → refuse-overwrite → atomic-create.

## Unit J — GitHub issue #149: a reported cold-start deadlock whose load-bearing half does not exist

External bug report (issue #149, `Confirmed preferences with 0 evidence get stuck at 0.00 confidence`). The reporter claims: `brain_feedback(force_confirmed=true)` creates a confirmed preference with `_applied_count: 0` and `_last_evidence_at: null`; the Wilson lower bound divides by zero; freshness is zero; the result is 0.00; a 0.00-confidence preference is de-prioritized in context, so it is rarely applied, so it never accumulates evidence — a deadlock. Two fixes are proposed: (A) write one implicit apply-evidence event at force-confirm time, giving n=1 and ~0.21; (B) return `BASELINE_CONFIDENCE * freshness` when n=0, with freshness decaying from confirmation time.

Verified state:

- CONFIRMED: a `force_confirmed` preference does settle at `value = 0`, `band = low`, and nothing but an apply-evidence event can move it. `computeConfidence` (`src/core/brain/confidence.ts:38-78`) has exactly one production caller, `planRefresh` (`src/core/brain/dream-refresh.ts:279`), driven entirely by the log.
- Premise CORRECTED: there is no division by zero. `confidence.ts:47` guards `if (n > 0)`; `wilsonLow` keeps its initializer. The zero is the product of two independent zeros — `wilsonLow = 0` AND `freshness = 0` — either sufficient on its own. A fix that only handles `n = 0` still yields `x * 0 = 0`.
- Premise CORRECTED, and this is the load-bearing one: the de-prioritization does not exist on the primary surface. `Brain/active.md` filters only on `status === confirmed` with no confidence cutoff and no top-N (`src/core/brain/active.ts:148-157`), renders every confirmed preference (`:324,329`), and sorts by **band, not value** (`:446-452`). Both proposed values (0.2065 and 0.25) sit below `medium_min = 0.40`, so **neither fix would move the preference one position in the injected context.** Budget truncation drops whole lower-priority sections before touching Confirmed (`src/core/brain/active-budget.ts:33-40`, `src/core/brain/text/text-budget.ts:119-138`). The feedback loop the reporter describes has no code path. It is real only for `brain_pre_compress_pack` and `brain_brief`, two topK-limited secondary surfaces.
- Premise CORRECTED: the initial on-disk value is `null`, not `0`. `preferenceFrontmatter` emits the literal `"null"` when the field is absent (`src/core/brain/preference.ts:494-498,525`), and neither force-confirmed writer passes it (`src/mcp/brain/feedback-tools.ts:202-212`, `src/cli/brain/verbs/feedback.ts:124-138`). `0` appears only after the first dream pass rewrites the file.
- Discovered defect, not in the report: `null` ranks WORSE than `0`. Two surfaces map it to negative infinity — `pref.confidence_value ?? Number.NEGATIVE_INFINITY` at `src/core/brain/pre-compress-pack.ts:104` and `src/core/brain/morning-brief.ts:87` — then sort descending and slice to `topK` (`pre-compress-pack.ts:146-153`, `morning-brief.ts:161,165`). `src/core/brain/dream.ts:498-502` already pre-seeds new unconfirmed preferences with an explicit `0` for precisely this reason, with a comment saying `null` reads as "needs update".
- Discovered defect, not in the report: the `force-confirmed` log event (`feedback-tools.ts:217-224`) carries `preference` and `agent` but no `result` field, and `scanApplyEvidence` requires a `result` in `{applied, violated, outdated}` (`dream-refresh.ts:129-138`). There is already an audit record of the force-confirm that the confidence pipeline is structurally unable to see.
- The normal promotion path is gated on at least one `applied` event (`dream-refresh.ts:236-240`, `firstApplied` at `:213`), so n >= 1 there — the reporter is right about that. But its own first pass computes `computeConfidence(1, 0, fresh) = 0.2065`, also `low`. A young preference sitting at a tiny value in the low band is the normal, intended state; `force_confirmed` differs only in that its number is 0 rather than 0.21, in the same band.
- Retirement does not read confidence at all. `dream.ts:1511-1519` retires a confirmed preference with no evidence at `stale_evidence_days` (default 90) measured from `confirmed_at`, with a comment reading "Confirmed with no evidence at all? Shouldn't happen". Force-confirmed preferences have been hitting that branch all along. `pinned: true` is the existing opt-out. So Option B's claimed safety net already exists and neither option changes retirement.
- A cold-start visibility mechanism already exists and is not a number: `doctor.ts:1323-1345` reports `low-evidence-confirmed` for exactly this population — confirmed, `applied_count <= confidence.low_max_applied` (default 2), older than `dream.unconfirmed_window_days` — with the message "The rule hasn't seen real use — review or retire."
- No cold-start provision exists in the formula: no additive smoothing, no prior, no floor, no `n === 0` special case. `confidence.ts:18-19` documents the hard zero deliberately.
- Option A's cost, verified: `applied_count` stops meaning "times this rule was applied to real work". It would corrupt the most-applied ranking (`src/core/brain/most-applied.ts`), the "Recent applications" body section, the outcome-regression success/failure ratio (`dream-refresh.ts:287-294`), and would consume one of the two-event budget the `low-evidence-confirmed` doctor warning relies on. It also violates the contract stated in `src/core/brain/apply-evidence.ts:3-8`, which defines an apply-evidence row as the canonical durable signal that a preference was exercised against real work.
- Option B's cost, verified: `computeConfidence` cannot see `confirmed_at`, so the proposal's freshness anchor is out of scope and would need a sixth parameter plus an undefined answer for unconfirmed preferences. It breaks two assertions outright (`tests/core/brain.confidence-value.test.ts:25-28`, `tests/core/brain/dream-modules.test.ts:29-33`) and introduces permanent churn: a decaying baseline drifts about 1e-4 per hour against a 1e-6 no-op threshold (`dream-refresh.ts:322-323`), so every dream pass would rewrite every zero-evidence preference, bumping `_revision` and emitting log and edit-history rows forever.
- Test blast radius: only two hard-coded numeric confidence assertions exist repo-wide, and 27 files assert bands rather than values.

The design question for this unit is therefore not "which of A or B", but: what is the honest fix when a reported deadlock turns out to be a real but cosmetic zero plus a genuine ranking defect plus a missing signpost — given that this release's whole thesis is that a diagnosis must name its exit rather than fabricate its way out of one.

# Project context

Open Second Brain — TypeScript on Bun, a CLI plus an MCP server (108 tools) over an Obsidian-compatible Markdown vault. The kernel is deterministic and makes no LLM calls. The vault is plain Markdown replicated peer-to-peer via Syncthing; there is no git transport for the vault.

Recent commits:

```
f91a698b feat: context integrity gates (v1.39.0) (#150)
c31a2574 feat: semantic-health baseline watermark (v1.38.0) (#148)
b0c37977 feat: retrieval quality and context delivery (v1.37.0) (#146)
842d690f feat: knowledge intake and consolidation (v1.36.0) (#145)
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0) (#139)
f2a037eb feat: today operator surface - dashboard, open loops, marker write-back (v1.31.0) (#138)
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)
70fb36e1 feat: operability, safety & first-run experience (v1.29.0) (#134)
ac26a675 feat: retrieval & ranking quality (v1.28.0) (#133)
99adb65f feat: ingestion & import robustness (v1.27.0) (#132)
```

The immediately preceding release (v1.39.0) established two shared seams this wave will sit next to:

- a closed-vocabulary degradation channel (`DegradationCode`, `src/core/integrity/degradation.ts`) whose closure is enforced by design so that adding a member breaks exhaustive consumers;
- a stamp-and-compare module with `off | warn | fail` gate modes, and an `integrity:` config block resolving from defaults.

Related files, by unit:

- A: `src/core/brain/runtime-notices.ts`, `src/core/brain/diagnostics.ts`, `src/cli/onboarding.ts`, `src/cli/brain/verbs/doctor.ts`, `src/cli/command-manifest.ts`, `src/cli/json-helpers.ts`, `src/cli/main.ts`, `src/mcp/brain/health-tools.ts`
- B: `src/core/brain/diagnostics.ts`, `src/core/brain/hygiene/{types,scan,plan,apply}.ts`, `src/core/brain/health/remediation.ts`, `src/core/brain/lint-consolidate.ts`, `src/core/brain/doctor.ts`, `src/core/brain/types.ts`, `src/core/integrity/degradation.ts`, `src/core/vault.ts`, `src/core/brain/pending.ts`, `src/core/brain/count-guard.ts`
- C: `src/core/brain/init.ts`, `src/core/brain/policy.ts`, `src/core/brain/health-baseline.ts`, `src/core/vault-scope/index.ts`, `src/core/config.ts`
- D: `src/core/brain/dream.ts`, `src/core/brain/dream-refresh.ts`, `src/core/brain/dream-phases.ts`, `src/core/brain/dream-workrun.ts`, `src/core/brain/safeguard.ts`
- E: `src/core/brain/session-lifecycle.ts`, `src/core/brain/inline-scan.ts`, `src/core/brain/fact-extract.ts`, `src/core/brain/continuity/{types,emit,store}.ts`, `src/core/brain/generation-reports.ts`
- F: `src/core/brain/session-summary.ts`, `src/core/scope-key.ts`, `src/core/brain/session-scope.ts`, `src/mcp/brain/synthesis-tools.ts`, `src/mcp/coerce.ts`
- G: `src/core/install/{types,registry,identity}.ts`, `src/core/install/adapters/*.ts`, `src/cli/install/install.ts`, `src/core/config.ts`, `install.md`, `install/*.md`
- H: `src/core/brain/skill-proposals.ts`, `src/core/brain/procedural-memory.ts`, `src/mcp/brain/procedure-tools.ts`
- I: `src/core/brain/portability/profiles.ts`, `src/core/fs-atomic.ts`, `src/core/reliability/lock.ts`, `src/core/brain/entities/registry.ts`
- J: `src/core/brain/confidence.ts`, `src/core/brain/dream-refresh.ts`, `src/core/brain/preference.ts`, `src/mcp/brain/feedback-tools.ts`, `src/cli/brain/verbs/feedback.ts`, `src/core/brain/pre-compress-pack.ts`, `src/core/brain/morning-brief.ts`, `src/core/brain/doctor.ts`, `src/core/brain/apply-evidence.ts`

Conventions:

- `package.json` `version` is the single source of truth, mirrored into seven manifests by `scripts/sync-version.ts`; CI gates on `--check`. The bump rides inside the feature pull request.
- One pull request equals one CHANGELOG version, which may bundle many atomic units.
- Every commit must pass, in the foreground: format, lint (an exact baseline of 134 warnings and 0 errors), typecheck, the full test suite (7260 passing today), the version-sync check, and a link-rot ratchet.
- Tests use `bun:test`, build throwaway vaults with `mkdtempSync`, inject a config path so the real environment is never touched, and inject clocks rather than mocking time.
- Writes under `src/core/brain/` must carry the vault-identity guard or be listed with a written justification; a census test enforces this.
- A census/matrix test that fails until a new surface is classified is an established pattern in this codebase (the previous release added one partitioning all 108 MCP tools).

Constraints:

- Every new surface must be byte-identical when its flag, argument or config key is absent. Existing callers must not change behaviour.
- No stubs. No fallback that silently does nothing — if something cannot be done, it must fail with a named, specific error rather than degrade quietly.
- No hardcoded natural-language word or phrase lists in any language. Detection and classification must use structural signals, explicit fields, or corpus statistics — never a list of English (or any other) words.
- The kernel makes no LLM calls; everything here must be deterministic and model-free.
- Do not introduce a new external dependency.
- Do not reverse the deliberate closure of `DegradationCode` without saying so explicitly and justifying it.
- Do not build a second install document, a second fix applier, or a second next-step registry alongside an existing one. Where a mechanism already exists, the work is to wire, unify or correct it.
- The vault has no git transport; do not propose vault-side git.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
