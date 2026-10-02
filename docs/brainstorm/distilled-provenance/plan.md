# Distilled provenance - implementation plan

Design: `docs/brainstorm/distilled-provenance/design.md` (decision numbers below refer to its "Design decisions" list).

## How to run this plan

Four lanes with DISJOINT file ownership run concurrently in the one worktree. Lane A (shared substrate) commits first; every other lane waits only on lane A and, where named, on one upstream task. A lane edits only the files listed under its own tasks. Every task is TDD: write the named test first, run it and see it fail for the stated reason, implement, see it pass, then `oxfmt` and `oxlint` on the lane's own files only, then `git add <own paths>` and one conventional commit (`feat(distill): ...`, `feat(provenance): ...`, `feat(hygiene): ...`, `docs: ...`). Retry on `index.lock`. Gates per task: `bun test <the task's test files>` and `bun run typecheck`.

CHANGELOG, the version bump and the OpenClaw bundle belong to no lane (PR preparation and the integrator handle them).

Dependency summary:

- A1 -> A2 -> A3 (A3 imports A1's `CAPTURE_SCOPE`; A1 and A3 both edit the census test, so they run in order); A4 has no dependency.
- Lane A complete (A1..A4) -> B1, C1, D4.
- B1 -> B2 -> B3 -> B4 (one lane, in order).
- C1 -> C2 -> C3 -> C4 (one lane, in order).
- B4 -> D1 -> D2; C4 -> D3. D1 and D2 run in lane D's order after B4; D3 waits on C4 alone.
- D4 (docs) is drafted from the contract after lane A and finalised last.

## Cross-lane contract (pinned now; no lane renames or re-spells any of this)

### `src/core/brain/provenance/capture-scope.ts` (lane A, A1)

- `CAPTURE_SCOPE = Object.freeze({ fullLocal: "full-local", boundedLocal: "bounded-local", urlOnly: "url-only" } as const)`
- `CAPTURE_SCOPES: ReadonlyArray<CaptureScope>` (frozen member list), `type CaptureScope`, `isCaptureScope(value: unknown): value is CaptureScope`
- `CAPTURE_SCOPE_KEY = "capture_scope"`, `CAPTURE_SCOPES_KEY = "capture_scopes"`, `EXCERPT_HASH_KEY = "excerpt_hash"`
- `CAPTURE_EXCERPT_MAX_BYTES = 65_536`
- `CAPTURE_EXCERPT_HEADING = "## Excerpt"`, `CAPTURE_EXCERPT_FENCE_INFO = "excerpt"`
- `captureScopeForTrust(trust: IntakeTrust): CaptureScope` - trusted -> `full-local`, untrusted -> `url-only`
- `classifyCaptureScope(vault: string, identity: string): CaptureScope` - via `classifySourceTrust`, never reads bytes
- `captureScopeFrontmatter(scope: CaptureScope): FrontmatterMap` - `{}` for `full-local`, else `{ capture_scope: scope }`
- `captureScopesFrontmatter(scopes: ReadonlyArray<CaptureScope>): FrontmatterMap` - `{}` when every member is `full-local`, else `{ capture_scopes: [...] }`
- `excerptDigest(excerpt: string): string` - sha256 hex over the UTF-8 bytes of the excerpt as given
- `renderExcerptSection(excerpt: string): string` - the heading, a blank line, then a fence long enough to contain any backtick run in the excerpt, info string `excerpt`, the excerpt verbatim, the closing fence
- `readExcerptSection(body: string): string | null` - inverse of the render; `null` when the section is absent or malformed
- `CaptureExcerptError extends Error` (`name = "CaptureExcerptError"`) - thrown by `assertExcerptAdmissible(scope: CaptureScope, excerpt: string)` when an excerpt is given for a non-`url-only` source, is empty after trim, or exceeds `CAPTURE_EXCERPT_MAX_BYTES`. Message: identifiers and integers only.

### `src/core/brain/distill/quote-spans.ts` (lane A, A2)

- `QUOTATION_MARK_RE = /\p{Quotation_Mark}/u` (separate from `canonical.ts`; `QUOTE_VARIANT_RE` is not touched)
- `interface QuoteSpan { readonly open: number; readonly close: number; readonly inner: string }` - UTF-16 offsets of the opening and closing mark in the input
- `interface QuoteSpanScan { readonly spans: ReadonlyArray<QuoteSpan>; readonly unpaired: number }`
- `findQuoteSpans(text: string): QuoteSpanScan` - decisions 1-4, outermost spans only
- `unquoteSpans(text: string, spans: ReadonlyArray<QuoteSpan>): string` - removes exactly the two marks of each given span
- `normalizeForQuoteComparison(text: string): string` - decision 5, both sides
- `splitEllipsisFragments(inner: string): ReadonlyArray<string>` - decision 6
- `spanOccursIn(inner: string, haystackNormalized: string): boolean` - fragments in order, no overlap

### `src/core/brain/distill/quote-verdict.ts` (lane A, A3)

- `QUOTE_CHECK_OUTCOME = Object.freeze({ verifiedInBlock: "verified-in-block", verifiedInSource: "verified-in-source", notInBlock: "not-in-block", notInSource: "not-in-source", blockNotFound: "block-not-found", blockAmbiguous: "block-ambiguous", sourceNotText: "source-not-text", urlOnly: "url-only" } as const)`. The `urlOnly` value is written as the literal, not as `CAPTURE_SCOPE.urlOnly`: the verdict-vocabulary census only registers objects whose values are all literals. The one-name rule (decision 13) is kept by a test that asserts `QUOTE_CHECK_OUTCOME.urlOnly === CAPTURE_SCOPE.urlOnly`.
- `QUOTE_CHECK_OUTCOMES`, `type QuoteCheckOutcome`, `isQuoteCheckOutcome(value: unknown)`
- `VERIFIED_QUOTE_OUTCOMES: ReadonlySet<QuoteCheckOutcome>` = `{verified-in-block, verified-in-source}`
- `QUOTE_FINDINGS_MAX = PAGE_LINT_MAX_FINDINGS` (imported from `page-lint.ts`), `QUOTE_SPAN_PREVIEW_MAX_CHARS = 120`
- `interface QuoteFinding { readonly claim: number; readonly outcome: QuoteCheckOutcome; readonly span: string }`
- `interface QuoteCheckReport { readonly checked: number; readonly verified_in_block: number; readonly verified_in_source: number; readonly unquoted: number; readonly unpaired: number; readonly findings: ReadonlyArray<QuoteFinding>; readonly total: number; readonly returned: number; readonly truncated: boolean }`
- `QUOTE_UNVERIFIED_CODE = "quote_unverified"`
- `QuoteCheckError extends Error` with `readonly code = QUOTE_UNVERIFIED_CODE`, `name = "QuoteCheckError"`, constructed from `ReadonlyArray<QuoteFinding>`; message is `quoted spans failed verification: ` followed by comma-separated `claim <i>: <outcome>` pairs, never span text
- Frontmatter keys: `QUOTES_VERIFIED_KEY = "quotes_verified"`, `QUOTES_UNQUOTED_KEY = "quotes_unquoted"`

### `src/core/brain/intake/source-trust.ts` and `src/core/brain/ingest/content-manifest.ts` (lane A, A4)

- `hashBytes(bytes: Uint8Array): string` in `content-manifest.ts`; `hashFile` becomes `hashBytes(readFileSync(abs))` with identical output
- `interface SourceOriginWithBytes extends SourceOrigin { readonly bytes?: Uint8Array }` - `bytes` present exactly when `contentHash` is
- `readSourceOrigin(vault: string, sourcePath: string): SourceOriginWithBytes` - same verdicts, same refusals (`SourceTrustError`, the 8 MiB ceiling) as `classifySourceOrigin`, one read feeding the digest and the returned bytes. `classifySourceOrigin` keeps its signature and delegates.

### `src/mcp/tool-error-codes.ts` (lane A, A3)

- `TOOL_ERROR_CODE.quoteUnverified = "quote_unverified"` (equal to `QUOTE_UNVERIFIED_CODE`; the test asserts equality)
- `fixed(QuoteCheckError, TOOL_ERROR_CODE.quoteUnverified)` in `CLASSIFICATION`

### `src/core/brain/distill/block-resolve.ts` (lane B, B1)

- `type BlockResolution = { kind: "found"; text: string } | { kind: "not-found" } | { kind: "ambiguous" }` - a plain discriminated union (no frozen object, so no census row), mapped onto `QUOTE_CHECK_OUTCOME` by B2
- `resolveBlock(source: string, blockId: string): BlockResolution`

### `src/core/brain/distill/quote-check.ts` (lane B, B2)

- `interface QuoteCheckInput { readonly claims: ReadonlyArray<DistillClaim>; readonly evidence: QuoteEvidence }`
- `type QuoteEvidence = { kind: "text"; text: string } | { kind: "not-text" } | { kind: "url-only" }`
- `interface QuoteCheckResult { readonly claims: ReadonlyArray<DistillClaim>; readonly report: QuoteCheckReport | null }` - `claims` with failed spans unquoted; `report` `null` when no claim contains a span
- `checkClaimQuotes(input: QuoteCheckInput): QuoteCheckResult` - pure, no I/O

### `distillSource` (lane B, B3 and B4)

- `DistillSourceInput` gains `readonly excerpt?: string`; `DistillSourceOptions` gains `readonly strictQuotes?: boolean`
- `DistillSourceResult` gains `readonly captureScope: CaptureScope` (always) and `readonly quotes?: QuoteCheckReport` (only when spans exist)
- Strict refusal throws `QuoteCheckError` before any write; an inadmissible excerpt throws `CaptureExcerptError` before any write

### Ingest and research (lane C)

- `IngestSourceResult.captureScope: CaptureScope` (always present)
- `ResearchReportResult.captureScopes: ReadonlyArray<CaptureScope>` (always present, parallel to `input.sources`)

### `src/core/brain/source-links.ts` (lane C, C3)

- `stringArrayField(meta: FrontmatterMap, key: string): ReadonlyArray<string>` and `wikilinkTarget(raw: string): string` (moved verbatim from `source-cleanup.ts`, which imports them back)
- `sourcesSectionTargets(body: string): ReadonlyArray<string>` - wikilink targets under the `## Sources` heading, the same rules `source-cleanup.ts` uses

