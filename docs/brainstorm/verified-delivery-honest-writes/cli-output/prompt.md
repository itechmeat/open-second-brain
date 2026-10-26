You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release wave cycle-20261026 for Open Second Brain, branch `feat/verified-delivery-honest-writes`. Eight kanban cards, grouped into four implementation lanes that must have disjoint file sets. The wave theme: verified delivery and honest writes - every surface states what it measured, classified or refused instead of staying silent.

Lane A - delivery:
- `t_cb6a5558` Score-aware tail trim for delivered evidence that keeps query restatements. Today the context-pack comparator sorts tier above query relevance (`src/core/brain/context-pack.ts:925-948`) and the budget walker reports only `over-budget` skips (1205-1223), while the ranked-mode jaccard scorer (897-905) already computes query-term overlap. Upstream ships an opt-in trim with delivered-token telemetry.
- `t_f8510c55` Receipts that confirm injected memories appear in the agent reply. Delivery receipts stop at rendering (`src/core/brain/context-receipts.ts:149` records a final-text hash); a Claude Code Stop hook (`hooks/answer-quote-check.ts`, registered in `hooks/hooks.json:159`) already reads the turn's assistant messages and checks quoted spans against the injection ledger. Per-injected-note presence verdicts do not exist. The continuity ledger is append-only.

Lane B - export privacy:
- `t_b88c2190` Per-memory privacy markers honored by shared surfaces. Narrowed by the validator: the knowledge pack already blocks privacy-marked pages (`pageBlockReason`, `src/core/brain/portability/knowledge-pack.ts:421-436`); the one residual lane is the preferences bank/llms-txt export (`src/core/brain/export.ts`), which filters by status only. Teach it the existing deny markers (`visibility: private` token, informal `access`/`confidentiality`/`sensitivity` markers); do not invent a new privacy class.

Lane C - capture writes:
- `t_50794f57` One-command recovery for dead extraction writes. Dead letters (`src/core/brain/dead-letter.ts`, schema 1, lane union with one member) name the payload but carry no classifier and no command; `listDeadLetters` has zero non-test callers. The signal lane has no revision counter - concurrency is a content-derived dedup hash, so re-admission means re-running the recorded payload at current vault state. Retention rule: nothing deletes a letter.
- `t_dc782fd5` Standalone validation gate for hook-less agents. `brain lint` always exits 0 even with findings (`src/cli/brain/verbs/lint.ts:31`); doctor exits non-zero but is a whole-vault pass with no file selection. The write-receipt page-lint pass (`lintPagesWithContext`, `src/core/brain/page-lint.ts:863`) is directly callable over a path set; no git-dirty helper exists.

Lane D - operator surfaces:
- `t_9571a47f` Folder-level note moves with inbound link rewriting. Note lifecycle is per file; `src/core/brain/notes/lifecycle.ts:623` refuses any rename that changes directory. The rewrite engine `retargetWikilinks` already applies a list of path pairs in one vault walk. No folder verb exists.
- `t_cfe2ce5d` Status surfaces which process owns the memory store and that this caller is read-only. `isWriterLockHeld` (`src/core/search/store/writer-lock.ts:74`) is called by nothing in status; the lock is a bare `proper-lockfile` directory carrying no owner identity (mtime only). The operator snapshot (`src/core/brain/operator-snapshot.ts`) composes doctor, hygiene and state health with no store field.
- `t_8e49ec96` Doctor reports the installed version of each detected agent client. The `registered_commands` readiness probe (`src/core/doctor-readiness.ts`) only resolves executables into resolves/absent/unresolved; nothing reports a client's own version. Version probing must be read-only and fail soft (unknown on no answer).

# Project context

Open Second Brain - a memory layer for AI agents living in an Obsidian vault. Bun + TypeScript; tests via `bun test`; formatter `oxfmt`, linter `oxlint`; CLI `o2b`; MCP servers plus lifecycle hooks reach one core.

Recent commits:
- b784126f chore(deps): bump the github-actions group with 2 updates (#276)
- c435bee9 chore(deps-dev): bump the bun-minor-and-patch group with 2 updates (#275)
- 61a7ff1d feat: continuity promote - the host-memory readback path for mirrored host memory writes (v1.94.0) (#278)
- 3064defd feat: embedding-window chunk fit, sharded retirement links, decision-model provider chain and local thresholds, self-healing launchers (v1.93.0) (#274)
- 5572997d feat: write-time honesty and egress consent (v1.92.0) (#273)

Related files:
- src/core/brain/context-pack.ts, src/core/config.ts, src/mcp/brain/pack-tools.ts (Lane A, trim)
- hooks/answer-quote-check.ts, src/core/brain/continuity/types.ts, src/core/brain/context-receipts.ts, hooks/active-inject.ts (Lane A, presence)
- src/core/brain/export.ts, src/core/brain/portability/knowledge-pack.ts, src/core/brain/portability/bundle.ts (Lane B)
- src/core/brain/dead-letter.ts, src/core/brain/extract-signals.ts, src/core/brain/page-lint.ts (Lane C)
- src/core/brain/notes/lifecycle.ts, src/core/search/store/writer-lock.ts, src/core/brain/operator-snapshot.ts, src/core/doctor-readiness.ts (Lane D)
- CLI wiring shared by any new verb: src/cli/brain.ts, src/cli/brain/verbs/index.ts, src/cli/command-manifest.ts, src/cli/brain/help-text.ts

Conventions:
- Config flags: `resolveConfigFlag(envKey, configKey, configPath)`, default off, absent option byte-identical; MCP-first (no CLI flag follows the query_mode, packing-policy and entity-facts precedents).
- Closed vocabularies are census-registered; entries self-derive from the source constants, so extending a registered vocabulary needs no census edit, but a new vocabulary or a new continuity record kind does (a new kind requires a fold-decision row or the fold-decision census fails).
- Destructive verbs follow the consent ladder: dry-run default, `--apply` requiring `--yes` under `--json` or non-TTY, frozen-vault and vault-identity guards.
- Exports name every omission (v1.92.0 convention: `blocked` arrays, stderr omission notices in the `contentClassOmissionNotice` shape); nothing shrinks silently.
- Partial-failure doctrine: a rewrite that could not be written is named, never rolled back.
- New verbs are flat (`o2b brain dead-letters`, not nested nouns); manifest rows feed derived help and completions tests.

Constraints:
- The four lanes must own disjoint file sets; the four CLI wiring files above may be owned by at most one lane.
- No new external dependencies. No change to the locking strategy, the append-only continuity store, or the closed dead-letter lane union.
- Honest reporting: a fact not measured is reported as unknown, never inferred (lock owner, presence joins).

# Required output format

The wave has four lanes. For EACH lane, produce exactly 2 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the two variants of each lane, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the other, considering the project context and constraints above.

Output nothing outside of these sections.
