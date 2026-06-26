# Plan - per-task implementation (TDD)

Release scope (ship together, one PR, branch `feat/crossvault-cards-eventtrace-fixes`):

- `t_fd411665` (p3) - cross-vault cards merge
- `t_27ea0daa` (p1) - event-trace IO error exit code (+ MCP twin)
- `t_6fbdba4b` (p1) - registry-guard membership hygiene

Cards are driven one at a time on the shared branch; each commit builds on the
previous. Follow each section under TDD: failing test first, watch it fail,
minimal code, green.

## t_fd411665 - cross-vault cards-aware union

**Files:** `src/core/search/cross-vault.ts`; test `tests/core/search/cross-vault.test.ts`.

**Acceptance (failing test first):**
- `searchAcrossVaults(config, active, { query, limit, disclosure: "cards" })`
  with a recall source returns `outcome.cards` containing cards from BOTH
  origins, each carrying its `origin` label and an `origin:<label>` reason, and
  `outcome.results` is empty.
- `limit` caps the merged cards; `total` sums per-origin totals.
- Full mode (no `disclosure`) stays byte-identical (existing tests pass).
- Cards-mode chain-stop: a confident active origin (threshold 0) skips the
  remaining origins and records `chainStop` gated on the top CARD score.

**Steps:** add `labelledCard`; add a `mergedCards` accumulator in the loop;
derive `cardsMode`; gate chain-stop on the populated collection; return cards
(sorted/capped, `results: []`) in cards mode, results otherwise.

## t_27ea0daa - event-trace runtime IO error is exit 1, not exit 2

**Files:** `src/core/brain/event-trace.ts`, `src/cli/brain/verbs/event-trace.ts`,
`src/mcp/brain/pack-tools.ts`; tests `tests/cli/brain-event-trace.test.ts`,
`tests/mcp/event-trace-tool.test.ts`.

**Acceptance (failing test first):**
- An unreadable/erroring log dir makes the CLI verb exit 1 (runtime), while a
  bad `--date`/`--at`/`--kind` stays exit 2 (usage).
- The MCP tool maps the same runtime IO error to `INTERNAL_ERROR`, and a bad
  selector to `INVALID_PARAMS`.

**Steps:** export `EventTraceSelectorError`; throw it from the three pre-IO
selector checks (wrap `validateIsoDate`); branch on `instanceof` in both
catches.

## t_6fbdba4b - registry-guard exempt membership

**Files:** `src/mcp/registry-guard.ts`; test `tests/mcp/registry-guard.test.ts`.

**Acceptance (failing test first):**
- A tool named like an `Object.prototype` member (e.g. `toString`) with neither
  a budget nor an exempt entry is reported in `unbudgetedAndUnexempted` (today
  `in` falsely treats it exempt).

**Steps:** hoist `PREVIEW_BUDGET_EXEMPT_NAMES = new Set(Object.keys(...))`; use
`.has()` for the exempt check and the `exemptButUnknown` scan.

## Depends on

Independent fixes; no inter-task code dependency. Order chosen for smallest
review surface: event-trace, then cross-vault, then registry-guard.
