# Memory subsystem alignment — design

## Problem

Open Second Brain declares itself as a Hermes memory provider, but its memory-write path is not aligned with the live Hermes memory semantics that motivated this release. `brain_pinned_context` currently accepts oversized content as a successful write while `sanitiseTextField` silently truncates it, writer tools are single-operation surfaces that cannot consolidate and add in one atomic turn, and the declared `on_memory_write` hook has no implementation.

That combination creates misleading success responses and prevents the vault from acting as the durable backing store for native host memory writes. The release must make budget handling honest, add atomic batch writes, and connect the host bridge without letting any partial write or guessed hook contract masquerade as success.

## Scope

In scope for this release:

- `t_64ec5bbd` — make pinned-context budget handling explicit instead of silently truncating.
- `t_c492e539` — add atomic batch writes for pinned context and continuity append flows.
- `t_5e06b572` — implement the Hermes `on_memory_write` bridge after verifying the exact host contract.

The cards ship together on branch `feat/memory-subsystem-alignment` and must be driven one at a time on the shared branch so later workers build on prior commits.

## Out of scope

- Replacing the vault-first Markdown/JSONL storage model.
- Adding LLM calls, semantic merging, or provider-specific logic inside the core.
- Rewriting unrelated memory tools, search, dream, hygiene, or recall behavior.
- Changing behavior for callers that stay within current single-operation budgets unless the new response fields are explicitly relevant.
- Dispatching cards from triage during Phase 0.

## Chosen approach

Chosen variant: Variant 1 — Shared budget-aware write engine.

Introduce a deterministic core memory-write module that centralizes budget accounting, operation validation, all-or-nothing application, and terminal/idempotent success metadata. Existing pinned-context and continuity writers become consumers of that primitive, and the Hermes `on_memory_write` hook becomes a thin adapter that maps the verified host payload into the same batch substrate.

I agree with the consultant recommendation. The release is about alignment across memory paths, so duplicating budget and atomicity rules per surface would recreate the drift this release is meant to remove. A shared primitive also preserves the strategic sequencing: budget honesty first, atomic batch substrate second, bridge adapter third.

## Design decisions

1. Centralize budget semantics in core, not MCP or plugin glue.
   - The core should expose an explicit outcome for normalized content that exceeds the pinned-context budget.
   - Oversized writes must fail as `budget_exceeded` and must not mutate `Brain/pinned.md`.
   - The failure metadata must include operation name, original size, normalized size, allowed budget, persisted size (unchanged/current), and a retry/consolidation hint.

2. Batch validation happens before mutation.
   - An `operations` array is validated in order against the final projected state.
   - A malformed operation, invalid replace target, or over-budget final state aborts the whole batch.
   - Tests must prove the on-disk store is unchanged when a middle operation fails.

3. Pinned context owns ordered text operations.
   - Preserve existing `read`, `write`, `append`, and `clear` behavior for callers that do not pass `operations`.
   - Add an ordered batch mode covering `write`, `append`, `clear`, and targeted `replace` segment operations.
   - Return terminal/idempotent success metadata so agents do not repeat successful writes.

4. Continuity owns append batches under one lock.
   - Add a batch append function that builds every record first, acquires the month lock once per affected shard, and appends only after validation succeeds.
   - Keep single-record append output byte-identical for existing callers.
   - If a batch can span months, group by shard deterministically and document the atomicity boundary; prefer same-call validation before any write and tests that cover the expected boundary.

5. The bridge is host-contract-first.
   - Before implementation, verify `on_memory_write` registration, payload shape, operation names, batch semantics, and success response contract against Hermes source and PRs #48507/#48262.
   - The plugin handler must be a thin adapter over the shared batch primitive, not an independent writer engine.
   - If the host never invokes the hook, behavior remains a no-op with no startup side effects.

6. No misleading fallbacks.
   - Unknown bridge payloads, invalid operations, partial writes, or budget overflows fail explicitly.
   - Do not silently drop fields, guess operation names, or translate unsupported host requests into approximate local writes.

## File changes

Expected implementation areas:

- `src/core/brain/pinned.ts` — budget-aware normalize/apply result, ordered pinned-context operations.
- `src/core/brain/memory-write.ts` or `src/core/brain/memory-write/` — shared budget and ordered-operation helper if implementation needs a separate module; otherwise keep the helper private to `pinned.ts` until a second consumer requires extraction.
- `src/core/redactor.ts` — keep generic sanitization behavior stable; avoid making global text-field sanitization throw for all callers unless all downstream impact is audited.
- `src/mcp/brain/context-tools.ts` — expose optional `operations` mode and serialize explicit budget/terminal metadata.
- `src/core/brain/continuity/store.ts` — add atomic batch append substrate while preserving single append behavior.
- `src/core/brain/continuity/types.ts` — add any required typed payload/record inputs without breaking current record shape.
- `plugins/hermes/provider.py` — implement the verified `on_memory_write` hook on `OpenSecondBrainMemoryProvider` as the host-facing adapter.
- `plugins/hermes/_base.py` — keep the local fallback `MemoryProvider` signature aligned with the verified hook contract for non-Hermes tests.
- `plugins/hermes/bridge.py` — extend the Python-to-TypeScript bridge only if the hook needs a dedicated tool call or typed adapter beyond existing `call_tool`.
- `plugins/hermes/__init__.py` — change only if provider registration/export wiring must expose the new hook differently; no independent write logic belongs here.
- `plugin.yaml` and `plugins/hermes/plugin.yaml` — keep hook declaration consistent; adjust only if contract verification requires metadata changes.
- Tests under `tests/` covering budget honesty, pinned batch atomicity, continuity batch atomicity, bridge persistence/no-op behavior, and fallback signature compatibility.

## Risks

- Hermes hook contract risk: the live `on_memory_write` payload may differ from assumptions in card text. Mitigation: make contract verification the first step of `t_5e06b572` and do not code the bridge from guesses.
- Atomicity boundary risk: continuity JSONL batches may span month shards. Mitigation: validate all records before writes, group deterministically, and document/test the supported atomicity boundary.
- Compatibility risk: existing agents may expect `brain_pinned_context` success for large input. Mitigation: keep within-budget behavior unchanged and surface explicit machine-readable budget failure for oversized input.
- Abstraction risk: a shared engine can become too broad. Mitigation: keep it narrow: budget accounting, operation validation, batch application, and result metadata only.
