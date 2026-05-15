# Brain Post-v0.9 Roadmap

Status: living document
Target: items deferred from v0.9.0 (see `2026-05-15-brain-observing-memory.md`)

## Purpose

This document tracks Brain features that were deferred beyond the v0.9.0 release. It is the canonical place to look when asking "what's next for Brain?" and the canonical place to add an item that doesn't fit in the v0.9 scope.

The document is **trigger-based**, not schedule-based. Each item has an explicit data-driven or dependency-driven condition under which it should be pulled forward into a real plan. Items do not have calendar deadlines.

## Authoring rules

- **IDs are immutable.** `BRAIN-FUT-001` is `001` forever. If an item is removed, retired, or superseded, its ID is not reused. Cross-references (commits, PRs, other docs) keep working.
- **Triggers are observable.** A trigger must be checkable by reading `Brain/log/`, `Brain/preferences/`, runtime telemetry, or an explicit user/agent request. "Feels stable" does not qualify.
- **No calendar dates.** Phrases like "in Q3", "after 2 weeks", "by end of month" are forbidden. Dependencies on releases (`after v0.9.1 ships`) and on data conditions (`after ≥50 apply-evidence entries accumulate`) are the only valid time references.
- **One item, one motivation.** Each item answers a specific observed or anticipated need; if the need isn't articulated, the item doesn't belong here.
- **Move out, don't grow in place.** When work on an item begins, create a separate `docs/plans/<topic>.md` design doc (following the v0.9 plan structure) and delete the entry here. The ID stays referenced by the new plan's title or frontmatter.

## Index

