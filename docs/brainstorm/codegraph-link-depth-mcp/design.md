# CodeGraph link-graph depth + MCP exposure — design

## Problem

Open Second Brain's link graph and MCP surface each have one honest, narrowly
scoped gap relative to the Graphify feature line, plus two packaging/transport
gaps that block wider MCP adoption. This release closes all four as a single
forward-only, backward-compatible release.

1. **Reference-style Markdown links produce no graph edges.** `extractLinks`
   (`src/core/search/links.ts`) resolves inline `[text](target)` links, wikilinks,
   and tags, but silently drops CommonMark reference-style links
   (`[text][label]` / `[text][]` / `[text]` shortcut forms plus their
   `[label]: url` definitions). Docs wired together with reference links import
   with no `references` edges, so hub/backlink ranking (`buildBacklinkIndex` /
   `pickTopReferenced`) misses them.
2. **The MCP server is reachable only through `o2b mcp`.** There is no standalone
   entry point, so standard JS/Node distribution (`npx`, global install) cannot
   launch the server without the subcommand.
3. **The MCP server is stdio-only.** Remote, multi-client, and team-wide shared
   deployments are impossible; there is no authenticated network transport.
4. **Credential resolution is not honestly deferred/declared.** The task brief
   claims session import and indexing "require provider credentials"; the actual
   source shows session import is already fully offline and lexical indexing
   needs no key, but that guarantee is implicit and untested, and the one
   credential-gated path (semantic embeddings) is not surfaced as an explicit,
   deferred reason in structured output.

The release must close these gaps without turning Graphify into an owned OSB
dependency, without adopting an MCP SDK or HTTP framework, without changing any
existing default output, and without coupling the kernel to the MCP server.

## Scope

- Resolve reference-style Markdown links into `markdown_link` edges, feeding the
  existing `replaceLinks` / backlink pipeline unchanged (t_13c92d85, CORE).
- Add a dedicated `o2b-mcp` console-script bin entry that launches the MCP
  server without the `o2b mcp` subcommand (t_da6321a9, packaging layer).
- Add a Streamable HTTP MCP transport that reuses `MCPServer.handleRequest` as
  the single JSON-RPC dispatch core, with constant-time API-key auth
  (t_31dfae18, transport layer).
- Make offline/deferred backend resolution explicit and guaranteed: a keyless
  environment runs the full deterministic pipeline (lexical indexing + session
  import) to completion; any credential requirement is reported as a deferred
  reason in structured output, never an up-front hard fail of the whole run;
  locked by a regression test that the keyless paths never read provider
  credentials (t_85252236, extraction hardening).
- Document and test every new surface through focused unit + CLI/MCP coverage.

## Out of scope

- Adopting `@modelcontextprotocol/sdk` or any HTTP/web framework (keep the
  hand-rolled JSON-RPC core and the minimal dependency set).
- Refactoring the existing `serveStdio` loop behind a transport abstraction
  (rejected variant: puts the byte-identical stdio guarantee at risk for a seam
  the four cards do not require).
- A unified MCP "runtime orchestrator" coupling packaging, transport, auth, and
  indexer readiness (rejected variant: god-object; violates kernel-independence
  and the deliberate packaging-vs-transport task split).
- Docker image, OAuth, or any transport other than stdio and Streamable HTTP.
- New graph edge types beyond the existing `markdown_link` row shape.
- LLM-generated labels, natural-language classification, or third-party graph
  algorithms.
- Changing default `o2b mcp` stdio output, default `extractLinks` output for
  inline links, or default indexer output when no new option is supplied.

## Chosen approach

Use **Variant 2: strictly additive leaves.** Every task is an independent,
forward-only addition that does not edit an existing happy path. The two hard
backward-compatibility guarantees — byte-identical stdio behavior and
byte-identical inline-link output — are true by construction because the
existing `serveStdio` loop and the inline-link branch of `extractLinks` are never
modified. The HTTP transport is a new file that calls
`MCPServer.handleRequest` directly over Node/Bun built-in `http`, so dispatch
stays single-source. The console script is a thin bin shim that delegates to the
existing MCP command dispatch, so it inherits whichever transports the dispatch
supports. The offline work is an in-place reordering/explicit declaration inside
the indexer and a guarantee test, never coupled to a running server.

