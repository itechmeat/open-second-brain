# Hindsight brain-loop ops design

Branch: `feat/hindsight-brain-loop-ops`
Variants: `docs/brainstorm/hindsight-brain-loop-ops/variants.md`
Plan: `docs/brainstorm/hindsight-brain-loop-ops/plan.md`

## Problem

Two upstream Hindsight features address the LLM-usage layer of the
brain loop: per-operation LLM request tracing (token usage, latency,
model, and memory linkage), and provider prompt-prefix caching for
repeated operations (retain / consolidate / reflect). Both are written
for a brain that calls an LLM itself.

Open Second Brain has a load-bearing invariant the Hindsight brain does
not: the kernel never calls an LLM. The calling agent owns all
generation; Open Second Brain owns sequencing, deterministic
computation, validation, and the atomic commit. So neither feature can
be ported verbatim. Today Open Second Brain has no persistent record of
the LLM usage the agent performs on behalf of brain operations, and no
structural guarantee that the prompts it hands the agent have a stable,
cacheable prefix across repeated calls.

The release must therefore deliver the OPERATIONAL VALUE of both
features (request observability and prompt-cost efficiency) without the
kernel ever calling an LLM, without persisting raw prompt text, and
without changing any default behaviour.

## Scope

- Add an opt-in, fail-open inbound tracing surface: the agent reports
  back the real usage of a generation it performed for a brain handoff
  (write-session step, context-pack consume, or dream-stage proposal),
  and Open Second Brain stores it as an additive continuity record
  correlated to the paths and ids it already owns. Cover t_281c3edc.
- Add a structural prompt-prefix stability layer: a deterministic
  prefix construction in the existing prompt builders plus a run-level
  metric that reports prefix stability across repeated calls. Cover
  t_d8c1f7d9.
- Add read surfaces (CLI verb and MCP tool) for the tracing records so
  operators and agents can list and summarise generation usage with
  memory linkage.
- Document and test both surfaces through focused unit, CLI, and MCP
  coverage.

## Out of scope

- The kernel calling an LLM, an OpenTelemetry GenAI recorder around LLM
  calls, or any direct provider HTTP call inside `src/core`.
- Persisting raw prompt text or model output. Only hashes, lengths,
  redacted metadata, and counts are stored.
- Inferring provider cache-hit rates. The release measures prefix
  STABILITY (structural), which is all the kernel can know; it does not
  claim to measure provider cache performance.
- A new `src/core/brain/generation/` seam that refactors write-session,
  context-pack, and dream behind one abstraction (Variant 3, deferred).
- A control-plane UI tab. Open Second Brain is vault-Markdown-first; the
  read surface is a CLI verb and an MCP tool, not a dashboard.
- Changing the default shape of the write-session envelope, the
  context_receipt record, the dream_stage metric, or recall_telemetry
  when no new option is supplied.

## Chosen approach

Use Variant 1: Extend continuity + metrics layers (reuse-first).

Both cards land as two opt-in, additive surfaces on infrastructure the
project already audits.

Tracing (t_281c3edc) becomes a new opt-in inbound continuity kind,
`generation_report`. After the agent fulfils a generation handoff it
optionally posts back the real usage (provider, model, finish reason,
latency, input/output/cached/total tokens) plus the handoff reference.
Open Second Brain stores this as a continuity record whose `sourceRefs`
are the paths and ids the kernel already owns (the write-session
session id, the context-receipt id, the dream run id, and the memory
paths involved), so memory <-> trace linkage is a `sourceRefs` join the
read-model already performs. The local token estimate
(`token-footprint.ts`) is always attached for comparison, and real
usage is present only when the inbound report arrives; absent is
reported as absent. The whole surface is gated by `emitGatedTelemetry`
(opt-in, fail-open) and payload-safe through `safeContinuityPayload`,
so no raw prompt or output is ever persisted.

Caching (t_d8c1f7d9) becomes a structural prefix-stability guarantee
plus a run-level metric. A small pure helper (`src/core/brain/prompt-prefix.ts`)
defines the deterministic-prefix contract the write-session prompt
builder and the context-pack builder already nearly satisfy: the prefix
is a function of stable inputs only (no timestamps, no random, sorted
keys), so the same inputs produce byte-identical prefix bytes across
repeated calls, which is exactly what a provider prefix cache rewards.
A new run-level metric surface, `prompt_prefix`
(`Brain/metrics/prompt_prefix.jsonl`), reports per-pass prefix
stability: the prefix hash, prefix length, the number of calls in the
pass, and how many reused the same prefix. This measures what the
kernel can know (structural stability), honestly distinct from what it
cannot (provider cache-hit rate).

We agree with the consultant recommendation. Variant 1 is the only
variant that covers all three handoff shapes, honours every binding
constraint, and stays within the operator's deliberate "two minor,
closely related, low-risk tasks" scope. Variant 2 leaves context-pack
and dream under-covered, and Variant 3 front-loads an abstraction the
two cards do not yet earn.

## Design decisions

