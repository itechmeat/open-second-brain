# Distilled provenance - quotes that are checked, sources that say how much was captured

**Status:** draft (phase 1 spec review applied)
**Author:** release orchestrator (via feature-release-playbook)
**Audience:** implementation
**Base:** origin/main 3ec2334a (v1.66.0), branch `feat/distilled-provenance`

## Problem statement

Open Second Brain presents a distillation page as a faithful record of its source, but `distillSource` validates claims structurally only (`src/core/brain/distill/distill-source.ts:10-15`, `validate()` at `:141-155`): a paraphrase wrapped in quotation marks is written exactly like a verbatim quote, and nothing compares it with the block the claim cites. Separately, no page records how much of its source was actually captured. A page whose only evidence is a URL looks the same as a page backed by a file the vault holds, and once the untrusted marker is removed (entity `restore`, `entities/registry.ts:669-721`) or was never written (research reports, `research/research.ts:158-210`), nothing reports that active knowledge rests on a locator that may rot.

## Premise verification (live source, 3ec2334a)

Full evidence: the two reconnaissance reports of this wave. The orchestrator re-opened the anchors this design builds on: `distill-source.ts:1-284`, `intake/source-trust.ts:94-135, 260-385`, `ingest/content-manifest.ts:81-87`, `ingest/ingest.ts:90-112, 156-200`, `research/research.ts:60-215`, `entities/canonical.ts:75-135`, `hygiene/types.ts:12-77`, `hygiene/scan.ts:29-36`, `hygiene/detectors/freshness.ts`, `mcp/tool-error-codes.ts:115-366`, `entities/status-scope.ts:34-76`, `trust/retrieval-gate.ts:38-104`.

### Card A (verify quotes on distilled pages verbatim) - confirmed, two framing claims corrected

1. Confirmed: no quote-fidelity check exists anywhere in `src/`. The kernel runs no model (`distill-source.ts:10-11`), so the check is deterministic and runs at write time inside `distillSource`, the one place both surfaces (MCP and CLI) pass through (`:172-174`).
2. Corrected: "the substrate already exists (block ids)". Only the block-id grammar exists (`BLOCK_ID_RE`, `:61`; `parseWikilinkRich` extracts `^id`). Nothing in `src/` resolves a block id to its text. The block resolver is new code.
3. Corrected (scope-scan claim): `entities/canonical.ts` does not find quotes. `QUOTE_VARIANT_RE` (`:79`) is a fold over identity keys built from `\p{Pi}\p{Pf}` plus U+02BC. It misses U+0022 and U+0027 (`Po`), U+201E and U+201A (`Ps`), the CJK corner brackets U+300C-U+300F and U+301D/U+301E (`Ps`/`Pe`), and `»…«` runs Pf to Pi. Its footprint is pinned over the whole code-point space (`tests/core/brain/entities/quote-variant-fold.test.ts`), so it is NOT widened. Span detection gets its own constant over the Unicode binary property `\p{Quotation_Mark}`; `foldQuoteVariantsByClass` (`:127-133`) is reused only in the comparison step.
4. Corrected: the quarantine lane is not a usable answer for a failed span. The retrieval trust gate is off by default (`search_trust_gate_enabled`, pinned by `tests/cli/distill-trust-lane.test.ts:100-135`), so a quarantined fabricated quote is still served by a default search.
5. Found: the source bytes are read inside `hashFile` and discarded (`source-trust.ts:369-372`, `content-manifest.ts:81-87`). A second read for the check could verify bytes that differ from the hashed ones, contradicting the module's own claim (`distill-source.ts:12-13`). One read must feed both.

### Card B (capture_scope plus a url-only health warning) - partly false, narrowed