| ID | Title | Category |
|---|---|---|
| [BRAIN-FUT-001](#brain-fut-001--workflow-auto-detection) | Workflow auto-detection | Engine |
| [BRAIN-FUT-002](#brain-fut-002--cross-topic-contradiction-detection) | Cross-topic contradiction detection | Engine |
| [BRAIN-FUT-003](#brain-fut-003--soft-stop-hook-reminder-for-brain_feedback) | Soft Stop-hook reminder for `brain_feedback` | Capture |
| [BRAIN-FUT-004](#brain-fut-004--external-research-as-signal-source) | External research as signal source | Capture |
| [BRAIN-FUT-005](#brain-fut-005--portable-subgraph-export) | Portable subgraph export | Surface |
| [BRAIN-FUT-006](#brain-fut-006--active-preference-injection-via-per-turn-hook) | Active-preference injection via per-turn hook | Surface |
| [BRAIN-FUT-007](#brain-fut-007--openclaw-native-js-parity-for-brain-tools) | OpenClaw native JS parity for Brain tools | Integration |
| [BRAIN-FUT-008](#brain-fut-008--pay-memory--brain-bridge) | Pay Memory ↔ Brain bridge | Integration |
| [BRAIN-FUT-009](#brain-fut-009--hard-removal-of-deprecated-legacy-write-paths) | Hard removal of deprecated legacy write paths | Lifecycle |
| [BRAIN-FUT-010](#brain-fut-010--high-confidence-preference-codification-into-brain-memory-skill) | High-confidence preference codification into `brain-memory` skill | Lifecycle |

## Engine

### BRAIN-FUT-001 — Workflow auto-detection

**Trigger to pull forward:**
- `Brain/log/` contains ≥50 `apply-evidence` entries spread across ≥30 distinct artifacts, AND
- A manual or scripted scan reveals at least 3 recognisable repeated sub-sequences of length ≥3 in the log, AND
- A user or another agent has asked at least once, in a recorded interaction, "can you save this as a routine / workflow?"

**Dependencies:** v0.9 in productive use long enough to satisfy the data conditions above. No code dependencies on other roadmap items.

**Scope sketch:**
- New module `src/core/brain/workflow.ts` — deterministic sequence detector (no embeddings, no LLM).
- New directory `Brain/workflows/` with a documented frontmatter schema.
- `dream` algorithm gains a step-group: detect, cluster by structural similarity, emit candidate workflow notes analogous to unconfirmed preferences.
- CLI verbs `o2b brain workflows list / suggest / approve <id>`.

**Why deferred:** the clustering thresholds and sequence-similarity metric cannot be designed sensibly without real `Brain/log/` data. Picking thresholds on hypothetical traces produces algorithms that fire on noise or never fire at all.

### BRAIN-FUT-002 — Cross-topic contradiction detection

**Trigger to pull forward:**
- At least 2 user-reported cases where two confirmed preferences in different topics produced operationally contradictory guidance, AND
- The same-topic rebuttal logic shipped in v0.9 has been observed to produce a low false-positive rate (no spurious retires under normal use).

**Dependencies:** v0.9 same-topic rebuttal flow stable; ideally also BRAIN-FUT-006 (active-preference injection), because contradictions are easier to surface when the agent is actively applying preferences.

**Scope sketch:**
- Augment `o2b brain doctor` (and `dream`) with a check that compares pairs of confirmed preferences using a deterministic rule set: shared `applies_to` scope plus opposite-direction principle markers.
- Surface candidate contradictions in `digest` under a new section.
- No automatic retire action; flag only. Resolution is a human or agent decision.

**Why deferred:** the rule set requires real examples of cross-topic contradictions to be useful. Designing rules on hypotheticals produces brittle heuristics.

## Capture

### BRAIN-FUT-003 — Soft Stop-hook reminder for `brain_feedback`

**Trigger to pull forward:**
- Multi-session observation that agents systematically miss preference signals in conversation (the user said "don't do X" but no `brain_feedback` was recorded), AND
- The miss rate is high enough that the cost of a soft reminder is justified by the catch rate.

**Dependencies:** v0.9 ships; `brain-memory` skill loaded across runtimes; `Brain/log/` has enough sessions to estimate the miss rate.

**Scope sketch:**
- Extend `hooks/hooks.json` Stop hook with a heuristic: if the latest turn contains preference-marker phrases (negations, explicit corrections, "use X instead", "stop doing Y") AND no `brain_feedback` MCP call happened in the turn, emit a soft reminder. Never blocks the Stop.

**Why deferred:** the phrases that mark preferences cleanly are not knowable in advance. Without observation, the heuristic is either too aggressive (false positives, agent annoyance) or too conservative (no real catch). Wait for real misses, then tune.

### BRAIN-FUT-004 — External research as signal source

**Trigger to pull forward:**
- User actively wants community/shared preferences from external sources (research papers, blog posts, agent-best-practices digests), AND
- A specific incoming source is identified (a URL feed, a curated bundle, a peer's exported subgraph).

**Dependencies:** BRAIN-FUT-005 (portable subgraph export and import format). Without it, no external signals can land in Brain with proper attribution.

**Scope sketch:**
- New `source_type: external` on signals.
- Trust-tier model: external signals do not contribute to the `candidate_threshold` count by themselves; they must be co-signed by at least one local signal of the same direction before promotion.
- Source pinning: each external signal references its origin URL/document with a checksum.

**Why deferred:** no real demand. v0.9 produces only local preferences. External-source ingestion is meaningful once a portable format exists and a use case has materialised.

## Surface

### BRAIN-FUT-005 — Portable subgraph export

**Trigger to pull forward:** an actual import target exists — a second vault to merge into, a team-shared bundle to broadcast, or an external system that consumes preferences.

**Dependencies:** v0.9 stable.

**Scope sketch:**
- `o2b brain export-profile` extracts a self-contained Markdown tree of `preferences/` (filtered: `status: confirmed`, optionally `pinned: true` only) plus their origin `evidenced_by` signals and any `supersedes` / `applies_to` edges.
- Output format: wikilinks rewritten to be relative within the bundle; frontmatter `id` preserved.
- Companion `o2b brain import-profile <bundle>` validates the schema, merges into the local Brain, and produces a conflict report.

**Why deferred:** without a real import target, the export "lands in the void" and we cannot validate the schema against actual use. Premature design of a cross-vault format produces something that won't fit real consumers.

### BRAIN-FUT-006 — Active-preference injection via per-turn hook

**Trigger to pull forward:**
- ≥10 confirmed preferences in `Brain/preferences/`, AND
- Observed cases where the agent did not apply a relevant active preference in a task despite the `brain-memory` skill being loaded.

**Dependencies:** v0.9 ships. Reuses existing Hermes `pre_llm_call` channel, Claude Code system-prompt prepend, and Codex pre-message hook.

**Scope sketch:**
- A shared module (per-runtime plugin, e.g. `~/.hermes/plugins/brain-preference-injector/`) reads `Brain/preferences/` filtered to `status: confirmed` and to scopes matching the current task topic; injects a compact summary into the per-turn system prompt.
- Hard token budget on the injection (e.g. 500 tokens) to avoid context-window bloat.
- Pinned preferences ordered first; high-confidence next; remainder may be elided if over budget.

**Why deferred:** with zero confirmed preferences the injection is empty. Even with a few, the noise-to-signal ratio is unfavourable. The trigger waits until the injection actually carries useful content.

## Integration

### BRAIN-FUT-007 — OpenClaw native JS parity for Brain tools

**Trigger to pull forward:** v0.9 has shipped and is actively used in at least one runtime; the OpenClaw runtime is part of the user's working set (i.e., real demand exists).

**Dependencies:** v0.9 stable.

**Scope sketch:**
- Mirror all 6 MCP `brain_*` tools as pure JavaScript in `openclaw/brain.js`.
- No subprocess (OpenClaw security scanner requirement).
- Reuse the pure-JS frontmatter parser already in `openclaw/vault.js`.
- Atomic-write parity using `node:fs/promises`.

**Why deferred:** dual TS+JS maintenance is real ongoing cost. Wait until v0.9 is genuinely used; if OpenClaw runtime is not adopted, parity may never need to ship.

### BRAIN-FUT-008 — Pay Memory ↔ Brain bridge

**Trigger to pull forward:** at least one paid action recorded by Pay Memory has touched, or would have benefited from, a budget-related preference (e.g., "avoid image generation above $0.05 for blog drafts").

**Dependencies:** v0.9 ships. Pay Memory continues to function unchanged.

**Scope sketch:**
- After a paid call lands and a Pay Memory receipt is written, an opt-in flag in Pay Memory config triggers emission of a `brain_feedback` signal with `scope: paid-action` and the cost embedded in the principle context.
- Over time, `dream` surfaces preferences like "avoid paysponge/fal above $X for media-generation" automatically.
- No coupling: Pay Memory does not require Brain; Brain does not require Pay Memory. The bridge is fully opt-in.

**Why deferred:** the bridge is cheap to implement but only valuable if Pay Memory is in active use. v0.9 ships Brain independent of payments; the bridge is a small follow-up.

## Lifecycle

### BRAIN-FUT-009 — Hard removal of deprecated legacy write paths

**Trigger to pull forward:**
- Brain has been in productive use for a sustained activity volume in `Brain/log/`, AND
- No agent or user has called the legacy `event_log_append` or `second_brain_capture` MCP tools in that volume (verified by absence of corresponding handler invocations in any session telemetry), AND
- No CHANGELOG entry or design doc references the legacy paths as still required.

**Dependencies:** v0.9 + the soft deprecation in v0.9.x must be stable.

**Scope sketch:**
- Remove `src/core/event-log.ts` writer functions (keep readers if still referenced by `second_brain_query`).
- Remove `src/mcp/handlers/event_log_append.ts` and `src/mcp/handlers/second_brain_capture.ts`.
- Remove CLI verbs `o2b append-event`, `vault-log` symlink, and the legacy AI Wiki bootstrap inside `o2b init`.
- Remove `docs/legacy-skills/` directory.
- Update CHANGELOG and bump to a new minor version (the removal is a public-API change).

**Why deferred:** soft deprecation in v0.9 leaves the code intact precisely so we can revisit if real usage shows the deprecation was premature. Wait for affirmative evidence that the legacy paths are truly unused before deleting.

### BRAIN-FUT-010 — High-confidence preference codification into `brain-memory` skill

**Trigger to pull forward:**
- ≥5 confirmed preferences with `confidence: high` and `applied_count` ≥ 20, AND
- BRAIN-FUT-006 has shipped and produced observable token-cost data for the per-turn injection, AND
- That cost is non-trivial relative to per-task budgets.

**Dependencies:** BRAIN-FUT-006.

**Scope sketch:**
- A semi-manual operation: `o2b brain skill-codify` selects the top-N most-applied high-confidence preferences and regenerates `skills/brain-memory/SKILL.md` body to include them as fixed agent knowledge.
- This converts "live preferences" into "permanent skill content", aligning with the "fat skill, thin harness" pattern. Reduces per-turn injection cost.
- The original preferences stay in Brain (now redundant with the skill, but kept as the audit trail and the source of truth if the skill is regenerated).

**Why deferred:** speculative. Requires BRAIN-FUT-006 first to have real cost data; without it, the codification is solving a non-problem.

## Removed / superseded

(none yet)

When an item is dropped because the underlying need disappeared or the design was fundamentally rethought, add it here with a one-line note explaining why, and keep its ID retired. Example shape:

```text
- **BRAIN-FUT-NNN** — Title. Removed because <reason>. See <link to discussion or replacement plan>.
```

## References

- v0.9.0 design doc: `docs/plans/2026-05-15-brain-observing-memory.md`. The starting point this roadmap defers items from.
- Prior plans for shape reference: `docs/plans/2026-05-06-cli-foundation.md`, `docs/plans/2026-05-10-pay-memory.md`. Useful when an item moves out into its own design doc.
