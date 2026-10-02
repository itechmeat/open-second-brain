# Non-Markdown source ingest - HTML parts, CSV and TSV table notes, named unsupported formats, and readers that answer at the caller's reach

**Status:** draft (phase 1 spec review applied)
**Author:** release orchestrator (via feature-release-playbook)
**Audience:** implementation
**Base:** origin/main f5c46615 (v1.68.0), branch `feat/non-markdown-ingest`, target version 1.69.0 (minor)

## Problem statement

Ingest in Open Second Brain is text-only. `DEFAULT_INGESTIBLE_EXTENSIONS` (`src/core/brain/ingest/batch-plan.ts:78-85`) holds `.md .markdown .txt .text .rst .org`; every other file only adds to a per-extension `unclassifiable` count (`batch-plan.ts:600-604`). The search walker indexes `.md` files only (`src/core/search/walker.ts:118`), so an exported web page or a spreadsheet export in the vault never reaches search or recall. Nothing parses HTML into structure (the only reducer, `htmlToText` in `src/core/brain/research/extract.ts:27-37`, is a 4000-character web-finding helper with no headings and no entity decoding), nothing parses tables, and PDF, Office and image files are dropped by an anonymous count instead of being named. Six smaller defects ride along: the bounded source reader allocates its full cap for every file, the recall verdict's root coverage counts a root as reached through pages the caller cannot read, the daily and weekly brief views name preference ids from log events whatever the caller's reach, the architect says "no edges" when every declared edge touches a module a link cannot carry, the Hermes plugin's `turn_id` is refused by `brain_recall_gate`, and the surfacing gate has a dead newline branch.

## Premise verification (live source, f5c46615)

Full evidence: the reconnaissance reports of this wave (HTML extraction and format registry, CSV and TSV table notes, v1.68.0 left-overs, the surfacing-gate facts). The orchestrator re-opened the anchors this design builds on: `batch-plan.ts:75-100, 130-195, 255-330, 578-625`, `extractable-gate.ts:30-90`, `ingest.ts:168-240, 286-345`, `ingest-tools.ts:95-126, 255-275`, `registry-guard.ts:352`, `search-tools.ts:255-270, 566-610`, `surfacing-gate.ts:40-58`, `indexer.ts:1725-1752`, `brief-tools.ts:170-195`, `architect/generate.ts:335-345, 419-432`, `chunker.ts:28-36, 157`, the OpenClaw bundle's module list, and ran the current CLI on a fixture tree (outputs in `cli-output/expected-output.md`).

### Card A (source artifact ingest) - partly false, narrowed and built as narrowed

- False: "no general artifact indexer". Per-source summary pages with provenance (`ingestSource`, `ingest.ts:152-285`), the sources registry, the content-hash manifest (it hashes raw bytes, so a changed HTML or CSV file is re-planned with no change), the batch planner and a closed skip-reason union already exist.
- False in its framing: the pipeline never reads a source's text for the agent; the calling agent writes the summary. A "searchable part" can therefore only exist as text on the indexed Markdown summary page.
- Narrowed (validator ruling, kept): PDF, Office and images are named as unsupported, not extracted; OCR stays caller-side; watches and URL fetch are out.
- Built: a format registry, HTML text with heading-derived parts (headings and line spans only, never body text, on the page), a named `format-not-extractable` skip, and a read-only `o2b brain extract` preview verb.

### Card B (plain-text notes for tabular data) - confirmed, narrowed

- Confirmed: nothing in `src/` parses or renders tables; `.csv` is the canonical `unclassifiable` example in two test files.
- Narrowed: CSV and TSV only, no formulas or workbook metadata (those live in XLSX and ODS, named unsupported under card A), no new dependency.
- New contract recorded: this is the first time the kernel writes derived source content onto a `kind: brain-source` page. It does so only for an in-vault file in the trusted lane, after the reach check, with two redaction passes, under named caps.

### Fold-ins - confirmed, folded as narrowed

