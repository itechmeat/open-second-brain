# Consultant prompt — release "codegraph-link-depth-mcp"

You are a senior backend architect. Propose architectural variants for ONE
coherent release of the **Open Second Brain** project. Output **variants and a
recommendation only** — no implementation code, nothing outside the requested
sections (see "Required output format" at the end).

---

## Project

- **Name**: `open-second-brain` (npm `open-second-brain`, CLI binary `o2b`).
- **Language / runtime**: TypeScript, ESM (`"type": "module"`), executed on
  **Bun** (also Node-compatible for the CLI). `package.json` version `1.16.0`.
- **Dependency posture**: intentionally minimal. Runtime deps = `proper-lockfile`
  only. No HTTP framework, no MCP SDK. Optional native deps: `sqlite-vec`,
  `@node-rs/jieba`, `tiny-segmenter`.
- **Tooling**: tests via `bash scripts/test` (Bun's test runner, `bun:test`);
  `oxlint` (lint), `oxfmt` (format), `tsc --noEmit` (typecheck);
  `bun run validate` = typecheck + lint + test. Strict TDD convention: write the
  focused failing test first, then implement, then refactor.
- **Conventions (hard)**: SOLID / KISS / DRY; no misleading fallbacks (a
  degraded path must SAY it degraded, never report success silently); no
  hardcoding; all strings/identifiers English-only and language-agnostic; new
  behavior must be **backward compatible** — existing outputs stay byte-identical
  when no new flag/option is supplied. Keep the dependency set minimal: prefer
  Node/Bun built-ins over new packages.

## Release theme

"CodeGraph link-graph depth + MCP exposure" — a single, coherent, forward-only
release composed of exactly four in-scope tasks (do not add, drop, or substitute).
Two deepen the link graph / extraction; two expose the existing MCP server
through new packaging and transports.

## In-scope tasks (verbatim bodies)

### t_13c92d85 (priority 4 — CORE): resolve reference-style Markdown links into graph edges

Graphify turns Markdown links into graph edges: it resolves inline
`[text](./other.md)`, **reference-style** links, and `[[wikilinks]]` relative to
the source file, skips external URLs/anchors/images, and emits `references`
edges so hub docs surface as graph hubs.

**Status in OSB**: `present_weaker`. `extractLinks`
(`src/core/search/links.ts:60`) already covers wikilinks (`WIKILINK_ALIAS_RE`),
inline markdown links (`MD_LINK_RE`, line 29), external-URL skip (`isUrl` line
40), mailto skip (`isMailto` line 44), image-embed exclusion (negative
lookbehind `(?<!!)` on `MD_LINK_RE`), and `#anchor` fragment stripping (lines
79-81). It is invoked by the indexer (`indexInto → extractLinks`,
`src/core/search/indexer.ts`) and persisted via `store.replaceLinks`;
hub/backlink ranking exists via `buildBacklinkIndex` / `pickTopReferenced`
(`src/core/brain/backlinks.ts:98`). **Gap**: `MD_LINK_RE` matches only the
inline `[text](target)` form — reference-style links (`[text][label]` /
`[text][]` / `[text]` shortcut forms plus their `[label]: url` definitions) are
never resolved, so `LinkType` (line 17) has no path for them.

Closing the gap means a reference-definition pass (collect `[label]: target`
lines, then match `[text][label]` / `[text][]` / `[text]` shortcut references
against them) feeding the same `markdown_link` row shape; the existing
`isUrl`/`isMailto`/anchor-strip filters apply unchanged to the resolved target.
Relative-path resolution to canonical doc ids stays the indexer's job.

### t_da6321a9 (priority 3): graphify-mcp console script for stdio MCP server

Graphify v0.8.36 added a `graphify-mcp` console script — MCP stdio server
directly invocable from `uv tool install` / `pipx`.

**Status in OSB**: `not_in_osb_useful`. OSB has an MCP server (`src/mcp/server.ts`)
but it is only reachable via the `o2b mcp serve` CLI command or by importing the
class. `src/mcp/index.ts:19` exports `serveStdio`, `serveStdioFromString`;
`pyproject.toml` has no console_scripts entry for MCP; `package.json` has no bin
entry for the MCP server. Goal: a dedicated entry point so OSB runs as an MCP
server via standard JS/Node tooling (`npx`, global install) without the `o2b mcp`
subcommand. Triage validator note: this is the **packaging layer**, distinct
from t_31dfae18 (transport layer).

### t_31dfae18 (priority 2): streamable HTTP MCP transport with API-key auth

Graphify v0.8.34 added a Streamable HTTP MCP transport: `graphify serve
graph.json --transport http` serves the graph over HTTP so a team shares one
server. Includes API-key auth (`--api-key`) and a Docker image.

**Status in OSB**: `not_in_osb_useful`. OSB's MCP server only supports stdio via
`serveStdio` (`src/mcp/stdio.ts:22`). An HTTP transport would let multiple
agents/clients connect to a shared brain, enable remote access, and support
team-wide sharing; API-key auth gives a simple security model. Triage validator
note: this is the **transport layer**, distinct from t_da6321a9 (packaging).

### t_85252236 (priority 1): offline code-only extraction without API keys

Graphify v0.8.32 made code-only extraction work fully offline: `graphify extract`
defers backend resolution until after file detection — a corpus with only code
files runs without any `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`. Keys are only
required when docs/PDFs/images are present.

**Status in OSB**: `not_in_osb_useful`. NOTE: the task's codegraph hint is
**partly inaccurate** and must be corrected by the design. Findings from the
current source:

- **Session import is already fully offline.** `src/core/brain/sessions/import.ts`
  (`importSession` / `importSessionPath`) runs a deterministic pipeline
  (`discoverMarkers`, `extractFacts`, `routeExtractedFacts`,
  `validateBrainFeedbackInput`, `importSessionRecall`) that never calls an LLM
  and reads no provider credentials. So "session import requires provider
  credentials" is false today.
- **Vault indexing is already offline-capable.** Lexical FTS5 indexing
  (`src/core/search/indexer.ts`) needs no key. The only credential-gated path is
  semantic embeddings: `populateEmbeddings` throws `EMBEDDING_KEY_MISSING` **only
  when** `config.semantic.enabled` AND provider != `local` AND no `apiKey` AND
  embeddings are actually being computed. `indexStats` / `indexCheck` already
  **degrade** with the warning `"embedding_api_key not configured; semantic
  search disabled"`. A keyless `local` embedding provider exists.

So the honest, graphify-inspired scope here is **deferred, content-aware backend
resolution + an explicit offline guarantee**, not a brand-new extraction engine:
ensure a keyless environment runs the full deterministic pipeline (lexical
indexing + session import) to completion, surface any credential requirement as
an explicit, deferred reason (never an up-front hard fail of the whole run), and
lock the guarantee with a regression test that the keyless paths never read
provider credentials.

## Relevant architecture (current source)

**MCP server (hand-rolled JSON-RPC 2.0, protocol `2025-06-18`)**

- `src/mcp/server.ts` — `MCPServer` class. `handleRequest(request)` dispatches
  `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `resources/templates/list`, `resources/read`. Advertises
  `tools` + `resources` capabilities. Tools built via `buildToolTable(scope)`;
  runtime capability window can narrow (never widen) the surface. Output goes
  through `buildMcpToolResult` with an optional preview budget + artifact store.
  Public `callTool(name, args)` exists for the CLI bridge.
- `src/mcp/stdio.ts` — `serveStdio(ctx, ioOpts, runtimeOpts)`: readline loop,
  newline-delimited JSON, one `handleRequest` per line. Rejects batch arrays
  (`INVALID_REQUEST`, the `2025-06-18` spec removed batch support). Also
  `serveStdioFromString(ctx, input, opts)` for in-memory tests.
- `src/mcp/index.ts` — public barrel re-exporting `MCPServer`, `serveStdio`,
  `serveStdioFromString`, protocol constants, etc.
- `src/mcp/protocol.ts` — `PROTOCOL_VERSION = "2025-06-18"`, `SERVER_NAME`,
  `SERVER_VERSION` (from package.json), JSON-RPC error codes, `MCPError`.
- CLI dispatch: `src/cli/main.ts` has the `o2b mcp` command (call it `cmdMcp`).
  It parses `--vault`, `--config`, `--repo`, `--scope full|writer|catalog`,
  `--tool-profile`, `--writer-only`, `--probe`, `--json`, `--allow-tool`,
  `--disable-tool`, `--max-tools`; constructs the server; prints
  `[mcp] <name> <version> listening on stdio (vault=<vault>)` to stderr; then
  calls `serveStdio`. JSON-RPC frames go to stdout only; logs to stderr.
- `package.json` `bin`: `o2b` → `./scripts/o2b`, `vault-log` → `./scripts/vault-log`.
  `scripts/o2b` is a bash launcher that sources a bun precheck and
  `exec bun run $REPO_ROOT/src/cli/main.ts "$@"`. No MCP-specific bin entry.
- `docs/mcp.md` documents the stdio server, Hermes/Claude Code/Codex
  registration, profiles, and the writer split.

**Link extraction (`src/core/search/links.ts`)** — see task t_13c92d85 above.
`extractLinks(content)` returns `ExtractedLink[]` (`{ targetPath, linkText,
linkType }`, `LinkType = "wikilink" | "markdown_link" | "tag"`). Order: strip
code fences + inline code (`stripCode`), then wikilinks, then inline MD links,
then tags, then `dedupe` by `type|target|text`. No standalone test file for
`links.ts` today (covered indirectly via indexer tests) — a clean TDD target.

**Indexing & credentials (`src/core/search/indexer.ts`)** — see t_85252236
findings above. `ResolvedSearchConfig.semantic` has `enabled`, `provider`
(incl. keyless `local`), `model`, `apiKey`, `costGateUsd`, `batchSize`,
`concurrency`.

## Constraints for this release

1. Backward compatible: `o2b mcp` stdio behavior and `extractLinks` output for
   inline links stay byte-identical when no new flag/option is supplied.
2. MCP stays optional; nothing in the kernel may depend on the MCP server
   running.
3. The `2025-06-18` protocol contract (no batch; JSON-RPC 2.0; `initialize` →
   `notifications/initialized` → `tools/list|call`) is preserved on every
   transport.
4. HTTP transport must reuse `MCPServer.handleRequest` (single source of truth
   for JSON-RPC dispatch) — do not duplicate request handling. Prefer Node/Bun
   built-in `http` over adding a framework dependency (KISS, minimal deps).
5. API-key auth on the HTTP transport: constant-time compare, reject
   unauthenticated requests with the correct HTTP status, never leak whether the
   failure is "missing" vs "wrong" beyond a single generic 401.
6. No misleading fallbacks: every degraded/offline path reports its mode
   explicitly in its structured output.
7. The four tasks ship together but are driven one card at a time on a shared
   branch; each card's change must build cleanly on top of the previously-driven
   cards' commits (no duplicate abstractions, no conflicts on shared files like
   `docs/mcp.md`, `docs/cli-reference.md`, `CHANGELOG.md`).

## Recent release history (git log, newest first)

```
da2e3cc feat: memory subsystem alignment (v1.16.0) (#107)
4db7862 fix(hermes): pass --repo so bridge skill discovery resolves repoRoot (#106)
0a4b6da feat: calendar obligations, agenda synthesis, OKF portability (v1.15.0) (#105)
f8b4abf feat(brain): add feedback default scope and vault write containment (#104)
20ea7ef feat: per-handoff LLM generation tracing and prompt-prefix stability (#102)
9c1d48f feat: CodeGraph and MCP operational readability (v1.12.0) (#101)
c2c3ff4 feat: Session Knowledge Synthesis Suite (v1.11.0) (#100)
... (older suites: recall quality, portability, indexer durability, provenance, integrity, search quality)
```

The directly related predecessor is `9c1d48f` (CodeGraph + MCP operational
readability, v1.12.0): read-only `brain_codegraph_report` + option-gated cluster
batching, deliberately keeping partner integration read-only and not adding new
graph edge schemas. This release continues that posture on the MCP side while
adding the one missing link-graph edge form (reference-style links).

## Required output format

Produce **exactly** these sections and nothing else:

### Variant 1
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullets.
- **Complexity**: small | medium | large.
- **Risk**: low | medium | high.

### Variant 2
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullets.
- **Complexity**: small | medium | large.
- **Risk**: low | medium | high.

### Variant 3
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullets.
- **Complexity**: small | medium | large.
- **Risk**: low | medium | high.

### Recommended: Variant N
A short rationale (a few sentences) naming the concrete reasons the chosen
variant fits this project's conventions, the four tasks, and the constraints
above.

Do not emit any code, file listings, implementation steps, or additional
sections. Variants must be genuinely distinct architectural strategies for
delivering the whole 4-task release, not rearrangements of the same strategy.
