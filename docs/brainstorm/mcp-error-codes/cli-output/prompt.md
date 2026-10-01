You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Two tracker cards ship together as one release ("stable error codes at the MCP boundary").

## Card A: stable machine-readable error codes on every MCP tool error
**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.47.4.0
**Repo**: garrytan/gbrain (18439★)
**Released**: v0.47.4.0 (2026-08-28T17:16:15Z)

## What
Give every MCP tool error a stable, machine-readable code, the way OSB already does for the search surface via SEARCH_ERROR_CODES. Today skill- and workspace-execution failures return free-form text with no enumerated code vocabulary, so remote agent clients cannot branch on an error class without parsing prose. This extends the existing code discipline to the skill/workspace tool surfaces and, optionally, standardizes an HTTP 429 JSON envelope on repeated-failure paths.

## Why useful for OSB
OSB is consumed over MCP by remote agent clients (Hermes, Claude Code, Codex). Stable codes on tool errors let those clients retry, fall back, or surface a specific class programmatically instead of string-matching English prose that can change at any time. It also makes the surface consistent: search already speaks codes; skill/workspace execution should too.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: Partial coverage exists - SEARCH_ERROR_CODES at src/core/search/search-error.ts:13 with the code accessor at src/core/search/search-error.ts:62; MCP protocol layer carries a code field at src/mcp/protocol.ts:23; response shaping has code at src/core/brain/response-shape.ts:212; policy errors expose source at src/core/brain/policy/errors.ts:24. Gap: no run_skillopt-equivalent or skill/workspace error-code vocabulary - not found for skill execution; the affected surfaces are src/core/brain/skill-accept-journal.ts and WORKSPACE_TOOLS at src/mcp/brain/workspace-tools.ts:148, neither of which defines an enumerated error-code set.

## Notes
Upstream's run_skillopt and admin-auth 429 specifics are gbrain-internal; the transferable idea is a single enumerated error-code vocabulary spanning all MCP tool surfaces, mirroring the existing search-error pattern rather than copying gbrain's endpoint names. Scope should reuse the existing code-bearing error class shape (search-error.ts, protocol.ts) to avoid a second, divergent convention. The 429 JSON-envelope piece applies only if OSB exposes rate-limited auth endpoints; verify before folding it into the same task.


**Also observed**:
- Gentleman-Programming/engram (4586★) — PR #906 — structured `invalid_session_id` / `retry_without_session_id` error fields on unregistered-session writes: a concrete first member for this task's cross-surface error-code vocabulary.

## Card B: reranker liveness as a typed degradation code, a doctor check and a rerank sunset table
**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.48.2.0
**Repo**: garrytan/gbrain (18439★)
**Released**: v0.48.2.0 (2026-09-02T21:47:13Z)

## What
Every reranker-facing surface reports whether the cross-encoder rerank stage actually ran on a query and, if it was skipped, why (missing key, dead/sunset provider, disabled) and the exact remediation. A reranker whose provider is gone degrades quietly to fusion order instead of erroring or paying dead HTTP calls, and the skip is surfaced as a first-class degradation code in explain output and doctor.

## Why useful for OSB
OSB has hybrid search with an optional cross-encoder rerank stage but no way to tell whether that stage actually fired on a given query — `o2b search rerank-fit` answers "does the configured reranker re-order results" (fit), not "was it skipped this query and why" (liveness). Without a liveness signal, a missing key or a decommissioned rerank provider silently returns fusion-order results that look unranked, with no surface pointing at the cause or the fix.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**:
  - `src/cli/search/verbs/rerank-fit.ts` — `o2b search rerank-fit` checks FIT (does the cross-encoder re-order), not LIVENESS (was it skipped this query and why); the liveness gap is adjacent but uncovered.
  - `src/cli/brain/verbs/doctor.ts` — no reranker health section (grep "rerank" = 0 hits across its 306 lines); doctor cannot report reranker skip/reason.
  - `src/core/search/retrieval-trail.ts:68` — `RETRIEVAL_DEGRADATION` is a closed code union with no reranker-skip member; a `reranker-skipped` code (with reason: `no_key` / `provider_sunset` / `disabled`) needs adding here to flow into `search --explain`.
  - `src/core/search/rerank/provider.ts` (`makeRerankProvider`), `registry.ts` (fail-soft load of `Brain/search/rerank-providers.json`), `cross-encoder.ts` (OpenAI-compatible `/rerank`) — the rerank path already fail-soft-loads but does not emit a structured skip event the surfaces can read.
  - `src/core/search/embeddings/sunset.ts` — static decommission SURVEY table (t_e7a226ce) exists for EMBEDDING models but has no rerank-provider equivalent; a sunset-driven skip reason for rerankers would mirror this.
  - `src/core/search/embeddings/zeroentropy.ts` — a native ZeroEntropy EMBEDDING provider exists, but the rerank side has no ZeroEntropy provider; the upstream ZeroEntropy hosted-rerank sunset (2026-09-04) maps to OSB's rerank-provider registry, not this embedding module.

## Notes
Scope is observability plus safe degradation, not a provider migration: OSB does not ship a ZeroEntropy rerank default to move off of, so the upstream "switch default to Voyage rerank-2.5" step does not directly apply — the transferable capability is the skip-reason surfacing (`degraded: reranker_skipped (no_key)`-style codes) and the "degrade to fusion order without dead HTTP" guarantee. Suggested surfaces to wire: `retrieval-trail.ts` degradation code → `search --explain`, a reranker section in `doctor.ts`, and the search-modes listing.

