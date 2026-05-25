You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain v0.10.18 must ship a coherent set of 6-8 related features that add a temporal/time-as-a-first-class axis to the agent-owned memory layer, plus companion synthesis surfaces that use the new temporal axis.

The cluster bundles these kanban triage items (related upstream + article tasks):

- `t_c7d26a30` Bi-temporal fact tracking with validity windows and audit trail. Inspired by obsidian-second-brain v3.2.0/v4.0.0: each fact gets `from`/`until` (event time) and `transaction_time` (when the vault learned it), plus a source pointer. Preferences and signals currently have no validity-window columns.
- `t_2f668121` Temporal query routing (gbrain a19ee8b). NOTE for orchestrator: skip the intent-classifier half (text-based "is this a temporal query?" regex is language-specific and forbidden by project pref `language-agnostic-only`). Keep only the deterministic timeline-reader half.
- `t_c77864bc` Belief-evolution timeline per preference: walk Brain/log/*.jsonl + Brain/retired/ to assemble a chronological per-pref or per-topic timeline.
- `t_09a3c5c3` Stale-watch with configurable thresholds by entry kind (preferences, signals, log files, retired). Pure structural staleness based on mtime/timestamps, no NLP.
- `t_542984c2` Daily automated vault brief. Deterministic data shape (events grouped by kind, vault delta vs previous day, status transitions). The agent does the narrative externally; OSB ships the structured brief.
- `t_f27d6f09` Weekly vault synthesis. Same as daily but 7-day window with status-transition aggregation; deterministic counters only.
- (optional) `t_03752ca6` complexity-vs-activity ratio as an extension to discipline-report.

Hard constraints from the project owner:

- Language-agnostic by construction. No vocabulary lists, no stopword sets, no per-language regex tables, no English keyword sniffers. Detectors must use only typed events or structural sigils (ISO timestamps, kind enums, frontmatter keys).
- One named subsystem per release (precedent: v0.10.15 `page-meta/`+`maintenance/`, v0.10.16 `trust/`, v0.10.17 `link-graph/`). The new subsystem name should describe the temporal axis.
- Synthesis briefs are deterministic data shape only - no LLM call inside the helpers. The LLM-narrative side is the agent's job.
- Backwards compatible. Frontmatter additions must be additive optionals; existing preference / retired pages must stay byte-identical when not opted in.
- Companion synthesis surfaces (daily/weekly brief) MUST USE the new temporal layer. If they could be implemented without the temporal storage, they belong in a different release.

# Project context

- Project: Open Second Brain (https://github.com/itechmeat/open-second-brain).
- Language / runtime: TypeScript (strict), Bun runtime, ESM modules.
- Layered DAG per release: atoms (data-shape additions) → pure helpers (one named subsystem) → consumers (CLI verbs + MCP tools).

Recent commits on origin/main:

```
d0598af v0.10.17 - link graph surfaces (#33)
3b7dfe9 v0.10.16: trust and operator surfaces (#32)
d045ea1 chore: bump version to 0.10.15 (#31)
5755200 v0.10.15: vault care bundle (#30)
9d9636b feat: index fastpath, PEM/JWT redaction (v0.10.14) (#29)
```

Related files (existing structure the new subsystem must integrate with):

- `src/core/brain/log-jsonl.ts` — single read entry-point for Brain/log/<date>.jsonl. Already typed via `BrainLogEventKind`.
- `src/core/brain/log.ts` — JSONL writer; `appendLogEvent({eventType, ...})`; events include `signal-recorded`, `preference-promoted`, `preference-retired`, `evidence-applied`, `evidence-violated`, `evidence-outdated`, `signal-suppressed`, `dream`, `note`, `pin`, `unpin`, ...
- `src/core/brain/digest.ts` — emits per-window summary (since/until); has `RetiredRecord` and `PreferenceSummary`; reads retired/ folder via `readAllRetired`.
- `src/core/brain/dream.ts` — preference lifecycle; emits `DreamRunSummary` per pass; writes `unconfirmed_until` on signals, `retired_at` on retired entries.
- `src/core/brain/preference.ts` — current frontmatter shape: `status`, `created_at`, `confirmed_at`, `last_evidence_at`, `confidence`, ...
- `src/core/brain/retired/<id>.md` — retired-preference entries; frontmatter has `retired_at` + reason.
- `src/core/brain/policy.ts` — config loader; `_brain.yaml` with named blocks (e.g., `link_graph:`); `BRAIN_*_DEFAULTS` constants per block.
- `src/core/brain/backlinks.ts` — backlink index, can supply cross-pref refs for topic timeline.
- `src/mcp/brain-tools.ts` — full-scope MCP tool registry; tools register after `brain_context_pack`.
- `src/cli/brain.ts`, `src/cli/brain/verbs/*.ts` — CLI dispatch + per-verb handlers.

Conventions:

- One named subsystem per release at `src/core/brain/<name>/`.
- New atoms are additive optionals on existing types.
- Three-layer DAG: atoms → helpers → consumers.
- MCP writer scope is FROZEN at 4 tools (brain_feedback, brain_apply_evidence, brain_note, brain_context). New tools always go into the full scope.
- Pure helpers take a `vault: string` first argument; never read env directly.
- All test files under `tests/core/brain/<subsystem>/...` and `tests/mcp/...` and `tests/cli/...`.
- No `[Unreleased]` placeholder in CHANGELOG; new entries go under concrete version headers.

Constraints:

- Do NOT change existing public APIs (`BrainLogEntry`, `BacklinkRef`, `BrainConfig`); only add optional fields.
- Do NOT introduce LLM calls inside helpers; helpers produce deterministic data shapes only.
- Do NOT use vocabulary-based detectors anywhere; only typed-event matching, frontmatter-key matching, or timestamp comparisons.
- Do NOT regress existing 2260 tests.
- Do NOT add a new dependency unless absolutely required (zero-dep additions strongly preferred).
- The temporal frontmatter atoms must be writable by future releases (this release is a read + atom layer; bulk-write tooling can ship later).

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