1. `readSourceBounded` allocates `PRE_EXTRACT_MAX_SOURCE_BYTES + 1` for every source (`ingest.ts:329`): confirmed; folded (the `architect/manifests.ts:224-249` pattern).
2. Coverage-divergent root flip (`indexRootCoverage`, `indexer.ts:1727-1750`, no reach filter): confirmed; folded.
3. Whole-layer status and brief counts: confirmed and wider than recorded (daily and weekly envelopes name preference ids from log events). Only the id slice is folded; the counts are deferred (see Out of scope).
4. Architect "no edges" sentence when only unlinkable edges exist (`generate.ts:419-432`, `NO_DEPENDS_ON` `:342`): confirmed, plus the same false sentence on the module note; folded.
5. Hermes `turn_id` refused by the closed `RECALL_GATE_INPUT_SCHEMA` (`search-tools.ts:566-609`, `additionalProperties: false`): confirmed; folded. The sibling schema at `search-tools.ts:263` already declares the same `turn_id` (512), which is the pattern copied.
6. Dead newline branch in `isShellOnlyPrompt` (`surfacing-gate.ts:53` tests `normalized`, already whitespace-collapsed at `:45`): confirmed. Premise corrected: testing the raw prompt for a line break admits multi-line prompts that start with a command name; a single-line prose prompt that starts with a command name ("git push keeps failing after the rebase") is still skipped as `shell_command`. The CHANGELOG and docs state exactly that, not "prose prompts are admitted".

## Scope

1. One format registry, `src/core/brain/ingest/source-formats.ts` (Node-safe leaf, no `Bun.*`): the `SOURCE_FORMAT` vocabulary, one spec per format with its extractor, the extension map, `sourceFormatOf`, and `DEFAULT_INGESTIBLE_EXTENSIONS` derived from it (re-exported from `batch-plan.ts`).
2. Planner: `.csv .tsv .html .htm` planned by default; PDF, Office, EPUB, RTF and image files reported per file as `format-not-extractable` with the format as `detail`; a planned file whose format is not `text` carries `format`.
3. HTML: a linear scanner (`extract-html.ts`) giving title, text and parts; `## Parts` on the summary page.
4. CSV and TSV: `table-note.ts` giving a fenced plain-text `## Table` section and five `table_*` frontmatter keys.
5. `brain_ingest_source`: automatic by format, `source_format` plus `source_content_hash` on derived pages, additive `parts` and `table` result fields (counts and tokens only).
6. CLI `o2b brain extract <file> [--json]` for every registered format.
7. Fold-ins 1, 2, 3 (id slice), 4, 5 and 6 above.

## Out of scope (deferred, by name)

- **PDF, Office (DOCX, XLSX, PPTX, ODT, ODS, ODP), EPUB, RTF and images**: named `format-not-extractable`, not extracted. PDF text needs content-stream and font decoding that is unreliable without a library; Office is feasible later through `node:zlib` but is its own change.
- **OCR**: caller-side (validator ruling); the per-file skip with `detail: image` is the hook a caller routes on.
- **External-extractor command gate**: a new subprocess capability reachable from MCP needs the `secrets/exec.ts` audit discipline, an apply gate and an allowlisted command form; the `format-not-extractable` entries are the hook a later gate claims (a config key on the `bench_judge_cmd` precedent, `config.ts:1230`).
- **Watches**: overlap the maintenance lane; the content-hash manifest already re-plans changed bytes.
- **URL fetch**: ingest stays network-free.
- **A read-only `brain_extract_source` MCP tool**: a new capability (tool count, parity, probe catalogue, docs) for a model that assumes the agent holds the source.
- **Whole-layer count aggregates of the status and brief views** (`computeBrainStatus`, `buildOperatorSnapshot`, monthly, operator and today views, `osb://status`): 12-16 files, a refusal-code decision and many tests that need a local reach; deferred as its own change. Only the daily and weekly slice ships now: their ids, and their `events_by_kind` and `vault_delta` counts recomputed from the events the caller may see (review round).
- `htmlToText` in `research/extract.ts` stays unchanged (a different contract: a bounded web finding).

## Chosen approach

The consultant recommended its Variant 1 (a second lane of the opt-in `pre_extract` pass, nothing written to the page). The orchestrator overrides it for Variant 2's spine, adjusted (see `variants.md`): card B's deliverable is rows that search can find, and search indexes only the summary page, so a preview the agent may or may not copy leaves the gap open. The consultant's two objections to Variant 2 are answered in the design: the header-loss problem by token-bounded row groups that each repeat the header (no chunker rule change), and the redaction worry by two named passes with a pinned over-redaction test. HTML keeps the consultant's "no body copied" line: only headings and line spans reach the page.

