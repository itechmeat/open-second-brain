# Workspace Insight Suite - implementation plan

One feature branch (`feat/workspace-insight-suite`), one conventional commit per task, formatter + linter green before every commit. TDD: failing test first, implement, refactor.

## Tasks

### Task 1: Kernel A - pointer discovery + project links (t_1375e69f, part 1)
- **Files**: `src/core/brain/portability/pointer.ts` (new), `src/core/config.ts` (resolveVault hook), `src/cli/brain/verbs/project.ts` (new), `src/cli/brain/verbs/index.ts`, `src/cli/brain/brain.ts`, `src/cli/command-manifest.ts`, `tests/core/brain/pointer.test.ts`, `tests/cli/project-verb.test.ts`
- **Acceptance**: `o2b brain project link <path> --vault <v>` writes `.o2b-vault.json`; `resolveVault` from a linked (or nested) cwd returns the pointed vault; env `VAULT_DIR` still wins; malformed pointer is skipped fail-soft and reported by `project status`; self-link (path inside the vault) refused; `list/remove/status` work.
- **Depends on**: none

### Task 2: Kernel A - read-only recall sources registry (t_1375e69f, part 2)
- **Files**: `src/core/brain/portability/recall-sources.ts` (new), `src/cli/brain/verbs/source.ts` (new), CLI registration files, `tests/core/brain/recall-sources.test.ts`, `tests/cli/source-verb.test.ts`
- **Acceptance**: `source add <vault> --alias <name>` validates (vault exists, alias unique, not the active vault, no duplicate path, refuses direct circular reference); `list` marks broken targets; `remove` works; registry file has stable key order and tolerant reads.
- **Depends on**: none

### Task 3: Kernel A - origins enumerator + cross-vault search (t_72a22658)
- **Files**: `src/core/brain/portability/origins.ts` (new), `src/core/search/cross-vault.ts` (new), `src/core/search/types.ts` (+`origin?`), `src/cli/search.ts` (`--global`), `src/mcp/search-tools.ts` (`global` input), `tests/core/search/cross-vault.test.ts`, `tests/mcp/search-global.test.ts`
- **Acceptance**: `listSearchOrigins` returns active + profiles + sources deduped by real path; union search merges results by score with `origin:<alias>` reason and `origin` field; an origin without an index yields a warning, not an error; default (no flag) path byte-identical to before.
- **Depends on**: Task 2

### Task 4: wikilink format kernel + normalize verb (t_5f31b5f1)
- **Files**: `src/core/brain/link-graph/format-wikilink.ts` (new), `src/core/config.ts` (`wiki_link_format` helper), `src/cli/brain/verbs/links.ts` (new), CLI registration, `tests/core/brain/format-wikilink.test.ts`, `tests/cli/links-verb.test.ts`
- **Acceptance**: `formatWikilink`/`normalizeWikilinks` pure functions handle target/anchor/block/alias round-trips; `full` rewrites to vault-relative key path; `short` computes shortest unambiguous suffix from known paths and leaves ambiguous links untouched; `preserve` is byte-identical; code blocks and media links untouched; verb dry-runs by default, `--write` applies.
- **Depends on**: none

### Task 5: shell-native surface - profile.md + sgrep + marker (t_323a9a83)
- **Files**: `src/core/brain/profile-doc.ts` (new), `src/cli/brain/verbs/profile.ts` (new), `src/cli/brain/verbs/sgrep.ts` (new), CLI registration, `tests/core/brain/profile-doc.test.ts`, `tests/cli/sgrep-verb.test.ts`
- **Acceptance**: `buildProfileDoc` assembles digest (facts, top preferences, recent activity, generated_at) without walking every vault file; `o2b brain profile` writes `Brain/profile.md` + `.o2bfs` marker and regenerates only when stale (age or `--force`); `sgrep` prints `path:line: snippet` lines, scopes by path argument, supports `--json`.
- **Depends on**: none

### Task 6: Kernel B - trigger queue with lifecycle (t_cd1fee79)
- **Files**: `src/core/brain/triggers/types.ts`, `store.ts`, `scan.ts`, `adapters.ts` (new), `src/core/brain/morning-brief.ts` (pending section), `src/core/config.ts` (cooldown helper), `src/cli/brain/verbs/trigger.ts` (new), CLI registration, `src/mcp/brain-tools.ts` (`brain_trigger`), `src/mcp/registry-guard.ts`, `tests/core/brain/trigger-store.test.ts`, `tests/core/brain/trigger-scan.test.ts`, `tests/mcp/brain-trigger-tool.test.ts`
- **Acceptance**: candidates from health/retention/stale adapters persist as `Brain/triggers/<id>.md` with full frontmatter; repeated scans are idempotent (cooldown-key dedup across all statuses); transitions pending→delivered→acknowledged/acted/dismissed enforced, expiry honoured; dismissed stays silent during cooldown; morning brief lists capped pending triggers and marks them delivered; CLI list/ack/dismiss/act/history and MCP operations mirror each other.
- **Depends on**: none

### Task 7: deep vault synthesis (t_04e94382)
- **Files**: `src/core/brain/deep-synthesis.ts` (new), `src/cli/brain/verbs/synthesis.ts` (new), CLI registration, `src/mcp/brain-tools.ts` (`brain_deep_synthesis`), `tests/core/brain/deep-synthesis.test.ts`, `tests/mcp/deep-synthesis-tool.test.ts`
- **Acceptance**: topic dossier lists matched notes, contradictions (typed relations), stale claims (superseded or aged), gaps (dangling link targets, unanswered open questions); dossier states checked dimensions; contradiction/gap findings convert to `InsightCandidate`s and `--triggers` enqueues them via the Task 6 store.
- **Depends on**: Task 6

### Task 8: idea discovery (t_8722a62a)
- **Files**: `src/core/brain/idea-discovery.ts` (new), `src/cli/brain/verbs/ideas.ts` (new), CLI registration, `src/mcp/brain-tools.ts` (`brain_idea_discovery`), `tests/core/brain/idea-discovery.test.ts`, `tests/mcp/idea-discovery-tool.test.ts`
- **Acceptance**: ranked candidates from orphan notes (low inbound links), open questions, aging inbox signals; deterministic scoring documented in the module; top 3-5 returned; `--triggers` enqueues into the queue.
- **Depends on**: Task 6

### Task 9: recall-gate telemetry (t_65036e02)
- **Files**: `src/core/brain/gate-telemetry.ts` (new), `src/core/config.ts` (`recall_gate_telemetry` helper), `src/mcp/search-tools.ts` (gate handler emission), `src/mcp/brain-tools.ts` or existing telemetry tool (gate summary section), `tests/core/brain/gate-telemetry.test.ts`, `tests/mcp/recall-gate-telemetry.test.ts`
- **Acceptance**: gate handler emits `gate_telemetry` continuity record (decision, reason, prompt hash, host) only when the key is on; off by default leaves behaviour byte-identical; summary aggregates by decision/reason; raw prompt never stored.
- **Depends on**: none

### Task 10: e2e integration + docs
- **Files**: `tests/e2e/workspace-insight.integration.test.ts` (new), `tests/mcp/mcp.test.ts` (contract: +3 tools), `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/how-it-works.md`
- **Acceptance**: one e2e flow exercises project link → cross-vault search with origins → trigger scan → ack → brief inclusion; MCP contract test passes with the new advertised list; docs describe all eight capabilities.
- **Depends on**: Tasks 1-9
