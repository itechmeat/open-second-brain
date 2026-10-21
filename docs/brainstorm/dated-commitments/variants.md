# Dated commitments, capture to surface - variant audit trail

Consultant: Claude Code (primary, phase 0 step 3), invoked with `docs/brainstorm/dated-commitments/cli-output/prompt.md`; raw output preserved verbatim at `docs/brainstorm/dated-commitments/cli-output/claude.md`. Three variants returned, all parseable; the codex fallback was not needed.

## Variant 1: Sibling "promises" family with one shared counterparty selector

- **Approach**: Add a new page family at `Brain/promises/<slug>.md`, built like `obligations.ts` (path constants, typed `PromiseError`, write-time validators, a soft reader, injected clock). Its keys are distinct: `promise_due`, `promise_status`, `evidence_quote`, plus new relation keys `promised_to` / `owed_by` added to `DEFAULT_RELATION_TYPES`, so the edges come in through the existing frontmatter-relations path. The feature is one new tool, `brain_promise` (operations add/done/list/show/remove/intake). The `intake` operation copies the `brain_intake_entities` contract: validate the whole payload, refuse before any write, use duplicate-refusing upserts, stamp provenance, and derive trust from cited sources. One pure kernel, `selectCounterpartyItems(entity, now, limit)`, does the shareable-only filtering through `strictestVisibilityOf`, then dated-first ordering, then the 3-item cap. Two things call it: a new `hooks/counterparty-brief.ts` (flag checked first, injection ledger, operator-declared intent vocabulary in config, a single confident `anchorEntityForms` match) and a new `entityFacts?: boolean` option on `packContext`, resolved at the tool seam.
- **Trade-offs**:
  - Pro: there is no clash with the existing `commitment:` tier, and the obligations pattern is copied exactly, so reviewers know what to look for.
  - Pro: the push brief and the pull `entity_facts` section can't drift apart, because both render from one selector. The pull side has no dependency on promises: it reads facts, and promises only add dated items when they exist.
  - Pro: edges and facts come out of the existing indexer and link-graph with no new projection code. Default packs stay byte-identical through the conditional report member and projection.
  - Con: one new MCP tool means the full four-census registration (parity test, visibility registry row, reach predicates, path-safe responses).
  - Con: the shared selector has to serve two budgets (3 items for the hook, a per-entity recency list for the pack), so its parameter surface needs careful design.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Generalize obligations to one-off items

- **Approach**: Extend the existing obligations family and the `brain_obligation` tool. `cadence` becomes optional, a one-off item carries a fixed `due` plus `evidence_quote` and a `counterparty` relation, and the tool gains an `intake` operation. No new tool and no new family. The counterparty hook and the context-pack `entity_facts` option read obligations directly.
- **Trade-offs**:
  - Pro: the smallest surface. There is no tool registration, the due-sorted list and overdue flag already exist, and the files land under the 50-70 budget.
  - Pro: a single "what is due" view covers both recurring and one-off items.
  - Con: it changes the semantics of a shipped family. The cadence math, `done` (which advances or archives), list ordering and existing tests all branch on the cadence type, so recurring-obligation behavior risks a regression in the same PR.
  - Con: agent-extracted promises with provenance and evidence sit beside hand-declared obligations. Trust and provenance stamping would leak into a family that never had it.
  - Con: the push and pull paths each query obligations their own way, so the shareable filter and the cap are duplicated. That is two places for the privacy rule to drift.
- **Complexity**: small
- **Risk**: medium

## Variant 3: Facts-first intake with thin ledger pages

- **Approach**: A dedicated `brain_intake_commitments` tool copies `brain_intake_entities` one-for-one. Each validated extraction writes a thin promise page as an audit ledger and, as its main output, a dated atomic fact anchored on the counterparty entity. A second tool, `brain_promise`, covers list/done. Both the hook and `entity_facts` read only from the fact store, so pages are evidence and facts are the queryable surface.
- **Trade-offs**:
  - Pro: dated items and ordinary recent facts share one storage shape, so `entity_facts` and the brief are the same query with a `due` filter.
  - Pro: the intake contract is a byte-faithful mirror of an existing reviewed tool, which keeps validation risk low.
  - Con: two new tools means two four-census registrations, and the PR goes past the ~70-file budget.
  - Con: the truth is split. Pages are the source of truth, yet the brief reads a derived fact store, so done/remove on a page must invalidate facts (more truth-maintenance code). A hand edit to a page's due date stays invisible until the facts are re-projected.
  - Con: it inverts the project rule that Markdown pages are canonical, and it adds a new projection path instead of reusing frontmatter relation edges.
- **Complexity**: large
- **Risk**: high

## Consultant recommendation

Variant 1. "It is the only variant that keeps all three: pages as canonical truth, the precedent for a new page family, and the separation from the existing `commitment:` tier. It also costs exactly one deliberate tool registration and fits the file budget. Using one shared selector in both the hook and the context-pack option means the privacy rule (shareable-only) and the 3-item cap live in one place. The pull side ships independently, and the push side only turns on once the promise supply exists, which matches the order the two cards depend on."

## Orchestrator decision

Variant 1 is adopted, with three documented deviations, each grounded in the verified premise work:

1. **Family name `pledges`, not `promises`.** A typed error named `PromiseError` sits next to the language's own `Promise` in every async signature of this codebase; `PledgeError` cannot be misread, and "pledge" stays operator-distinct from both "obligation" (the recurring family) and "commitment" (the epistemic tier on preferences, theses and decisions). The bare frontmatter keys follow the obligations idiom (`due`, `evidence`, `source`, `fulfilled`) instead of the proposed `promise_*` prefixes; only the relation token is distinctive, and one token (`promised_to`) suffices - the proposed `owed_by` needs directionality semantics the card never asks for.
2. **Two tools, not one tool with an `intake` operation.** Under `additionalProperties: false` a per-operation payload union cannot be expressed cleanly; separate `brain_pledge` (the `brain_obligation` shape) and `brain_intake_pledges` (the `brain_intake_entities` shape) each mirror an exactly-reviewed precedent. Cost: one additional visibility-registry row, inside the budget.
3. **The shared selector is split by population, joined by rule.** The pull side reads only candidates the pack already kept (no new reads, no new privacy surface); the push side reads the pledge family and preference pages directly. Forcing one selector over both would make the pack walk new directories. What is genuinely shared - the reserved-token exclusion, strictest-visibility inheritance, identical-to-absent shaping, dated ordering, the item cap - is pinned as one contract in `plan.md` and implemented once in the brief core, which the pack section's tests assert against the same rules.

Variant 2 is rejected for exactly the consultant's stated risk: it mutates a shipped, frozen-semantics family in the same PR, and provenance discipline would leak into a family that never carried it. Variant 3 is rejected: it splits the truth across a page and a derived store, inverts the Markdown-pages-are-canonical rule, and breaks the file budget.