## Design decisions

### Registry and planner (lane A)

- **R1 one registry.** `SOURCE_FORMAT` (four-piece, census row) = `text, csv, tsv, html, pdf, docx, xlsx, pptx, odt, ods, odp, epub, rtf, image`. Markdown and the lightweight markups map to `text` (they are read as they are). Each spec is `{format, extractor, extensions}` with `extractor` from `SOURCE_EXTRACTOR` (`verbatim | html | table`) or `null`. Evidence: the pre-extract `LANGUAGE_BY_EXTENSION` single-home pattern; a Map, not prose, decides.
- **R2 derived defaults.** `DEFAULT_INGESTIBLE_EXTENSIONS` = the extensions of every spec with a non-null extractor, in spec order: the existing six first, then `.csv .tsv .html .htm`. Same name and export from `batch-plan.ts`, so nothing that iterates it reorders.
- **R3 skip routing.** In `collectIngestible`, after the ignore check and before the reach predicate: an extension in the effective set is discovered; an extension the registry names with `extractor: null` becomes `{reason: "format-not-extractable", detail: <format>}`; anything else stays `unclassifiable`. `format-not-extractable` is FIRST in `SKIPPED_PAGE_REASONS` ("in the order a page meets the gates"). Format skips sort by path and precede schema skips in `skippedNonExtractable`. Evidence: visibility is a Markdown rule (docs/mcp.md:2062-2064) and calling the predicate on a binary reads it whole (`vault.ts:200`); the unclassifiable count already runs before the predicate for the same reason. A caller's `extensions` override still wins: a named format the caller lists is planned.
- **R4 planned format.** `PlannedFile.format?: SourceFormat`, set only when the format is not `text`; serialized as `format` beside `status`. A tree of Markdown files plans byte-identically. The plan id of a tree holding HTML, CSV or TSV changes (those files join the discovered set), disclosed in `docs/updating.md`.
- **R5 bounded reader.** `readSourceBounded(absolute, maxBytes)` allocates `stat.size + 1` and grows once to `maxBytes + 1` when the buffer fills under the cap (the `manifests.ts` pattern), exported for the CLI verb; the pre-extract pass passes `PRE_EXTRACT_MAX_SOURCE_BYTES` unchanged.
- **R6 one fence helper.** `fenceFor` moves from `provenance/capture-scope.ts` to `src/core/markdown-fence.ts`; the excerpt section and both new sections use it.

### Dispatch and the ingest write (lane A)

- **I1 dispatch.** `extract-source.ts` exports `extractSource(path, bytes)` with an exhaustive `switch (spec.extractor)` over `null`, `verbatim`, `html` and `table`. The orchestrator steer had lane A ship the `verbatim` and `null` arms and lanes B and C each add one arm. Overturned: an exhaustive switch over a union that already holds `html` and `table` does not type-check without those arms, and a placeholder arm would be a stub. Lane A writes all four arms in its last task (A4), which waits on the two pure modules (B2, C2) whose exported signatures this plan pins; `extract-source.ts` then has one owner.
- **I2 trigger.** Automatic by format; no new MCP argument, no new tool, the `brain_ingest_source` description (299 of 300 characters) untouched. Evidence: the derived section is the page content the card asks for; the pre-extract pass is opt-in because its output never reaches the page.
- **I3 reach order.** Identity is a vault-relative file whose format has an extractor of `html` or `table`; then the trusted lane; then `isSourceHidden(vault, source, readable)`; then one `readSourceOrigin` read (8 MiB, `O_NOFOLLOW`, digest of exactly the bytes returned). A URL, an absent file and a hidden file all answer `source-not-local` with no digest and no section. A source above 8 MiB is already refused by the intake before this step.
- **I4 page.** The derived section comes after `## Connections to existing notes`. Frontmatter gains `source_format` and `source_content_hash` (via `sourceContentHashFrontmatter`) whenever the bytes were read, plus the format's own keys. A `text` source gains nothing: byte-identical.
- **I5 visibility kept.** An operator-set `visibility` on an existing summary page is preserved on rewrite, the way `created_at` is (`ingest.ts:201-202`). Applied to every summary page: dropping it on re-ingest is the same defect for a text source, and the key is the only control a rendered table has. Disclosed in `docs/updating.md`.
- **I6 wire.** `parts` (HTML) and `table` (CSV, TSV) on the result, each absent for other formats, counts and tokens only. `registry-guard.ts:352` reason becomes "write; returns the summary path, bounded id lists and derived-section counts".

