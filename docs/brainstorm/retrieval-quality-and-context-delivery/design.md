# Retrieval quality and context delivery - one wave, nine tasks, two hard seams

**Status:** approved
**Author:** wave orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain answers relationship-shaped and summary-shaped questions through generic hybrid search, ships advisory retrieval signals that no single surface composes, and cannot tell an operator when the reranker hurts a given vault. On the delivery side, injected context is all-or-nothing per hook, nothing enforces "query the index before re-reading raw notes", the overwrite-only pinned scratchpad silently leaks stale state back through recall, dedup and search ignore session and project scope, and codegraph partnering collapses a multi-project workspace to its first project.

## Scope

Nine kanban tasks in two themes, one PR, one release (v1.37.0):

- A. Retrieval quality: t_09b7ccea (typed-edge relational retrieval as a fourth RRF arm with federation-hardened keys), t_7b96f242 (deterministic summary-search router plus retrieval skill hardening), t_267f3b4c (per-store reranker fit check diagnostic), t_3ffb021c (shadow-only retrieval_plan advisor).
- B. Context delivery and state hygiene: t_2d4f34d7 (tiered context injection with cadence-controlled navmap), t_36b0fd8d (opt-in strict PreToolUse read-block hook with fail-open orientation stamp), t_b0c9d0a3 (overwrite-only exact-state lane excluded from semantic layers plus retrieval-time staleness barrier), t_37c05a34 (composite scope keys with per-scope dedup and search scoping), t_0f3f2422 (codegraph partnering across all workspace projects).

## Out of scope

- A full user/agent/session/project namespace rewrite (t_37c05a34 ships the per-scope dedup and search-scoping slice over existing owner and session axes).
- A generalized retrieval-diagnostics layer or hook-state store (consultant Variant 1); the fit check and the advisor read existing signal modules directly, hook stamps use the existing hooks/lib session state under namespaced keys.
- Webhook or non-Claude-Code hard-block enforcement for the strict hook (other harnesses stay nudge-only).
- Any LLM call inside the deterministic kernel; the relational parser, router, fit check, advisor, and staleness barrier are structural and deterministic.

## Chosen approach

Consultant Variant 2, two hard seams, rest conventions.

Seam 1, composite-key module: one module owning both the RRF/dedup source-identity key (federation hardening of t_09b7ccea) and the scope-key vocabulary (owner/session/project axes for t_37c05a34's per-scope dedup, search filters, and t_09b7ccea's scope-aware seed resolution). A key mismatch silently collapses distinct results or fails to collapse duplicates, so exactly one implementation exists. Rides in the t_37c05a34 anchor commit; t_09b7ccea consumes it.

Seam 2, index-admission predicate: one predicate at the walker/indexer touch point deciding what enters the search index. Owned by t_b0c9d0a3 (exact-state lane exclusion), consulted by t_37c05a34 (scope-aware indexing). Rides in the t_b0c9d0a3 anchor commit.

Conventions, not extractions: the fit check (t_267f3b4c) and the advisor (t_3ffb021c) each read query-plan, density, token-impact, and latency modules directly; shadow-only is enforced by exposing no mutating handles and by tests. The strict hook (t_36b0fd8d) and the nav cadence (t_2d4f34d7) store stamps in the existing hooks/lib session state under namespaced keys with explicit TTL semantics defined in plan.md.

Track ordering: state track t_b0c9d0a3 then t_37c05a34 then t_09b7ccea; t_7b96f242, t_267f3b4c, t_3ffb021c, t_2d4f34d7, t_36b0fd8d, t_0f3f2422 independent.

## Design decisions

