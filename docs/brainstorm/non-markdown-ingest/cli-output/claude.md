### Variant 1: Pre-extract gains a second lane, "text structure"

- **Approach**: Extend the existing opt-in pre-extract pass (`runPreExtract` in ingest.ts, `pre_extract` on `brain_ingest_source`) with a sibling result shape, `PreExtractText`, that for `.html`/`.htm` returns extracted text and heading-derived parts (via `HTMLRewriter` with a text handler on the document plus element handlers for `h1-h6`/`title`, a hand-written entity decoder for the five XML entities plus numeric refs, and no `onEndTag`), and for `.csv`/`.tsv` returns a header row, a column count, a row count and a bounded row sample. PDF, Office and image extensions join `LANGUAGE_BY_EXTENSION`'s neighbour table as a closed `UNSUPPORTED_SOURCE_KIND` vocabulary so the pass answers `extracted: false, reason: <token>` by name. The calling agent still writes the summary page; the kernel only returns the structure it read, and the batch planner gains `.html .htm .csv .tsv` in `DEFAULT_INGESTIBLE_EXTENSIONS` plus a per-extension `unsupported` bucket beside `unclassifiable`.
- **Trade-offs**:
  - Pro: one read path, one bounded reader, one opt-in flag, no new tool and no description change on `brain_ingest_source` (already at 299).
  - Pro: HTML text never lands in the vault; the page is still agent-authored, so provenance and redaction stay as today.
  - Pro: the CSV table never enters the chunker, sidestepping the header-loss and `[[x]]`/`#tag` cell problems entirely.
  - Con: a CSV's rows are not searchable unless the agent renders them, so the "table without rows" gap is only half closed; the kernel can offer a fenced sample but cannot force it onto the page.
  - Con: overloading `pre_extract` (named "code-structure") with text structure muddies the result type and the CLI verb name; a rename or alias ripples through serializers and tests.
  - Con: `HTMLRewriter` runs in Bun only; the Node-bundled build needs a conditional fallback (regex strip) or a named `unsupported-on-this-runtime` reason.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: A "source reading" kernel stage with a rendered table block on the page

- **Approach**: Introduce a new ingest-side module `source-read.ts` that runs before the page write for every file source (not opt-in), classifies the source into a closed `SOURCE_FORMAT` vocabulary (`markdown-like`, `html`, `delimited-table`, `pdf`, `office`, `image`, `unknown`), and produces a `SourceReading` carried on the ingest result and, for `delimited-table`, written by the kernel into a fenced ```` ```table ```` block on the summary page (header + rows up to a byte cap, fence so links and tags stay inert, redactor's raw-output pass applied cell-wise). HTML yields heading parts only. Unsupported formats become a typed `SkippedPageReason`-style result and a batch-plan `unsupported` map.
- **Trade-offs**:
  - Pro: closes the CSV gap fully. Rows become searchable because they live on the only indexed page, and the fence keeps them out of the graph and out of the GFM chunker's header-splitting path.
  - Pro: one closed vocabulary covers both planner counting and ingest reporting; the census test registers it once.
  - Con: the kernel now writes source body onto a page it previously never touched. This crosses a line the task draws for HTML ("no source body copied") and changes the agent/kernel contract for a page the agent owns; existing text sources must be proven byte-identical by test.
  - Con: a code fence in a table block defeats the chunker's table awareness, and the chunker's line-by-line split of oversize fences still drops the header in later chunks; closing that needs a chunker change (repeat the fence header per chunk) in the same release.
  - Con: cell-wise redaction has to run on data the kernel never saw before; a false-negative leaks a secret into an indexed page.
  - Con: not opt-in means every ingest pays the read; the 1 MiB allocation fold-in becomes mandatory, not optional.
- **Complexity**: large
- **Risk**: high

### Variant 3: Planner-only honesty plus a sidecar reader verb

- **Approach**: Keep ingest untouched for this release. The batch planner learns a closed `SOURCE_FORMAT` classification and reports `unsupported` per extension and reason (`binary-document`, `image`, `archive`) beside `unclassifiable`, and a new CLI-only verb `o2b brain source-read <path>` (no MCP tool) returns HTML text with heading parts or CSV/TSV header, dimensions and a sample, for the agent to fold into the page it writes. Fold-ins ship as independent commits.
- **Trade-offs**:
  - Pro: smallest blast radius. No ingest result shape change, no page content change, byte-identity of text sources is trivially preserved.
  - Pro: the Node-bundled build is unaffected because the verb lives in the CLI only.
  - Con: MCP callers (the primary surface) cannot reach the reader, so for the agent in an MCP session nothing changes about HTML or CSV. The release title promises ingest of non-Markdown sources and delivers it only to CLI users.
  - Con: two format vocabularies drift (planner and verb) unless shared, and the sidecar invites a later MCP tool anyway, which the constraints discourage.
  - Con: the CSV rows-in-the-index gap stays open.
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 1
**Rationale**: It reaches the MCP caller through the existing `pre_extract` flag and bounded reader, so no new tool, no description budget and no second read path are needed, and it keeps the kernel out of the page body, which matches both the "no source body copied" rule for HTML and the byte-identity constraint. Variant 2 closes the CSV gap more fully but does so by having the kernel write unredacted-by-design source rows onto an agent-owned page, which couples the release to a chunker change and a redaction guarantee the project does not yet have; Variant 3 is safe but leaves MCP sessions exactly where they are. The CSV residue in Variant 1 is honest: the result names header, dimensions and a fenced sample, and the agent renders the rows it chooses, which is the same contract the project already uses for every other source.
