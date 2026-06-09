# Language-agnostic fact extraction - implementation plan

## Tasks

### Task 1: Structural-only `fact-extract.ts`
- **Files**: `src/core/brain/fact-extract.ts`, `tests/core/brain/fact-extract.test.ts`
  (and any other test asserting removed families).
- **Changes**:
  - Narrow `FactFamily` to `"url" | "email" | "quantity"`.
  - Replace `FAMILY_PATTERNS` with three structural patterns: bare URL, bare
    e-mail, and a currency/percent-bound quantity.
  - Delete `QUANTITY_UNIT_STOPWORDS`, `POSSESSION_KEY_BLOCKLIST`, English
    action verbs.
  - `parseQuantityFact`: detect a number bound to a currency symbol, an
    ISO-4217-style 3-letter code, or `%`; drop the `action` field from
    `ParsedQuantityFact` (no language-neutral source).
- **Acceptance** (tests, written first, must fail before the change):
  - "my name is Bob" / "I prefer X" / "yes, the price is 5" extract NOTHING.
  - A URL, an e-mail, and a `$1,200` / `50%` / `3.5 USD` amount extract in
    any language context (assert with a non-Latin sentence wrapping them).
  - `parseQuantityFact("$42")` -> `{value: 42, unit: "usd"}`; bare "42"
    without a symbol -> `null`.

### Task 2: De-couple `truth/ingest.ts`
- **Files**: `src/core/brain/truth/ingest.ts`, `tests/core/brain/truth/ingest.test.ts`.
- **Depends on**: Task 1.
- **Changes**:
  - Delete `POSSESSION_RE` and the English `STRUCTURERS` (name/called/based-in).
  - Keep the structural e-mail and website structurers.
  - Remove the `possession` branch in `claimsFromAssertion`.
  - Quantity branch: pass `action: null` (field stays nullable in the ledger).
- **Acceptance**:
  - An assertion "my name is Bob" yields NO claim.
  - An assertion with an e-mail / URL / currency amount yields the
    corresponding structural claim.
  - `truth/aggregate.ts` + `truth/store.ts` still pass with `action: null`.

### Task 3: Suite sweep
- **Files**: any remaining test under `tests/**` referencing removed
  families, English fixtures, or `quantity.action`.
- **Acceptance**: full `bun test`, `bun run typecheck`, `bun run lint` green.
