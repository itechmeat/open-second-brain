You are a senior backend architect advising on a brainstorm for the
**Open Second Brain** project. Read the full brief below, then produce
exactly THREE distinct architectural variants and exactly ONE
recommendation. No code. Nothing outside the requested sections.

================================================================
OUTPUT FORMAT (strict)
================================================================

Produce this structure and ONLY this structure:

## Variant 1: <short name>
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
- <bullet>
Complexity: small|medium|large
Risk: low|medium|high

## Variant 2: <short name>
Approach: ...
Trade-offs: ...
Complexity: ...
Risk: ...

## Variant 3: <short name>
Approach: ...
Trade-offs: ...
Complexity: ...
Risk: ...

## Recommended: Variant N
Rationale: <3-5 sentences>

The three variants must be genuinely distinct architectural shapes
(not three flavours of the same idea). Each must cover BOTH in-scope
cards as a single coherent release (the release ships both together
on one feature branch).

================================================================
PROJECT CONTEXT
================================================================

- Project: Open Second Brain (https://github.com/itechmeat/open-second-brain)
- Language/runtime: TypeScript, runs on the Bun runtime. ESM modules.
  Package manager: bun. Linter: oxlint. Formatter: oxfmt. Tests: `bun test`
  via `scripts/test`. Typecheck: `tsc --noEmit`.
- Current version: 1.12.0.
- Distribution: a CLI (`o2b`) and an MCP server consumed by AI agents
  (Hermes Agent, Claude Code, Codex, Cursor, opencode, Grok Build, and
  others). The agent is the LLM; Open Second Brain is the deterministic
  memory/coordination layer.

THE DOMINANT ARCHITECTURAL INVARIANT (read carefully):

  The Open Second Brain kernel NEVER calls an LLM. The calling agent
  owns all generation. Open Second Brain owns sequencing, deterministic
  computation, validation, and the atomic commit. This invariant is
  load-bearing and intentional; the whole safety model rests on it.

This means the two in-scope cards (which originate in the Hindsight
project, where the brain ITSELF makes LLM calls for retain /
consolidate / reflect) cannot be ported verbatim. They must be
re-shaped so that Open Second Brain delivers the same OPERATIONAL VALUE
(request observability + prompt-cost efficiency) WITHOUT the kernel
ever calling an LLM. The variants you propose must respect this.

================================================================
THE TWO IN-SCOPE CARDS (release: "Hindsight brain-loop ops")
================================================================

--- CARD t_281c3edc ---
Title: [upstream:hindsight] Per-bank LLM request tracing via OTel GenAI recorder

What Hindsight did:
- Records every LLM call (success/failure) into a new llm_requests table
  per bank when HINDSIGHT_API_LLM_TRACE_ENABLED=true.
- Captures input messages, model output, token usage
  (input/output/cached/total), finish reason, provider/model/scope,
  timing, caller metadata.
- GET /v1/default/banks/{bank}/llm-requests (+ /stats) read API.
- Control-plane "LLM Requests" tab: list, filters, detail dialog,
  Calls/Tokens chart.
- Memory <-> trace bidirectional navigation (memory detail shows
  "Created by" / "Consolidated by" trace links).

Why useful for Open Second Brain:
- Open Second Brain has no LLM request tracing. Calls go through the
  agent's providers with no persistent audit log tied to brain
  operations. Per-agent / per-session LLM tracing with token usage,
  latency, and memory linkage would give operators full observability
  into what the brain asked, what it got, and which memories were
  involved.

Status in Open Second Brain:
- No LLM request tracing table, no OTel GenAI recorder, no memory<->
  trace navigation exists. The kernel does not call providers.

--- CARD t_d8c1f7d9 ---
Title: [upstream:hindsight] LLM prompt-prefix caching for retain/consolidate/reflect

What Hindsight did:
- v0.8.0 added provider prompt-prefix caching for retain, consolidation,
  and reflect operations (bank-agnostic, default-on). Caches the common
  prompt prefixes across repeated LLM calls within these operations.

Why useful for Open Second Brain:
- Open Second Brain's brain operations (dream stages, context packing,
  write-session generation steps) produce repeated structured prompts.
  Prompt-prefix caching would reduce API cost and latency for providers
  that support it (OpenAI, Anthropic, etc.). A bank-agnostic design
  works across memory partitions.

Status in Open Second Brain:
- No prompt-prefix caching layer exists. The codegraph query for
  "prompt prefix caching retain consolidate reflect" returned no results.
  src/core/brain/dream.ts makes repeated generation handoffs;
  src/core/brain/context-pack.ts has no prompt-caching layer.

================================================================
THE GENERATION SEAM IN OPEN SECOND BRAIN
================================================================

Because the kernel never calls an LLM, the place where "LLM usage"
actually happens is the HANDOFF from Open Second Brain to the agent.
There are three handoff shapes, all deterministic and file/JSON based:

1. Write-session engine (src/core/brain/write-session/engine.ts,
   types.ts, store.ts, validate.ts, panel.ts).
   - Lifecycle: open -> `needs-llm-step` envelope -> submit ->
     `done` | `needs-correction` | `needs-review` | `failed`.
   - The envelope (WriteSessionEnvelope) carries: status, session_id,
     kind (artifact | panel), step, prompt, schema_hints, errors,
     attempts_left, expires_at, target_path, existing (collision info).
   - The session record (WriteSessionRecord) persists: id, kind, status,
     step, agent, createdAt, updatedAt, expiresAt, attempts, retryCap,
     targetPath, intent (create | overwrite | merge), requireReview,
     prompt, schemaType, topic, personas, responses, pendingArtifact,
     lastErrors, failReason. Stored as JSON at Brain/.sessions/write/<id>.json.
   - Every terminal transition appends exactly one `write-session` audit
     event through the log chokepoint (appendLogEvent in log.ts).
   - HARD RULE: OSB never generates content; every artifact byte comes
     from the caller. Fail-closed: nothing lands unless validation clean.

2. Context pack / pre-compress pack (src/core/brain/context-pack.ts,
   pre-compress-pack.ts).
   - Produces the context text the agent consumes before answering /
     compressing. Emits a `context_receipt` continuity record
     (opt-in) listing the items served, their token estimates, tier,
     trim state, and the final-text hash.
   - Token counts here are local estimates (token-footprint.ts), NOT
     provider-reported usage.

3. Dream stages (src/core/brain/dream.ts, dream-stage.ts,
   dream-refresh.ts, dream-plan.ts).
   - Deterministic proposal/synthesis passes. The kernel does NOT call
     an LLM; where generation is needed, Open Second Brain emits a
     structured proposal/handoff the agent fulfils. dream stages emit
     a `dream_stage` metric record (Brain/metrics/dream_stage.jsonl).

================================================================
EXISTING OBSERVABILITY SURFACES (reuse candidates)
================================================================

- Brain log: Brain/log/<date>.md + JSONL sidecar (appendLogEvent).
  Kinds include dream, feedback, write-session, etc.
- Continuity store: Brain/log/continuity/<month>.jsonl, envelope
  {schema: "o2b.continuity.v1", id, kind, createdAt, sourceRefs,
  payload, private, redacted}. Existing kinds: recall_telemetry,
  context_receipt, gate_telemetry, session_turn, session_summary_node,
  pre_compact_extract, source_invalidation.
  - All opt-in telemetry routes through emitGatedTelemetry(gate, build):
    gate off => the build thunk is NEVER invoked; a throwing thunk is
    swallowed => the primary operation still completes.
  - Payload safety: <private> regions stripped, secrets redacted, raw
    prompts NEVER stored (only SHA-256 prefix + length for gate telemetry).
  - Record id = sha-256 over kind + createdAt + sourceRefs + payload
    (content-hash dedup). Additive optional fields do NOT bump schema
    version; renames/removals bump to o2b.continuity.v2.
- Metrics layer: Brain/metrics/<surface>.jsonl, envelope
  {schema: "o2b.metrics.v1", surface, run_at, payload}. Run-level only
  (one line per pass), O_APPEND, payloads < ~4 KiB. Existing surfaces:
  index, bridge_discovery, communities, recall_benchmark, self_tuning,
  dream_stage.
- Write-session audit event already records session lifecycle; it does
  NOT record token usage, latency, or the agent's actual model/provider.
- Readers: brain_recall_telemetry / brain_context_receipts MCP tools,
  o2b brain recall-telemetry, o2b brain context-receipts CLI.

================================================================
RELATED FILES / GREP ANCHORS
================================================================

- src/core/brain/write-session/{engine,types,store,validate,panel}.ts
- src/core/brain/context-pack.ts, pre-compress-pack.ts, context-receipts.ts
- src/core/brain/dream.ts, dream-stage.ts, dream-refresh.ts, dream-plan.ts
- src/core/brain/continuity/{store,types,emit,redaction,read-model}.ts
- src/core/brain/log.ts, types.ts (BRAIN_LOG_EVENT_KIND)
- src/core/brain/metrics.ts
- src/core/brain/token-footprint.ts
- src/cli/brain/verbs/write-session.ts (CLI envelope surface)
- src/mcp/brain/ (MCP tool registrations)
- docs/observability.md, docs/metrics.md (the on-disk contracts)

================================================================
CONSTRAINTS (all binding)
================================================================

1. The kernel never calls an LLM. No new direct provider calls,
   OpenTelemetry GenAI recorder around LLM calls, or fetch() to a model
   endpoint inside src/core. Generation stays agent-owned.
2. Every new telemetry/observability surface must be OPT-IN (per-call
   option or config key, default off) and FAIL-OPEN: a telemetry
   problem must never fail the primary operation. Reuse the
   emitGatedTelemetry gate pattern; never construct a payload on the
   no-consumer path.
