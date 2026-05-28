You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one cohesive "MCP context economy" capability for Open Second Brain, composed of two atomic units that release together:

## Unit 1 (primary, architectural) — MCP tool-result preview budget with full-artifact fetch path

Open Second Brain's MCP tools (brain_search, brain_context_pack, brain_digest, brain_query, brain_timeline, brain_concept_synthesis, second_brain_status, ~27 brain_* tools total) can return large payloads when the vault is dense. Returning the full payload inline burns the calling agent's context window for content it may not need. We want a per-tool preview budget: the agent sees a bounded preview by default, and the full oversized output stays reachable through a follow-up tool call. This is a preview budget, not a capability cutoff — no information is lost, only deferred.

Minimum viable shape: a preview_chars budget per tool definition (default e.g. 2000) at the MCP layer; when the serialized result exceeds it, the response carries {preview, artifact_id, full_chars} and a sibling tool brain_artifact_get(artifact_id) returns the full bytes. Artifacts live under Brain/.artifacts/<run-id>/<artifact_id> with a TTL or on-shutdown cleanup. Reuses existing fs primitives.

## Unit 2 (secondary, thin) — Auto-recall hint text on search results

brain_search / brain_query return raw FTS5 + embedding results. Add a lightweight, computed-at-recall-time hint string that guides the downstream agent on how/why the recalled set is relevant (e.g. "N confirmed preferences and M signals matched; highest-confidence rule is X"). The hint is computed from the result set, never stored, and complements the existing per-result reasons[] (why_retrieved) array. Cosmetic-but-cheap polish layered over already-structured results.

# Project context

Project: Open Second Brain — an Obsidian-native, plain-Markdown memory layer for AI agents. Language: TypeScript. Runtime: Bun. MCP server speaks JSON-RPC 2.0 over the 2025-06-18 protocol.

Recent commits (default branch):
- v0.17.0 — Brain Lifecycle Review Suite (read-only review surfaces)
- v0.16.0 — Agent boundary control surfaces: pinned context, Markdown links, MCP output contracts
- v0.15.0 — Cross-agent query foundation

Key architecture facts the variants must respect:
- The single serialization chokepoint is toolResult(tool, structured) in src/mcp/server.ts. It runs assertOutputContract, then JSON.stringify(structured, sortedReplacer, 2) into content[0].text, and also attaches the raw object as structuredContent. Every tool output flows through this one function (both the JSON-RPC tools/call path and the CLI bridge callTool).
- Tool definitions are ToolDefinition in src/mcp/tools.ts with {name, description, inputSchema, outputSchema?, handler}. Tools are assembled in buildToolTable(scope).
- Brain paths are centralized in src/core/brain/paths.ts (BRAIN_ROOT_REL = "Brain", existing .snapshots/ dir with run-id pattern, strict slug/run-id validation via ensureInsideVault). Atomic writes via src/core/fs-atomic.ts (atomicWriteFileSync). Redaction via src/core/redactor.ts.
- brain_search already truncates per-result content to 600 chars and returns {results[], warnings[], total} with per-result reasons[].
- The MCP envelope distinguishes the human/agent-facing content[0].text (what floods context) from the machine-readable structuredContent (the raw object).

Conventions:
- Mirrors a legacy Python implementation in places; deterministic, no LLM inside algorithms.
- Plain Markdown in the vault; no daemon, no hidden state outside the vault.
- TDD is mandatory; every unit ships with tests first.
- Output contracts (JSON Schema outputSchema) are validated at the MCP boundary.

Constraints:
- No new runtime dependencies unless strongly justified (current deps: proper-lockfile; optional: sqlite-vec).
- Do not break existing outputSchema contracts for tools (existing clients rely on structuredContent shape).
- Must be language-agnostic by construction — no hardcoded natural-language phrase tables for any specific human language. Any recall-hint text must be built from a single English template/derivation, not per-locale strings.
- Artifact storage must not leak outside the vault root and must redact secrets the same way other Brain writers do.
- The preview seam must be opt-in-safe: tools whose output is always small should be unaffected; a tool with no declared budget must behave exactly as today.

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