### HTML (lane B)

- **H1 scanner, not HTMLRewriter.** A pure TypeScript linear scanner (index walk, no regex over unbounded input). Evidence: HTMLRewriter leaves entities undecoded, misses document-level text in element handlers, throws on `onEndTag` for void elements, and is Bun-only (recon probes on Bun 1.4.0 and 1.4.2).
- **H2 grammar.** Comments, doctype and processing instructions dropped; `script style noscript template svg math` skipped whole; `<private>` content becomes `PRIVATE_REGION_PLACEHOLDER`; numeric entities (invalid code points become U+FFFD) and `amp lt gt quot apos nbsp` decoded, any other named entity kept verbatim; block elements emit line breaks; `pre` keeps whitespace, elsewhere whitespace collapses; `<title>` is the title; no attribute value is ever emitted; CRLF and CR normalised before lines are counted; strict UTF-8, refused by name.
- **H3 parts.** `{index, level, heading, trail, lineStart, lineEnd, sourceOffset}`; level 0 is a non-empty preamble; `trail` joins ancestor headings with ` > `; headings folded with `oneLine` and capped at 200 characters; at most `HTML_PARTS_MAX = 256` parts, the rest counted in `partsOmitted`.
- **H4 section.** `## Parts` holds one fenced block (info string `parts`, fence by `fenceFor`) with one line per part, `h<level> <trail> | lines <a>-<b>` (`preamble | lines <a>-<b>` for level 0). Inside a fence, `[[...]]` and `#word` from untrusted headings stay out of the link graph (`stripCode`, `tags.ts:38-52`) while FTS still indexes the text.
- **H5 CLI.** `o2b brain extract <file> [--json]`, read-only, through `readSourceBounded(file, SOURCE_HASH_MAX_BYTES)`, prints the dispatch result for any registered format; text and named-unsupported formats print `{extracted: false, format, reason}`.

### Tables (lane C)

- **T1 section.** Fenced plain text, not a GFM table: one block per row group under `### Rows <a>-<b>`, info string `table`, the header record first in every group, cells joined by ` | `, cell escapes `\` -> `\\`, `|` -> `\|`, LF -> `\n`, CR -> `\r`, TAB -> `\t`, and (review round) a backtick -> ``\` `` so no row line can start a fence and every table body takes a three-backtick fence, and every other C0 control, DEL and C1 control -> `\u{XXXX}`. Evidence: a GFM table turns `[[x]]` and `#word` cells into graph facts and loses its header in later chunks (`splitBlock`, `chunker.ts:511`).
- **T2 group size.** At most `TABLE_NOTE_ROWS_PER_GROUP = 50` rows AND at most `TABLE_NOTE_GROUP_MAX_TOKENS = 600` tokens counted by the chunker's own counter (exported as `countChunkTokens`), so a group block fits one 800-token chunk and every chunk carries a header line and a `Table > Rows a-b` heading path. Adjusted from the steer's fixed 50 rows: a 50-row group of a 15-column table exceeds one chunk and its later chunks lose the header. A single row over the budget forms its own group (residue: such a group can still split). `CHUNKER_VERSION` untouched.
- **T3 parsing.** Delimiter by extension: `.tsv` TAB without quote processing; `.csv` comma with RFC 4180 lenient quoting, switching to semicolon when the first record has two or more fields with semicolon and more fields with semicolon than with comma (amended in the review round from "one field with comma": a comma-decimal export quotes only fields holding `;`, so its header `name;"price, eur";qty` has two comma fields; `"a;b",c` stays comma). BOM stripped, empty lines skipped, CRLF, LF and lone CR end records, bare quotes kept, an unterminated quoted field refused as `malformed-quoting` with the 1-based record number. The first record is always the header. Ragged rows keep their own cell count.
- **T4 caps.** `TABLE_NOTE_MAX_ROWS = 1_000`, `TABLE_NOTE_MAX_COLUMNS = 64`, `TABLE_NOTE_MAX_CELL_CHARS = 256` (code points, U+2026 marks a cut), `TABLE_NOTE_MAX_BYTES = 262_144` for the section. Every cut is named in `table_truncated` and a closing line states rendered and total rows.
- **T5 redaction.** A column whose header satisfies `isSecretKeyName` has every value replaced by `REDACTION_PLACEHOLDER` (header kept); every other cell goes through `redactRawOutput(cell, {redactUrlCredentials: true, maxInput: Number.POSITIVE_INFINITY})`; no `redactTokens` (it would erase order ids and hashes). `keyword` headers over-redact, pinned by a test. Count on `redacted_cells`.
- **T6 refusals.** `TABLE_NOTE_SKIP_REASON`: `source-not-local`, `not-utf8`, `contains-nul`, `malformed-quoting`, `empty`. Data, not errors: the page and entities are still written.