### Hygiene detector (lane C, C4)

- Detector id `"capture-scope"` appended to `HYGIENE_DETECTOR_IDS` and to `DEFAULT_SCAN_IDS`
- `CAPTURE_SCOPE_DETECTOR_ID = "capture-scope"`, `detectCaptureScope(vault: string): ReadonlyArray<HygieneFinding>`
- Finding: `severity: "warning"`, `proposed_action: "review"`, `targets: [page]`, `title: "Active knowledge rests on url-only sources"`, `evidence: { sources: string[], stamped: CaptureScope | null }` where `stamped` is the page's own `capture_scope` value (null when absent, and always null on a report, whose per-source stamps live in `capture_scopes`)

### Surface names (lane D)

- MCP `brain_distill_source` input: `strict_quotes` (boolean), `excerpt` (string); output adds `capture_scope` and, when present, `quotes` (the `QuoteCheckReport` keys verbatim)
- MCP `brain_ingest_source` output adds `capture_scope`; `brain_research_report` output adds `capture_scopes`
- CLI `o2b brain distill`: `--strict-quotes`, `--excerpt-file <path>`; `--json` adds `capture_scope` and `quotes`; human suffixes ` [quotes verified:V unquoted:U]` and ` [bounded-local]`
- A strict refusal on MCP: `MCPError(INVALID_PARAMS, "brain_distill_source: <message>", { code: "quote_unverified" })`