We agree with the consultant recommendation. Variant 2 is the only strategy that
satisfies both backward-compatibility guarantees by construction, honors the
repo's minimal-dependency and KISS conventions, keeps the kernel independent of
MCP, reuses `handleRequest` as the single dispatch source, and fits the
one-card-at-a-time shared-branch cadence (each card is an additive leaf;
conflicts are confined to append-only doc/CHANGELOG edits). It continues the
predecessor release's (v1.12.0) deliberately additive, read-only/forward-only
posture.

## Design decisions

1. **Reference-link pass is self-contained and appends inside `extractLinks`.**
   - Add a reference-definition collection pass: scan the code-stripped content
     for `[label]: <target>` definitions (CommonMark: up to three spaces indent,
     case-insensitive label, target is a URL or relative path; titles ignored
     for edge purposes), then match `[text][label]`, `[text][]` (collapsed), and
     `[text]` (shortcut) reference forms against the definition map.
   - Reuse the existing `isUrl` / `isMailto` / `#anchor`-strip filters on the
     resolved target unchanged; emit the same `markdown_link` row shape
     (`ExtractedLink` with `linkType: "markdown_link"`).
   - Inline-link matching (`MD_LINK_RE`) and its image-embed negative
     lookbehind are untouched — inline output stays byte-identical.
   - Apply after wikilink/inline matching and before tag matching so the
     existing `dedupe` (by `type|target|text`) collapses any overlap.
   - Relative-path resolution to canonical doc ids stays the indexer's job, as
     for inline links today.

2. **HTTP transport reuses the dispatch core, adds no dependency.**
   - New `src/mcp/http.ts` exports `serveHttp(ctx, opts, runtimeOpts)` built on
     `node:http`. It constructs one `MCPServer` and routes every accepted
     JSON-RPC request through `server.handleRequest` — no re-derived dispatch.
   - Implements the MCP `2025-06-18` Streamable HTTP shape: a single endpoint
     accepting `POST` with `Accept: application/json, text/event-stream`;
     responses are either a single JSON body or an SSE stream when the client
     requests event-stream and the request is resumable; `initialize` may issue
     an `Mcp-Session-Id` header. GET is used only for an SSE stream when
     supported. Batch (JSON array) bodies are rejected with `INVALID_REQUEST`
     (`-32600`), mirroring the stdio loop's batch rejection — the protocol
     removed batch support.
   - `MCPServer.handleRequest` is unchanged; it already returns well-formed
     JSON-RPC frames (result or error). The transport only frames them for HTTP.

3. **API-key auth is constant-time and generic.**
   - When `--api-key` is supplied, every request must present a matching key
     (header `Authorization: Bearer <key>` is the canonical form; accept the
     exact configured value only). Compare in constant time; on any
     missing/wrong/absent credential respond with a single generic `401
     Unauthorized` carrying no information about which check failed.
   - When `--api-key` is not supplied, the HTTP transport refuses to start and
     prints a clear stderr reason (HTTP without auth would expose the brain to
     the network); stdio is unaffected and remains auth-less by design.

4. **Console script delegates; it does not re-parse.**
   - New `scripts/o2b-mcp` mirrors `scripts/o2b` (bash launcher + bun precheck)
     and execs the CLI with the MCP command injected, forwarding all flags. It
     is transport-agnostic: once the HTTP transport lands in the shared
     dispatch, the console script exposes it automatically with no edit.
   - Add `"o2b-mcp": "./scripts/o2b-mcp"` to `package.json` `bin` and ensure the
     script is covered by `files`. A separate TS `main()` is rejected as DRY
     duplication of dispatch already in `cmdMcp`.

5. **Offline/deferred backend resolution is declared, not newly invented.**
   - The indexer already runs lexically without a key and already degrades
     semantic search with a warning when `embedding_api_key` is absent. Make the
     guarantee explicit: structured index output carries a `mode`/`backend`
     field (`offline` when no provider credentials are resolved, `semantic` when
     the embedding backend is active, plus the existing deferred reason string),
     and ensure the credential check is evaluated lazily — after content is
     detected — so a corpus that needs only deterministic processing never
     hard-fails for a missing key.
   - Add a regression test proving `importSession` and keyless indexing never
     read provider-credential environment variables or config keys, locking the
     offline guarantee the task brief incorrectly assumed was absent.

