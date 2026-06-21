# CodeGraph link-graph depth + MCP exposure — plan

Shared branch: `feat/codegraph-link-depth-mcp`. Combined design:
`docs/brainstorm/codegraph-link-depth-mcp/design.md` (Variant 2 — strictly
additive leaves).

<lock-scope>
<task_ids>
t_13c92d85
t_da6321a9
t_31dfae18
t_85252236
</task_ids>
</lock-scope>

Cards are driven **one at a time** in priority order (highest first):
`t_13c92d85` → `t_da6321a9` → `t_31dfae18` → `t_85252236`. Before editing,
inspect the current branch commits and build on any previously-driven in-scope
card commits. Do not duplicate sibling work; update shared doc/CHANGELOG
sections in place if a sibling already touched them.

Every task is implemented under TDD: write/adjust the focused failing test
first, then make it pass, then refactor. All identifiers and messages are
English; no natural-language keyword lists.

---

## t_13c92d85 (P4 — CORE): resolve reference-style Markdown links into graph edges

### Files

- `src/core/search/links.ts` — add a reference-definition collection pass and a
  reference-usage matcher, appended after the inline-link loop and before the
  tag loop. Collect `[label]: <target>` definitions (CommonMark: up to three
  leading spaces, case-insensitive label, URL or relative path target; ignore
  link titles for edge purposes) from the already code-stripped content, then
  resolve `[text][label]`, `[text][]` (collapsed), and `[text]` (shortcut)
  references against the map. Reuse `isUrl` / `isMailto` / `#anchor`-strip on
  the resolved target unchanged and emit the existing `markdown_link` row shape
  (`ExtractedLink` with `linkType: "markdown_link"`). The inline `MD_LINK_RE`
  branch and its image-embed negative lookbehind stay byte-identical.
- `tests/core/search/links.test.ts` (**extend** — the file already exists with
  wikilink/inline/tag/code-fence/dedupe coverage) — add reference-style cases
  (full/collapsed/shortcut, label case-insensitivity, duplicate labels,
  definition-after-use, image-embed exclusion still holds, external-URL/mailto
  skip still holds, code fences still ignored) and a byte-identical-inline
  regression asserting that inline-link output is unchanged by the new pass.
- `CHANGELOG.md` — append under the new release section.

### Acceptance

A passing test in `tests/core/search/links.test.ts` asserts that Markdown
containing a reference-style link (`Some [text][ref] prose\n\n[ref]: ./other.md`)
produces an `ExtractedLink` with `linkType: "markdown_link"`, `targetPath:
"./other.md"`, `linkText: "text"`, and that a second test asserts inline-link
output for a fixture is byte-identical before and after the change. `bun run
validate` is green.

### Depends on

None. Self-contained inside `extractLinks`; the indexer and
`store.replaceLinks` consume the same row shape, so no downstream change is
needed.

---

## t_da6321a9 (P3): graphify-mcp console script for stdio MCP server

### Files

- `scripts/o2b-mcp` (new) — bash launcher mirroring `scripts/o2b` (follow
  symlink, source `_bun-precheck.sh` / `_macos-sqlite.sh`, resolve repo root)
  that execs the CLI with the MCP command injected, forwarding `"$@"` verbatim.
  Confirm the exact MCP command form in `src/cli/main.ts` (`o2b mcp …`) and
  inject that subcommand so `o2b-mcp --vault X` ≡ `o2b mcp --vault X`. The shim
  is transport-agnostic: do NOT add transport logic here.
- `package.json` — add `"o2b-mcp": "./scripts/o2b-mcp"` to `bin`; ensure the
  script is reachable (it lives under `scripts/`, already in `files`).
- `tests/cli/o2b-mcp-launcher.test.ts` (new, or extend an existing CLI launch
  test) — assert the bin entry resolves to MCP serving (e.g. `--probe`/version
  path reaches the MCP server banner) and forwards flags.
- `docs/mcp.md`, `docs/cli-reference.md` — document the `o2b-mcp` entry point.
- `CHANGELOG.md` — append under the new release section.

### Acceptance

A passing test proves `o2b-mcp` (via the launcher) reaches MCP serving with
forwarded flags (e.g. the `[mcp] … listening on stdio` banner or the probe
report), and `package.json` `bin` exposes `o2b-mcp`. `bun run validate` is green.

### Depends on

