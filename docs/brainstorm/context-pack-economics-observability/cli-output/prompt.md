# Consultant prompt — context-pack memory-economics & observability

You are a senior backend architect. Produce architectural variants for a single
shippable release of **Open Second Brain (o2b)**. Read the context below
carefully; every design MUST respect o2b's hard invariants.

## Output contract (MANDATORY)

Output EXACTLY three variant sections then ONE recommendation. No code. Nothing
outside these sections. Each variant:

```
### Variant N — <short name>
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
Complexity: small | medium | large
Risk: low | medium | high
```

Then exactly:

```
### Recommended: Variant N
<rationale, 3-5 sentences>
```

Do not add an introduction, summary, or closing.

## Project

- Name: `open-second-brain` (o2b), v1.23.0.
- Language/runtime: TypeScript, ESM, runs on Bun + Node. `type: module`.
- What it is: an Obsidian-native memory layer for AI agents. Plain Markdown in a
  vault (`Brain/` directory). Deterministic CLI + MCP tools. **The kernel calls
  no LLM** — this is a core, load-bearing invariant.
- Conventions (hard): deterministic, byte-identical-when-off for any new field
  or switch; pure functions do the work, IO shells stay thin; everything is
  language-agnostic (no English wordlists); additive optional fields absent by
  default; privacy-preserving telemetry (no raw prompts, recalled text, or
  secrets); persistence via the continuity store (append-only, month-sharded
  JSONL under `<vault>/Brain/logs/continuity/`, reloaded on startup); config
  flags are explicit opt-in.

## The release problem

Releases v1.18–v1.23 repeatedly improved recall *precision* (coverage, rerank,
dedup, provenance) with **zero gain in measuring the value that precision
delivers**. o2b can enforce token/char budgets and record recall/gate telemetry,
but it cannot answer: "how many prompt tokens did the memory layer keep out of
(or add to) the agent call?", "which MCP route is slow?", "is the active-memory
body near its budget before it silently truncates?", or "did this recall sample
lead to a first-pass success or force repair/retries?" This release closes that
gap with five deterministic, independently-shippable signals that REUSE existing
budget/telemetry machinery.

## In-scope cards (ship together, driven one-at-a-time on one branch)

### Card 1 — `t_affa3bd9` (p4): value-per-token density in context-pack
Today `src/core/brain/context-pack.ts` orders candidates by:
1. tier ascending importance (core → supporting → peripheral);
2. created_at desc;
3. id asc.
Then fills the token budget greedily; overflow goes to `pagesSkipped`.
There is NO per-item density/impact score, so as the vault grows the budget fills
with recent-but-low-value entries and skips denser high-signal ones.
Requirement: a computed heuristic density score (signal markers / links /
evidence weight per estimated token) — NOT an LLM judgement. Tier can remain a
coarse gate; density ranks within/across tier. Default-off switch → byte-identical
ordering when disabled. `estimateTokens` lives in `src/core/brain/text/tokenizer.ts`
(`ceil(utf8_bytes/4)`).

### Card 2 — `t_6c9a3e5c` (p4): route-level latency metrics for MCP tools
o2b records some latency for generation reports and memory benchmarks, but not
per-MCP-route. Operators need to see which tool blocks a turn by endpoint.
Requirement: a latency wrapper around the tool registry/handlers
(`src/mcp/tools.ts` `ToolDefinition.handler`, assembled in `buildToolTable`)
recording tool name, duration, status, and optionally argument-shape hashes —
never raw prompt or note content. Persist via the continuity store. Surface as a
reader (CLI/MCP summary) consistent with existing `recall-telemetry` /
`generation-report` readers.

### Card 3 — `t_a8926bd0` (p3): durable token-impact + context-pack-quality ledger
A durable, bounded, privacy-preserving ledger measuring the prompt-economics
impact of the memory/context layer: tokenizer-exact prompt-token deltas per
context pack, persisted, reloaded on startup, with honest "fallback estimation"
labeling when a tokenizer is unavailable. A second ledger separates EXACT
prompt-token savings from MODELED/counterfactual inference-avoidance
(retries/repairs avoided), with an `/outcome`-style endpoint to post outcomes and
calibrate the modeled estimate. Store no raw prompts or recalled text. Reuse the
continuity store. Distinct from Card 1 (ranking) and Card 5 (outcome loop) — this
is the passive measurement/telemetry layer.

### Card 4 — `t_dfda8adb` (p3): proactive active-memory budget-pressure watermark
Today `src/core/brain/active-budget.ts` truncates the rendered `active.md`
injection REACTIVELY at render time, dropping sections in priority order
(retired → quarantine → most-applied; confirmed survives) and printing
`ACTIVE_TRUNCATION_NOTICE`. Nothing reports "active.md is at 85% of budget" or
names stale entries you could archive — content silently disappears.
Requirement: a proactive watermark probe (fill-rate metric + ranked eviction
CANDIDATES, reusing the existing `SECTION_PRIORITIES` model). Deterministic
(byte/section counting, no LLM). "Empty output = healthy" keeps it quiet on
healthy vaults. Candidates are SUGGESTIONS, never auto-deleted. Use a distinct
term (e.g. "active budget pressure") — do NOT reuse the unrelated `WatermarkState`
cursor in `skill-proposals.ts`. Surface through `doctor.ts` / hygiene.

### Card 5 — `t_f2140bae` (p2): agent-operable context-pack outcome loop
Layered on Card 3's ledger: the agent carries the latest recall/context-pack
quality-sample id through its session as bounded local state, then on completion
posts a compact outcome row — first-pass-success, repair-required, retry-count,
follow-up-token, provider-token counters. Three token signals kept strictly
separate: exact prompt-token savings (tokenizer-aware delta), modeled inference
avoidance (confidence-banded counterfactual), observed provider usage
(provider-reported). Compact counters only; never raw text/secrets; agent omits a
field rather than inventing it. Best sequenced AFTER Card 3 lands. Nearest
existing surface is Brain's `brain_apply_evidence` outcome field
(preference-level, not recall/context-pack-level).

## Cross-cutting constraints

- The five cards are independent modules EXCEPT Card 5 depends on Card 3's
  ledger. They reuse: the continuity store (Cards 2, 3, 5), `estimateTokens`
  (Cards 1, 3), the tool registry (Card 2), `SECTION_PRIORITIES` (Card 4),
  `emitGatedTelemetry`/fail-open emission (all).
- Each card's off/default branch must be provably byte-identical to today.
- Recommend a drive order (one-at-a-time on the shared branch) that resolves file
  collisions. The only structural dependency is Card 3 → Card 5.
- No web dashboard (o2b has none). No shared/hosted control plane. No LLM in any
  kernel logic.

## Recent git history (for convention grounding)

```
67bcb71c refactor: DRY and decomposition (Phases 0-2) (#121)
b9bbcb16 feat(brain): semantic entity dedup and cross-encoder rerank (1.23.0) (#120)
b8d709ee fix: keep full MCP status output and normalize codegraph paths (#116)
a98bed1d feat(brain): retrieval precision and quality loop (v1.22.0) (#118)
42816058 feat(brain): integrity & safety hardening suite (1.21.0) (#115)
33b4fba5 feat: recall precision, coverage, and provenance hardening (v1.18.0) (#110)
da2e3ccd feat: memory subsystem alignment - honest pinned budgets, atomic batch writes (v1.16.0) (#107)
```

Now produce the three variants and the single recommendation.
