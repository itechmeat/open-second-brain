# vault-care-bundle - implementation plan

Eight atomic TDD units in the order the chosen variant requires. Each unit ends with a passing-test green bar and a conventional commit on `feat/vault-care-bundle`. The bundle ships as v0.10.15.

## Tasks

### Task 1: F7 - NFKC + casefold dedup normaliser (`text/normalize.ts`)

- **Files**:
  - new: `src/core/brain/text/normalize.ts`
  - modified: `src/core/brain/dedup-hash.ts` (swap inline `normalize("NFC")` → call `normalizeForDedup`)
  - new tests: `tests/core/brain/text/normalize.test.ts`, `tests/core/brain/dedup-hash-unicode.test.ts`
- **Acceptance**: `bun test tests/core/brain/text/normalize.test.ts tests/core/brain/dedup-hash-unicode.test.ts` green. Regression cases: fullwidth `Ａ` vs halfwidth `A` produce identical hash; CJK `テスト` survives normalisation without collapsing to empty string; uppercase / lowercase variants of the same principle produce identical hash. All existing dedup tests still pass.
- **Depends on**: none.
- **Commit**: `feat(brain): unicode-aware dedup normalisation (NFKC + casefold)`

### Task 2: F1 - confidence + lifecycle frontmatter atoms (`page-meta/`)

- **Files**:
  - new: `src/core/brain/page-meta/lifecycle.ts`, `src/core/brain/page-meta/confidence.ts`
  - modified: `src/core/brain/preference.ts` (emit `_lifecycle` next to `_confidence`)
  - modified: `src/cli/brain/verbs/migrate-frontmatter.ts` (add `_lifecycle: stable` to legacy pages)
  - new tests: `tests/core/brain/page-meta/lifecycle.test.ts`, augment `tests/cli/brain/migrate-frontmatter.test.ts`
- **Acceptance**: New preferences carry `_lifecycle: stable` by default. Migration adds the field to legacy pages idempotently (byte-identical second run). `isStale()` returns true for `lifecycle: stable` pages older than 180 days. All existing preference tests still pass.
- **Depends on**: none.
- **Commit**: `feat(brain): per-page confidence and lifecycle frontmatter`

### Task 3: F2 - tier frontmatter + ranker weighting

- **Files**:
  - new: `src/core/brain/page-meta/tier.ts`
  - modified: `src/core/search/ranker.ts` (extend `RankerInputs` with `tierByDoc`, apply `tierWeight()` multiplier in `rankResults`)
  - modified: `src/core/brain/preference.ts` (accept `tier?` input, default `supporting`)
  - modified: `src/cli/brain/verbs/migrate-frontmatter.ts` (add `tier: supporting` to legacy pages)
  - new tests: `tests/core/brain/page-meta/tier.test.ts`, `tests/core/search/ranker-tier.test.ts`
- **Acceptance**: Ranker multiplies the candidate score by `tierWeight()` (core=1.4, supporting=1.0, peripheral=0.6). When every input is `supporting` (default) the ranker output is bit-identical to pre-change behaviour. Tests pin both regressions.
- **Depends on**: Task 2 (migrate sweep shares the same verb).
- **Commit**: `feat(brain): page importance tier with ranker weighting`

### Task 4: F3 - page-level dedup + wikilink patcher

- **Files**:
  - new: `src/core/brain/page-meta/page-id.ts`
  - new: `src/core/brain/page-dedup.ts`
  - new: `src/cli/brain/verbs/page-dedup.ts`
  - modified: `src/cli/brain/verbs/index.ts` (register verb)
  - modified: `src/cli/brain/verbs/migrate-frontmatter.ts` (recognise existing `merged_into:` pointers)
  - new tests: `tests/core/brain/page-meta/page-id.test.ts`, `tests/core/brain/page-dedup.test.ts`, `tests/cli/brain/page-dedup.test.ts`
- **Acceptance**: `findDuplicateCandidates` reports near-dup pairs using `normalizeForDedup` on titles + body fingerprint. `mergePage(secondary, canonical)` writes `merged_into: <id>` to secondary and rewrites every `[[secondary-title]]` reference across the vault. Cycle detection trips at depth 5. Dry-run mode emits diff without touching files.
- **Depends on**: Task 1 (uses `normalizeForDedup`), Task 2 (skips pages with `lifecycle: archived`).
- **Commit**: `feat(brain): page-level dedup with wikilink repatching`

### Task 5: F5 - token footprint monitor

- **Files**:
  - new: `src/core/brain/text/tokenizer.ts`
  - new: `src/core/brain/token-footprint.ts`
  - new: `src/cli/brain/verbs/token-footprint.ts`
  - modified: `src/cli/brain/verbs/index.ts` (register verb)
  - modified: `src/core/brain/digest.ts` (add `tokenFootprint` section to digest payload)
  - new tests: `tests/core/brain/text/tokenizer.test.ts`, `tests/core/brain/token-footprint.test.ts`, `tests/cli/brain/token-footprint.test.ts`
- **Acceptance**: `estimateTokens()` returns word-count × 1.3 with CJK-block adjustment; deterministic. `computeTokenFootprint(vault)` returns per-category counts (preferences, signals, retired, daily, other). Digest output includes `Token footprint` section with `total`, `byCategory`, `exceededWarnThreshold` boolean. Default threshold 200_000, overridable via `BRAIN_TOKEN_WARN_THRESHOLD` env var.
- **Depends on**: none (introduces tokenizer that later tasks reuse).
- **Commit**: `feat(brain): vault token footprint monitor`

