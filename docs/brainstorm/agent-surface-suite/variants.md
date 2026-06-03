# Agent Surface Suite - brainstorm audit trail

Consultant: Claude Code (`claude -p`), single pass, 2026-06-03. Prompt and raw
output live in `cli-output/`. Three variants were requested for the epic as a
whole (eight units, two themes); the consultant also returned exactly one
recommendation.

## Variant 1: Two theme kernels (catalog kernel + session-scope kernel)

- **Approach**: Build exactly two shared modules. A catalog/scoring kernel
  emits uniform descriptor records (name, one-line desc, group/toolset, tags,
  checksum) over both MCP tools and `skills/` entries, plus one deterministic
  BM25 scorer; it feeds two-pass hydration, `list_skills`/`get_skill`, skill
  auto-attach, and the adaptive tool-surface selector. A session-scope kernel
  owns a session-id-keyed scope record with lifecycle hooks; it feeds
  role-filtered capture, handoff notes, per-session focus binding, and
  intention chains. The two kernels stay decoupled across the theme boundary.
- **Trade-offs**:
  - Pro: honors the "share kernels where natural" constraint with one kernel
    per theme - no eight disconnected features, no single god-module.
  - Pro: tool-surface work stays request-local (compatible with the
    static-per-process MCP server and the hidden-tool precedent); session
    state is isolated and fail-soft.
  - Pro: the two kernels are independently testable and parallelizable across
    the PR's eight units.
  - Con: tool descriptors vs skill descriptors must be reconciled into one
    schema, which is some up-front design tax.
  - Con: BM25 scorer is reused for two different inputs (turn-vs-tool,
    turn-vs-skill), risking subtle tuning divergence if not parameterized
    cleanly.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Unified per-session context spine

- **Approach**: Make a single `SessionContext` object the backbone for all
  eight units, keyed by session id and surfaced through the existing provider
  `system_prompt_block()` / `brain_context_pack`. Tool-surface profiles, skill
  auto-attach, focus, intention chain, capture filter, and handoff all read
  and write that one per-session state, so a turn's advertised tools, injected
  skills, and recalled memory are decided in one place.
- **Trade-offs**:
  - Pro: maximal coherence - focus, intention, skills, and tool surface all
    flow through one injection point with consistent token budgeting.
  - Pro: per-session binding (focus, intention) gets a natural home and clean
    auto-clear on session end.
  - Con: forces request-local, stateless Theme A work (which the static MCP
    server cannot vary per session anyway - no `listChanged`) into a
    session-stateful frame it does not fit; tool-surface adaptation would be
    misleadingly "session-bound."
  - Con: a central spine touched by all eight units is a merge-and-regression
    hotspot and contradicts the "everything off by default, bit-identical
    defaults" guarantee being easy to prove per-unit.
  - Con: highest blast radius if the shared object misbehaves.
- **Complexity**: large
- **Risk**: high

## Variant 3: Thin additive layers over existing surfaces

- **Approach**: Ship each unit as a minimal independent layer on what already
  exists - a `session_capture_roles` config key, `list_skills`/`get_skill`
  reading `skills/`, auto-attach as a new context-pack lane, the tool-surface
  selector as a dry-run/advisor first using the hidden-tool flag, handoff as a
  CLI+Stop-hook artifact, per-session focus as extra keys on
  `session-focus.json`, intention as a versioned sibling of `pinned.ts`. Share
  only two trivial utilities: a scoped-session-id resolver and one lexical
  scorer, used opportunistically rather than as mandatory kernels.
- **Trade-offs**:
  - Pro: lowest risk, fastest to land, cleanest match to house style
    (additive, fail-soft, off by default, easy per-unit defaults proof).
  - Pro: defers the riskiest piece (active per-turn tool filtering) behind a
    dry-run advisor, which the static server constraint favors anyway.
  - Con: weakest on the "avoid eight disconnected mini-features" constraint -
    sharing is incidental, so skill discovery could be implemented twice (once
    for `get_skill`, once for auto-attach).
  - Con: descriptor metadata and scoring logic risk duplication and drift
    across units.
- **Complexity**: small
- **Risk**: low

## Consultant recommendation

Variant 1. "It is the only option that directly satisfies the epic's explicit
'share kernels where natural' instruction - one skill/tool catalog+scorer, one
session-scope concept - without the over-coupling of Variant 2, which fights
the static-per-process MCP server and the off-by-default guarantee by forcing
request-local tool work into session state. Compared to Variant 3 it avoids
duplicating skill discovery and scoring across units while staying within the
same additive, fail-soft, deterministic constraints, and its two-kernel split
cleanly mirrors the two themes so the eight units remain independently
testable and parallelizable."

## Orchestrator decision

Variant 1, accepted as recommended (no override). Two refinements applied in
the design doc: (a) the descriptor checksum field is deferred - the static
server has no live-schema snapshot to verify against, so the checksum carries
no information yet; (b) Variant 3's "fail open on unknown profile" idea is
folded into the profile selector, since the upstream Tool Slimmer contract
fails open on selector errors and that matches the project's fail-soft
runtime convention.
