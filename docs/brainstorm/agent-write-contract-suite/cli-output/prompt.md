You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One PR ships four related kanban tasks as a single "Agent Write Contract Suite". Theme: how external agents write into and deliberate with the Brain without an LLM living inside the core.

## Task 1 (t_bc36a8a2) - Provider-agnostic Brain write-session protocol with correction loop

External agents need to propose structured Brain artifacts (schema-pack pages, handoffs, evidence summaries, curated notes). Today validation can reject malformed output, but there is no agent-facing lifecycle. Add a write-session protocol: a caller opens a session and receives a JSON envelope with `status`, `session_id`, `step`, generation `prompt`, schema hints; the caller produces the artifact, submits it back; OSB validates locally and returns either `done`, a `needs-correction` step with machine-readable errors plus a compact correction prompt, `needs-review` for operator-gated targets, or terminal `failed` after a retry cap. Sessions live in a store with TTL and retry count. Path collisions never overwrite without explicit overwrite/merge intent (existing-content metadata is returned). Completed sessions land in an audit log. Core Brain transitions remain deterministic; OSB never calls an LLM for this protocol.

## Task 2 (t_53f9f67f) - Pluggable backend boundary for memory rendering

OSB memory rendering is hardcoded to Claude via src/core/brain/claude-memory-render.ts (renderPreferenceFromMemory and the claude-memory-* parser/plan/manifest flow). Introduce a backend protocol boundary so brain operations that today assume Claude's memory format can support alternative agent runtimes without modifying core code. Upstream pattern (memclaw v1.2.0/v2.0.0): a pluggable AgentBackend protocol, each backend a self-contained module, selection by configuration, no changes to core/tools/handlers when adding a backend.

## Task 3 (t_936a1a61) - Cross-agent shared memory namespace

Opt-in cross-agent shared brain: a configuration key makes explicit remember-writes mirror to a shared namespace so facts learned by one agent become visible to other agents sharing that namespace. Per-agent attribution via source metadata. Mirror failures are swallowed - they must never break the primary write. Default off = zero behavior change. OSB context: multi-vault profiles exist (pointer-based, no symlinks, Syncthing-friendly), source-agent metadata exists.

## Task 4 (t_0cc6fdff) - Multi-persona decision panel

Structured multi-persona deliberation on a decision topic: distinct analytical lenses (technical, strategic, risk, user-experience) with synthesis into a structured output. OSB constraint: no LLM inside the core, so the panel must be provider-agnostic - plausible shape: persona definitions as markdown in Brain/personas/, and the panel runs AS a write-session (Task 1 protocol) where OSB returns per-persona prompts and the calling agent supplies per-persona answers plus a synthesis, which OSB validates and commits as a structured decision note.

# Project context

Open Second Brain - TypeScript on Bun, plus a thin Python provider layer. Markdown/Obsidian vault is the storage; an MCP server (65 advertised tools) and an `o2b` CLI are the surfaces. v0.40.0 just shipped (Project History Suite).

Recent commits:
7733f20 feat: Project History Suite - git history memory, ADR mining, architecture notes, query telemetry (#71)
8e8c0bc feat: Memory Observability Suite - versioned continuity contract, lazy telemetry, ATOF/ATIF export, recall benchmark (#70)
eb56c9f feat: Workspace Insight Suite - project pointers, cross-vault recall, trigger queue, proactive synthesis (#69)
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)

Related files:
- src/core/brain/claude-memory-render.ts (renderPreferenceFromMemory, slugifyMemoryName), claude-memory-parser.ts, claude-memory-plan.ts, claude-memory-manifest.ts, claude-memory-paths.ts
- src/core/brain/signal.ts (writeSignal -> Brain/inbox), note.ts + log.ts (appendLogEvent -> Brain/log/<date>.md + JSONL sidecar) - the single write chokepoints
- src/core/brain/preference-txn.ts (writePreferenceTxn: lockfile + expectation gates, the preference write chokepoint)
- src/core/brain/schema-pack.ts (loadSchemaPack from Brain/_brain.yaml), schema-contracts.ts (BrainSchemaContract, SchemaValidationResult {ok, errors[]})
- src/core/brain/payload-registry.ts (content-addressed blob store under Brain/.payloads/), continuity/store.ts (append-only JSONL shards, idempotent)
- src/core/config.ts (discoverConfig, parseSimpleYaml - dependency-free key:value parser, resolveVault), src/core/brain/portability/profiles.ts (multi-vault profiles.json, pointer-based activation)
- src/mcp/tools.ts (ToolDefinition, buildToolTable with scopes full/writer/catalog), src/mcp/brain-tools.ts
- src/cli/brain.ts + src/cli/brain/verbs/* + help-text.ts + command-manifest.ts (CLI verb pattern)

Conventions:
- Deterministic core: no LLM call inside OSB, ever. Agents do generation; OSB validates and commits.
- All vault writes atomic (temp + rename), append-only JSONL where possible, Syncthing-friendly (no symlinks, idempotent re-runs).
- On-disk JSON uses snake_case fields; TypeScript uses camelCase.
- Fail-soft on read (malformed lines skipped), fail-closed on write (validation before any byte lands).
- bun:test, fixtures in tmp vaults; every feature gets CLI + (where agent-facing) MCP surface + tests.
- MCP contract is additive-only; currently 65 advertised tools, growth must be deliberate.

Constraints:
- No new external dependencies (stdlib + Bun only).
- Do not change existing public APIs or record shapes; additive changes only.
- Sessions/state must survive process restarts (file-backed, not in-memory).
- Mirror/shared-namespace writes must be fail-soft; write-session commits must be fail-closed.
- The decision panel must not require any new LLM plumbing in OSB.

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