### Task 6: F6 - bounded-token context pack

- **Files**:
  - new: `src/core/brain/context-pack.ts`
  - new: `src/cli/brain/verbs/context-pack.ts`
  - modified: `src/cli/brain/verbs/index.ts` (register verb)
  - modified: `src/mcp/brain-tools.ts` (register `brain_context_pack` MCP tool)
  - new tests: `tests/core/brain/context-pack.test.ts`, `tests/cli/brain/context-pack.test.ts`, `tests/mcp/context-pack-tool.test.ts`
- **Acceptance**: `packContext(vault, { maxTokens: 5000 })` returns a slice ordered by tier (core → supporting → peripheral) then by recency, stops adding pages when next page would exceed budget. Result payload includes `tokensUsed`, `pagesIncluded`, `pagesSkipped`. MCP tool exposes same with JSON-RPC shape consistent with existing `brain_context`.
- **Depends on**: Task 3 (tier), Task 5 (tokenizer).
- **Commit**: `feat(brain): brain_context_pack with token budget`

### Task 7: F4 - self-healing lint --consolidate

- **Files**:
  - new: `src/core/brain/lint-consolidate.ts`
  - new: `src/cli/brain/verbs/lint.ts`
  - modified: `src/cli/brain/verbs/index.ts` (register verb)
  - new tests: `tests/core/brain/lint-consolidate.test.ts`, `tests/cli/brain/lint.test.ts`
- **Acceptance**: `o2b brain lint --consolidate` performs detection-only by default; emits a structured diff (`fixes`, `demotions`, `alias-normalisations`). `--apply` performs writes idempotently (second run = no-op). Lifecycle demotion only triggers on `stable` + age > 180 days + zero recent reapplies. Broken-link fix follows `merged_into` chains. Tag aliases normalise via `normalizeForDedup`.
- **Depends on**: Task 1 (normaliser), Task 2 (lifecycle), Task 4 (page-id resolution).
- **Commit**: `feat(brain): self-healing lint --consolidate with dry-run`

### Task 8: F8 - ranked maintenance action list

- **Files**:
  - new: `src/core/brain/maintenance/action-scorer.ts`
  - modified: `src/core/brain/digest.ts` (add `## Actions` section)
  - modified: `src/core/brain/doctor.ts` (emit `suggested_actions:` block)
  - new tests: `tests/core/brain/maintenance/action-scorer.test.ts`, `tests/core/brain/digest-actions.test.ts`
- **Acceptance**: Action scorer takes inputs `{ orphans, staleByLifecycle, dedupCandidates, tokenFootprintExceeded, brokenLinks }` and returns top-N actions ranked by impact score. Each action has `id`, `title`, `impact` (number), `category`, `target` (path or id). Empty input → empty list (no spurious entries). Digest renders the top 10 as a Markdown bullet list; doctor surfaces same as YAML block.
- **Depends on**: Task 4 (dedup candidates), Task 5 (footprint), Task 7 (broken links via lint).
- **Commit**: `feat(brain): ranked maintenance action list in digest and doctor`

## Post-implementation tasks

### Task 9: Phase 3 self-review pass

- Run `superpowers:requesting-code-review` on the branch; apply auto-fix findings.
- Run `superpowers:verification-before-completion`; capture command output for each "feature works" claim.
- Commit: `chore: address self-review findings` (only if anything needed fixing).

### Task 10: Phase 4 QA

- `bun test` - full suite green.
- `bun run typecheck` - no errors.
- `bun run lint` - clean.
- Manual smoke: run each new CLI verb against a tmpdir vault, confirm output shape.

### Task 11: Phase 5 docs

- `README.md` - new "Vault care" paragraph in the features list.
- `CHANGELOG.md` - new `[0.10.15]` entry with capability-first summary + Added / Changed / Notes.
- No `[Unreleased]` placeholder.

### Task 12: Phase 6 PR + auto-merge

- Stop-point: operator confirms diff summary.
- `git push -u origin feat/vault-care-bundle`.
- `gh pr create` with mermaid diagram + capability summary.
- `gh pr merge --auto --squash --delete-branch`.

### Task 13: Phase 7-8 CodeRabbit + merge wait

- Apply CodeRabbit findings if any; commit `fix: address CodeRabbit review feedback`.
- Poll `gh pr view --json state,reviewDecision` until `MERGED`.

### Task 14: Phase 9 release

- Bump `package.json` 0.10.14 → 0.10.15.
- Generate excalidraw → PNG: three-layer diagram showing atoms → helpers → consumers.
- Stop-point: operator confirms release title + body.
- `gh release create v0.10.15` with PNG + excalidraw assets.

### Task 15: Phase 10 tracker tick + kanban close

- Add entry #38 to `/root/vault/Projects/OpenSecondBrain/Features/_summary.md`.
- `brain_note`: release shipped.
- Direct SQL UPDATE on kanban DB: move `t_5de021f1`, `t_3d157e9b`, `t_e0d65daa`, `t_55bd528a`, `t_68e65e77`, `t_31c16ba2`, `t_2e7e3b8d`, `t_8dd35d10` from `triage` to `done` with `completed` events, summary referencing release URL.