1. The traced unit is the agent's inbound report, not an LLM call the
   kernel makes.
   - The kernel cannot observe an LLM call it never makes. Tracing is
     therefore an opt-in INBOUND path: the agent reports back after it
     generates. The kernel keys the report by the handoff ref and the
     paths/ids it already owns, never inventing an LLM message id.
   - Honest asymmetry: the local estimate is always present; real usage
     is present only when the agent reports it. A missing real-usage
     block is normal, not a failure.

2. Reuse the continuity store and metrics layer; do not add a parallel
   store or a new module.
   - `generation_report` is a new continuity kind under the existing
     `o2b.continuity.v1` envelope, dedup id, payload-safety, and
     read-model. No new directory, no new lifecycle.
   - `prompt_prefix` is a new metrics surface under the existing
     `o2b.metrics.v1` envelope (run-level, O_APPEND, < 4 KiB).
   - Both reuse `emitGatedTelemetry` so the gate-off path never
     constructs a payload and a throwing build is swallowed.

3. Opt-in, fail-open, payload-safe by construction.
   - Tracing is gated by a per-call option (MCP/CLI param) and/or a
     config key (default off). When off, no payload object is built.
   - Caching is default-on structurally (the prefix builders already
     produce stable output in practice) but the METRIC is opt-in
     (default off), so default behaviour is byte-identical.
   - No raw prompt or model output is stored: `prompt_hash` (sha-256
     prefix) and `prompt_chars` only; counts and metadata only for
     usage. `safeContinuityPayload` strips `<private>` regions and
     redacts secret-shaped tokens.

4. Additive-only schema evolution.
   - `generation_report` is an additive kind; existing readers skip
     unknown kinds. Its payload fields are additive-optional. Renames
     or removals would bump to `o2b.continuity.v2`; this release adds
     none.
   - `prompt_prefix` is an additive metrics surface; consumers ignore
     unknown surface files. Payload fields are additive-optional.

5. Default behaviour is byte-identical.
   - With tracing off and the metric off, the write-session envelope,
     the context_receipt record, the dream_stage metric, and
     recall_telemetry keep their current shapes exactly.
   - The prefix-stability guarantee is non-observable to existing
     consumers (it constrains builder internals, not output shape) and
     is locked by a regression test that asserts byte-stable prefixes
     for the same inputs.

6. Language-agnostic and provider-agnostic.
   - No natural-language keyword lists anywhere. The prefix contract is
     structural (ordering, hashing), independent of any language.
   - Provider and model are opaque agent-reported strings; the kernel
     never branches on them and never implies it calls them.

## Report contracts

### generation_report continuity record

Envelope: `o2b.continuity.v1`. `kind: "generation_report"`. `id` is the
sha-256 content-hash over `kind + createdAt + sourceRefs + payload`
(existing `recordId` rule). Stored under
`Brain/log/continuity/<month>.jsonl`.

`sourceRefs` join the report to vault artifacts: for a write-session
step, the session id and the `target_path`; for a context-pack consume,
the context-receipt id and the surfaced item paths; for a dream-stage
proposal, the dream `run_id` and the affected preference paths.

`payload` (all usage and report fields optional except `handoff` and
`local_estimate`):

```
{
  handoff: { kind: "write_session" | "context_pack" | "dream_stage", ref: <id> },
  agent: <string>,
  scope: <optional string>,
  provider: <optional, agent-reported>,
  model: <optional, agent-reported>,
  finish_reason: <optional>,
  latency_ms: <optional>,
  prompt_hash: <sha-256 prefix of the handoff prompt>,
  prompt_chars: <number>,
  local_estimate: { input_tokens: <token-footprint estimate, always present> },
  usage: {                       // agent-reported, all optional
    input_tokens?, output_tokens?, cached_tokens?, total_tokens?
  }
}
```

Read surface: `o2b brain generation-reports list|summary` and MCP
`brain_generation_reports` (action `list` | `summary`). `summary`
aggregates calls, total/estimated tokens, and the per-handoff-kind
breakdown, and joins `sourceRefs` so a memory path links back to the
generation reports that produced or consumed it. Unknown payload fields
are ignored.

### prompt_prefix metric record

Envelope: `o2b.metrics.v1`. `surface: "prompt_prefix"`. One line per
generation pass (run-level), under `Brain/metrics/prompt_prefix.jsonl`.

```
{
  schema: "o2b.metrics.v1",
  surface: "prompt_prefix",
  run_at: <ISO>,
  payload: {
    handoff: { kind: "write_session" | "context_pack" | "dream_stage" },
    prefix_hash: <sha-256 of the deterministic prefix>,
    prefix_chars: <number>,
    call_count: <number of calls in the pass>,
    stable_count: <number of calls whose prefix matched prefix_hash>,
    run_ref: <optional id of the pass, e.g. dream run_id>
  }
}
```

Read surface: the existing `listMetrics` reader
(`src/core/brain/metrics.ts`) returns the new surface with no code
change beyond registration; no new CLI verb is required for the metric
(the metrics reader already covers arbitrary surfaces).

### prompt-prefix helper contract

