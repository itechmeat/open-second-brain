# MCP context economy - brainstorm variants (audit trail)

Primary consultant: Claude Code CLI (`claude -p`), exit 0, 3 parseable variants.
Fallback consultant (Codex): not invoked - primary succeeded with >= 2 variants.

## Consultant output (verbatim)

### Variant 1: Single-seam byte budget
- **Approach**: Add an optional `preview_chars` field to `ToolDefinition` and put all logic in `toolResult(tool, structured)`. After serializing, if the JSON string exceeds the tool's budget, write the full bytes to `Brain/.artifacts/<run-id>/<artifact_id>` (atomic write + standard redaction), and replace `content[0].text` with a small valid-JSON envelope `{preview: "<head slice>", artifact_id, full_chars}`. `structuredContent` is left fully intact, so no outputSchema contract changes; a sibling `brain_artifact_get` reads back the bytes. Unit 2's recall hint is a shared `deriveRecallHint(resultSet)` helper called inside `brain_search`/`brain_query`, returning one English-template string folded into the result object before serialization.
- **Trade-offs**:
  - Pro: Smallest possible footprint - one chokepoint, one new tool, one new field; everything else untouched.
  - Pro: Opt-in-safe by construction - budget only engages when text exceeds it, and structuredContent never changes shape.
  - Pro: Truncation is content-agnostic, so it works uniformly across all ~27 tools with zero per-tool code.
  - Con: The preview is a dumb head-slice of serialized JSON - semantically arbitrary (may cut mid-record), not a curated summary.
  - Con: Full payload still lives in `structuredContent`, so harnesses that inject structuredContent (not text) see no savings.
- **Complexity**: small
- **Risk**: low

### Variant 2: Declarative per-tool preview projection
- **Approach**: Same chokepoint mechanics, but `ToolDefinition` also carries an optional deterministic `previewProjection` - a pure spec (keep/drop fields, cap arrays to N, replace heavy arrays with counts) that produces a smaller structured object from the full one. When over budget, `toolResult` emits the projected object as the preview (still valid, schema-shaped data), archives the full object to the artifact, and stamps `artifact_id`/`full_chars`. The recall hint is itself expressed as a projection-friendly field so `brain_search`'s preview leads with "N confirmed / M signals, top rule X" while the full results defer to the artifact.
- **Trade-offs**:
  - Pro: Previews are meaningful and machine-valid - the agent sees the most useful slice (counts, top-K, the hint), not a truncated string.
  - Pro: Each tool declares its own intent; budget engagement is explicit opt-in per tool.
  - Con: Authoring a projection for each large tool spreads work across many definitions and adds per-tool tests.
  - Con: Projections must be kept consistent with `outputSchema` (preview must validate as a sub-shape), adding contract-maintenance surface.
  - Con: More moving parts than strictly needed for an MVP "bounded preview."
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Extracted artifact-store service + pluggable budget middleware
- **Approach**: Factor a dedicated artifact-store module (run-id lifecycle, TTL/on-shutdown cleanup, `ensureInsideVault` validation, redaction) consumed by both the write path and `brain_artifact_get`, and introduce a thin budget middleware in `buildToolTable` that wraps handler output before `toolResult` with a swappable truncation strategy (head-slice today, projection or structuredContent-trimming later behind a flag). The recall hint becomes one registered strategy/derivation in the same middleware pipeline rather than inline handler code.
- **Trade-offs**:
  - Pro: Cleanest separation of concerns and the most extensible - artifact lifecycle and truncation policy each evolve independently.
  - Pro: A single place to later add cursor pagination, structuredContent trimming, or per-scope policies.
  - Con: Largest surface area for an MVP; introduces a middleware abstraction the codebase doesn't currently have.
  - Con: Two seams (middleware + chokepoint) risk double-processing or ordering bugs versus the proven single `toolResult` seam.
  - Con: Over-engineered relative to the stated minimum viable shape.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: It matches the stated minimum viable shape exactly, exploits the single existing serialization chokepoint, and preserves every `structuredContent`/outputSchema contract by only trimming the context-flooding `content[0].text` - satisfying the "opt-in-safe" and "no broken contracts" constraints with the least code and the lowest risk. Variant 2's semantic previews and Variant 3's middleware are real future improvements, but the projection spec and artifact-store extraction can be layered onto Variant 1's seam later without rework, so paying for them now buys complexity the first release doesn't need. Unit 2's recall hint is thin enough to ride along identically under any variant, so it shouldn't drive the choice.

## Orchestrator decision

Accepted: Variant 1 (single-seam byte budget), with two project-context refinements that do not change the variant's shape:

1. **Apply the budget only on the MCP JSON-RPC path (`handleToolsCall`), not on the CLI bridge (`callTool`).** The budget exists to protect a calling agent's context window over MCP. The CLI is operator-facing and must keep printing full output. Splitting the seam this way keeps `toolResult` (used by the CLI bridge) returning the full payload, while the MCP dispatch path wraps over-budget results.

2. **The preview lives in `content[0].text` as a valid-JSON envelope whose head-slice is a string field** (`{preview_truncated, artifact_id, full_chars, bytes_preview}`), so the envelope is always parseable even when the slice cuts mid-record - addressing the consultant's first Con. `structuredContent` stays the full, schema-valid object, so programmatic consumers and `outputSchema` contracts are untouched - and the still-written artifact lets a text-only agent fetch the full bytes via `brain_artifact_get`. The consultant's second Con (structuredContent-injecting hosts see no savings) is accepted: the primary consumers (Claude Code, Hermes) inject `content` text, not `structuredContent`, so the flooding vector is the one we bound.