### Reach left-overs (lane D)

- **L1 root coverage.** `indexRootCoverage(config, roots, admit?)` counts a root reached only through an admitted path; below local reach `admit` is `isPathReadableAtReach` over `indexedVisibilityByPaths` read in the same store session; `probeRetrievalCorpus(resolveConfig, reach?)` threads it; local reach unchanged. The `brain_search` and `brain_recall_gate` residual sentences leave the registry.
- **L2 brief id slice.** Below local reach the daily and weekly views drop `status_transitions`, `retired`, `contradictions` and `source_pointers` rows whose ids fail `readerRefView`, and skip `captureReportDelta` (the digest precedent, `brief-tools.ts:190`). Counts stay as they are and the registry row says so.
- Public wording: "answers at the caller's reach".

### Small fixes (lane E; `turn_id` rides in lane D, which owns `search-tools.ts`)

- **E1 architect.** When every declared edge touches an unlinkable module the region prints a distinct fixed sentence and lists the dropped edges as code spans (`codeSpanName(from) -> codeSpanName(to)`); with some edges drawn, one extra line under the diagram names the dropped ones; the module note says `Not linked:` with the code spans instead of `Depends on: no other module`. `depends_on` frontmatter unchanged.
- **E2 `turn_id`.** Optional `turn_id` (string, max 512) on `RECALL_GATE_INPUT_SCHEMA`, recorded on the `gate_telemetry` payload under `CONTINUITY_TURN_ID_KEY`; `plugins/hermes/_schemas.py` re-vendored verbatim; a `prefetch(..., turn_id=...)` drive in `tests/python/test_static_schemas.py`.
- **E3 newline branch.** `isShellOnlyPrompt` receives the raw prompt's line-break test before normalisation; the four-script contract test untouched.

## File changes

About 57-59 files: 19 new (6 source modules, 13 tests), about 32 changed source and test files, 6 docs; plus the version mirrors and the bundle outside the lanes. Exact ownership in `plan.md`.

## Risks and open questions

1. The plan id of a tree holding HTML, CSV or TSV changes; an in-flight resume checkpoint for such a tree no longer matches (disclosed).
2. `.png` and the other named formats move from `unclassifiable` to `skipped_non_extractable`; a reader that summed `unclassifiable` sees fewer files there (disclosed).
3. A re-ingest of an already-ingested CSV, TSV or HTML file rewrites its page once with the new section and keys (disclosed).
4. Redaction of table cells is fail-safe by over-redaction on key-like headers; a credential that matches no pass stays in an indexed page, the same exposure the raw file already has in the vault, now also in embeddings (stated in docs/mcp.md).
5. A summary page that carries a derived section is at most as visible as its source (review round): `deriveSourceSection` returns the source's own `visibility` tokens and `ingestSource` joins them with the page's kept `visibility`; a leading frontmatter block of the source is not handed to the extractor.
6. Redaction residue of table cells (review round, kept as decided in T5): bare vendor tokens, base64 or high-entropy blobs, PEM blocks in quoted multi-line cells and credential-like values under headers that name no credential are not redacted; stated in docs/how-it-works.md.
7. No lane edited a module of the OpenClaw bundle; the review round did (`redactor.ts` for linear private-region walking, `vault.ts` for a linear frontmatter opener), so `openclaw/index.js` is rebuilt and committed after the last `src/` change.