## File ownership (every file this plan touches, exactly one owner)

| Lane | Owns |
| ---- | ---- |
| A substrate | `src/core/brain/provenance/capture-scope.ts` (new), `src/core/brain/distill/quote-spans.ts` (new), `src/core/brain/distill/quote-verdict.ts` (new), `src/core/brain/intake/source-trust.ts`, `src/core/brain/ingest/content-manifest.ts`, `src/mcp/tool-error-codes.ts`, `tests/core/brain/provenance/capture-scope.test.ts` (new), `tests/core/brain/distill/quote-spans.test.ts` (new), `tests/core/brain/distill/quote-verdict.test.ts` (new), `tests/core/brain/intake/source-origin-bytes.test.ts` (new), `tests/mcp/tool-error-codes.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts` |
| B quote check and distill write path | `src/core/brain/distill/block-resolve.ts` (new), `src/core/brain/distill/quote-check.ts` (new), `src/core/brain/distill/distill-source.ts`, `tests/core/brain/distill/block-resolve.test.ts` (new), `tests/core/brain/distill/quote-check.test.ts` (new), `tests/core/brain/distill/distill-source-quotes.test.ts` (new), `tests/core/brain/distill/distill-source-capture.test.ts` (new), `tests/core/brain/distill/distill-source.test.ts`, `tests/core/brain/distill/distill-source-trust.test.ts` |
| C capture scope, ingest, research, detector | `src/core/brain/ingest/ingest.ts`, `src/core/brain/research/research.ts`, `src/core/brain/source-links.ts` (new), `src/core/brain/source-cleanup.ts`, `src/core/brain/hygiene/detectors/capture-scope.ts` (new), `src/core/brain/hygiene/types.ts`, `src/core/brain/hygiene/scan.ts`, `tests/core/brain/ingest/ingest-capture-scope.test.ts` (new), `tests/core/brain/research/research-capture-scope.test.ts` (new), `tests/core/brain/source-links.test.ts` (new), `tests/core/brain/hygiene-capture-scope.test.ts` (new), `tests/mcp/hygiene-link-integrity.test.ts` |
| D surfaces and docs | `src/mcp/brain/distill-tools.ts`, `src/mcp/brain/ingest-tools.ts`, `src/mcp/brain/research-tools.ts`, `src/mcp/brain/hygiene-tools.ts`, `src/mcp/registry-guard.ts`, `src/cli/brain/verbs/distill.ts`, `src/cli/command-manifest.ts`, `tests/mcp/distill-tool.test.ts`, `tests/mcp/distill-quotes-envelope.test.ts` (new), `tests/mcp/ingest-tool.test.ts`, `tests/mcp/research-tool.test.ts`, `tests/cli/brain-distill.test.ts`, `tests/cli/brain-hygiene.test.ts`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md` |

Shared-file rules:
- `tests/core/architecture/verdict-vocabulary-census.test.ts` is lane A's. Both four-piece vocabularies (`CAPTURE_SCOPE`, `QUOTE_CHECK_OUTCOME`) are lane A's, so the census is green from A1/A3 onward. A lane that believes it needs a new four-piece vocabulary reports it instead of adding one.
- `tests/mcp/hygiene-link-integrity.test.ts` pins `HYGIENE_DETECTOR_IDS`; lane C owns it so the id and the pin change in one commit (C4).
- `src/core/brain/distill/distill-source.ts` is lane B's alone. The capture-scope stamp on distillation pages is done by B4 with lane A's helpers; lane C never edits it.
- `src/mcp/brain/hygiene-tools.ts` derives its enum from `HYGIENE_DETECTOR_IDS`; lane D edits only its description text (D3).
- `tests/core/brain/distill/distill-source-trust.test.ts:278-309` (byte identity of a clean trusted page) must stay green unchanged; it is listed under B only so that a deliberate change, if one is ever needed, has an owner. Expected: no edit.
- Not touched by any lane: `src/core/brain/entities/canonical.ts`, `src/mcp/brain/shared.ts`, `src/core/brain/page-lint.ts` (only imported), `openclaw/index.js`, `plugins/codex/`, `CHANGELOG.md`, `package.json`.

Size: 49 files in the table (20 new: 9 source, 11 test), within the 35-50 budget.

## Tasks

### Lane A - shared substrate (commits first)

### Task A1: capture-scope vocabulary, classifier, frontmatter and excerpt block
- **Files**: `src/core/brain/provenance/capture-scope.ts` (new), `tests/core/brain/provenance/capture-scope.test.ts` (new), `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Test first**: (a) the four-piece shape: frozen object, frozen member list equal to its values, guard accepts each member and rejects `"full_local"`, `""`, `null`; (b) `classifyCaptureScope` over a temp vault: an existing vault file -> `full-local`; `https://x.test/a`, `//x.test/a`, `evil.com/x` -> `url-only`; a vault-shaped path with no file -> `url-only`; a directory -> `url-only`; (c) `captureScopeFrontmatter(full-local)` is `{}`, the others carry the key; `captureScopesFrontmatter` is `{}` for all-full-local and a list otherwise; (d) `renderExcerptSection` then `readExcerptSection` round-trips text containing a triple-backtick run, CJK text and a trailing newline exactly; `readExcerptSection` on a body without the heading is `null`; (e) `assertExcerptAdmissible` throws `CaptureExcerptError` for a `full-local` scope, a whitespace-only excerpt and one byte over the cap (multi-byte characters counted as bytes), and passes at the cap; (f) the census lists `CAPTURE_SCOPE`.
- **Acceptance**: tests pass; census test passes; `bun run typecheck` clean.
- **Depends on**: none

