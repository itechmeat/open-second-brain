### Variant 1: Gate in distillSource, scope derived at classification

- **Approach**: Extend `classifySourceOrigin` to keep the bytes it already reads and return `{trust, contentHash, bytes, captureScope}` in one pass, so the capture scope is a by-product of the existing trust classification (bytes present and complete gives `full-local`, bytes truncated by a ceiling gives `bounded-local`, URL or missing file gives `url-only`). `distillSource` scans each claim for `\p{Quotation_Mark}` pairs, normalises both sides for comparison only, and substring-matches against the whole source body; a failed span has its marks stripped and the receipt gains a `quote_fidelity` finding, while a `url-only` source yields a named `unavailable`. The health side is one hygiene detector that walks active pages to cited sources and warns when any cited source page carries `capture_scope: url-only`.
- **Trade-offs**:
  - Pro: smallest surface; one read of the source, no block resolver, no new module layout.
  - Pro: the trust classifier is already the chokepoint for "no local bytes", so the shared vocabulary falls out naturally.
  - Con: whole-source matching ignores the block id, so a quote that exists elsewhere in the source passes even when the cited block is wrong.
  - Con: only guards the `distillSource` path; `brain_write_session` bytes and already-written pages are never checked.
  - Con: `classifySourceOrigin` returning up to 8 MiB of bytes widens its contract for every other caller.
- **Complexity**: small
- **Risk**: medium

### Variant 2: Shared provenance module, write-time gate plus lint detector

- **Approach**: Add a `provenance` module holding the four-piece `capture_scope` vocabulary (registered in the census), a `readSourceEvidence()` that returns bytes, hash and scope and is called by ingest, distill and trust classification, a quote-span scanner over `\p{Quotation_Mark}` with a word-boundary rule for U+2019, a comparison-only normaliser separate from `QUOTE_VARIANT_RE`, and a best-effort block resolver that narrows the match window when the cited `^id` exists and falls back to the whole source otherwise. The verifier runs twice: at write time inside `distillSource` (failed span unquoted, receipt finding `quote_fidelity` with `verified | unquoted | unavailable`), and as a hygiene detector over existing distillations and session pages so caller-authored bytes and old pages surface the same finding. `capture_scope` is written to the frontmatter of new source, distillation and report pages; the url-only-backs-active-knowledge check is a second hygiene detector with a doctor code and exit-census row, deriving scope for pre-release pages from the existing `missing` sentinel.
- **Trade-offs**:
  - Pro: one vocabulary and one evidence reader serve both cards; "no local bytes" is a single enum member everywhere.
  - Pro: covers the `brain_write_session` bypass and the already-written corpus through the existing detector plumbing that already reaches `brain_status`.
  - Pro: block-scoped matching when ids exist, graceful whole-source fallback for the fixtures that cite `^abc` with no ids.
  - Con: more files and tests; the block resolver is new code with its own edge cases (ids on list items, headings, tables).
  - Con: new frontmatter key on new pages means those writers' byte-stability fixtures need regeneration (existing pages untouched).
  - Con: the detector re-reads sources on every hygiene pass, which is a cost on large vaults.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Typed claims and a configurable quote policy

- **Approach**: Change the claim contract so callers mark `kind: quote | paraphrase`; `distillSource` renders a quote only after verification and otherwise applies a configured policy (`distill_quote_policy: unquote | drop | reject`), where `reject` fails the whole write with a new coded error registered in tool-error-codes. `capture_scope` becomes an explicit ingest input validated against what was saved (mismatch is an error), and the url-only warning is a doctor check only. Failed spans under `unquote` are also recorded in a frontmatter list of unverified block ids on that page.
- **Trade-offs**:
  - Pro: strongest guarantee; a strict install can refuse to persist a paraphrase disguised as a quote.
  - Pro: typed claims give downstream recall a clean quotable-or-not signal without re-scanning text.
  - Con: breaks the current `{text, block?}` caller contract and the MCP schema, with the tool description at 280 of 300 characters.
  - Con: three policies and an explicit scope input multiply the test matrix and the config surface for one release.
  - Con: `drop` silently loses knowledge, and `reject` turns a model's punctuation choice into a hard write failure.
  - Con: no detector over existing pages, so the corpus written before this release stays unchecked.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It is the only variant that satisfies both cards with one vocabulary and one evidence reader while covering the `brain_write_session` bypass and the already-written corpus through detector plumbing the project already has. Variant 1 leaves two write paths unguarded and silently widens the trust classifier's contract; Variant 3 breaks the claim and MCP contracts and adds policy surface this release does not need. The block resolver with whole-source fallback keeps the match deterministic and fixture-compatible, and the unquote-plus-named-finding fallback follows the existing receipt convention without losing text.