`src/core/brain/prompt-prefix.ts` exposes pure functions:

- `deterministicPrefix(inputs): { prefix: string, hash: string, chars: number }`
  - Builds the stable prefix from inputs only (no `Date.now`, no random,
    sorted keys, stable whitespace). The same inputs always yield the
    same bytes.
- `isStable(current, prior): boolean`
  - True when `current.hash === prior.hash` for the same handoff kind.

The write-session prompt construction (`personaPrompt` / `synthesisPrompt`
in `write-session/panel.ts`, surfaced on the `needs-llm-step` envelope
emitted by `write-session/engine.ts`) and the context-pack builder
(`packContext` in `context-pack.ts`) route their stable preamble segment
through this helper. A regression test asserts byte-stable prefixes for
identical inputs across repeated calls.

## File changes

Expected implementation touchpoints:

- `src/core/brain/continuity/types.ts` - document the new
  `generation_report` kind (additive; no envelope version bump).
- `src/core/brain/continuity/emit.ts` (or the write/ingest helper) -
  `emitGenerationReport(vault, input)` gated by `emitGatedTelemetry`.
- `src/core/brain/continuity/read-model.ts` - lift the new kind's
  handoff ref into a first-class field for the join, additive.
- `src/core/brain/continuity/redaction.ts` - ensure `generation_report`
  payload passes `safeContinuityPayload` (prompt_hash only, no raw
  prompt; usage counts only).
- `src/core/brain/prompt-prefix.ts` - new pure helper (deterministic
  prefix + stability check).
- `src/core/brain/write-session/panel.ts` (and `engine.ts` where the
  `needs-llm-step` envelope is built) - route the generation prompt
  preamble (`personaPrompt` / `synthesisPrompt` output) through
  `deterministicPrefix`. NOTE: no prompt builder lives in `validate.ts`;
  its only prompt is `buildCorrectionPrompt`, which is unrelated and
  must NOT be touched.
- `src/core/brain/context-pack.ts` - route the stable preamble segment
  of `packContext`'s output through `deterministicPrefix`.
- `src/core/brain/metrics.ts` - NO change for the metric itself: the
  reader is surface-agnostic (`appendMetric` validates the surface name
  by regex and writes `Brain/metrics/<surface>.jsonl`; `listMetrics`
  auto-discovers all `*.jsonl` files). The `prompt_prefix` emission
  point lives at the call site that runs a generation pass (see
  t_d8c1f7d9 plan), exactly as `dream-stage.ts` already emits
  `dream_stage` with no registration.
- `src/cli/brain/verbs/generation-reports.ts` - new CLI verb
  `o2b brain generation-reports list|summary`.
- `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`,
  `src/cli/command-manifest.ts` - register the new verb, help, command
  manifest.
- `src/mcp/brain/` - add the `brain_generation_reports` tool (action
  `list` | `summary`) to the most fitting existing tool module by
  cohesion (e.g. `analytics-tools.ts` or `health-tools.ts`) or a new
  `generation-tools.ts`, and register it in the MCP manifest. There is
  no single "generation/observability" module today.
- Inbound report write path: a CLI verb (e.g.
  `o2b brain generation-report` or an MCP tool action) the agent calls
  to post the usage back, gated opt-in.
- Tests:
  `tests/core/brain/continuity-generation-report.test.ts`,
  `tests/core/brain/prompt-prefix.test.ts`,
  `tests/cli/brain-generation-reports.test.ts`,
  MCP parity test for `brain_generation_reports`, and a regression test
  asserting default byte-identical output when no option is set.
- `docs/observability.md` - document the `generation_report` continuity
  kind and its fail-open/payload-safety rules.
- `docs/metrics.md` - document the `prompt_prefix` surface and payload.
- `docs/cli-reference.md`, `docs/mcp.md` - document the new verb and
  tool.
- `CHANGELOG.md` - Keep a Changelog entry.

## Risks

- Tracing can drift toward the kernel calling an LLM. Mitigation: the
  inbound report is the only path; a regression test pins that no
  `fetch`/provider call is added under `src/core` for this feature.
- Raw prompt text could leak into a record. Mitigation: only
  `prompt_hash` + `prompt_chars` are stored; `safeContinuityPayload`
  redaction and a test that asserts no raw prompt survives to disk.
- The prefix-stability guarantee could be claimed as provider
  cache-hit measurement. Mitigation: the metric and docs name it
  "stability" (structural), explicitly distinct from provider
  cache-hit rate the kernel cannot observe.
- Default output could drift when the prefix builder is wired in.
  Mitigation: the builder only constrains internal ordering, not output
  shape; a regression test asserts byte-identical envelopes and
  receipts when no option is set.
- New CLI/MCP surface area increases documentation burden. Mitigation:
  keep wrappers thin, reuse the metrics reader for the metric surface,
  and document the structured record once.
- The two cards touch overlapping files (continuity, metrics, prompt
  builders). Mitigation: drive them one at a time on the shared branch
  per the plan, with the tracing card landing first so the prefix
  helper can reuse its prompt_hash convention.