### Task A2: quote-span finder and comparison normaliser
- **Files**: `src/core/brain/distill/quote-spans.ts` (new), `tests/core/brain/distill/quote-spans.test.ts` (new)
- **Test first**: cases are built from code points, not from word lists: (a) every one of U+0022, U+0027, U+00AB/U+00BB both directions, U+201C/U+201D, U+201E/U+201C, U+2018/U+2019, U+201A/U+2018, U+300C/U+300D, U+300E/U+300F, U+301D/U+301E pairs into exactly one span with the right `inner`; (b) a mark between two `\p{L}` letters (Latin, Cyrillic and Greek letters generated by code point) is never a delimiter, so `X’Y` alone yields zero spans and zero unpaired; (c) nested `“a ‘b’ c”` yields one outer span; (d) a lone opener yields `unpaired: 1`, zero spans; (e) an empty span `""` is not a span; (f) `unquoteSpans` removes exactly the two marks and keeps every other byte; (g) `normalizeForQuoteComparison` folds NFD to NFC, `**b**`, `_i_`, `` `c` ``, `~~s~~`, `[t](u)`, `[[p|a]]`, `[[p]]`, `> `, `- `, `1. ` and a trailing ` ^id`, collapses whitespace, and does NOT change case or punctuation; (h) `splitEllipsisFragments` splits on U+2026 and on three or more dots, drops empty fragments; `spanOccursIn` requires order and no overlap.
- **Acceptance**: tests pass; `bun run typecheck` clean.
- **Depends on**: A1 (ordering only)

