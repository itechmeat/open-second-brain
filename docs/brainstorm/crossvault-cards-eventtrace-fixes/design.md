# Design - Cross-vault cards, event-trace exit codes, registry-guard hygiene

## Problem

Three follow-ups deferred from the v1.18.0 CodeRabbit review on PR #110, all
correctness/hygiene gaps on primary paths:

1. **Cross-vault search drops `disclosure: "cards"` results (t_fd411665).**
   In `--global` mode a cards-mode search returns nothing. Single-vault
   `search()` in cards mode puts hits on `outcome.cards` and leaves
   `outcome.results` empty; `searchAcrossVaults` only merges and ranks
   `outcome.results`, so every origin's cards are dropped and the union is
   empty. Cards mode is the recommended token-cheap first layer, so the gap
   sits on a primary recall path. The chain-stop also no-ops in cards mode
   because it gates on `results`.

2. **A genuine IO error from event-trace surfaces as a usage error
   (t_27ea0daa).** `cmdBrainEventTrace`'s blanket `catch` maps ANY throw from
   `resolveLogEventTraces` to `usageError` (exit 2). That is correct for the
   selector checks (`--date` / `--at` / `--kind`) which run before any IO,
   but `readLogDay -> listLogShardFiles` calls `readdirSync` guarded only by
   `existsSync`: an existing-but-unreadable log dir (EACCES) or an EIO is a
   runtime failure that must be exit 1, not exit 2. The MCP twin
   `toolBrainEventTrace` has the identical blanket catch, mapping a runtime IO
   error to `INVALID_PARAMS` instead of an internal error.

3. **Registry-guard membership check uses the `in` operator (t_6fbdba4b).**
   `auditPreviewBudgets` tests exemption with `tool.name in
   PREVIEW_BUDGET_EXEMPT` and recomputes `Object.keys(...)` on every call.
   `in` walks the prototype chain, so a tool whose name collides with an
   `Object.prototype` member (`constructor`, `toString`, `hasOwnProperty`, ...)
   is falsely reported exempt; the per-call `Object.keys` is avoidable work.

## Scope

- `src/core/search/cross-vault.ts` - make `searchAcrossVaults` cards-aware.
- `src/core/brain/event-trace.ts` - tag selector-validation errors with a
  distinct error type.
- `src/cli/brain/verbs/event-trace.ts` - route selector errors to exit 2 and
  runtime errors to exit 1.
- `src/mcp/brain/pack-tools.ts` - route the MCP twin's selector errors to
  `INVALID_PARAMS` and runtime errors to `INTERNAL_ERROR`.
- `src/mcp/registry-guard.ts` - hoist the exempt-name set once; use own-key
  membership instead of `in`.

## Out of scope

- No change to single-vault cards semantics, `expandHit` layers, or the
  progressive-disclosure grammar.
- No change to the continuity store, the log shard format, or selector syntax.
- No new MCP tools, flags, or output fields beyond making `cards` flow through
  the union (the `SearchCard.origin` field already exists).

## Chosen approach (Variant B - focused per-seam fixes)

1. **Cross-vault cards.** Accumulate each origin's `outcome.cards` into a
   `mergedCards` array, labelled by origin via a `labelledCard` helper that
   mirrors the existing `labelled` (sets `origin` and an `origin:<label>`
   reason). Detect cards mode from `opts.disclosure === "cards"`. The
   chain-stop gate reads the active origin's top score over whichever
   collection is populated (cards in cards mode, results otherwise). On return:
   full mode is byte-identical to today (`results` capped, no `cards`); cards
   mode returns sorted/capped `cards` with `results` empty, mirroring
   single-vault semantics. A shared comparator orders by score desc, then
   origin label, path, chunk id.

2. **Event-trace error classification.** Introduce
   `EventTraceSelectorError extends Error` in `event-trace.ts`. The three
   selector checks (`validateIsoDate` wrap, `--at` format, `--kind` membership)
   throw it; nothing on the IO path does. The CLI verb catch returns
   `usageError` (exit 2) for `EventTraceSelectorError` and `fail` (exit 1)
   otherwise. The MCP handler returns `INVALID_PARAMS` for the selector error
   and `INTERNAL_ERROR` otherwise.

3. **Registry-guard hygiene.** Precompute
   `PREVIEW_BUDGET_EXEMPT_NAMES = new Set(Object.keys(PREVIEW_BUDGET_EXEMPT))`
   at module load and use `.has()` for membership; reuse it for the
   `exemptButUnknown` scan. This removes the per-call `Object.keys` and the
   prototype-chain false positive in one change.

## Design decisions

- **One shared selector-error type for both event-trace entry points.** The
  CLI verb and the MCP tool wrap the same resolver and had the same blanket
  catch; classifying once in the resolver fixes both without duplicating
  format-validation logic. (Avoids a cheap one-surface-only fix.)
- **Cards flow through the existing union, not a parallel function.** The
  read-only invariants, session-focus resolution, and chain-stop policy are
  identical for cards and full mode; only the collection being merged differs.
- **`Set` over `Object.hasOwn`.** Both fix the prototype gotcha; the hoisted
  `Set` additionally removes the repeated `Object.keys` allocation.

## File changes

| File | Change |
|---|---|
| `src/core/search/cross-vault.ts` | cards accumulator + `labelledCard` + card comparator; cards-mode chain-stop gate and return shape |
| `src/core/brain/event-trace.ts` | export `EventTraceSelectorError`; selector checks throw it |
| `src/cli/brain/verbs/event-trace.ts` | catch routes selector vs runtime to exit 2 vs exit 1 |
| `src/mcp/brain/pack-tools.ts` | catch routes selector vs runtime to `INVALID_PARAMS` vs `INTERNAL_ERROR` |
| `src/mcp/registry-guard.ts` | hoisted exempt-name `Set`; `.has()` membership |

## Risks

- **Cross-vault return-shape regression.** Mitigated: full mode must stay
  byte-identical; covered by the existing union tests plus a new cards-mode
  test asserting `results` empty and `cards` labelled per origin.
- **Mis-tagging a runtime error as a selector error (or vice versa).** Mitigated
  by throwing the typed error ONLY in the three pre-IO checks and asserting an
  EACCES/EIO surfaces as exit 1 / `INTERNAL_ERROR` in tests.
- **A real tool legitimately named like a prototype member.** None exists today;
  the `Set` makes the guard correct if one is ever added.
