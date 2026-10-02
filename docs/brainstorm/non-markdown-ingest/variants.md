# Non-Markdown source ingest - variants and decision

Consultant: the primary CLI consultant (`claude -p`, prompt in `cli-output/prompt.md`, verbatim answer in `cli-output/claude.md`). Exit 0, three parseable variants; the fallback consultant was not run.

## Variant 1: A second, text-structure lane of the opt-in pre-extract pass - lost (consultant's recommendation, overridden)

Extend `runPreExtract` and the `pre_extract` flag so an HTML file returns text and heading parts (through `HTMLRewriter`) and a CSV returns a header, dimensions and a row sample; the agent decides what reaches the page.

Why it lost: card B's deliverable is rows that search and recall can find, and search indexes only the summary page, so a sample the agent may or may not copy leaves the gap open. It also overloads a pass named for code structure, and `HTMLRewriter` is Bun-only, leaves entities undecoded, misses document-level text and throws on `onEndTag` for void elements.

## Variant 2: A source-reading kernel stage that renders derived sections on the page - chosen, adjusted

Classify every file source against one closed format vocabulary, write a derived section onto the summary page for formats that have an extractor, and name every other format.

Adjustments by the orchestrator, with evidence in `design.md`:

1. HTML writes headings and line spans only (`## Parts`), never body text: the consultant's own line for HTML holds.
2. The chunker's header-loss objection is answered without changing chunking rules: row groups are bounded by 50 rows AND 600 tokens counted by the chunker's own counter, each repeating the header under a `Rows a-b` heading (design T2).
3. The redaction objection is answered by two named passes with fail-safe over-redaction pinned by a test (T5), and by keeping operator `visibility` on rewrite (I5).
4. The derived read happens only for an in-vault file in the trusted lane, after the reach check, so "every ingest pays the read" does not hold: text sources pay nothing and stay byte-identical (I3, I4).
5. Named formats are a `SKIPPED_PAGE_REASON` member with the format as `detail`, not a separate `unsupported` map beside `unclassifiable` (R3).

## Variant 3: Planner-only honesty plus a CLI-only reader verb - lost

Teach the planner the format vocabulary and add a CLI verb that previews HTML and CSV structure; leave ingest untouched.

Why it lost: an MCP session, the primary surface, gains nothing, and the CSV rows stay out of the index. Its CLI verb survives inside the chosen variant as `o2b brain extract`.

## Alternatives considered inside the chosen variant

- **HTMLRewriter vs the linear scanner**: the scanner won. Entity decoding is project code either way, the two silent-loss or abort traps above need workarounds, and a Bun-only module cannot be reused from the Node-bundled build.
- **GFM table vs fenced plain text**: fenced text won. A GFM table turns `[[x]]` and `#word` cells into graph facts from untrusted data and loses its header in every chunk after the first; inside a fence `stripCode` keeps links and tags out while FTS still indexes the cells.
- **Opt-in flag vs automatic by format**: automatic won. The derived section is the page content the cards ask for, the `brain_ingest_source` description has one character left for documenting a flag, and text sources stay byte-identical by construction.
- **New MCP tool (`brain_extract_source`) vs CLI verb**: the CLI verb won. A tool is a new capability with a tool-count move, parity rows, a probe-catalogue entry and docs, for an ingest model in which the agent already holds the source.
- **External extractor command gate now vs later**: later. It is a new subprocess capability reachable from MCP that needs the exec audit discipline and an apply gate; the per-file `format-not-extractable` entries are the hook it will claim.
- **Lanes B and C adding their own switch arms vs lane A writing all four**: lane A writes all four in A4. An exhaustive switch over a union that already holds `html` and `table` does not type-check without those arms, and a placeholder arm would be a stub.
- **Fixed 50-row groups vs token-bounded groups**: token-bounded. A fixed 50-row group of a wide table spans several chunks, and every chunk after the first loses the header.
- **Whole-layer count aggregates of the status and brief views now vs later**: later, as their own change; the id slice of the daily and weekly views ships now.