6. **Preserve language-agnostic behavior.**
   - No natural-language keyword lists. Link forms, transport framing, auth,
     and offline detection use structural/typed fields and explicit operator
     input only. All identifiers and messages are English.

## File changes

Expected implementation touchpoints (final paths confirmed by each driven card):

- **t_13c92d85**: `src/core/search/links.ts` (reference-definition pass +
  matcher, appended; inline path untouched); **extend the existing**
  `tests/core/search/links.test.ts` (which already covers wikilinks, inline MD
  links, image-embed exclusion, anchor-strip, tags, code-fence stripping, dedupe,
  mailto) with reference-style cases and a byte-identical-inline regression;
  `CHANGELOG.md`.
- **t_da6321a9**: new `scripts/o2b-mcp` (bash launcher delegating to the MCP
  command); `package.json` (`bin.o2b-mcp`, ensure `files` coverage); new
  `tests/cli/o2b-mcp-launcher.test.ts` (or extend an existing CLI launch test)
  proving the entry resolves to MCP serving; `docs/mcp.md`, `docs/cli-reference.md`,
  `CHANGELOG.md`.
- **t_31dfae18**: new `src/mcp/http.ts` (`serveHttp` over `node:http`, framing,
  constant-time API-key auth, batch rejection, session header); `src/cli/main.ts`
  (`cmdMcp` gains `--transport stdio|http`, `--port`, `--host`, `--api-key`;
  stdio path byte-identical when no transport flag is supplied); `src/mcp/index.ts`
  (re-export `serveHttp`); new `tests/mcp/http-transport.test.ts` (auth
  accept/reject, initialize handshake, tools/list, framing, batch rejection);
  `docs/mcp.md`, `docs/cli-reference.md`, `CHANGELOG.md`.
- **t_85252236**: `src/core/search/indexer.ts` (explicit `mode`/`backend` +
  deferred credential reason in structured output; lazy credential evaluation);
  `src/core/search/config.ts` / `src/core/search/index.ts` (credential
  resolution surface used by the regression test, if a seam is needed);
  `tests/core/search/index-offline.test.ts` and
  `tests/core/brain/sessions-import-offline.test.ts` (keyless path +
  no-credential-read guarantee); `CHANGELOG.md`.

Shared, append-only edits (each driven card updates in place if a sibling
already touched it): `CHANGELOG.md`, `docs/mcp.md`, `docs/cli-reference.md`.

## Risks

- **Reference-link regex can over- or under-match.** Mitigation: implement the
  CommonMark definition + three reference forms precisely, cover edge cases
  (collapsed/shortcut, duplicate labels, definitions after use, code-fence
  stripping already applied), and add a byte-identical-inline regression test.
- **HTTP transport can drift from the `2025-06-18` Streamable HTTP spec.**
  Mitigation: reuse `handleRequest` for all dispatch; keep framing minimal and
  spec-aligned (single endpoint, POST + optional SSE, `Mcp-Session-Id`, batch
  rejection); cover handshake + framing with focused tests; no framework to
  impose its own semantics.
- **API-key handling can leak timing or diagnostic detail.** Mitigation:
  constant-time compare; single generic `401` with no missing-vs-wrong
  distinction; refuse to start HTTP without `--api-key`.
- **Offline declaration can accidentally change default indexer output.**
  Mitigation: the new `mode`/`backend` field is additive; existing fields stay
  byte-identical when no option changes; regression test pins the default shape.
- **Console-script delegation can break if the MCP command surface changes.**
  Mitigation: the shim forwards flags verbatim and a launch test pins that the
  entry reaches MCP serving; it never re-implements parsing.
- **Doc/CHANGELOG conflicts across the four cards on a shared branch.**
  Mitigation: cards are driven one at a time; each updates shared doc sections in
  place on top of the prior commit rather than re-creating them.