3. Payload safety: raw prompts are NEVER persisted to disk in
   plaintext. Use SHA-256 prefix + length, hashes, redacted metadata,
   and counters. Reuse safeContinuityPayload / context-receipt hashing.
4. Additive-only schema evolution: new continuity kinds / metric
   surfaces / optional payload fields do not break existing readers.
   Unknown kinds/fields are skipped. New surface names are lowercase
   snake_case, max 64 chars.
5. Default behaviour is byte-identical when no new option is supplied.
   Existing reads (write-session envelope, context_receipt, dream_stage
   metric, recall_telemetry) must not change shape unless a flag is set.
6. Language-agnostic. No hardcoded natural-language keyword lists,
   stop-words, or per-language phrase tables (project rule, PR #84).
7. SOLID / KISS / DRY. No misleading fallbacks (absent data is reported
   as absent, never fabricated). No hardcoded provider names that imply
   OSB calls them directly. English-only strings, abstract over any
   language.
8. Token usage the kernel can know: only LOCAL estimates
   (token-footprint.ts). Real provider-reported token usage is NOT
   available to the kernel unless the agent reports it back (an opt-in
   inbound path). Surface this asymmetry honestly in the variants.

================================================================
KEY DESIGN QUESTION THE VARIANTS MUST ANSWER
================================================================

Both cards are about the LLM-usage layer of the brain loop, but the
kernel makes no LLM calls. So the variants must decide:

(A) For LLM-request TRACING: what is the Open Second Brain unit being
    traced? Options include but are not limited to: the write-session
    generation step lifecycle (envelope -> submit -> terminal, with
    attempts, latency, and the agent-reported usage), the context-pack
    / dream handoff, or a new opt-in inbound "generation report" the
    agent sends back. How is it stored (new continuity kind? new metric
    surface? a new Brain/ directory?), how is it read (CLI verb + MCP
    tool), and how does memory <-> trace linkage work when the kernel
    only knows paths/ids, not LLM message ids?

(B) For prompt-prefix CACHING: since OSB cannot cache on a provider it
    does not call, the value must be delivered structurally. Options
    include but are not limited to: a deterministic-prefix construction
    in the write-session prompt builder + context-pack so the prefix
    the agent forwards to its provider is byte-stable across repeated
    calls (cache-friendly), plus an opt-in metric that reports prefix
    stability. Or: advisory cache-control hints emitted in the handoff
    that the agent MAY honour. How much is structural guarantee vs
    advisory, and how is it measured without the kernel seeing the
    provider's cache stats?

The three variants should differ in WHERE the shared seam lives
(write-session engine vs a new generation-observability module vs
extending continuity/metrics layers), how invasive the change is, and
how honestly they handle the kernel-cannot-see-real-usage asymmetry.

Prefer variants that reuse existing observability infrastructure
(continuity records, metrics layer, write-session audit) over
inventing parallel stores, and that keep both cards small and
low-risk (the operator scoped this release to 2 minor, closely related
tasks deliberately).

================================================================
GIT LOG (recent main history)
================================================================

9c1d48f feat: CodeGraph and MCP operational readability (v1.12.0) (#101)
c2c3ff4 feat: Session Knowledge Synthesis Suite - structured session
        summaries, idea-lineage, episodic note history (v1.11.0) (#100)
56dd3dd fix(hermes): bridge EOF - byte streams, stderr drain, retry loop (#92)
35b824e feat: Recall & Working-Memory Quality Suite - selectable profiles,
        usage decay, co-occurrence, file-context (v1.10.0) (#99)
929d54c feat: Brain Portability & Interop Suite - bank export/import, page
        contract, brain_create_note, in-process SDK (v1.9.0) (#98)
7cdbfc0 feat: Indexer Durability & Resilience Suite - cooperative abort,
        graceful watch shutdown, resumable reindex (v1.8.0) (#97)
8b679fe feat: Knowledge Provenance Suite (v1.7.0) (#96)
6e59a42 feat: Vault Integrity & Trust Suite (v1.6.0) (#95)
e4df212 feat: Search & Recall Quality Suite (v1.5.0) (#93)
0340560 feat: Continuity, Hygiene & Freshness Suite (v1.3.0) (#87)
8972f13 refactor: SOLID/DRY decomposition (v1.2.0) (#86)

================================================================
ACTIVE ENGINEERING CONVENTIONS
================================================================

- New telemetry is opt-in, fail-open, payload-safe (hashes not raw text).
- Every release lands as additive, option-gated surfaces; defaults stay
  byte-identical. CHANGELOG follows Keep a Changelog; SemVer.
- CLI verbs live under src/cli/brain/verbs/; MCP tools under
  src/mcp/brain/; core logic under src/core/brain/. Wrappers are thin
  delegations over a core module. Tests: focused unit + CLI/MCP parity.
- Version is bumped only via `bun run scripts/sync-version.ts` (single
  source: package.json version, mirrored to plugin manifests).

Now produce the three variants and the single recommendation.
