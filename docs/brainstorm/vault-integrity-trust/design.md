# Vault Integrity & Trust - a five-unit suite hardening the trust and identity boundaries of the vault

**Status:** draft
**Author:** @claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain is an agent-owned vault that ingests external material and feeds untrusted note/source text into model-facing operations. Today five distinct boundaries are soft: untrusted spans reach prompts un-delimited and un-neutralized; the same note has byte-different identities across devices (NFD vs NFC paths); the search index goes stale between manual runs; graph queries rebuild adjacency on every call; and recall has no agent-ownership isolation. This suite hardens each boundary as an opt-in capability without changing any existing default.

## Scope

Five atomic units, one feature branch, one release. Implemented one-by-one via TDD.

- **Unit 1 - Untrusted-source delimiting + sentinel neutralization + prompt hardening.** A provenance-carrying wrapper `<untrusted_source path="..." sha256="...">...</untrusted_source>` plus structural, language-agnostic neutralization of injection vectors (zero-width / bidi / control characters, fenced role-turn markers, nested-delimiter escaping). Applied at the agent-facing context-pack assembly (the surface where untrusted note bodies actually reach the model), gated behind the `untrusted_source_delimiting` guardrail flag. (Implementation note: dream, deep-synthesis, and pre-compact-extract read note bodies for deterministic analysis, not as model prompts, so the delimiting lives at the context pack rather than those passes.)
- **Unit 2 - NFC path-identity normalization.** The path component is NFC-normalized at the identity boundary (note-path / content-hash) so the same note is one identity across a multi-device (Syncthing) vault, killing re-index churn and phantom cross-device duplicates.
- **Unit 3 - File-watcher auto index sync.** An opt-in watch mode (native `fs.watch`, no new dependency) that debounces and coalesces `.md` edits and drives the existing incremental `indexVault` path; never overlaps passes; shuts down cleanly.
- **Unit 4 - O(1) graph query/stats via precomputed side-indexes.** In-memory side-indexes (name->node, (src,dst,type)->edge, node->degree, top-degree snapshot) memoized on the `Store` and invalidated on store version, so `detectCommunities` / `sharedEntities` stop rebuilding adjacency per call.
- **Unit 5 - Agent-scoped recall isolation.** An opt-in agent-scope filter (sibling of the existing `visibility` content-scope) so a recall constrained to an agent never returns another agent's owner-private memories.

## Out of scope

- `t_bf6933bc` (codegraph ghost-duplicate auto-merge) - de-scoped: it is a thin passthrough to the external `graphify extract --force` binary; the dedup logic lives in graphify, not Open Second Brain, and a verb that silently no-ops when graphify is absent would be exactly the misleading fallback the project forbids.
- Persisting any derived view into note frontmatter (read-time-derive precedent holds).
- Any new external dependency.
- Migrating existing on-disk indexes (NFC identity converges on the next index pass; no one-shot migration).

## Chosen approach

**Variant 3 - Thin Identity Core, Independent Edges.** Extract only the one primitive two units provably share - a canonical identity (NFC-normalized path + content-hash) - into the existing `content-hash.ts` / `note-path.ts` boundary, consumed by both Unit 1's provenance (`sha256` / `path`) and Unit 2's change-detection key, so the two cannot drift. The three operational units (3 watcher at the CLI/MCP edge, 4 graph side-indexes, 5 recall scope) stay fully independent in their own homes. The derive-vs-persist tension is resolved by one documented rule: read-time-derive everywhere (Units 1, 2, 5), with Unit 4 the single principled exception (in-memory memoize + version-invalidate, never SQLite-persisted) its O(1) goal demands, and Unit 3 reusing the existing incremental index path rather than introducing new persisted state.

## Design decisions

