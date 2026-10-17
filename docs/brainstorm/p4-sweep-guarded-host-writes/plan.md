# p4-sweep-guarded-host-writes - implementation plan

## Tasks

### Cross-lane contract

File ownership is disjoint. Respect it strictly; a lane that needs a file another lane owns stops and renegotiates instead of editing.

| Lane | Cards | Owns (summary) |
|---|---|---|
| A - trust | t_b6bcd984, t_f4555087 | The three write lanes (install JSON-merge, protect, doctor repair), the core diff leaf, the PreToolUse host-settings backup hook, and src/core/config.ts (Lane A ONLY - no other lane touches it) |
| B - pagination | t_5198f0c7 | The core cursor helper, the 23 censused list-tool surfaces (tools.ts, query-tools.ts, search-tools.ts, recall-tools.ts, context-tools.ts, generation-tools.ts, pack-tools.ts, analytics-tools.ts, admin-tools.ts, lifecycle-file-tools.ts, knowledge-tools.ts), and the four census tests |
| C - Converse adapter | t_7ff0b101 | src/core/decision-model/** plus one egress site in src/core/egress/registry.ts, the provider docs and skill |
| D - trigger snooze | t_00e9de6a | src/core/brain/triggers/**, the trigger CLI/MCP projections (verbs/trigger.ts, help-text.ts trigger blocks, command-manifest.ts trigger block, workspace-tools.ts), the probe catalogue |

Sequencing rules:

1. Lane A lands its conventions and diff leaf (Task 1) before its three write lanes, and the backup hook (Tasks 5-7) only after the consent lanes: on the shared write path the order is consent, then backup, then write.
2. Lane B lands its helper (Task 8) before any tool batch; existing cursor surfaces (decisions history, brain_session_expand, brain_search_expand) and the core-only `paginateContinuityRecords` are read-only context - do not refactor them.
3. Lanes B, C, D are mutually independent and can start immediately; only Lane A has internal ordering.
4. Every commit that changes a censused surface updates the matching census test in the SAME commit (agent-scope-matrix, visibility-surface-census, reader-census, maintenance-parity-census).
5. The openclaw bundle (openclaw/index.js) is rebuilt by the integrator as the LAST commit after any src/ edit. Lanes do not commit it.
6. Every task is test-first: the Acceptance names the test file and what the failing test asserts; implementation follows the red test.
7. Conditional pickup, default defer: the `agent_scope` gap on brain_agent_diff/brain_writes may be added ONLY if Lane B finishes Task 11 early, routed through `coerceAgentScope` with the agent-scope-matrix census updated in the same commit. Default is defer.
8. Coordination points between lanes: help-text.ts and command-manifest.ts carry blocks from both Lane A and Lane D (disjoint blocks); registry-guard description ceilings apply to Lane B schema descriptions and the Lane D brain_trigger description alike (TOOL_DESCRIPTION_MAX = 300); CHANGELOG entries are per-lane, with Lane A writing the breaking-edge note for headless callers.

### Lane A - trust (cards t_b6bcd984, t_f4555087)

### Task 1: Core diff leaf and trust conventions
- **Files**: src/core/diff.ts (new; `renderUnifiedDiff` moved from src/cli/brain/upgrade-render.ts:65-88), src/cli/brain/upgrade-render.ts (re-export kept so upgrade/rollback keep working), tests/core/diff.test.ts (new), tests/core/trust-conventions.test.ts (new fixture test pinning the consent vocabulary `confirmed | refused | headless-refused`, the receipt-line schema (actor, pid, before-hash, summary plus a per-lane tail), and the timestamped backup-folder layout), src/cli/brain/verbs/upgrade.ts (unchanged; its ladder at 119-137 stays the canonical pattern).
- **Acceptance**: tests/core/diff.test.ts fails first, asserting the moved renderer emits `---`/`+++`/`-`/`+` lines for a small before/after pair; tests/core/trust-conventions.test.ts fails first, pinning the receipt shape and consent vocabulary as fixtures the three write lanes and the standalone hook must satisfy; tests/cli/brain-upgrade.test.ts must stay green (upgrade plan text still renders diffs through the re-export).
- **Depends on**: none.

### Task 2: Install JSON-merge consent and diff
- **Files**: src/core/install/types.ts (`InstallStep.diff?: string`, additive, at 77-81), src/core/install/adapters/_json-mcp.ts (`plan()` at 296-312 reads the on-disk raw file and computes `mergeMcpServers` before write, renders the diff; apply path 353-361 unchanged; drift guard 328-349 composes, never bypassed), src/cli/install/install.ts (`yes` in `parseInstallArgs` 97-136; gate in `runTarget` 407-419; refusal exit code pinned against `INSTALL_EXIT` 16-29), src/cli/install/render.ts (diff in plan output 122-141; consent verdict key in apply JSON 143-174, additive under `INSTALL_JSON_SCHEMA_VERSION = 1`), tests/cli/install-json-shape.test.ts (key-set pin update), install/*.md (`--yes` documented; byte-pinned human tables swept per render.ts:8-19).
- **Acceptance**: failing tests in tests/cli/install-verb.test.ts `describe("o2b install --target X --apply")`: "--apply in --json/non-TTY without --yes exits non-zero, names --yes, and leaves ~/.gemini/settings.json byte-identical"; "--apply --yes writes and the apply JSON carries the consent verdict"; "--plan prints a unified diff of the settings file"; and the existing "every exit code is distinct" assertion pins the refusal code.
- **Depends on**: Task 1.

### Task 3: Protect consent and diff
- **Files**: src/core/brain/protect.ts (split `applyClaudeCode` 468-516 into a compute step returning `{before, after, changed}` and the write; same for the codex fence path 540+; the existing `.bak.${Date.now()}` own-write backup at 503-507 untouched), src/cli/brain/verbs/protect.ts (`--yes` flag, fail-closed ladder before `applyProtect` at 29, diff render, consent key in the JSON at 30-37), src/cli/brain/help-text.ts (protect one-liner at 73), src/cli/command-manifest.ts (protect flags, ~335).
- **Acceptance**: failing tests in tests/cli/brain.test.ts `describe("brain protect")` (line 1516): "--apply without --yes in non-TTY refuses and settings.json is unchanged"; "--apply --yes writes, and the JSON carries the consent verdict and the backup path"; failing diff assertion at core level in tests/core/brain/protect.test.ts `describe("applyProtect claudecode")` (line 212) that the compute step returns before/after without writing.
- **Depends on**: Task 1.

### Task 4: Doctor repair consent, receipt verdict, and diff preview
- **Files**: src/cli/brain/verbs/doctor.ts (ladder at 151-165 for `--repair --apply`; `renderRepair` 386-418 renders the diff under dry-run), src/core/brain/diagnostics.ts (optional `Fixer.preview` at 1083-1089 implemented for walGap 1107 and orphanedReference 1158; consent field added to the doctor-repair event body 1542-1546; consent option threaded through `ApplyRepairOptions` 1384-1428), src/core/brain/types.ts (event kind doc 496-506), src/mcp/brain/health-tools.ts (handler 96-119 records provenance `caller-apply`; tool description 396-397 updated; no new required args - `apply: true` stays machine consent).
- **Acceptance**: failing tests in tests/cli/brain.test.ts doctor repair block (line 1250): "--repair --apply in non-TTY without --yes refuses before writing and logs no event"; "--repair --apply --yes writes and the doctor-repair event body carries the consent verdict"; failing event-body assertion in tests/core/brain.diagnostics.test.ts (171-230) for the `yes-flag` | `interactive-yes` | `caller-apply` vocabulary; failing MCP assertion that `apply: true` records `caller-apply` with an unchanged input schema; failing dry-run test that `brain doctor --repair` prints a unified diff (`---`/`+` lines) per fixable file for a staged wal-gap fixture.
- **Depends on**: Task 1.

### Task 5: Host-settings backup decision core
- **Files**: src/core/brain/pretool-host-backup.ts (new, pure: `decideHostBackup({runtime, toolName, toolInput, home, now})` - tilde expansion, cwd-relative join, `realpathSync` canonicalization, protected-path predicate over `~/.claude/settings.json`, `.claude/settings.local.json` and peers, excluding `.codex/config.toml` which protect's fence manages; plus the fail-closed backup executor over `compactRunStamp` src/core/brain/time.ts:129-137, `atomicCreateFileSyncExclusive` src/core/fs-atomic.ts:467, `collisionCandidateName` src/core/brain/paths.ts:980; receipt via `appendAuditRecord` src/core/reliability/audit.ts:30-39), tests/core/brain/pretool-host-backup.test.ts (new; precedent tests/core/brain/pretool-orient.test.ts).
- **Acceptance**: failing pure tests: a Write/Edit `tool_input.file_path` of `~/f/.claude/settings.json`, `f/.claude/settings.json` relative to cwd, and a symlinked settings path all resolve to the same canonical protected target; `.claude/settings.local.json` matches; unrelated paths return allow; two backups inside one second produce two distinct files (exclusive create, bounded attempts, then a typed error - never overwrite); a missing source file allows with no receipt; an unreadable source or failed copy returns a typed failure naming the path; success appends exactly one AuditRecord (actor, pid, before-hash, summary) matching the Task 1 receipt fixture.
- **Depends on**: Task 1 (receipt and backup-folder conventions pinned).

### Task 6: Hook wrapper and opt-in flag
- **Files**: hooks/pretool-host-backup.ts (new, copied structurally from hooks/pretool-orient.ts: flag check first, `armProcessCeiling`, `readHookInput`/`asHookPayload`, `decideHostBackup`, deny via `emitPermission` at pretool-orient.ts:127-136; stdlib-only - no core imports), src/core/config.ts (resolver `resolveConfigFlag("OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP", "host_settings_backup", configPath)` beside `resolveHookStrictEnabled` at 1597-1603; default OFF), tests/hooks/pretool-host-backup.test.ts (new; spawn pattern of tests/hooks/pretool-orient.test.ts:44-58 with `homeEnv` from tests/helpers/platform.ts:45).
- **Acceptance**: failing spawn tests: flag off emits nothing and exits 0 for a settings-targeting Write (byte-identical no-op, no ceiling armed); flag on plus a Write to `<tempHome>`/`.claude/settings.json` produces a backup file on disk, one receipt line, and allows the call; flag on plus a backup made to fail (target dir read-only) emits stdout `hookSpecificOutput.permissionDecision: "deny"` naming the path; a missing vault skips the receipt without denying.
- **Depends on**: Task 5.

### Task 7: Hook registration, mirror, docs, and CHANGELOG
- **Files**: hooks/hooks.json (one PreToolUse group appended after the orient group; matcher `Write|Edit|MultiEdit|apply_patch`; command ending `o2b-hook pretool-host-backup; exit 0`), plugins/codex/hooks/hooks.json (regenerated via scripts/sync-plugin-mirrors.ts), hooks/README.md (table row plus opt-in note including the fail-closed hard floor and the Bash-classification gap), CHANGELOG.md (the headless breaking edge for `doctor --repair --apply`, `protect --apply`, `install --apply` from Tasks 2-4), tests/hooks/hooks-json-shape.test.ts (new entry assertion).
- **Acceptance**: failing test in tests/hooks/hooks-json-shape.test.ts asserting the new PreToolUse entry exists with the write matcher and the o2b-hook command shape; tests/scripts/sync-plugin-mirrors.test.ts stays green after the mirror regeneration.
- **Depends on**: Tasks 2, 3, 4, 6 (lands last inside Lane A so the write path reads consent, then backup, then write, and the CHANGELOG can name all three breaking edges).

### Lane B - pagination (card t_5198f0c7)

### Task 8: Core offset-cursor helper
- **Files**: src/core/brain/offset-cursor.ts (new: `encodeOffsetCursor`/`decodeOffsetCursor` lifted from src/core/brain/decisions/receipts.ts:515-531 base64url form; `pageSlice(items, offset, limit, total)` returning `{items, total, next_cursor}`), src/core/brain/decisions/receipts.ts (`queryDecisionChangeHistory` re-pointed at the helper; wire encoding unchanged), tests/core/brain/offset-cursor.test.ts (new), tests/core/brain/decisions/receipts.test.ts (stays green at 95-126).
- **Acceptance**: failing tests in tests/core/brain/offset-cursor.test.ts: encode/decode round-trip; malformed cursor rejected (mirroring receipts.test.ts:123-126); an exhausted page returns `next_cursor: null` (mirroring receipts.test.ts:95-106); the decisions history walk is byte-identical before and after the re-point.
- **Depends on**: none.

### Task 9: Tier-A cursor rollout, batch 1
- **Files**: src/mcp/brain/query-tools.ts (brain_writes list at 361/:386-387; brain_agent_query at 308), src/mcp/brain/context-tools.ts (brain_write_session op=list at 169), src/mcp/brain/generation-tools.ts (brain_generation_reports at 124), src/mcp/brain/pack-tools.ts (brain_context_receipts at 509/:713; brain_event_trace at 800), and the per-tool tests/mcp files (brain-writes.test.ts, brain-write-session.test.ts, generation-reports-tool.test.ts, context-receipts-tool.test.ts, event-trace-tool.test.ts).
- **Acceptance**: failing per-tool tests: a `cursor` input property with a description (search-tools.ts:1997-2001 form, within registry-guard description ceilings); each page's `next_cursor` leads to the next and the pages reassemble the full set; the last page returns `next_cursor: null`; a malformed cursor is INVALID_PARAMS; assertions on `structuredContent` per the payload-expand.test.ts:101-111 pattern.
- **Depends on**: Task 8.

### Task 10: Tier-A cursor rollout, batch 2
- **Files**: src/mcp/tools.ts (second_brain_query 202-272: keep `total_pages`/`returned`, make the loop continue on cursor past the break at 262), src/mcp/brain/query-tools.ts (brain_unlinked_mentions 632-680), src/mcp/brain/analytics-tools.ts (brain_analytics view=timeline at 66), src/mcp/brain/admin-tools.ts (brain_maintenance journal at 390), src/mcp/brain/lifecycle-file-tools.ts (brain_scaffold_stub list at 276), plus their tests/mcp files.
- **Acceptance**: failing per-tool walk-and-reassemble tests as in Task 9; additionally for second_brain_query, a failing assertion that an initial call with a small limit returns both `total_pages`/`returned` AND `next_cursor`, and that following the cursor walks every page without duplicating entries.
- **Depends on**: Task 8 (can proceed in parallel with Task 9 once the helper lands; both touch query-tools.ts, so land them sequentially in one lane).

### Task 11: Tier-B census decisions and Tier-C non-goal
- **Files**: src/mcp/brain/recall-tools.ts (brain_session_grep at 972 gets a cursor - its matches are walkable; the remaining Tier-B tools keep limit), src/mcp/brain/knowledge-tools.ts (brain_truth events keep since-window paging, decision recorded beside knowledge-tools.ts:1449's documented convention), the recorded report-cap annotations for brain_recall_telemetry, brain_route_metrics, brain_token_impact, brain_context_pack_outcome, brain_knowledge_gaps, brain_deep_synthesis, brain_brief written beside the census tests, and the Tier-C rationale entry for brain_search and brain_file_context (ranking-stability: re-running a ranked query for page 2 races the index), plus tests/mcp/session-grep walk test and the census-guard assertion that fails on newcomers lacking either a cursor or a recorded cap.
- **Acceptance**: failing test that brain_session_grep walks matches by cursor to exhaustion; failing census-guard assertion that every Tier-A/B tool without a cursor carries the recorded report-cap annotation, and that brain_search and brain_file_context stay limit-only with the rationale pinned - so the gap is a decision, not an oversight, and a newcomer tool cannot land silently uncursored.
- **Depends on**: Task 8. Conditional pickup after this task: the brain_agent_diff/brain_writes `agent_scope` gap, only if the lane is ahead of schedule (see Cross-lane contract rule 7).

### Lane C - Converse adapter (card t_7ff0b101)

### Task 12: Union arm, factory case, and contract-suite route
- **Files**: src/core/decision-model/presets.ts (union at 34 gains `"converse"`), src/core/decision-model/provider.ts (case `"converse"` with a lazy require at 57-81; exhaustiveness makes typecheck the enforced registration point), tests/core/decision-model/contract-suite.test.ts (fourth `Route` in `ROUTES`: adapter name, path, `calibrated`, `encode()` mapping the adapter-neutral fixtures into the Converse reply shape, `errorBody` with the canary, `requestsOn422`).
- **Acceptance**: failing contract-suite run: the suite errors until the adapter exists, then pins the request path, the bearer header set only when a key resolves, the calibrated flag, and the full failure matrix (success, recomputed confidence, invalid probabilities, unknown keys, missing answer, non-JSON, 401 canary discipline, 422/429/529, reset, timeout, choice-limit refusal, oversized model id); `bun run typecheck` fails until the exhaustive switch arm exists.
- **Depends on**: none.

### Task 13: Converse adapter module
- **Files**: src/core/decision-model/converse.ts (new, standalone `implements DecisionProvider` in the llm-emulation.ts:66 pattern - the chat-shaped protocol cannot reuse the systemone field-rename hooks: build the request from `{state, questions}` (system/message content mapping, inference config), map the reply into the canonical answer shape, read camelCase usage, `redactForEgress` with `resolvedLiterals: [apiKey]`, `fenceUntrustedContent`, `redirect: "error"`, own `ping()`; compose transport.ts helpers `readAttempt`/`fetchFailure`/`decisionHttpError`/`withOneRetry`/`answeringModel`), tests/core/decision-model/converse.test.ts (new; loopback fake per tests/helpers/fake-decision-provider.ts, mapping plus preset-resolution pattern of vercel-evaluate.test.ts).
- **Acceptance**: failing tests: request and response mapping both ways against the loopback fake; the error-body canary never surfaces and a 401 names the env var NAME, never the value or body; invalid answers fail per item; an egress refusal sends nothing; oversized replies are drained unread per the 1 MiB `readAttempt` cap.
- **Depends on**: Task 12.

### Task 14: Preset, threshold profile, egress site, and docs
- **Files**: src/core/decision-model/presets.ts (preset entry in `DECISION_MODEL_PRESETS` 91-268, pattern vercel-evaluate at 182-199: name, adapter, baseUrl, model, envKey, ceilings, prices, `calibrated` decision, declared `thresholdProfile`, licence, processor; the calibration decision recorded in the preset comment - no `jev-1.13` borrowing without evidence), src/core/decision-model/questions.ts (profile registry entry at 111-120, or the recorded reuse decision), src/core/egress/registry.ts (site `decision-model-converse` after line 322, `R.sharedRedactor`, reason in the house style), tests/core/decision-model/presets-profiles.test.ts (resolver behaviour), tests/core/architecture/egress-census.test.ts (stays green), docs/decision-models/providers.md (table rows plus a `### converse` section), skills/decision-model-setup/SKILL.md and plugins/codex/skills/decision-model-setup/SKILL.md (kept byte-identical).
- **Acceptance**: failing tests in the presets-profiles style: `decision_model_provider: converse` resolves end-to-end through `resolveDecisionModelConfig` plus `makeDecisionProvider`; a key is required off-loopback; state clamps to the preset ceiling; profile borrowing is refused; `check` and `doctor` output list the new preset and profile; the egress-census test fails while the site is missing and passes after; `bun run build:openclaw` output is handed to the integrator for the final bundle commit.
- **Depends on**: Task 13.

### Lane D - trigger snooze (card t_00e9de6a)

### Task 15: Snooze status plumbing
- **Files**: src/core/brain/triggers/types.ts (`snoozed` in `TRIGGER_STATUS`/`TRIGGER_STATUSES` at 20-45; TERMINAL partition at 56-73; `TriggerRecord` fields `snoozedAt`/`snoozedUntil`/`snoozedFrom` at 121-159), src/core/brain/triggers/store.ts (`TRIGGER_KEY` entries `snoozed_at`/`snoozed_until`/`snoozed_from` at 91-106; renderer conditionals per the 131-138 pattern; refusing parsers per the `suppressedAt` pattern at 463-464), tests/core/brain/trigger-store.test.ts.
- **Acceptance**: failing round-trip test "a snoozed record round-trips through the Markdown file with snoozed_at/snoozed_until/snoozed_from" (pattern: trigger-store.test.ts:335 suppression round-trip); the partition-cover test at :173 passes only with `snoozed` in the terminal set; failing refusing-parser tests for each new frontmatter key (pattern: :422 - unreadable values raise `TriggerFieldError`, never silently default).
- **Depends on**: none.

### Task 16: Snooze transition and wake
- **Files**: src/core/brain/triggers/store.ts (`TriggerAction` gains `"snooze"` at 875; `ACTION_TO_STATUS` at 901-906; `transitionTriggerLocked` snooze arm at 931-959, legal from open states only, window from a new `TRIGGER_SNOOZE_DAYS` constant beside `TRIGGER_COOLDOWN_DAYS` at 60-62 - not a config key, Lane A owns src/core/config.ts; `effectiveStatus` wake arm at 382-389: restore `snoozedFrom` once `now > snoozedUntil` OR `lastSeenAt > snoozedAt`, re-applying expiry to the restored status; `blockReason` snoozed arm returning a new `SkippedCandidate.reason` value `"snoozed"` at 685-688, ordered before the open/terminal fallthrough so `recordRecurrence` keeps stamping), tests/core/brain/trigger-store.test.ts, tests/cli/brain-trigger.test.ts, tests/mcp/brain-trigger-tool.test.ts.
- **Acceptance**: failing tests: "snooze defers a trigger for a bounded window" (a blocked scan during the window records a recurrence with skip reason `snoozed`; after the window the original resurfaces with its ledger intact); "a snoozed trigger wakes early when the finding fires again" (`lastSeenAt > snoozedAt`); "snooze is refused on a terminal trigger" (refusal text at 945-947 names snoozed correctly); CLI verb routing (pattern tests/cli/brain-trigger.test.ts:174); MCP operation enum (pattern tests/mcp/brain-trigger-tool.test.ts:122).
- **Depends on**: Task 15.

### Task 17: Movement-gated resurrection
- **Files**: src/core/brain/triggers/store.ts (`blockReason` dismissed arm at 701-716 becomes movement-gated: unblock only when the candidate's `sourceArtifacts` differ from the twin's persisted set - order-insensitive comparison following the `deriveDatasetHash` convention from src/core/brain/derived-artifact.ts:44; `acted` keeps the plain cooldown window; legacy dismissed records with unchanged persisted artifacts stay blocked, and a missing fingerprint never reads as changed, per the neutral-absence convention src/core/content-hash.ts:66-74), tests/core/brain/trigger-store.test.ts.
- **Acceptance**: failing tests: "a dismissed trigger stays silent while its source artifacts are unchanged, however long" (after 8 days with identical artifacts the twin is still skipped, not recreated - extending the :85 test); "a dismissed trigger is recreated when the finding re-fires on changed source artifacts" (same cooldownKey, mutated `sourceArtifacts`, resurrection arrives as a new pending record); "an acted trigger still uses the plain cooldown window" (guards the scoped-out half); an order-insensitivity unit test for the artifact-set comparison.
- **Depends on**: Task 15 (shares `blockReason` with Task 16; land 15, 16, 17 in order inside the lane).

### Task 18: Surface sync and exhaustiveness
- **Files**: src/cli/brain/verbs/trigger.ts (`VERB_TO_ACTION` at 33-39; `triggerJson` at 55-74 gains the snooze fields; usage line at 53; skip-reason serialization at 115), src/cli/brain/help-text.ts (183 and 1361), src/cli/command-manifest.ts (607) - the three hand-maintained verb-list copies, src/mcp/brain/workspace-tools.ts (`TRIGGER_TRANSITIONS` at 140-146; `triggerToJson` at 118-137; tool description at 324 within `TOOL_DESCRIPTION_MAX = 300`), tests/helpers/tool-probe-catalogue.ts (1068), tests/core/brain/triggers (new exhaustiveness test), tests/cli/brain-trigger.test.ts, tests/mcp/brain-trigger-tool.test.ts.
- **Acceptance**: failing exhaustiveness test that `TRIGGER_TRANSITIONS` covers every `TriggerAction` (the array type does not enforce it); failing assertions that the CLI usage line, both help-text blocks, the manifest, and the probe catalogue all know `snooze`; failing JSON projection tests that `triggerJson`/`triggerToJson` carry the snooze fields and the new skip reason; registry-guard stays green on the description ceiling.
- **Depends on**: Task 16.