1. Confirmed: `capture_scope`, `full-local`, `bounded-local` and `url-only` have zero hits in `src/`, `tests/` and `docs/`.
2. False, as the validator said: "nothing records how much of the source was captured". The trust lane (`untrusted_source`, `trust/untrusted-provenance.ts:88-90`) is already a two-way local versus not-local verdict for a single source, `source_content_hash` records the hashed bytes, and the freshness `missing` sentinel (`freshness.ts:31`) records absence for handoff pages. The work is the third member (a bounded excerpt) and the warning.
3. Corrected: the warning condition is not on the ingest happy path. Untrusted ingest and entity intake already land in the quarantine lane. The condition lives in three places that escape it: research reports (`provenance: stated`, URL wikilinks, no trust field), released entities (`restore` deletes the marker on purpose, `registry.ts:712-716`) and trusted pages whose local source later vanished (only handoff pages carry the freshness contract).
4. Corrected anchors: `brain_sources` (`mcp/brain/query-tools.ts:1006`) is a signal dashboard, not a list of ingested sources; `vault_health` (`mcp/tools.ts:519`) runs the vault/config doctor, not the Brain doctor, and is the wrong home. The OKF walk is `collectOkfPages` at `portability/okf.ts:261`, not `:244`.
5. Not usable as the base: the validator pointed at `MISSING_SOURCE_HASH`. Ingest, distill, research and entity pages do not carry the `source_paths`/`source_hashes` contract (only `handoff.ts:165` writes it), so the scope is derived from the source identity through the trust classifier, not from that sentinel.

## Scope

1. A shared capture-scope vocabulary `CAPTURE_SCOPE` (`full-local`, `bounded-local`, `url-only`) with a classifier over a source identity, a frontmatter helper that writes nothing for `full-local`, and the bounded-excerpt block format (render, read, digest).
2. A quote-span finder over `\p{Quotation_Mark}` with position-based pairing and the between-letters apostrophe exclusion, and a comparison-only normaliser.
3. A block resolver: block id to block text inside source bytes.
4. The quote check inside `distillSource`: each quoted span in a claim is compared with the cited block (or, for a claim with no block, the whole source); a failed span is unquoted by default and named in the result; `strict_quotes` / `--strict-quotes` refuses the write with the registered code `quote_unverified`.
5. One read of the source feeds both the content digest and the check.
6. A `distillSource` `excerpt` argument that makes `bounded-local` reachable: for a source with no local bytes, the caller may supply the verbatim excerpt it read; the page stores it in a marked block with its digest, and quotes are checked against it.
7. `capture_scope` stamped at write time on distillation, ingest summary and research report pages (only when not `full-local`), surfaced on each write result.
8. A default-on hygiene detector `capture-scope`: a retrievable page of active knowledge whose every cited source is currently `url-only` gets a `warning` finding with `proposed_action: review`.
9. Docs: new `brain_distill_source` and `o2b brain distill` reference sections (neither exists today), the detector in the hygiene lists, a capture-scope section.

## Out of scope

1. Checking pages that `brain_write_session` commits into `Brain/distillations` (`write-binding/index.ts:294`). Those bytes never pass `distillSource`; a doctor or hygiene re-check over existing distillation pages is a later slice.
2. Re-checking quotes on pages already on disk (drift against changed source bytes). Same later slice.
3. Wiring `research/extract.ts` `extractPage` (network egress on a write path). `bounded-local` is reachable through the explicit `excerpt` argument only.
4. A `capture_scope` field on `listIngestedSources` / `IngestedSource`, an OKF `producer_meta` field, a "list ingested sources" surface.
5. The unchecked `raw` quote on `brain_session_checkpoint` signals (same class of gap, different surface).
6. Widening `QUOTE_VARIANT_RE`, or any change to `canonical.ts`.
7. CHANGELOG, version bump, OpenClaw bundle rebuild (handled by PR preparation and the integrator).

## Chosen approach