## Verified premise (live source, tree a1ecfe7b)
- Two error channels exist. Channel A: a handler throws MCPError (src/mcp/protocol.ts:38) and handleRequest returns a JSON-RPC error {code:<numeric>, message, data?} (src/mcp/server.ts:358-361, builder errorResponse :585). 373 throw sites; only about 12 put a string `code` in `data` (write batch, create note, pinned, memory bridge, lifecycle, vault_frozen). Channel B: any other throw inside tools/call is caught (server.ts:463-478) and wrapped by toolError (:570) as {content:[{type:"text",text}], isError:true} with no code; withProgressRefusal (src/mcp/progress.ts:173-179) REPLACES `_meta` with the progress refusal.
- About 28 core error classes carry a readonly `code` (SearchError with SEARCH_ERROR_CODES, SkillError NOT_FOUND|INVALID_PATH, WriteBatchError, CreateNoteError, NoteLifecycleError, PinnedBatchError, ...). Casing on the wire is mixed (snake, kebab, UPPER) and is a public contract where already emitted; tests pin budget_exceeded, invalid_action, invalid_target.
- searchErrorToMcp (src/mcp/search-tools.ts:863-887) drops SearchError.code; skill-tools.ts:90 rewraps SkillError as MCPError(INVALID_PARAMS, message) and drops the code; workspace tools and the write-session refusals are prose only.
- The MCP SDK (1.30) validates structuredContent against outputSchema even when isError is true, so an error object in structuredContent breaks strict clients on 16 tools; `_meta` passes the loose result schema. Repo already uses a namespaced `_meta` key "open-second-brain/progress". Tests pin the text body with toBe in two places.
- No HTTP 429 exists in the MCP server (out of scope). The engram pair has no direct counterpart; the closest is write-session unknown/terminal plus a missing session_id.
- Rerank: RETRIEVAL_DEGRADATION (src/core/search/retrieval-trail.ts:68) is a closed vocabulary with no rerank member; rerank failure is only a warning string `rerank_degraded: <raw provider message>` (pipeline/post-rank.ts:178); trail detail must be identifiers/integers only, never provider prose. `disabled` and missing-key cannot be degradations (disabled is the default; enabled + missing key fails closed). Embedding sunset survey precedent: src/core/search/embeddings/sunset.ts, model-string keyed, injectable survey and clock, classifier generic over the survey; doctor check precedent doctor/embedding-sunset-check.ts with a doctor exit census. A degraded rerank outcome is currently written to the query cache, so a transient failure is served from cache.

# Project context

Open Second Brain: TypeScript on Bun, a hand-rolled MCP server (stdio and HTTP), a CLI `o2b`, a Hermes Python plugin. No @modelcontextprotocol/sdk dependency.
Recent commits:
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0) (#223)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0) (#222)
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
eb3c4c85 docs: concise README, ZCode client page, CLI reference and safety notes moved to child pages (#219)
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0) (#217)
3e59f319 feat: decision-model uses, adapters and setup skill (v1.60.0) (#215)
eacad953 feat: optional decision-model core and decision-model rerank kind (v1.59.0) (#214)
0afa0c5a chore(deps): bump the bun-minor-and-patch group with 5 updates (#201)
f6212cd2 fix: quiet one-line Stop reminder via Claude Code feedback channel (v1.58.2) (#202)
534befdb chore(deps): bump the github-actions group with 3 updates (#200)
5c550263 fix: session capture off the hook path, registry scanner hygiene (v1.58.1) (#199)
6f33c424 feat: payload registry and knowledge packs, boundary hardening, CJK chunking (v1.58.0) (#197)
a4d3ecf8 fix(codex): real plugin files and a truthful install check (v1.57.1) (#193)
d7e6094a feat: a second platform (v1.57.0) (#191)
54bb28d9 feat: what this install knows (v1.56.0) (#185)
5f415267 feat: who wrote what, and how to take it back (v1.55.0) (#184)
dc552590 feat: private is not a suggestion (v1.54.0) (#183)
23e6b81e fix(brain): merged pages leave the dedup pool, and the write seam refuses cycles (v1.53.1) (#182)
Related files: src/mcp/server.ts, src/mcp/protocol.ts, src/mcp/progress.ts, src/mcp/search-tools.ts, src/mcp/skill-tools.ts, src/mcp/brain/workspace-tools.ts, src/mcp/brain/context-tools.ts, src/core/search/search-error.ts, src/core/search/retrieval-trail.ts, src/core/search/rerank/index.ts, src/core/search/rerank/cross-encoder.ts, src/core/search/pipeline/post-rank.ts, src/core/search/search.ts, src/core/search/embeddings/sunset.ts, src/core/brain/doctor.ts, src/core/brain/diagnostics.ts, src/core/brain/doctor-exits.ts
Conventions:
- Closed vocabularies as frozen object + members list + guard, registered in a census test.
- Named failures, never silent fallbacks; "absent, not empty" envelopes keep healthy payloads byte-identical.
- No network calls for third-party facts; sourced static tables with review dates.
- All strings English; no per-language phrase lists.
Constraints:
- Text bodies of existing errors stay byte-identical; existing wire codes keep their spelling.
- No error payload in structuredContent.
- No new external dependencies. Every enumerated code must have a live producer.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