- **One identity function, two consumers.** `canonicalNotePath` (NFC of the path component) feeds both the content-hash key and the Unit 1 delimiter provenance. NFC is idempotent on already-NFC (Linux) inputs, so the byte-identical-when-off guarantee holds on the dominant platform with no flag.
- **Neutralization is structural, never lexical.** No natural-language word lists in any language. The neutralizer strips zero-width / bidi / C0-C1 control characters, escapes nested `</untrusted_source>` delimiters, and defuses lines that structurally mimic chat role-turn boundaries. This satisfies `pref-language-agnostic-search`.
- **Delimiter helper lives beside `redactor.ts`.** Same sanitization family (`stripPrivateRegions`, `redactRawOutput`, `normaliseTextField`); pure function, no I/O.
- **Watch loop is library-pure derivation + edge-owned lifecycle.** The debounce/coalesce planner is a pure function over an event stream; the `fs.watch` handle, timers, and the index call live at the CLI verb edge. No overlapping passes via a single-flight guard.
- **Side-indexes are memoized on the Store, invalidated on store version.** No SQLite schema change, no persisted state, deterministic rebuild on invalidation. This is the one persisted-ish exception and gets explicit concurrency/determinism review in self-review.
- **Agent-scope mirrors `visibility`.** New optional `SearchOptions.agentScope` and an `owner:` frontmatter field; absent scope == today's behaviour, byte-identical. Composes with `visibility` by intersection.
- **Every unit opt-in, with a named switch per unit.** No existing caller changes behaviour unless it opts in:
  - Unit 1: a `_brain.yaml` config flag `untrusted_source_delimiting` (default `false`). Off == byte-identical assembled payloads; on == untrusted spans wrapped at the assembly sites.
  - Unit 2: unconditional but byte-identical on already-NFC (Linux) inputs because NFC is idempotent; only NFD (macOS) paths converge, which is the bug fix itself.
  - Unit 3: a new opt-in CLI verb (`o2b ... watch`); nothing runs unless the operator starts it. Not an MCP tool (a long-running daemon is a CLI concern).
  - Unit 4: internal performance refactor; output is parity-tested byte-identical to the per-call-rebuild path, so it is on unconditionally with no behaviour change.
  - Unit 5: optional `SearchOptions.agentScope`; absent == today's behaviour. Surfaced as one new optional MCP input on `brain_search`.

## File changes

New:
- `src/core/brain/untrusted-source.ts` - delimiter + structural neutralizer (pure).
- `src/core/search/index-watch.ts` - pure debounce/coalesce planner for the watch loop.
- `src/cli/brain/verbs/watch.ts` - CLI verb owning the `fs.watch` lifecycle.
- `src/core/brain/link-graph/graph-index.ts` - Store side-index snapshot (memoize + version-invalidate).
- Tests for each unit under `tests/`.

Modified:
- `src/core/brain/note-path.ts`, `src/core/brain/content-hash.ts` - canonical NFC path identity (Unit 2 + identity core).
- `src/core/brain/dream.ts`, `src/core/brain/deep-synthesis.ts`, `src/core/brain/pre-compact-extract.ts` - wrap untrusted spans (Unit 1).
- `src/core/brain/link-graph/communities.ts` + `src/core/search/store.ts` - consume side-indexes (Unit 4).
- `src/core/search/search.ts`, `src/core/search/types.ts`, `src/core/graph/visibility.ts` (or sibling) - agent-scope filter (Unit 5).
- `src/mcp/search-tools.ts` - one new optional `agentScope` input on `brain_search` (Unit 5 only).
- `src/core/brain/types.ts` (`BrainConfig`) + `src/core/brain/policy.ts` (`loadBrainConfig` / a `resolveGuardrails`-style resolver) - the `untrusted_source_delimiting` flag (Unit 1).
- `README.md`, `CHANGELOG.md`, `package.json` (+ `sync-version.ts`).

## Risks and open questions

- **Unit 4 determinism/concurrency** - the memoized side-index must invalidate correctly on every write path; a stale snapshot would silently corrupt graph reads. Resolved in self-review with an explicit invalidation audit.
- **Unit 1 over-neutralization** - structural neutralization must not corrupt legitimate note content (e.g. a note that legitimately contains the literal `system:`); the wrapper delimits rather than deletes, and neutralization is confined to control/zero-width characters + escaping, leaving visible prose intact.
- **Unit 3 fs.watch portability** - `fs.watch` semantics differ across platforms (recursive support, event coalescing); the pure planner is unit-tested independently of the OS watcher, and the verb degrades to a clear error (not a silent no-op) where recursive watch is unsupported.
- **Unit 5 ownership source** - `owner:` frontmatter must have a single canonical reader; reuse the existing frontmatter parse path, do not invent a second.