### Task A3: quote outcome vocabulary, report types, named error and wire code
- **Files**: `src/core/brain/distill/quote-verdict.ts` (new), `src/mcp/tool-error-codes.ts`, `tests/core/brain/distill/quote-verdict.test.ts` (new), `tests/mcp/tool-error-codes.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Test first**: (a) four-piece shape of `QUOTE_CHECK_OUTCOME`; `QUOTE_CHECK_OUTCOME.urlOnly === CAPTURE_SCOPE.urlOnly` (one name for "no local bytes", decision 13); (b) `QuoteCheckError` carries `code === "quote_unverified"`, its message contains `claim 0: not-in-block` for a finding at index 0 and never the span text; (c) `codeForError(new QuoteCheckError([...]))` is `quote_unverified` and `TOOL_ERROR_CODE.quoteUnverified === QUOTE_UNVERIFIED_CODE`; (d) census lists `QUOTE_CHECK_OUTCOME`.
- **Acceptance**: tests pass, including the existing `tool-error-codes` and census suites; `bun run typecheck` clean.
- **Depends on**: A2

### Task A4: one source read feeds the digest and the bytes
- **Files**: `src/core/brain/intake/source-trust.ts`, `src/core/brain/ingest/content-manifest.ts`, `tests/core/brain/intake/source-origin-bytes.test.ts` (new)
- **Test first**: (a) `readSourceOrigin` on a vault file returns `trust: trusted`, `contentHash === hashFile(abs)`, and `sha256(bytes) === contentHash`; (b) on a URL and on a missing file returns untrusted with neither `contentHash` nor `bytes`; (c) above `SOURCE_HASH_MAX_BYTES` throws `SourceTrustError`, as `classifySourceOrigin` does; (d) `hashBytes` equals `hashFile` for a file with a BOM and invalid UTF-8; (e) a spy on `readFileSync` (or a counting wrapper) proves one read per call.
- **Acceptance**: new test passes; `tests/core/brain/intake/*.test.ts` and `tests/core/brain/ingest/content-manifest.test.ts` pass unchanged; `bun run typecheck` clean.
- **Depends on**: none

### Lane B - quote check and the distill write path

### Task B1: block resolver
- **Files**: `src/core/brain/distill/block-resolve.ts` (new), `tests/core/brain/distill/block-resolve.test.ts` (new)
- **Test first**: (a) a paragraph line ending ` ^p1` resolves to the paragraph without the marker (multi-line paragraph included); (b) a list item ending ` ^li` resolves to that item; (c) a standalone `^t1` line after a table or blockquote resolves to that block; (d) an id inside a fenced code block is ignored (`not-found`); (e) two definitions give `ambiguous`; (f) an id that is a prefix of another (`^a` vs `^ab`) does not match; (g) CRLF sources resolve identically.
- **Acceptance**: tests pass.
- **Depends on**: lane A complete

### Task B2: the pure quote check
- **Files**: `src/core/brain/distill/quote-check.ts` (new), `tests/core/brain/distill/quote-check.test.ts` (new)
- **Test first**: (a) a verbatim span in a claim citing an existing block -> `verified-in-block`, claim unchanged; (b) the same span differing in one word -> `not-in-block`, the claim's marks removed and words kept, finding `{claim: 0, outcome: "not-in-block", span}`; (c) a claim without `block` matched anywhere -> `verified-in-source`, missing -> `not-in-source`; (d) a cited block that does not resolve -> `block-not-found` even when the span appears elsewhere in the source (decision 7); duplicate -> `block-ambiguous`; (e) evidence `url-only` -> every span `url-only`, unquoted; evidence `not-text` -> `source-not-text`; (f) curly versus straight inner marks, NFD versus NFC, emphasis in the source and collapsed whitespace all verify; a case difference does not; an ellipsis span verifies only with fragments in order; `[sic]` fails; (g) no spans anywhere -> `report: null` and claims identical; (h) 30 failing spans -> `total: 30`, `returned: 25`, `truncated: true`; `span` capped at 120 characters; (i) unpaired marks counted and claims unchanged.
- **Acceptance**: tests pass.
- **Depends on**: B1

### Task B3: quote check inside `distillSource`, strict refusal
- **Files**: `src/core/brain/distill/distill-source.ts`, `tests/core/brain/distill/distill-source-quotes.test.ts` (new), `tests/core/brain/distill/distill-source.test.ts`
- **Test first**: (a) a trusted source with a block-cited verbatim quote: page keeps the marks, frontmatter has `quotes_verified: 1` and `quotes_unquoted: 0`, result `quotes.verified_in_block === 1`; (b) a paraphrase in marks: page shows the words without marks, `quotes_unquoted: 1`, result names the finding; (c) `strictQuotes: true` with the paraphrase throws `QuoteCheckError` and writes nothing (no file, no directory created); (d) re-running the same input is inert (bytes and `updated_at` unchanged); (e) a page with no quoted spans is byte-identical to the 3ec2334a output (existing `distill-source.test.ts` and `distill-source-trust.test.ts` pass unchanged); (f) the check uses `readSourceOrigin` bytes: the source is rewritten between two calls and the verdict follows the bytes whose digest is on the page; (g) the header comment states the new contract (structural validation PLUS the quote check).
- **Acceptance**: tests pass; existing distill suites pass unchanged.
- **Depends on**: B2

### Task B4: capture scope and the bounded excerpt on distillation pages
- **Files**: `src/core/brain/distill/distill-source.ts`, `tests/core/brain/distill/distill-source-capture.test.ts` (new), `tests/core/brain/distill/distill-source-trust.test.ts` (expected: unchanged)
- **Test first**: (a) a trusted source -> `captureScope: "full-local"`, no `capture_scope` key, page byte-identical to before; (b) a URL source -> `capture_scope: url-only` on the page beside `untrusted_source: true`, result `captureScope: "url-only"`, any quoted span unquoted with outcome `url-only`; (c) a URL source with `excerpt` -> `capture_scope: bounded-local`, `excerpt_hash` equal to `excerptDigest(excerpt)`, a `## Excerpt` section that `readExcerptSection` returns verbatim, and a quote present in the excerpt verifies (`verified-in-source`, or `verified-in-block` when the excerpt carries the cited `^id`); (d) `excerpt` with a trusted source throws `CaptureExcerptError` and writes nothing; an over-cap excerpt likewise; (e) idempotent re-run with the excerpt is inert.
- **Acceptance**: tests pass; `bun run typecheck` clean.
- **Depends on**: B3

### Lane C - capture scope on ingest and research, the detector

### Task C1: capture scope on ingest summary pages
- **Files**: `src/core/brain/ingest/ingest.ts`, `tests/core/brain/ingest/ingest-capture-scope.test.ts` (new)
- **Test first**: (a) an in-vault source -> result `captureScope: "full-local"`, page byte-identical to the 3ec2334a output; (b) a URL source -> page carries `capture_scope: url-only`, result `captureScope: "url-only"`; (c) re-ingest of an unchanged URL source is inert.
- **Acceptance**: new test and `tests/core/brain/ingest/ingest.test.ts`, `tests/core/brain/intake/intake-trust.test.ts` pass.
- **Depends on**: lane A complete

### Task C2: per-source capture scopes on research reports
- **Files**: `src/core/brain/research/research.ts`, `tests/core/brain/research/research-capture-scope.test.ts` (new)
- **Test first**: (a) every source an in-vault file -> no `capture_scopes` key, result `captureScopes` all `full-local`; (b) one URL and one vault file -> `capture_scopes: [url-only, full-local]` in `sources` order; (c) a wikilinked source `[[x.md]]` is classified by its target.
- **Acceptance**: new test and `tests/core/brain/research/research.test.ts` pass.
- **Depends on**: C1 (ordering only; C1 and C2 touch different files)

### Task C3: lift the source-link helpers
- **Files**: `src/core/brain/source-links.ts` (new), `src/core/brain/source-cleanup.ts`, `tests/core/brain/source-links.test.ts` (new)
- **Test first**: (a) `stringArrayField` and `wikilinkTarget` behave exactly as before (cases copied from `source-cleanup` behaviour: aliases, headings, block refs, `.md` suffix); (b) `sourcesSectionTargets` returns the targets under `## Sources` only and stops at the next heading.
- **Acceptance**: new test passes; `tests/core/brain/source-cleanup.test.ts` and `tests/core/brain/gates/recoverability.test.ts` pass unchanged.
- **Depends on**: C2 (ordering only)

### Task C4: the `capture-scope` hygiene detector
- **Files**: `src/core/brain/hygiene/detectors/capture-scope.ts` (new), `src/core/brain/hygiene/types.ts`, `src/core/brain/hygiene/scan.ts`, `tests/core/brain/hygiene-capture-scope.test.ts` (new), `tests/mcp/hygiene-link-integrity.test.ts`
- **Test first**: (a) a research report citing only URLs -> one `warning` finding with `proposed_action: review` and the URLs in `evidence.sources`; (b) a report citing one URL and one vault file -> no finding; (c) a released entity (`status: active`, no marker, `## Sources` citing a URL) -> finding; the same entity in `quarantine` -> none; (d) an ingest page with `untrusted_source: true` -> none (gate excludes it); (e) a distillation page with no `capture_scope` whose vault source file was deleted -> finding with `evidence.stamped: null` (re-derived, decision 17); (f) a `bounded-local` page with an intact excerpt -> none; with the excerpt section removed or edited -> finding with `stamped: "bounded-local"`; (g) the detector runs in the default sweep; `HYGIENE_DETECTOR_IDS` pin updated; finding ids are deterministic.
- **Acceptance**: tests pass; `tests/cli/brain-hygiene.test.ts` still passes (lane D adjusts it only if it pins the default list).
- **Depends on**: C3

### Lane D - surfaces, envelope tests and docs

### Task D1: `brain_distill_source` surface
- **Files**: `src/mcp/brain/distill-tools.ts`, `src/mcp/registry-guard.ts`, `tests/mcp/distill-tool.test.ts`, `tests/mcp/distill-quotes-envelope.test.ts` (new)
- **Test first**: (a) `strict_quotes` and `excerpt` are declared with descriptions of 160 characters or fewer, the tool description stays within 300 and still contains `untrusted_source` and `search_trust_gate_enabled`; (b) the result carries `capture_scope` always and `quotes` only when spans exist, with the contract keys verbatim; (c) a strict refusal answers a JSON-RPC error whose `data.code` is `quote_unverified` and writes nothing; (d) an inadmissible excerpt answers `invalid_params` with a message naming the reason; (e) the budget rationale string for `brain_distill_source` names the quotes report.
- **Acceptance**: tests pass, `tests/mcp/registry-guard.test.ts` and `tests/mcp/tool-error-envelope.test.ts` pass.
- **Depends on**: B4

### Task D2: `o2b brain distill` surface
- **Files**: `src/cli/brain/verbs/distill.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-distill.test.ts`
- **Test first**: (a) `--strict-quotes` on a paraphrase exits 1 with `distill: ` plus the `QuoteCheckError` message, and writes nothing; (b) `--excerpt-file` with a URL source writes a `bounded-local` page and the human line ends with ` [untrusted_source] [bounded-local]` (order pinned); (c) a checked quote adds ` [quotes verified:1 unquoted:0]`; (d) `--json` carries `capture_scope` and `quotes`; (e) the existing human line for a clean trusted run is unchanged; (f) the manifest entry lists the two new flags.
- **Acceptance**: tests pass.
- **Depends on**: B4

### Task D3: ingest, research and hygiene surfaces
- **Files**: `src/mcp/brain/ingest-tools.ts`, `src/mcp/brain/research-tools.ts`, `src/mcp/brain/hygiene-tools.ts`, `tests/mcp/ingest-tool.test.ts`, `tests/mcp/research-tool.test.ts`, `tests/cli/brain-hygiene.test.ts`
- **Test first**: (a) `brain_ingest_source` returns `capture_scope`; (b) `brain_research_report` returns `capture_scopes` aligned with `sources`; (c) the `brain_hygiene` schema enum and description include `capture-scope` and stay within the registry caps; (d) the CLI hygiene default sweep lists the new detector where the test pins the list.
- **Acceptance**: tests pass; `tests/mcp/registry-guard.test.ts` passes.
- **Depends on**: C4

### Task D4: reference docs
- **Files**: `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md`
- **Test first**: none new; the docs suites (`tests/docs/*.test.ts`) must pass.
- **Content**: a `brain_distill_source` section in `docs/mcp.md` and an `o2b brain distill` entry in `docs/cli-reference.md` (neither exists): inputs, the quote check, the matching tolerance (decision 5-7), the unquote default and the strict refusal with `quote_unverified`, the `quotes` report keys, `capture_scope` and the excerpt; the `capture-scope` detector added to the hygiene detector lists (`docs/cli-reference.md:493`, `docs/mcp.md:379` and the detector table near `:1867`); a short capture-scope section in `docs/how-it-works.md` (the three values, stamp at write, re-derive on read, the warning). Keep `docs/mcp.md:1310-1318` true. English, "Open Second Brain" in full, no exclamation marks, no card ids.
- **Acceptance**: `bun test tests/docs` passes; every flag and key named in the docs exists in the code.
- **Depends on**: lane A complete (drafted from the contract), finalised after D1-D3.