## Follow-ups (review round)

- **Chunker fence rule.** `readCodeBlock` (`src/core/search/chunker.ts`) closes a fence of four or more backticks on any line starting with three. A CommonMark-length-aware close (a run of the same character at least as long as the opening one, the rule `src/core/tags.ts` already implements) is deferred: it changes chunk boundaries and needs a `CHUNKER_VERSION` bump that re-chunks every vault. Table notes no longer depend on it, since cells escape every backtick.
- **`@osb` marker fence rule.** `discoverMarkersDetailed` (`src/core/brain/inline.ts`) recognises only three-backtick fences. The same length-aware rule is deferred because it changes marker parsing; latent today, since both walkers that act on markers skip `Brain/`.
- **Format skips before the reach predicate** (accepted residual). `brain_ingest_batch_plan` names a format-skipped file in `skipped_non_extractable` before asking the reach predicate. Visibility is a frontmatter rule, so a real PDF or image is always readable; only a non-text file that starts with a frontmatter block, or an unreadable one, would be named where a reserved page is not.
- **Single read in `deriveSourceSection`.** The section is derived from a second read of the source; a source that grows past the ceiling between the intake's read and this one now answers `source-not-local`. Threading the intake's bytes through is the follow-up that removes the second read.
- **`oneLine` leaf module.** `src/core/brain/ingest/extract-html.ts` and `src/cli/brain/verbs/extract.ts` import `oneLine` from `src/core/architect/manifests.ts`, a Bun-dependent module (safe to load in the Node build, since the Bun call sits inside a function). Moving `oneLine` to a leaf module, re-exported from `manifests.ts`, removes the coupling of ingest to the architect; deferred.
- **Frontmatter pattern, one copy.** The leading-block strip of `extract-source.ts` copied the vault's frontmatter pattern; it now imports `FRONTMATTER_RE` from `src/core/vault.ts`, as do the two link-graph readers that held their own copies. The pattern's opener takes horizontal whitespace only, so a run of blank lines after an unclosed `---` is read in linear time.
- **Other `<private>` detectors (resolved in the review rounds).** `src/core/brain/session-recall.ts` and `src/core/brain/continuity/redaction.ts` matched the open tag with their own regular expressions; both now ask the redactor's span walker (`privateRegionTexts`), so one linear rule decides what opens a region.
- **Repeated remote re-ingest of a reserved summary page** (accepted residual). A second remote brain_ingest_source of a source whose deterministic summary page is reserved still reveals that page's existence. Both calls answer created: true where the control answers true then false, and brain_search_by_source totals differ (2 against 3). A remote caller's summary write is discarded. Closing it means a caller-lane summary path below local reach (the R2S11 follow-up).
- **Provenance as the summary id (R2S11, the full form of R3-6).** An entity page from an intake still names the reserved source path in its `## Sources` section (no content, no digest). The full fix reads the source's visibility once from `origin.bytes`, hands it to both the intake and the derivation, writes the provenance as the summary id rather than the source path, and teaches `traceReferences` to follow summary-id provenance so a local `brain_delete_by_source` still cascades to the entity pages. Deferred because it changes the cascade and the provenance shape together.
- **`removed-tool-reference` cap before the reach filter** (count residual). `REMOVED_TOOL_MAX_WARNINGS` counts before `brain_doctor` filters findings by the caller's reach, so a reserved page can take one of the capped slots. The check runs without the caller's view; moving the cap after the filter needs the view threaded into it.
- **Stale-dependency note over the whole Brain layer** (count residual, released code). The `uncertain` stale-dependency note of `brain_doctor` counts "N state(s) stopped being current" over every record and moves by one when a reserved record is retired; it names no record. Answering it at the caller's reach needs the stale-dependency collector to take the reach view.
- **Shared ranking statistics** (residual, stated on the `brain_search` registry row). The bm25 corpus statistics and the diversity rerank run over the shared index, so scores can differ by reach while the returned paths do not.