- Relational arm (t_09b7ccea): the relational-query parser detects relationship shape structurally (edge-type vocabulary drawn from schema packs with subset validation, never natural-language word lists); relationalFanout generalizes typed-edge traversal to a seed array with bounded depth 2, aggregating hop count, edge richness, and via-link-types into ranked nodes; wired as a fourth RRF arm behind a mode flag, byte-identical when off; the shared rrfKey carries source identity, and the query cache scopes by canonical source-set key.
- Summary router (t_7b96f242): first verify what buildQueryPlan intent detection already routes; the router is a deterministic strategy step that selects the summary-search surface for summary-shaped questions (structural signals: query targets a source, an artifact kind, or a summary-typed page), with hardened retrieval skill instructions naming the intended surface; no new ranking policy.
- Fit check (t_267f3b4c): hosted in the doctor/diagnostics surface; samples real recorded queries for the current vault, computes correlation between reranker scores and the base retrieval signal, and reports out-of-domain (low correlation) and inverted (negative correlation) verdicts with a concrete recommendation; quiet when the reranker helps; read-only.
- Advisor (t_3ffb021c): one read-only tool composing buildQueryPlan intent and weights, impact-per-token density allocation, the calibrated token-impact ledger, and observed route latency into a per-question retrieval plan with token allocation, graph-expansion advice, and a marginal-value stop derived from the density curve plus p95 latency; the tool exposes no mutating parameters and changes no live policy.
- Tiered injection (t_2d4f34d7): the always-on kernel stays exactly today's injected context; the navmap tier is additive, injected only on cadence or trigger, and every inclusion decision is recorded (when, why, char count); cadence state lives in hooks/lib session state under a namespaced key.
- Strict hook (t_36b0fd8d): opt-in via env; the first raw vault-file read of a session gets a deny with a redirect message naming the brain search surface, after which the hook downgrades to a nudge; any brain query/search refreshes a short-lived "recently oriented" stamp that suppresses the block; every path fails open (missing state, unreadable stamp, non-Claude-Code harness); default installs are byte-identical.
- Exact-state lane (t_b0c9d0a3): a structured overwrite-only lane keyed by aspect replaces free-form current-state accumulation; the lane is excluded from FTS/vector/graph/rollups via the admission predicate; a retrieval-time barrier drops superseded exact-state rows from every source; a regression test proves no existing non-lane content leaves the index.
- Scope keys (t_37c05a34): composite scope keys (owner plus session/project axes) make dedup per-scope so identical text in two scopes is not collapsed; search accepts optional scope filters; existing global dedup state is handled additively (new keys apply to new writes; no destructive migration).
- Codegraph workspace (t_0f3f2422): checkCodegraph iterates all discovered projects, threads project_path per query, aggregates health output across projects, and degrades to today's single-project behavior when the partnered codegraph lacks project_path support.

## File changes

- New: composite-key module and index-admission predicate under src/core (exact paths follow neighboring conventions), relational parser and fanout modules under src/core/search, summary-router step in the query-plan path, fit-check diagnostic module, retrieval-plan advisor module and MCP tool, navmap tier logic in hooks, strict PreToolUse hook script and hooks.json entry, exact-state lane module, scope-filter plumbing, tests beside every change.
- Modified: src/core/search/store.ts and RRF composition, src/core/search/query-plan.ts, src/core/search/walker.ts, src/core/vault-scope/defaults.ts, src/core/brain/pinned.ts, hooks/hooks.json and hooks/lib, src/core/graph/agent-scope.ts consumers, openclaw/index.js, MCP registrations and registry baselines, docs.
- Implementers adapt names to neighboring conventions and record deviations in commit bodies.

## Risks and open questions

- The relational arm touches RRF composition, the highest-traffic ranking path; the mode flag with byte-identical default-off plus regression tests is the containment.
- Existing global dedup state versus per-scope keys: additive keying avoids migration, but reruns over old rows must not re-collapse; verify during TDD.
- The strict hook must never strand an agent: every failure path is fail-open and covered by tests, including missing session state and non-Claude-Code harnesses.
- Excluding the exact-state lane from the index must not drop any existing content; the admission predicate defaults to admit and excludes only the lane's marked artifacts.
- The advisor and fit check must remain provably shadow-only; tests assert no config or store writes occur through their code paths.
- openclaw/index.js is JavaScript in the integration layer; changes stay defensive (feature-detect project_path support) and covered by its existing test harness.