Consultant variant 2 ("shared provenance module, write-time gate plus lint detector"), narrowed. Kept: one provenance vocabulary shared by both cards, one evidence read, a `\p{Quotation_Mark}` span scanner separate from `QUOTE_VARIANT_RE`, a comparison-only normaliser, the block resolver, unquote plus a named finding at write time, `capture_scope` on new pages, the url-only warning as a hygiene detector. Dropped: the second quote detector over existing and write-session pages (out of scope, item 1), the doctor code (a hygiene finding already reaches `brain_status` through the `hygiene-findings` count, `operator-snapshot.ts:166`), deriving scope from the `missing` sentinel (premise B.5), and the whole-source fallback when a cited block does not resolve (decision 6). Added: the `excerpt` argument, so `bounded-local` has a real producer.

## Design decisions

### Quote spans

1. **Delimiters.** A quotation mark is any code point with the Unicode binary property `Quotation_Mark` (`/\p{Quotation_Mark}/u`). No language list. A new constant in the span module; `canonical.ts` is untouched.
2. **Apostrophe exclusion.** A mark with a letter (`\p{L}`) immediately on both sides is never a delimiter (`don’t`, `l'eau`). U+02BC is not `Quotation_Mark` and needs no rule. Ps/Pe quotation marks are directional and never apostrophes.
3. **Pairing by position, not by glyph.** An opener is a mark at the start of the text or after whitespace or opening punctuation (`\p{Ps}`, `\p{Pi}`, another opener), and followed by a non-space. A closer is a mark followed by the end, whitespace or punctuation, and preceded by a non-space. This pairs `"…"`, `“…”`, `„…“`, `»…«`, `«…»`, `「…」` and `『…』` without knowing which language uses which. Pairing is a stack; only outermost spans are checked, an inner quote is part of its outer span's text.
4. **Unpaired marks** are not spans. They are counted (`unpaired`) in the result and left on the page untouched. An empty or whitespace-only span is not a quote.

### Matching tolerance

