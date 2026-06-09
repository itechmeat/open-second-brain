# Language-agnostic fact extraction - remove hardcoded human-language trigger phrases

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook; external consultant step waived by operator)
**Audience:** implementation

## Problem statement

`src/core/brain/fact-extract.ts` and `src/core/brain/truth/ingest.ts` detect facts in user
turns using regexes anchored on English trigger phrases ("my name is", "I prefer", a
"yes/correct/right/exactly ... is/are" confirmation frame, English quantity action verbs
"spent|paid|earned|...", English stop-words, an English possession-key blocklist, and
English `STRUCTURERS` like "based in"). PR #84 made search and classification
language-agnostic; this extraction path was the one deferred slice. We cannot enumerate the
world's languages, so any phrase list is a defect, not a feature.

## Scope

- Delete every hardcoded human-language phrase from the fact-extraction path: the prose
  family patterns in `fact-extract.ts` and the English `STRUCTURERS` / `POSSESSION_RE` in
  `truth/ingest.ts`.
- Keep only structurally detectable, language-neutral facts: URLs, e-mail addresses, and
  quantities expressed through language-neutral symbols (currency symbols / ISO codes,
  percent).
- Update `truth/ingest.ts` so no dead branch survives the family removals.

## Out of scope

- Re-introducing prose-fact capture through any other mechanism (explicit author labels or
  an LLM provider). Tracked as a follow-up if recall loss proves material.
- The `decision:`/`rule:` explicit-label markers in `pre-compact-extract.ts`. Those are an
  author-written structured-label convention (like `TODO:`), not natural-language detection;
  left as-is.
- Changing the persisted claim-ledger schema. The nullable `action` column stays for
  back-compat; we simply stop deriving it from English verbs.

## Chosen approach

Variant 1 (structural-only). `extractFacts` keeps three language-neutral families:

- `url` - bare `https?://...` match, no trigger phrase.
- `email` - bare RFC-ish address match, no trigger phrase.
- `quantity` - a number bound to a language-neutral measurement symbol (currency symbol,
  ISO-4217-style code, or percent). The English actor/action frame and stop-word list are
  removed; `parseQuantityFact` no longer emits a prose-derived `action`.

Everything that needed a human-language frame (identity, preference, location, possession,
confirmation) is removed. Prose facts in any language are not auto-captured by this
real-time, LLM-free path; that is an accepted, explicit recall reduction, consistent with
precision-over-recall and with PR #84's structural philosophy.

## Design decisions

- **Structural, not lexical.** A signal qualifies only if it is detectable without knowing
  any natural language (a URL, an `@`-address, a currency symbol). This is the same test
  PR #84 applied to search and classification.
- **No fake fallback.** We do not add a "no provider -> pretend" path. Removed families are
  removed, not stubbed.
- **`action` is no longer invented.** The quantity `action` was an English verb. It is set
  to `null` from this path; `truth/aggregate.ts` already buckets `action: string | null`, so
  quantities now aggregate by `unit`. The column stays nullable for back-compat and for a
  future explicit-label source.
- **Stable public API.** `extractFacts`, `parseQuantityFact`, `factDedupHash`,
  `routeExtractedFacts` keep their signatures; only behavior narrows. `FactFamily` loses the
  removed members.

## File changes

- `src/core/brain/fact-extract.ts` - replace `FAMILY_PATTERNS` with the three structural
  families; delete `QUANTITY_UNIT_STOPWORDS`, `POSSESSION_KEY_BLOCKLIST`, the English action
  verbs; narrow `FactFamily`; rework `parseQuantityFact` to structural quantity (no action).
- `src/core/brain/truth/ingest.ts` - delete `POSSESSION_RE`, the English `STRUCTURERS`
  (name/called/based-in); keep the structural email/website structurers; drop the
  `possession` branch; keep the `quantity` branch (`action` now null).
- Tests across `tests/core/brain/**` and `tests/**` that assert removed families.

## Risks and open questions

- **Recall regression (accepted).** English prose facts (name, preference, location) stop
  auto-extracting. Mitigation: explicit labels and the dream pass still feed memory; the
  loss is precision-safe.
- **Quantity precision.** Without an actor frame, quantity must stay tight (bound to a
  currency/percent symbol) to avoid matching arbitrary numbers. Covered by tests.
- **Downstream `action` consumers.** Confirm `truth/aggregate.ts` and `truth/store.ts`
  tolerate a null `action` end-to-end (they type it `string | null`).
