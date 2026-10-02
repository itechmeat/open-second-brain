# Non-Markdown source ingest - implementation plan

Design: `docs/brainstorm/non-markdown-ingest/design.md` (decision ids R*, I*, H*, T*, L*, E* below refer to its "Design decisions").

## How to run this plan

Five lanes with DISJOINT file ownership run concurrently in the one worktree. Lane A (shared substrate) commits A1-A3 first; lanes B-E start at once and wait only on the lane A task named in "Depends on". Lane A's last task A4 waits on B2 and C2, the two pure modules whose signatures this contract pins. A lane edits only the files listed for it under "File ownership". Every task is TDD: write the named test first, run it and see it fail for the stated reason, implement, see it pass, then `bunx oxfmt` and `bunx oxlint -c oxlint.json` on the lane's own files only, then ONE step `git commit --only <own paths> -m "<conventional message>"` (retry on `index.lock`; after five hook rejections caused by another lane's files, check your own files and commit with `--no-verify`). Gates per task: `bun test <the task's test files>` and `bun run typecheck`, Bun 1.4.0 (`~/.cache/osb-pr-prepare/bun-1.4.0/bun-linux-x64`). Tests use forward-slash vault-relative paths, never compare absolute paths (Windows CI), use `tests/helpers/platform.ts` guards for permission and FIFO rows, and take credential-shaped literals (cells, `href`s) from `fakeCredential()`; no identifier contains `secret` before `=` or `:`.

CHANGELOG, the version bump (1.69.0) and the OpenClaw bundle belong to no lane. No lane edits a bundled module (`openclaw/index.js` carries `redactor.ts` and `vault.ts`; lane C only imports `redactor.ts`); the integrator rebuilds the bundle after the last `src/` change and runs `tests/openclaw/bundle-node.test.ts`.

Dependencies:

- A1 -> A2 -> A3 (one lane, in order); B2 and C2 -> A4.
- A1 -> B1 -> B2; A4 -> B3 -> B4.
- A1 -> C1 -> C2; A4 -> C3.
- D1 -> D2 -> D3 -> D4 (no lane A dependency; waits on A1 only so the census edit lands first).
- E1 and E2 need nothing; E3 (docs) depends on A4, B3, C3, D4 and E2 (it describes and verifies their shipped behaviour).

## Cross-lane contract (pinned now; no lane renames or re-spells any of this)

### `src/core/brain/ingest/source-formats.ts` (lane A, A1; Node-safe leaf, no `Bun.*`, imports only types)

- `SOURCE_FORMAT = Object.freeze({ text: "text", csv: "csv", tsv: "tsv", html: "html", pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx", odt: "odt", ods: "ods", odp: "odp", epub: "epub", rtf: "rtf", image: "image" } as const)`, `type SourceFormat`, `SOURCE_FORMATS` (frozen, this order), `isSourceFormat(value: unknown): value is SourceFormat`. Census row `SOURCE_FORMAT`.
- `SOURCE_EXTRACTOR = Object.freeze({ verbatim: "verbatim", html: "html", table: "table" } as const)`, `type SourceExtractor` (no list, no guard: not a reason vocabulary).
- `interface SourceFormatSpec { readonly format: SourceFormat; readonly extractor: SourceExtractor | null; readonly extensions: ReadonlyArray<string> }`
- `SOURCE_FORMAT_SPECS: ReadonlyArray<SourceFormatSpec>`, this order: text `verbatim` (`.md .markdown .txt .text .rst .org`), csv `table` (`.csv`), tsv `table` (`.tsv`), html `html` (`.html .htm`), pdf `null` (`.pdf`), docx `null` (`.docx`), xlsx `null` (`.xlsx`), pptx `null` (`.pptx`), odt `null` (`.odt`), ods `null` (`.ods`), odp `null` (`.odp`), epub `null` (`.epub`), rtf `null` (`.rtf`), image `null` (`.png .jpg .jpeg .gif .webp .bmp .tif .tiff .heic`).
- `SOURCE_FORMAT_BY_EXTENSION: ReadonlyMap<string, SourceFormat>`; `sourceFormatOf(path: string): SourceFormat | null` (lowercased extension of the last path segment, `""` never matches); `sourceFormatSpec(format: SourceFormat): SourceFormatSpec`.
- `DEFAULT_INGESTIBLE_EXTENSIONS: readonly string[]` = `.md .markdown .txt .text .rst .org .csv .tsv .html .htm` (derived, frozen); `batch-plan.ts` re-exports it under the same name.
- `SOURCE_EXTRACT_SKIP_REASON = Object.freeze({ formatReadVerbatim: "format-read-verbatim", formatNotExtractable: "format-not-extractable", formatUnknown: "format-unknown", sourceNotLocal: "source-not-local", sourceTooLarge: "source-too-large", notARegularFile: "not-a-regular-file", notUtf8: "not-utf8" } as const)`, `type SourceExtractSkipReason`, `SOURCE_EXTRACT_SKIP_REASONS`, `isSourceExtractSkipReason`. Census row `SOURCE_EXTRACT_SKIP_REASON`.

### `src/core/brain/ingest/extractable-gate.ts` and the planner (lane A, A1-A2)

- `SKIPPED_PAGE_REASON.formatNotExtractable = "format-not-extractable"`, FIRST in `SKIPPED_PAGE_REASONS`; `SkippedPage.detail` = the `SourceFormat` token. `parseSkippedPageReason` unchanged.
- `PlannedFile.format?: SourceFormat` (absent when `text`); wire key `format` after `status` in `serializeBatchPlan`; CLI text line `- <path> (<status>, <bytes>B, <format>)` only when present.
- `skippedNonExtractable` = format skips sorted by path, then schema skips. Existing wire keys `skipped_non_extractable` and `skip_reason_counts` reused.
- Fixtures `.png`/`.csv` in `batch-plan.test.ts:289-330` and `brain-batch-plan-ignore-warnings.test.ts:205-242` become `.bin`/`.dat`.

### Shared helpers (lane A, A3)

- `src/core/markdown-fence.ts`: `export function fenceFor(text: string): string` (moved verbatim from `provenance/capture-scope.ts:178-182`).
- `src/core/brain/ingest/ingest.ts`: `export function readSourceBounded(absolute: string, maxBytes: number): { readonly text: string; readonly unread?: undefined } | { readonly text: null; readonly unread: SourceUnread }`, `SourceUnread` exported with members `"not a regular file"` and `"larger than the read limit"` (unchanged strings). Callers map them to `not-a-regular-file` and `source-too-large`.

### `src/core/brain/ingest/extract-html.ts` (lane B, B1-B2; pure, no I/O)

- `HTML_EXTRACT_MAX_SOURCE_BYTES = SOURCE_HASH_MAX_BYTES`, `HTML_PARTS_MAX = 256`, `HTML_HEADING_MAX_CHARS = 200`.
- `interface HtmlPart { readonly index: number; readonly level: number; readonly heading: string; readonly trail: string; readonly lineStart: number; readonly lineEnd: number; readonly sourceOffset: number }`
- `interface HtmlExtraction { readonly extracted: true; readonly title: string | null; readonly text: string; readonly parts: ReadonlyArray<HtmlPart>; readonly partsOmitted: number }`
- `type HtmlExtractResult = HtmlExtraction | { readonly extracted: false; readonly reason: typeof SOURCE_EXTRACT_SKIP_REASON.notUtf8 }`
- `extractHtml(bytes: Uint8Array): HtmlExtractResult`
- `renderPartsSection(extraction: HtmlExtraction): string` - `""` when there are no parts, else `## Parts`, blank line, one fence by `fenceFor` with info string `parts`, one line per part: `h<level> <trail> | lines <a>-<b>`, level 0 as `preamble | lines <a>-<b>`.

### `src/core/brain/ingest/table-note.ts` (lane C, C1-C2; pure, no I/O)

- Constants: `TABLE_NOTE_MAX_ROWS = 1_000`, `TABLE_NOTE_MAX_COLUMNS = 64`, `TABLE_NOTE_MAX_CELL_CHARS = 256`, `TABLE_NOTE_MAX_BYTES = 262_144`, `TABLE_NOTE_ROWS_PER_GROUP = 50`, `TABLE_NOTE_GROUP_MAX_TOKENS = 600`.
- `TABLE_DELIMITER = Object.freeze({ comma: "comma", semicolon: "semicolon", tab: "tab" } as const)`, `type TableDelimiter`.
- `TABLE_TRUNCATION = Object.freeze({ rows: "rows", columns: "columns", cells: "cells", bytes: "bytes" } as const)`, `TableTruncation`, `TABLE_TRUNCATIONS`, `isTableTruncation`.
- `TABLE_NOTE_SKIP_REASON = Object.freeze({ sourceNotLocal: "source-not-local", notUtf8: "not-utf8", containsNul: "contains-nul", malformedQuoting: "malformed-quoting", empty: "empty" } as const)`, `TableNoteSkipReason`, `TABLE_NOTE_SKIP_REASONS`, `isTableNoteSkipReason`.
- `type TableFormat = typeof SOURCE_FORMAT.csv | typeof SOURCE_FORMAT.tsv`
- `interface TableNoteRendered { readonly rendered: true; readonly format: TableFormat; readonly delimiter: TableDelimiter; readonly columns: number; readonly rows: number; readonly rowsRendered: number; readonly truncated: ReadonlyArray<TableTruncation>; readonly redactedCells: number; readonly section: string }`
- `interface TableNoteSkipped { readonly rendered: false; readonly format: TableFormat; readonly reason: TableNoteSkipReason; readonly detail?: string }`; `type TableNoteResult = TableNoteRendered | TableNoteSkipped`.
- `tableNote(path: string, bytes: Uint8Array): TableNoteResult` (throws `TypeError` naming the path when its format is not csv or tsv: a caller error).
- `tableNoteFrontmatter(result: TableNoteRendered): FrontmatterMap` -> `table_delimiter`, `table_columns`, `table_rows`, `table_rows_rendered`, `table_truncated` (absent when empty), in this order.
- Section: `## Table`, then per group `### Rows <a>-<b>` (1-based data rows) and one fence by `fenceFor` with info string `table`, header record first, cells joined by ` | `, escapes per T1; last line `Rendered <n> of <m> rows.` only when `rowsRendered < rows`.
- `src/core/search/chunker.ts` (lane C): `export const DEFAULT_CHUNK_MAX_TOKENS = 800` (the existing `DEFAULT_MAX_TOKENS` renamed and exported) and `export function countChunkTokens(text: string): number` (the existing `countTokens`, exported under this name). `CHUNKER_VERSION` untouched.

### `src/core/brain/ingest/extract-source.ts` (lane A, A4)

- `type SourceExtraction = { readonly extractor: typeof SOURCE_EXTRACTOR.html; readonly format: SourceFormat; readonly html: HtmlExtractResult } | { readonly extractor: typeof SOURCE_EXTRACTOR.table; readonly format: SourceFormat; readonly table: TableNoteResult } | { readonly extractor: null | typeof SOURCE_EXTRACTOR.verbatim; readonly format: SourceFormat | null; readonly reason: SourceExtractSkipReason }`
- `extractSource(path: string, bytes: Uint8Array): SourceExtraction`; an unregistered extension answers `{extractor: null, format: null, reason: "format-unknown"}` before the switch. The switch arms, exactly:
  - `case null: return { extractor: null, format: spec.format, reason: SOURCE_EXTRACT_SKIP_REASON.formatNotExtractable };`
  - `case SOURCE_EXTRACTOR.verbatim: return { extractor: spec.extractor, format: spec.format, reason: SOURCE_EXTRACT_SKIP_REASON.formatReadVerbatim };`
  - `case SOURCE_EXTRACTOR.html: return { extractor: spec.extractor, format: spec.format, html: extractHtml(bytes) };`
  - `case SOURCE_EXTRACTOR.table: return { extractor: spec.extractor, format: spec.format, table: tableNote(path, bytes) };`
- `type PartsOutcome = { readonly extracted: true; readonly count: number; readonly omitted?: number } | { readonly extracted: false; readonly reason: SourceExtractSkipReason }`
- `type TableOutcome = Omit<TableNoteRendered, "section"> | TableNoteSkipped`
- `interface SourceDerivation { readonly format: SourceFormat; readonly frontmatter: FrontmatterMap; readonly section: string; readonly parts?: PartsOutcome; readonly table?: TableOutcome }`
- `deriveSourceSection(vault: string, source: string, trust: SourceTrust, readable?: (rel: string) => boolean): SourceDerivation | undefined` - `undefined` unless the format's extractor is `html` or `table` (text, unknown and named-unsupported sources: byte-identical page). Order: format, trusted lane and vault-relative file, `isSourceHidden`, `readSourceOrigin`. Not local, absent or hidden: `section ""`, `frontmatter {}`, outcome reason `source-not-local`. Read: `frontmatter` = `source_format`, then `sourceContentHashFrontmatter(contentHash)`, then the table keys when rendered.

### Ingest result and wire (lane A, A4)

- `IngestSourceResult.parts?: PartsOutcome`, `IngestSourceResult.table?: TableOutcome`.
- `brain_ingest_source` result keys, after `capture_scope` and before `pre_extract`: `parts: {extracted, count, omitted?} | {extracted: false, reason}` and `table: {rendered: true, format, delimiter, columns, rows, rows_rendered, truncated?, redacted_cells} | {rendered: false, format, reason, detail?}`.
- Frontmatter keys on derived pages: `source_format`, `source_content_hash`, then `table_delimiter`, `table_columns`, `table_rows`, `table_rows_rendered`, `table_truncated`. Body section order: summary, provenance, `## Entities`, `## Connections to existing notes`, then `## Parts` or `## Table`.
- `registry-guard.ts:352`: `brain_ingest_source: "write; returns the summary path, bounded id lists and derived-section counts"`.

### CLI `o2b brain extract <file> [--json]` (lane B, B3)

- Manifest entry `extract` (flags `--json`), dispatch case `"extract"` in `src/cli/brain.ts`, export `runBrainExtract` from `verbs/index.ts`.
- Reads `readSourceBounded(file, HTML_EXTRACT_MAX_SOURCE_BYTES)`; `unread` maps to `not-a-regular-file` or `source-too-large`.
- JSON: html `{path, extracted: true, format: "html", title, text, parts: [{index, level, heading, trail, line_start, line_end, source_offset}], parts_omitted?}`; csv/tsv rendered `{path, extracted: true, format, delimiter, columns, rows, rows_rendered, truncated?, redacted_cells, section}`; anything else `{path, extracted: false, format, reason, detail?}` (`format` is `null` for an unknown extension). Exit code 0 in every case: "could not extract" is data.
- Text: `extract: <path> (<format>)` then the title line, `<n> part(s)` with one `h<level> <trail> | lines <a>-<b>` line each, or the table counts line and the section, or `not extracted: <reason>`.

### Reach (lane D)

- `indexRootCoverage(config: ResolvedSearchConfig, roots: ReadonlyArray<string>, admit?: (path: string, indexedTags: ReadonlyArray<string>) => boolean): Promise<IndexRootCoverage>`; `probeRetrievalCorpus(resolveConfig, reach?: TransportReach)`.
- Brief: rows dropped below local reach are filtered with `readerRefView`; no new wire key, no error code.
- `RECALL_GATE_INPUT_SCHEMA.properties.turn_id = { type: "string", maxLength: 512, description: "Optional turn correlation id recorded on the telemetry record." }` (the `search-tools.ts:263` text); `GateTelemetryInput.turnId?: string`, payload key `CONTINUITY_TURN_ID_KEY`.

### Census and docs headings

- `tests/core/architecture/verdict-vocabulary-census.test.ts` (lane A): rows `SOURCE_FORMAT`, `SOURCE_EXTRACT_SKIP_REASON` (A1), `TABLE_NOTE_SKIP_REASON`, `TABLE_TRUNCATION` (A4). Lane C's own gates skip the census suite until A4.
- Docs (lane E): `docs/mcp.md` bullet "Since v1.69.0"; `docs/updating.md` section "Upgrading to 1.69.0"; `docs/cli-reference.md` lines for `extract` and `batch-plan`; README release paragraph. Public wording "answers at the caller's reach"; never security wording.

## File ownership (every file this plan touches, exactly one owner)

| Lane | Files |
|---|---|
| A | `src/core/brain/ingest/source-formats.ts` (new), `tests/core/brain/ingest/source-formats.test.ts` (new), `src/core/brain/ingest/extractable-gate.ts`, `tests/core/brain/ingest/extractable-gate.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`, `src/core/brain/ingest/batch-plan.ts`, `tests/core/brain/ingest/batch-plan.test.ts`, `tests/core/brain/ingest/batch-plan-extractable.test.ts`, `src/cli/brain/verbs/batch-plan.ts`, `tests/cli/brain-batch-plan-ignore-warnings.test.ts`, `tests/mcp/ingest-tool-ignore-warnings.test.ts`, `tests/mcp/ingest-plan-format-reach.test.ts` (new), `src/core/markdown-fence.ts` (new), `src/core/brain/provenance/capture-scope.ts`, `src/core/brain/ingest/ingest.ts`, `tests/core/brain/ingest/ingest.test.ts`, `src/core/brain/ingest/extract-source.ts` (new), `tests/core/brain/ingest/extract-source.test.ts` (new), `tests/core/brain/ingest/ingest-derived-section.test.ts` (new), `src/mcp/brain/ingest-tools.ts`, `src/mcp/registry-guard.ts` |
| B | `src/core/brain/ingest/extract-html.ts` (new), `tests/core/brain/ingest/extract-html.test.ts` (new), `src/cli/brain/verbs/extract.ts` (new), `src/cli/brain/verbs/index.ts`, `src/cli/brain.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-extract.test.ts` (new), `tests/mcp/ingest-parts-reach.test.ts` (new) |
| C | `src/core/brain/ingest/table-note.ts` (new), `tests/core/brain/ingest/table-note.test.ts` (new), `src/core/search/chunker.ts`, `tests/core/brain/ingest/table-note-chunks.test.ts` (new), `tests/mcp/ingest-tool-table.test.ts` (new) |
| D | `src/core/search/indexer.ts`, `src/core/search/pipeline/outcome.ts`, `src/mcp/search-tools.ts`, `src/core/search/visibility-surface-registry.ts`, `tests/core/search/index-root-coverage.test.ts` (new), `tests/mcp/derived-digest-search-reach.test.ts`, `src/mcp/brain/brief-tools.ts`, `tests/mcp/brief-ids-reach.test.ts` (new), at most two existing brief tests that need `{ reach: TRANSPORT_REACH.local }` (named in the commit body), `src/core/brain/gate-telemetry.ts`, `plugins/hermes/_schemas.py`, `tests/python/test_static_schemas.py`, `tests/mcp/recall-gate-turn-id.test.ts` (new) |
| E | `src/core/brain/architect/generate.ts`, `tests/core/brain/architect-dependencies.test.ts`, `src/core/search/surfacing-gate.ts`, `tests/core/search/surfacing-gate.test.ts`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/updating.md`, `docs/observability.md`, `README.md` |
| none | `CHANGELOG.md`, `package.json` and the version mirrors (PR preparation); `openclaw/index.js` (integrator) |

Expected size: about 57-59 changed files (19 new).

## Tasks

### Lane A - shared substrate (A1-A3 commit first)

### Task A1: format registry, extract skip reasons, the new gate member
- **Files**: `src/core/brain/ingest/source-formats.ts`, `tests/core/brain/ingest/source-formats.test.ts`, `src/core/brain/ingest/extractable-gate.ts`, `tests/core/brain/ingest/extractable-gate.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Acceptance**: the test pins the spec order, every extension's format, `sourceFormatOf` (case-insensitive, URL and extensionless paths give `null`), `DEFAULT_INGESTIBLE_EXTENSIONS` order, and that the module has no `Bun.` reference; `SKIPPED_PAGE_REASONS[0]` is `format-not-extractable`; the legacy parser still maps only to `schema-type-not-extractable`; census passes with both new rows.
- **Depends on**: none

### Task A2: planner routing, planned `format`, fixtures, planner A/B
- **Files**: `src/core/brain/ingest/batch-plan.ts`, `tests/core/brain/ingest/batch-plan.test.ts`, `tests/core/brain/ingest/batch-plan-extractable.test.ts`, `src/cli/brain/verbs/batch-plan.ts`, `tests/cli/brain-batch-plan-ignore-warnings.test.ts`, `tests/mcp/ingest-tool-ignore-warnings.test.ts`, `tests/mcp/ingest-plan-format-reach.test.ts`
- **Acceptance**: fixtures moved to `.bin`/`.dat` with unchanged totals; a tree with HTML, CSV, PDF, PNG and `.bin` plans the HTML and CSV with `format`, skips PDF and PNG as `format-not-extractable` (`detail` pdf, image) before schema skips, counts `.bin` unclassifiable; an `extensions` override that lists `.pdf` plans it; a Markdown-only tree serializes byte-identically; through the real MCPServer at remote reach a vault with a hidden Markdown page and one without give identical format-skip lists; the CLI text matches `cli-output/expected-output.md`.
- **Depends on**: A1

### Task A3: bounded reader grows on demand, shared fence helper
- **Files**: `src/core/brain/ingest/ingest.ts`, `tests/core/brain/ingest/ingest.test.ts`, `src/core/markdown-fence.ts`, `src/core/brain/provenance/capture-scope.ts`
- **Acceptance**: two `fstatReportsSize` spy rows (grows after the fstat but stays under the cap: read whole; grows past the cap: refused `larger than the read limit`); the over-cap and FIFO rows unchanged; the excerpt tests pass unchanged with the moved `fenceFor`.
- **Depends on**: A2

### Task A4: dispatch, derived section on the page, wire fields
- **Files**: `src/core/brain/ingest/extract-source.ts`, `tests/core/brain/ingest/extract-source.test.ts`, `src/core/brain/ingest/ingest.ts`, `tests/core/brain/ingest/ingest-derived-section.test.ts`, `src/mcp/brain/ingest-tools.ts`, `src/mcp/registry-guard.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Acceptance**: `extractSource` returns each arm for `.md`, `.html`, `.csv`, `.pdf`, `.xyz`; an HTML and a CSV source get `source_format`, `source_content_hash` equal to `hashBytes` of the file, and their section last; a `.md` source page is byte-identical to before; a URL `.csv`, an absent and a hidden `.csv` all give `table.reason` `source-not-local`, no digest, no section; an operator `visibility` survives a re-ingest; census passes with the two table rows; `brain_ingest_source` description length unchanged.
- **Depends on**: A3, B2, C2

### Lane B - HTML

### Task B1: linear scanner and text
- **Files**: `src/core/brain/ingest/extract-html.ts`, `tests/core/brain/ingest/extract-html.test.ts`
- **Acceptance**: entities (numeric, invalid code point, the six named, an unknown named kept), raw-text elements skipped, `<private>` placeholder, void elements, document-level text, `pre` whitespace, CRLF equals LF output, no attribute value emitted (a `fakeCredential()` `href`), title, malformed and unclosed tags, invalid UTF-8 refused as `not-utf8`, linear time on a 1 MiB adversarial input.
- **Depends on**: A1

### Task B2: parts, caps, `## Parts` section
- **Files**: `src/core/brain/ingest/extract-html.ts`, `tests/core/brain/ingest/extract-html.test.ts`
- **Acceptance**: levels, trail, 1-based line spans, `sourceOffset` of the start tag, preamble only when non-empty, 257 headings give 256 parts and `partsOmitted: 1`, a 300-character heading capped at 200, `renderPartsSection` output pinned, `[[x]]` and `#tag` in a heading yield no link or tag through `stripCode`.
- **Depends on**: B1

### Task B3: `o2b brain extract`
- **Files**: `src/cli/brain/verbs/extract.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-extract.test.ts`
- **Acceptance**: text and `--json` for an HTML, a CSV, a `.md`, a `.pdf` and an unknown extension match `cli-output/expected-output.md`; a FIFO answers `not-a-regular-file` (POSIX only); manifest-completeness and help-surface-parity suites pass.
- **Depends on**: A4

### Task B4: parts through the real MCPServer, reach A/B
- **Files**: `tests/mcp/ingest-parts-reach.test.ts`
- **Acceptance**: `brain_ingest_source` on an HTML vault file returns `parts {extracted: true, count}` and the page holds `## Parts`; at remote reach a vault with an owner-scoped HTML-named Markdown source and one without give identical normalised results and pages; a `.md` source result has no `parts` key.
- **Depends on**: B3

### Lane C - tables

### Task C1: CSV and TSV parsing, delimiter, header
- **Files**: `src/core/brain/ingest/table-note.ts`, `tests/core/brain/ingest/table-note.test.ts`
- **Acceptance**: CRLF, LF, lone CR, BOM, quoted delimiters and line breaks, `""`, bare quotes, an unterminated quote refused `malformed-quoting` with the record number, ragged rows, a semicolon export, a TSV with quotes kept, `contains-nul`, `not-utf8`, `empty`.
- **Depends on**: A1

### Task C2: render, caps, redaction, chunk-sized groups
- **Files**: `src/core/brain/ingest/table-note.ts`, `tests/core/brain/ingest/table-note.test.ts`, `src/core/search/chunker.ts`, `tests/core/brain/ingest/table-note-chunks.test.ts`
- **Acceptance**: every cap named in `truncated`; groups of at most 50 rows and 600 tokens; cell escapes; a fence longer than a backtick run in a cell; a `fakeCredential()` value under a key-like header and a URL with userinfo redacted and counted; `keyword` over-redaction pinned; `chunkMarkdown` over a rendered 400-row, 15-column page gives chunks that each carry the header line and a `Table > Rows a-b` heading path; determinism.
- **Depends on**: C1

### Task C3: table through the real MCPServer, reach A/B
- **Files**: `tests/mcp/ingest-tool-table.test.ts`
- **Acceptance**: the `table` wire field and the five frontmatter keys; an unchanged re-ingest is inert, a changed CSV rewrites the page; at remote reach a vault with a hidden `.csv`-named source and one without give identical normalised results and pages (`source-not-local`, no digest); a text source has no `table` key.
- **Depends on**: A4

### Lane D - reach left-overs and the gate argument

### Task D1: root coverage admits only readable paths
- **Files**: `src/core/search/indexer.ts`, `tests/core/search/index-root-coverage.test.ts`
- **Acceptance**: an `admit` that rejects every path leaves the root without documents; no `admit` is byte-identical to today.
- **Depends on**: A1

### Task D2: reach threaded into the corpus probe, registry, A/B
- **Files**: `src/core/search/pipeline/outcome.ts`, `src/mcp/search-tools.ts`, `src/core/search/visibility-surface-registry.ts`, `tests/mcp/derived-digest-search-reach.test.ts`
- **Acceptance**: a root holding only a reserved page and the same root empty give identical remote `brain_search` and `brain_recall_gate` verdicts; local stays `not_found`; the residual sentences leave both registry rows; visibility census passes.
- **Depends on**: D1

### Task D3: daily and weekly brief ids at reach
- **Files**: `src/mcp/brain/brief-tools.ts`, `tests/mcp/brief-ids-reach.test.ts`, `src/core/search/visibility-surface-registry.ts`, at most two existing brief tests
- **Acceptance**: with apply evidence inside BOTH the 24-hour and 30-day windows and a reserved preference confirmed and retired in the window, the two-vault remote A/B gives identical normalised daily and weekly envelopes and no delta snapshot; local still names the id and captures the delta; the `brain_brief` row states the remaining count residual.
- **Depends on**: D2

### Task D4: `turn_id` on the recall gate
- **Files**: `src/mcp/search-tools.ts`, `src/core/brain/gate-telemetry.ts`, `tests/mcp/recall-gate-turn-id.test.ts`, `plugins/hermes/_schemas.py`, `tests/python/test_static_schemas.py`
- **Acceptance**: the real MCPServer accepts `turn_id` and records it on `gate_telemetry` with telemetry on; 513 characters refused; the vendored schema equals the live projection; the Python suite drives `prefetch(..., turn_id=...)` through the conformance check.
- **Depends on**: D3

### Lane E - small fixes and docs

### Task E1: architect names the edges it cannot draw
- **Files**: `src/core/brain/architect/generate.ts`, `tests/core/brain/architect-dependencies.test.ts`
- **Acceptance**: only-unlinkable fixture prints the new fixed sentence plus code-span edges on the overview and `Not linked:` on the module note; the mixed fixture gains one line naming the dropped edge; the no-edge sentence tests at :137 and :155 unchanged; second run `unchanged`.
- **Depends on**: none

### Task E2: newline test on the raw prompt
- **Files**: `src/core/search/surfacing-gate.ts`, `tests/core/search/surfacing-gate.test.ts`
- **Acceptance**: `"git status\nwhy does this fail"` is retrieved; `"git status"` and `"$ ls -la"` still skipped as `shell_command`; the single-line `"git push keeps failing after the rebase"` stays skipped (pinned, the documented residue); the four-script contract test unchanged.
- **Depends on**: none

### Task E3: reference docs
- **Files**: `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/updating.md`, `docs/observability.md`, `README.md`
- **Acceptance**: "Since v1.69.0" bullet (formats, the header rule, caps, frontmatter keys, `parts` and `table`, redaction, the `turn_id` argument row); cli-reference lines for `extract` and `batch-plan`; how-it-works ingest paragraph and the architect clause; "Upgrading to 1.69.0" (CSV, TSV and HTML planned by default, re-ingest adds the section, `.png` and friends move from `unclassifiable` to format skips, plan ids of trees holding these formats change, `visibility` now kept on re-ingest, multi-line prompts starting with a command name admitted); observability row; README paragraph; every statement checked against the shipped code; no card ids, no exclamation marks, "Open Second Brain" in full.
- **Depends on**: A4, B3, C3, D4, E2
