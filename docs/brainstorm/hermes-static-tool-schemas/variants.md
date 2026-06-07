# Variants audit trail - hermes-static-tool-schemas

Consultant: Claude Code CLI (`claude -p`), single pass, 2026-06-07.
Raw output: `cli-output/claude.md`. Prompt: `cli-output/prompt.md`.
Fallback consultant (Codex) not invoked - primary returned 3 parseable variants.

## Variant 1: Hand-authored static schema literals

- **Approach**: Embed the 10 MEMORY_TOOLS schemas (name, description, inputSchema) as a
  Python dict literal in a new module (e.g. `plugins/hermes/_schemas.py`).
  `get_tool_schemas()` returns these when `self._bridge is None`, and switches to the
  live-filtered list once the bridge is up. The anti-drift unittest spawns `o2b mcp`,
  fetches `tools/list`, and asserts the static literals match the live MEMORY_TOOLS
  subset by name and inputSchema.
- **Trade-offs**:
  - Pro: stdlib-only, zero import-time I/O, no Bun needed for the import path; the
    schemas are readable and reviewable in-tree.
  - Pro: trivially fail-soft - the static path can never block or throw at gateway boot.
  - Con: a second hand-maintained copy of schema text that can drift; relies entirely
    on the anti-drift test (skippable when Bun absent) to catch divergence.
  - Con: full inputSchema bodies are verbose to hand-transcribe and review.
- **Complexity**: small
- **Risk**: low

## Variant 2: Vendored JSON snapshot generated from the TS core

- **Approach**: Add a generator (a script / `bun`-backed step) that calls `o2b mcp`
  `tools/list`, filters to MEMORY_TOOLS, and writes a committed JSON artifact under
  `plugins/hermes/`. `get_tool_schemas()` loads this JSON (cached at import) when the
  bridge is not started. The anti-drift test regenerates into a temp file and asserts
  byte/structure equality with the committed snapshot.
- **Trade-offs**:
  - Pro: single authored source (TS core); the Python copy is mechanically derived, so
    drift is a regeneration step rather than manual editing.
  - Pro: the snapshot doubles as a documented contract artifact; full inputSchemas are
    exact, not transcribed.
  - Con: introduces a build/codegen step and a generated file that must be regenerated
    and committed on every schema change - easy to forget, and CI must enforce freshness.
  - Con: adds file-read I/O at import and a packaging concern (the JSON must ship with
    the shim).
- **Complexity**: medium
- **Risk**: medium

## Variant 3: Lazy eager-bridge fetch at schema-request time

- **Approach**: On the first `get_tool_schemas()` call while `self._bridge is None`,
  attempt a short, time-boxed synchronous bridge start to fetch live schemas, caching
  the result; if the start fails or times out, fall back to a minimal static
  name/description stub. No full static schema copy is maintained as the primary source.
- **Trade-offs**:
  - Pro: schemas always come from the live TS core when reachable - essentially no
    drift surface.
  - Pro: removes the need for a committed schema duplicate.
  - Con: risks the fail-soft contract - a synchronous start during gateway registration
    can block boot or surface Bun-unavailability into a hot path; needs careful
    timeout/guard handling.
  - Con: the fallback stub still ships incomplete inputSchemas, so the "N >= 1 with
    real schemas" guarantee degrades exactly when Bun is missing; harder to test
    deterministically with FakeBrainBridge alone.
- **Complexity**: medium
- **Risk**: high

## Consultant recommendation

Variant 1. "It is the smallest change that satisfies every acceptance criterion while
honoring the hard constraints - stdlib-only, fail-soft (the static path cannot block or
throw at boot), unchanged public signatures, and MEMORY_TOOLS as the single subset
source. The drift risk that distinguishes it from Variant 2 is precisely what the
required anti-drift test against live `o2b mcp` neutralizes, without paying Variant 2's
codegen/regeneration ceremony or Variant 3's fail-soft hazard during gateway
registration."

## Orchestrator decision

Agree with the consultant: **Variant 1**. Two project-context refinements on top:

1. The initial literals are transcribed mechanically from the live `tools/list`
   (verified 2026-06-07: all 10 MEMORY_TOOLS present on the 77-tool server), so the
   "verbose to hand-transcribe" con is paid once and exactly.
2. The static fallback also covers a failed live listing (bridge present but
   `list_tools()` raises), not only `bridge is None` - this keeps the post-init schema
   surface consistent with the registration-time routing table in every failure mode.

Variant 3 was rejected outright: starting the bridge inside `get_tool_schemas()` runs
during `add_provider()` at gateway boot, which directly violates the provider's
fail-soft contract. Variant 2's codegen ceremony buys exactness we already get from
Variant 1 plus the anti-drift test, at a higher maintenance cost.
