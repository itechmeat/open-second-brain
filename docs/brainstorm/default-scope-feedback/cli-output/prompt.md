# Consultant prompt: configurable default_scope for feedback signals

You are consulting on Open Second Brain, a TypeScript/Bun project that provides an Obsidian-native memory layer for AI agents through CLI and MCP tools.

Return exactly 3 distinct architectural variants for the locked scope below. For each variant use this exact structure:

## Variant N: <name>
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
- <bullet>
Complexity: small|medium|large
Risk: low|medium|high

Then return exactly one recommendation section:

## Recommended: Variant N
Rationale: <why>

Variants plus recommendation only. No code. No extra sections outside those sections.

## Locked scope

Scope name: configurable default_scope for feedback signals
Slug: default-scope-feedback
Branch: feat/default-scope-feedback
Patch target: next patch release after v1.12.0
In-scope task ids: t_d8a58683

The change should be one small additive backend config feature with limited change surface. It should not take over other unrelated work on the branch.

## In-scope task body

id: t_d8a58683
title: [upstream:mnemosyne] feat(hermes): configurable default_scope for remember()/feedback calls
status: triage priority: 0

Source: https://github.com/AxDSan/mnemosyne/releases/tag/v3.9.0
Repo: AxDSan/mnemosyne
Released: v3.9.0 (2026-06-17T23:18:44Z)

What: Upstream adds a configurable `default_scope` so `remember()` calls that do not pass an explicit scope inherit a preset value instead of recording scope-less. In Open Second Brain terms, this is a default for the optional `scope` field on `brain_feedback`/remember signals.

Why useful for Open Second Brain: Open Second Brain signals recorded without a `scope` currently stay uncategorized (`scope` undefined/null), which weakens later application-scope matching during the dream/preference-promotion pass. A vault-configurable default scope would let an operator ensure agent-recorded signals land in a sensible category, for example `coding`, by default, improving preference scoping consistency without forcing every call to set it.

Status in Open Second Brain: verdict `not_in_osb_useful`. Codegraph hints: `scope` is an optional free-form slug on feedback signals - `src/core/brain/signal.ts:70` (type), `:197-198` (metadata write only when present), `:266-281` and `:318-327` (parse/serialize, omitted when absent), `:488-489` (`brain/scope/TBD` tag only when set). No `default_scope`/`defaultScope` symbol exists. Absent scope consistently falls back to null/empty string in consumers. Guardrail/config defaults in `policy.ts` cover vault-scope ignore paths and owner-scoped-facts, not a remember() default scope.

Notes: Small, additive config feature. Natural home: a vault config default consumed where signals are constructed in `signal.ts`, with the explicit per-call `scope` argument overriding it. Distinct from Open Second Brain's existing `owner_scoped_facts` / vault-scope guardrails, which govern fact visibility, not feedback categorization.

## Project context

- Project: Open Second Brain
- Language/runtime: TypeScript ESM on Bun, package `open-second-brain`, current package version 1.13.0.
- Main surfaces: CLI `o2b` and MCP tools for Brain memory writes and reads.
- Data model: Brain data is plain Markdown in an Obsidian vault. Feedback signals are immutable `Brain/inbox/sig-*.md` files with YAML frontmatter.
- Config file: vault-local `Brain/_brain.yaml`, parsed by `src/core/brain/yaml-parse.ts` and validated in `src/core/brain/policy.ts`. The root type is `BrainConfig` in `src/core/brain/types.ts`.
- Current config blocks include `vault`, `active`, `discipline_report`, `guardrails`, `link_graph`, `temporal`, `notes`, `schema`, sessions and other feature blocks. Unknown top-level keys are tolerated as forward compatibility warnings, not hard errors.
- Current `_brain.yaml` parser supports nested one-level blocks, scalars, `[]`, and simple inline scalar arrays.

## Recent git log

