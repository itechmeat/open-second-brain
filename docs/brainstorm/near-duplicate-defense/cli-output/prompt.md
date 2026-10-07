You are brainstorming architectural variants for an Open Second Brain release wave. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic "Near-Duplicate Defense Across the Fact Lifecycle" for Open Second Brain. Four kanban cards ship as one release (about 40-55 changed files):

1. t_acab97de - Surface near-duplicate facts when forgetting, with accept-gated rewording proposals.
2. t_fda66477 - Hint an existing similar page when a write creates a near-duplicate.
3. t_b915b9cc - Derivation rules that ground dates, skip chit-chat, and dedupe extracted facts.
4. t_72e93e18 - Stage-level timing breakdown within the memory write path.

Spine: one near-duplicate candidate lookup built on the existing similarity machinery, wired into every path a fact enters or leaves the vault, plus content-free per-stage timings so the added cost is measured.

# Verified premise reports (read all four files before answering)

- <wave-cache>/design/premise-t_acab97de.md
- <wave-cache>/design/premise-t_fda66477.md
- <wave-cache>/design/premise-t_b915b9cc.md
- <wave-cache>/design/premise-t_72e93e18.md

Key verified corrections to respect:
- The hygiene apply "forget" action exists but NO detector ever proposes it, so a sibling scan hooked into the apply path would never fire; retirement actually happens through merge/archive/recompile today.
- A Jaccard-0.8 same-directory near-duplicate hint has shipped in write receipts since v1.64.0; the card's residual value is cross-cutting similarity (embeddings, cross-directory, facts not just pages) and better surfacing, not the hint itself.
- The extract lane mines taste rules, not facts; date grounding needs the turn timestamp carried into MinedTurn plus an ISO-instruction, reusing the dream pass temporal extraction; no natural-language date parser (kernel language-independence rule).
- Lifecycle hooks already run capture detached from the agent turn; stage timings on mcp_route_latency cover only MCP tools/call and the CLI bridge, and the card's stage names must be remapped to what the write tools actually do.

# Constraints

- Engineering rules in CLAUDE.md at the repo root (read it): SOLID, KISS, DRY; no silent fallbacks; no hardcoded natural-language phrases; errors surface by name.
- Nothing model-driven enters the kernel: model-invoking steps live behind the existing step registries.
- New similarity spend must respect the embedding spend gates from v1.72.0/v1.73.0; reuse already-paid embeddings where possible.
- Features that propose retire/reword must be accept-gated and off by default (the upstream project measured wrong-merge churn with a default-on write hint).
- Windows CI must stay green (no POSIX-only assumptions in new tests); test runs use a throwaway HOME.

# Deliverable

3-5 named architectural variants. For each: the approach in two or three sentences, pros, cons, and what it cuts or defers. End with one recommended variant and why in at most five sentences. Consider at least: where the shared near-duplicate lookup lives and what it returns; how the forget-side scan reaches real retirements; whether the existing write-receipt hint is extended or replaced; how stage timings are named and attached without bloating every response.
