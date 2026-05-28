# Cross-agent query foundation - universal agent-source retrieval and comparison

**Status:** reviewed for implementation
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain already records agent provenance on signals, preferences, and log events, and it already has a session-adapter pattern for Claude, Codex, and Hermes. What it lacks is a dedicated read-only layer that lets an operator or agent ask what a specific source agent contributed, compare contributions between agents, and grow that capability without rewriting the query path whenever a new runtime is added.

The current implementation leaks a fixed present-day matrix into the import surface: `SessionAdapterId` is closed over `claude|codex|hermes`, `agentLabelForTurn()` hardcodes those adapter ids, and the CLI validates `--format` against the same literal list. That is manageable for today's adapters, but it is the wrong seam for a universal cross-agent foundation.

## Scope

- Introduce a dedicated `core/brain/agent-source/` read-only module.
- Define a provider abstraction for agent-source evidence, with a registry-driven agent universe.
- Ship the first provider over existing vault provenance: signals, preferences, and Brain log events.
- Add `brain_agent_query` as a structured, deterministic retrieval surface over one or more agents.
- Add `brain_agent_diff` as the first comparison surface (browse/search/diff/map modes) built on the query foundation.
- Remove hardcoded adapter matrices from the session-import public surface where they would force future query-layer churn.
- Add CLI mirrors for operator use and MCP tools for runtime use.
- Add tests covering provider discovery, query semantics, diff semantics, and the CLI/MCP envelopes.

## Out of scope

- Raw transcript-history storage or a persistent session-history index.
- On-demand ingestion of "last N unprocessed sessions" during query execution.
- New runtime adapters such as Copilot or Pi.
- Any write path changes to Brain state.
- LLM-only synthesis or opaque ranking that cannot be explained from deterministic inputs.

## Chosen approach

Create a new agent-source query layer with a registry and one concrete provider: vault provenance. The provider reads the Brain artifacts that already carry `agent` information and normalizes them into a single contribution model. `brain_agent_query` uses that model to retrieve, group, and summarize matched contributions for selected agents; `brain_agent_diff` builds comparison views and knowledge-gap signals on top of the same normalized data.

The provider registry is the universality seam. Future agents should extend OSB by adding new providers or new session adapters that feed the same provenance model, not by modifying the query or diff algorithms. The current import surface will be trimmed so agent-source logic is derived from registry metadata instead of literal `claude/codex/hermes` branches scattered across CLI and import code. The session adapter contract will keep the current typed id union for compile-time checks, while adding registry-owned helpers (`isSessionAdapterId`, `sessionAdapterFormatChoices`, and an adapter-level `defaultAgent`) so runtime validation and signal stamping no longer duplicate the present-day adapter list.

## Design decisions

- Use dedicated tools instead of bolting `agent` filters onto `brain_query` and `brain_search`.
  This keeps the existing vault-centric surfaces small and avoids turning them into general-purpose provenance multiplexers.

- Start with one provider: vault provenance.
  OSB already stores agent identity on signals, preferences, and log entries. That is sufficient for a useful first release and avoids the storage/index duplication of a raw transcript store.

- Make the agent universe registry-driven, not matrix-driven.
  Query and diff should enumerate whatever providers expose. CLI validation and helper defaults should resolve through registry helpers rather than fixed literal checks.

- Keep outputs structured and deterministic.
  `brain_agent_query` may return a synthesized summary field, but it must be computed from deterministic grouping/retrieval over matched artifacts, not by outsourcing the answer to an unconstrained model.

- Build diff on top of query, not beside it.
  The triage note for `t_64dad481` explicitly names the query layer as a prerequisite. Reusing the same normalized contribution model keeps the dependency honest and reduces drift between browse and diff semantics.

- Preserve additive adoption for future agents.
  New agents should require adapter/provider registration and tests, not query-layer rewrites. This PR should make that extension path explicit.

## File changes

Expected implementation surface:

- `src/core/brain/agent-source/`
  - `types.ts`
  - `registry.ts`
  - `vault-provider.ts`
  - `query.ts`
  - `diff.ts`
  - `summary.ts`
- `src/core/brain/sessions/`
  - `types.ts`
  - `registry.ts`
  - `import.ts`
- `src/cli/brain/verbs/`
  - `agent-query.ts`
  - `agent-diff.ts`
  - `import-session.ts` (only if registry-driven validation changes belong there)
- `src/cli/brain.ts`
- `src/cli/brain/help-text.ts`
- `src/mcp/brain-tools.ts`
- tests under `tests/core/`, `tests/cli/brain/`, and `tests/mcp/`
- phase-5 docs updates in `README.md`, `CHANGELOG.md`, and any implementation-facing doc touched by the new tools

## Risks and mitigations

- The current session adapter contract is strongly typed around a closed union. Keep that union for compile-time coverage, but move all runtime validation, format choice rendering, and default agent labeling behind registry helpers. Future adapter work then touches the type, adapter module, and registry entry, but not the query or diff layer.

- Provenance on preferences and log entries is not identical in meaning. The normalized contribution model must make it explicit whether an item is a signal, preference, or log-event contribution so `brain_agent_diff` does not overstate equivalence.

- `brain_agent_query` has a bounded query language: `agents`, `topic`, `query`, `kind`, and `limit`. `agents` selects explicit agent ids or all known ids; `topic` is an exact topic match; `query` is a case-insensitive substring match across deterministic text fields; `kind` is one of `signal`, `preference`, or `log`; `limit` caps returned contributions after deterministic sorting.

- The comparison modes for `brain_agent_diff` should stay explainable. A deterministic topic/entity overlap model is preferable to clever but opaque heuristics.