20ea7ef feat: per-handoff LLM generation tracing and prompt-prefix stability metric (#102)
9c1d48f feat: CodeGraph and MCP operational readability (v1.12.0) (#101)
c2c3ff4 feat: Session Knowledge Synthesis Suite - structured session summaries, idea-lineage, episodic note history (v1.11.0) (#100)
56dd3dd fix(hermes): bridge EOF - byte streams, stderr drain, retry loop (#92)
35b824e feat: Recall & Working-Memory Quality Suite - selectable profiles, usage decay, co-occurrence, file-context (v1.10.0) (#99)
929d54c feat: Brain Portability & Interop Suite - bank export/import, page contract, brain_create_note, in-process SDK (v1.9.0) (#98)
7cdbfc0 feat: Indexer Durability & Resilience Suite - cooperative abort, graceful watch shutdown, resumable reindex (v1.8.0) (#97)
8b679fe feat: Knowledge Provenance Suite - ingest, research, NER, derived facts, owner-scope, standing-query (v1.7.0) (#96)
6e59a42 feat: Vault Integrity & Trust Suite - untrusted-source containment, NFC identity, watch-sync, O(1) graph, agent-scope (v1.6.0) (#95)
70d95c6 chore(release): bump version to 1.5.0 (#94)
e4df212 feat: Search & Recall Quality Suite - explainable scores, trust, threshold, reinforce, eval (#93)
2e74afe feat: native Grok Build CLI integration - bundled plugin, hooks, session import (v1.4.0) (#91)
3e7e233 fix(hermes): serialize handle_tool_call result to a string (v1.3.1) (#90)
2abc90b fix(changelog): the opencode integration ships in v1.3.0, not a phantom 1.4.0 (#89)
96f1ff4 feat: native opencode integration - config-correct install, bundled plugin, session capture (#88)
0340560 feat: Continuity, Hygiene & Freshness Suite - session lineage, memory hygiene, anticipatory cache (v1.3.0) (#87)
8972f13 refactor: SOLID/DRY decomposition - domain modules, unified helpers, surface guards (v1.2.0) (#86)
6651228 refactor: language-agnostic fact extraction + README slim (v1.1.0) (#85)
9886d9a refactor: make search and classification language-agnostic (#84)
618870e refactor!: remove the pay.sh integration and the Pay Memory layer (#83)

## Related implementation files and observed behavior

- `src/core/brain/signal.ts`
  - `WriteSignalInput.scope?: string` is optional.
  - `writeSignal` writes `scope` to frontmatter only if the sanitized scope exists and is non-empty.
  - `sanitiseSignalInput` sanitizes a provided scope with max length 128 and single-line rules.
  - `parseSignal` returns `scope: undefined` when frontmatter has no non-empty scope.
- `src/mcp/brain/feedback-tools.ts`
  - `brain_feedback` validates input, extracts optional `scope`, then builds `signalInput` with `...(scope ? { scope } : {})`.
  - Force-confirmed preference creation also passes scope only when explicitly provided.
  - The live MCP path resolves agent identity via config when absent.
- `src/cli/brain/verbs/feedback.ts`
  - `o2b brain feedback` accepts optional `--scope`.
  - It builds `signalInput` with `...(flags["scope"] ? { scope: String(flags["scope"]) } : {})`.
  - Force-confirmed preference creation also passes explicit scope only.
- `src/core/brain/policy.ts`
  - `loadBrainConfig` / validation already provide resolved default blocks for other features.
  - Existing guardrail defaults are separate from feedback categorization and should not be reused for this concern.
- `src/core/brain/types.ts`
  - `BrainConfig` is the root `_brain.yaml` type. Additive optional fields are the normal approach.
  - `BrainVaultConfig` currently covers `ignore_paths` only. `BrainGuardrailConfig.owner_scoped_facts` governs fact visibility/recall, not signal categorization.
- Tests likely relevant:
  - feedback CLI tests around `o2b brain feedback` and signal writing.
  - MCP feedback tool tests for `brain_feedback` payload behavior.
  - config loader tests for `_brain.yaml` parsing/validation.

## Documentation and release conventions

README documents Open Second Brain as an Obsidian-native memory layer with deterministic CLI/MCP tools, no hidden state, no daemon, no cloud copy. Documentation index includes `docs/how-it-works.md`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/updating.md`, `docs/hermes-cron.md`, `docs/cross-project-pointer.md`, and `docs/architecture.md`.

Top changelog entry is 1.13.0; patch target for this selected release is the next patch after v1.12.0 per workflow instruction. Do not decide release mechanics here, but implementation should be patch-sized and additive.

Existing brainstorm docs use `docs/brainstorm/<slug>/design.md`, `plan.md`, `variants.md`, and `cli-output/claude.md`.

## Active Brain preferences and coding constraints

- Public Open Second Brain docs/comments/changelog should use the full product name, not the abbreviation.
- No long em dashes in generated prose.
- No AI authorship markers in public artifacts.
- Search/classification behavior must stay language-agnostic. Do not use natural-language keyword lists.
- Avoid TypeScript cast crutches. Build correct typed objects with conditional spreads, narrowing, or dedicated builders.
- Version bumps, if any in later phases, must go through `bun run scripts/sync-version.ts`; do not hand-edit mirrored version files.
- This phase should not implement code. Produce architectural variants only.

## Constraints for your recommendation

- Explicit per-call `scope` must override any configured default.
- With no configured default and no explicit scope, current behavior should remain byte-identical: signal has no `scope` frontmatter and no scope tag.
- The feature must be vault-configurable and should avoid global hidden state.
- Keep it small, additive, deterministic, and testable.
- Avoid misleading fallbacks: invalid configured default should be surfaced as config validation/doctor feedback rather than silently ignored if the design chooses validation.
- No hardcoded natural-language categories.
- Consider CLI and MCP parity for feedback signal writes.