5. **Comparison-only normalisation, applied identically to both sides:** NFC; inline Markdown reduced to display text (emphasis and code markers `*`, `_`, `` ` ``, `~~`; `[text](url)` to `text`; `[[target|alias]]` to `alias`, `[[target]]` to `target`); line-leading block markers removed (`>`, list bullets, ordered-list numbers); the trailing ` ^id` removed; `foldQuoteVariantsByClass` for marks inside the span; whitespace runs collapsed to one space; trimmed. Then the span must be an exact substring of the normalised block. Never folded: case, punctuation other than quote width, wording. Evidence: `page-lint.ts:39-43` refuses normalisation of WRITTEN bytes only; the page bytes are never normalised by this check.
6. **Ellipsis.** A span containing `…` (U+2026) or a run of three or more `.` is split there; every non-empty fragment must appear in the block, in order, without overlap. A bracketed insertion (`[sic]`, `[the protocol]`) is not interpreted and fails as a mismatch.
7. **Comparison scope.** A claim with `block` is compared with the resolved block only. If the block does not resolve, the outcome is `block-not-found` (duplicate id: `block-ambiguous`), never a silent fall-back to the whole source: the citation is part of what the page asserts. A claim with no `block` is compared with the whole source and the outcome is `verified-in-source`, distinct from `verified-in-block`, so the weaker guarantee never reads as the stronger. Existing fixtures cite `^abc` against sources with no block ids but contain no quotation marks, so no claim in them is checked.
8. **Block resolution.** Fenced code is skipped. A line ending in whitespace plus `^id` is a paragraph or list-item block (its paragraph, marker removed); a line holding only `^id` attaches to the block directly above it (table, blockquote, list). Two definitions of one id are `block-ambiguous`.
9. **Source text.** The bytes from the single read are decoded as strict UTF-8 (`TextDecoder` with `fatal: true`); a decode failure gives every span of the page the outcome `source-not-text`.

### Failed-span policy

10. **Default: unquote and name it.** The delimiter pair of a failed span is removed, the words stay, the write lands, and the result names each failure. The page never shows an unverified quote. Dropping the claim was rejected (it loses caller-supplied knowledge unasked); quarantine was rejected (premise A.4). Unquoting is a named, deliberate edit of authored bytes stated in the result and the docs, unlike the silent normalisation `page-lint.ts` refuses.
11. **Opt-in strict refusal.** `strict_quotes: true` (MCP) / `--strict-quotes` (CLI) refuses the whole write when any span would be unquoted, with `QuoteCheckError` carrying the registered wire code `quote_unverified`. Nothing is written. The message names claim indices and outcomes, never claim text or paths.
12. **Unpaired marks never trigger strict refusal**; they are counted only.

### Capture scope

13. **One vocabulary for "no local bytes".** `CAPTURE_SCOPE.urlOnly = "url-only"` is the single name. The quote check's outcome for a span with no local bytes to check against IS that token (`QUOTE_CHECK_OUTCOME.urlOnly = CAPTURE_SCOPE.urlOnly`), not a second spelling.
14. **Boundaries.** `full-local`: the identity is vault-shaped and resolves to a readable file (the trusted verdict of `classifySourceTrust` / `classifySourceOrigin`). `url-only`: the identity carries a URI scheme or authority shape, or is vault-shaped with no file behind it (the untrusted verdict), so the lane and the scope cannot disagree. `bounded-local`: a `url-only` identity whose page holds a verbatim excerpt the same writer stored, in the marked excerpt block, with its digest. Never inferred from prose: an ingest `summary` is a paraphrase, not a capture.
15. **Oversized sources stay a refusal.** A file above `SOURCE_HASH_MAX_BYTES` keeps throwing `SourceTrustError`; it never becomes `bounded-local` by truncation (consultant variant 1's idea, rejected: a refusal turned into a degraded success).
16. **Where `bounded-local` comes from.** Only `distillSource`, through the new `excerpt` argument, accepted only when the source is `url-only` (a local source with an excerpt is refused by name: the file is the evidence) and bounded by `CAPTURE_EXCERPT_MAX_BYTES`. Ingest and research keep two-valued scopes in this release; `extractPage` stays unwired (out of scope, item 3).
17. **Stamp at write, re-derive on read.** Writers stamp `capture_scope` (single source) or `capture_scopes` (research reports, parallel to the report's `sources` order) only when a value is not `full-local`, so every full-local page stays byte-identical (pinned by `distill-source-trust.test.ts:278-309`). Absence means "full-local or written before this release" and is resolved by re-deriving, never by assuming. The detector re-derives the CURRENT scope from the identity (`classifySourceTrust`, no byte read), so a full-local page whose file vanished reports as `url-only`; a stamped `bounded-local` counts as backing only while the page's excerpt block is present and matches its digest.
18. **The warning.** A default-on hygiene detector `capture-scope` (severity `warning`, `proposed_action: review`) over retrievable pages (`classifyRetrievalTrust(meta).quarantined === false`) of kind `brain-distillation`, `brain-source`, `brain-report`, and `brain-entity` in the canonical status scope (`entityStatusInScope(status, "canonical")`). It fires when every source the page cites is currently `url-only`. Quarantined pages are skipped: the gate already excludes them. A doctor check was rejected (it would need a `DOCTOR_EXIT_EXCLUSIONS` row and adds nothing the hygiene count does not already show in `brain_status`); `brain_health` was rejected (preference-centric fold).
19. **Source extraction is not re-implemented.** `stringArrayField` and `wikilinkTarget` move from `source-cleanup.ts` into a small shared module with a `## Sources` link reader; `SourceCleanupEntry` and the `deleteBySource` payload (pinned by `gates/recoverability.test.ts`) are untouched.

### Result and page shapes

20. **Distill result.** Additive keys, absent when there is nothing to report: `quotes` (present only when at least one claim contains a span) and `captureScope` (always present, mirroring `trust`). The MCP payload uses `quotes` and `capture_scope`; the CLI `--json` the same. `quotes` = `{checked, verified_in_block, verified_in_source, unquoted, unpaired, findings, total, returned, truncated}`, findings only for unquoted spans, each `{claim, outcome, span}` with `claim` the 0-based index, `span` capped at `QUOTE_SPAN_PREVIEW_MAX_CHARS`, findings capped at the page-lint cap (25). Built from the claim's own text only, never a path.
21. **Distill page.** `quotes_verified` and `quotes_unquoted` frontmatter integers only when spans exist; `capture_scope` and, for `bounded-local`, `excerpt_hash` only when not full-local; the excerpt in a `## Excerpt` section as a fenced block with the info string `excerpt`, so its bytes are verbatim and wikilink parsing skips it. A clean page stays byte-identical; the idempotent re-run stays inert.
22. **CLI human line.** The existing suffix idiom (`untrustedNote`): ` [quotes verified:V unquoted:U]` when spans were checked, ` [bounded-local]` when an excerpt was stored. Exit 1 on a strict refusal, as for any validation failure.
23. **Ingest and research results** gain `captureScope` / `captureScopes`, serialised as `capture_scope` / `capture_scopes` on MCP. None of these tools has an `outputSchema`, so no contract change.
24. **Wire code.** `QuoteCheckError` is registered in `CLASSIFICATION` (`tool-error-codes.ts:340-366`) as `fixed(QuoteCheckError, TOOL_ERROR_CODE.quoteUnverified)`. `wrapToolErrors` drops data (`mcp/brain/shared.ts:95-110`), so `distill-tools.ts` maps this one class itself with `{code}` in the `MCPError` data; `shared.ts` is not changed.

## File changes

New: `src/core/brain/provenance/capture-scope.ts`, `src/core/brain/distill/quote-spans.ts`, `src/core/brain/distill/quote-verdict.ts`, `src/core/brain/distill/block-resolve.ts`, `src/core/brain/distill/quote-check.ts`, `src/core/brain/source-links.ts`, `src/core/brain/hygiene/detectors/capture-scope.ts`, plus their tests.

Modified: `src/core/brain/intake/source-trust.ts`, `src/core/brain/ingest/content-manifest.ts`, `src/mcp/tool-error-codes.ts`, `src/core/brain/distill/distill-source.ts`, `src/core/brain/ingest/ingest.ts`, `src/core/brain/research/research.ts`, `src/core/brain/source-cleanup.ts`, `src/core/brain/hygiene/types.ts`, `src/core/brain/hygiene/scan.ts`, `src/mcp/brain/distill-tools.ts`, `src/mcp/brain/ingest-tools.ts`, `src/mcp/brain/research-tools.ts`, `src/mcp/brain/hygiene-tools.ts`, `src/mcp/registry-guard.ts`, `src/cli/brain/verbs/distill.ts`, `src/cli/command-manifest.ts`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, and the tests named in `plan.md`. Exact ownership is in `plan.md`.

Not touched: `src/core/brain/entities/canonical.ts`, `src/mcp/brain/shared.ts`, `openclaw/index.js` (nothing distill- or hygiene-related is bundled; the integrator verifies with `bun run build:openclaw`), `plugins/codex/` (no skill text changes).

## Risks and open questions

1. **MCP description budget.** `brain_distill_source` is at 280 of 300 characters. The new `strict_quotes` and `excerpt` properties carry their own descriptions (cap 160); the tool description gains at most one short clause. If the clause does not fit, the property descriptions carry the behaviour and the docs section carries the rest.
2. **Unquoting changes caller bytes.** A caller re-running the same claims gets the same unquoted page (idempotent), but a caller comparing its input with the page sees a difference. The result names every change; the docs state it.
3. **Position pairing ambiguity.** Text like `5" screen` or `rock 'n' roll` can produce an unpaired mark or a short span. An unpaired mark is only counted; a short span that fails is unquoted, which is the honest outcome for an unverifiable quotation.
4. **Detector cost.** One `stat` per cited source per page on every default hygiene sweep. Bounded by the page kinds above; no byte reads.
5. **Census coupling.** The new four-piece vocabularies (`CAPTURE_SCOPE`, `QUOTE_CHECK_OUTCOME`) must be registered in `verdict-vocabulary-census.test.ts` in the same task that adds them, or the census is red for the other lanes.