None (hard). The shim delegates to the shared MCP command dispatch, so it
exposes whichever transports the dispatch supports at the time it runs. If driven
before `t_31dfae18`, it serves stdio; once `t_31dfae18` lands `--transport`,
the console script inherits HTTP automatically with no edit. Coordinate
`docs/mcp.md` / `CHANGELOG.md` append sections with the HTTP card to avoid
duplication.

---

## t_31dfae18 (P2): streamable HTTP MCP transport with API-key auth

### Files

- `src/mcp/http.ts` (new) — `serveHttp(ctx, opts, runtimeOpts)` built on
  `node:http`. Construct one `MCPServer` and route every accepted JSON-RPC
  request through `server.handleRequest` (single dispatch source — do not
  re-derive handling). Implement the `2025-06-18` Streamable HTTP shape: single
  endpoint, `POST` with `Accept: application/json, text/event-stream`; respond
  with a single JSON body or an SSE stream when the client requests event-stream;
  `initialize` may issue `Mcp-Session-Id`; reject JSON-array (batch) bodies with
  `INVALID_REQUEST` (`-32600`), matching the stdio loop's batch rejection.
  Constant-time API-key check on every request (accept the configured key only);
  single generic `401 Unauthorized` with no missing-vs-wrong distinction.
  Refuse to start without `--api-key` (HTTP without auth would expose the brain
  to the network) and print a clear stderr reason.
- `src/mcp/index.ts` — re-export `serveHttp`.
- `src/cli/main.ts` — extend `cmdMcp` with `--transport stdio|http` (default
  `stdio`), `--port`, `--host` (default `127.0.0.1`), and `--api-key` (required
  for `http`). The stdio path is byte-identical when no `--transport` flag is
  supplied.
- `tests/mcp/http-transport.test.ts` (new) — auth accept/reject (missing,
  wrong, correct; constant-time generic 401), initialize handshake, `tools/list`
  over HTTP, single-body vs SSE framing, batch rejection, refusal to start
  without `--api-key`. Use Node's built-in client or an in-memory server handle
  so no new test dependency is added.
- `docs/mcp.md`, `docs/cli-reference.md` — document the HTTP transport, flags,
  and auth model.
- `CHANGELOG.md` — append under the new release section.

### Acceptance

A passing test asserts an authenticated `initialize` → `tools/list` round-trip
over HTTP returns well-formed JSON-RPC results through `handleRequest`, that an
unauthenticated request gets a generic `401`, that a batch body is rejected, and
that starting HTTP without `--api-key` fails fast. The stdio path's existing
tests stay green and byte-identical. `bun run validate` is green.

### Depends on

None. Adds a new transport file and extends `cmdMcp` additively. Builds on
`t_da6321a9` only insofar as the console script inherits the new `--transport`
flag automatically (no coordinated edit required).

---

## t_85252236 (P1): offline code-only extraction without API keys

### Files

- `src/core/search/indexer.ts` — make deferred/offline backend resolution
  explicit: structured index output gains an additive `mode`/`backend` field
  (`offline` when no provider credentials are resolved; `semantic` when the
  embedding backend is active) carrying the existing deferred reason string, and
  the credential check is evaluated lazily (after content detection) so a
  deterministic-only corpus never hard-fails for a missing key. Existing fields
  stay byte-identical when no option changes.
- `src/core/search/config.ts` and/or `src/core/search/index.ts` — expose a
  minimal credential-resolution seam (no new behavior, just a named, testable
  surface) if the regression test needs it.
- `tests/core/search/index-offline.test.ts` (new) — keyless indexing runs the
  lexical pipeline to completion with `mode: offline`, computes no embeddings,
  and the structured output reports the deferred reason; default output shape is
  unchanged.
- `tests/core/brain/sessions-import-offline.test.ts` (new) — `importSession`
  runs to completion and never reads provider-credential env vars or config keys
  (assert via a scrubbed env / credential-read spy), locking the guarantee the
  task brief incorrectly assumed was absent.
- `CHANGELOG.md` — append under the new release section (frame honestly: the
  paths were already largely offline; this makes the guarantee explicit and
  tested).

### Acceptance

A passing test asserts that keyless indexing completes with an explicit
`mode: offline` and a deferred-credential reason, and that `importSession` never
reads provider credentials. Default indexer output is byte-identical to the
prior commit when no new option is supplied. `bun run validate` is green.

### Depends on

None. Kernel/indexer-only; stays independent of MCP. Coordinate `CHANGELOG.md`
append with siblings.
