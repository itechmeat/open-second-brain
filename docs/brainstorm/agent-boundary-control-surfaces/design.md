# Agent Boundary Control Surfaces - transient context, link output, contracts, and private-region stripping

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain gives agents a durable Brain through deterministic CLI and MCP tools, but several small boundary controls are still missing. Agents can load `Brain/active.md`, but they cannot pin short-lived task facts without turning them into permanent preferences. Brain outputs are Obsidian-first wikilinks even when a downstream consumer wants standard Markdown links, and MCP tools expose structured payloads without validating output contracts at the boundary. Finally, the redactor catches secret-looking assignments but does not let a user or agent explicitly mark a region as private before it reaches storage.

## Scope

- Add a transient pinned-context surface backed by `Brain/pinned.md`.
- Expose one MCP tool for pinned context read/write/append/clear operations.
- Include pinned context in `brain_context` so runtimes without a session-start hook can load active rules plus current-task facts in one call.
- Add a dependency-free link output format resolver for `link_output_format: wikilink | markdown` in the existing config file.
- Keep on-disk Brain artifacts Obsidian-compatible by default; apply the configured Markdown-link format to presentation outputs, not to internal identity fields that must stay stable.
- Add a lightweight MCP output contract mechanism: optional `outputSchema` on `ToolDefinition`, validated against returned `structuredContent` before the MCP envelope is emitted.
- Add output schemas first for the new pinned-context tool and the highest-value existing Brain/search surfaces touched by this release (`brain_context`, `brain_query`, `brain_search`), with loose object schemas where exact payload details are intentionally extensible.
- Add `stripPrivateRegions` to the shared redactor and run it before secret assignment redaction through `redactRawOutput` / `sanitiseTextField`.
- Update docs, changelog, tests, and project version before push as requested by the operator.

## Out of scope

- Real-time session lifecycle hooks, workers, or embedding changes from the parent cavemem task.
- Path-glob capture exclusion from the cavemem task; this needs a separate vault-scope design.
- A generic boundary pipeline abstraction for all inbound/outbound surfaces.
- Rewriting persisted Brain files from wikilinks to Markdown links.
- Full JSON Schema draft compliance; the validator only covers the schema subset used by MCP contracts in this release.
- Visibility tags, retention lifecycle review, multi-phase dream, schema packs, and vector backend work.

## Chosen approach

Use independent additive slices. The pinned-context feature gets a small core module and MCP tool, link output gets a small config resolver plus presentation renderer options, MCP contracts get an optional `outputSchema` field and a focused validator at `toolResult`, and private-region stripping extends the existing redactor. This keeps each task testable in isolation and avoids introducing a cross-cutting pipeline before the codebase has more than one concrete need for it.

## Design decisions

- `Brain/pinned.md` lives at the Brain root beside `active.md`, because it is session/task context rather than an inbox signal, preference, retired rule, or log event.
- The pinned-context MCP tool uses an explicit operation field (`read`, `write`, `append`, `clear`) instead of several tool names, so the writer-server surface grows by one tool and remains easy to advertise.
- Pinned content is returned as its own structured `pinned` block from `brain_context`, and also appended to the human-readable `content` only when non-empty. Agents get a stable machine field and humans still see one combined context card.
- Private-region stripping is included only as a deterministic text transform. It strips balanced `<private>...</private>` blocks case-insensitively and leaves an audit marker; malformed/unclosed tags are handled conservatively by stripping from the opening tag to end of input.
- `redactRawOutput` runs `stripPrivateRegions` before assignment/key redaction, so any existing writer using `sanitiseTextField` receives the new privacy behaviour without per-call drift.
- `link_output_format` accepts only `wikilink` or `markdown`; invalid or absent config falls back to `wikilink` for backward compatibility.
- Markdown-link rendering preserves the same display title sanitisation as wikilinks and points to stable vault-relative Brain paths (`Brain/preferences/pref-*.md`, `Brain/retired/ret-*.md`) when the helper can infer them.
- MCP output contracts validate `structuredContent` before `content` text is generated, so the text mirror cannot accidentally serialize an invalid object.
- Contract failure is an internal server error, not a client `INVALID_PARAMS`, because the tool handler returned a shape that violates its own declaration.
- The schema validator is local and deliberately small: object/string/number/integer/boolean/array/null, `required`, `properties`, `items`, `enum`, and `additionalProperties: false` are enough for the planned contracts.
- The generic playbook says version bump usually happens during release, but the operator explicitly requested a project version bump before GitHub push; this branch follows the operator override.

## File changes

Expected new files:

- `src/core/brain/pinned.ts`
- `src/mcp/output-contract.ts`
- `tests/core/brain.pinned.test.ts`
- `tests/mcp/output-contract.test.ts`
- `docs/brainstorm/agent-boundary-control-surfaces/*`

Expected modified files:

- `src/core/brain/paths.ts`
- `src/core/brain/wikilink.ts`
- `src/core/config.ts`
- `src/core/redactor.ts`
- `src/mcp/tools.ts`
- `src/mcp/server.ts`
- `src/mcp/brain-tools.ts`
- `src/mcp/search-tools.ts`
- `tests/core/brain.wikilink.test.ts`
- `tests/core/redactor.test.ts`
- `tests/mcp/brain.test.ts`
- `tests/mcp/mcp.test.ts`
- `tests/mcp/mcp-json.test.ts` if contract assertions fit better there
- `README.md`
- `docs/mcp.md`
- `docs/how-it-works.md`
- `docs/cli-reference.md`
- `CHANGELOG.md`
- `package.json` and version-synced metadata files via `bun run sync-version`

## Risks and open questions

- `brain_context` content composition must stay backward compatible for agents that only read `content`. The new `pinned` block should be additive.
- Link-format configuration can become too broad if applied to persisted Brain internals. Keep it presentation-only unless a separate storage-migration task explicitly changes that contract.
- Output schemas for broad tools such as `brain_search` must stay loose enough to avoid breaking extensibility while still catching gross contract drift.
- Private-region stripping may surprise users if they intentionally write literal XML-like examples. Document the behaviour clearly and test escaped/malformed cases.
- The exact MCP tool name should avoid confusion with the existing CLI preference pin command. Implementation should prefer a name like `brain_pinned_context` unless local naming conventions strongly point elsewhere.
