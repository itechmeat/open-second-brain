# Hindsight brain-loop ops implementation plan

Branch: `feat/hindsight-brain-loop-ops`
Design: `docs/brainstorm/hindsight-brain-loop-ops/design.md`
Release scope (ships together): t_281c3edc (LLM request tracing) and
t_d8c1f7d9 (prompt-prefix caching).

Cards are driven ONE AT A TIME on this shared branch. Each worker must
build on (git aware) the commits the previously-driven in-scope card
already landed, and must not duplicate or conflict with the sibling
task. Follow each section under TDD.

## t_281c3edc - [upstream:hindsight] Per-bank LLM request tracing via OTel GenAI recorder

### Files

- `src/core/brain/continuity/types.ts` - document the new
  `generation_report` continuity kind (additive; no envelope version
  bump).
- `src/core/brain/continuity/emit.ts` or a new
  `src/core/brain/continuity/generation-report.ts` -
  `emitGenerationReport(vault, input)` gated by `emitGatedTelemetry`
  (opt-in; the build thunk is never invoked on the gate-off path).
- `src/core/brain/continuity/read-model.ts` - lift the new kind's
  handoff ref into a first-class join field (additive).
- `src/core/brain/continuity/redaction.ts` - route the new payload
  through `safeContinuityPayload`; store `prompt_hash` + `prompt_chars`
  and usage counts only, never raw prompt or model output.
- Inbound report write path (CLI verb and/or MCP tool action) the agent
  calls to post usage back after fulfilling a write-session step, a
  context-pack consume, or a dream-stage proposal.
- `src/cli/brain/verbs/generation-reports.ts` - new read verb
  `o2b brain generation-reports list|summary`.
- `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`,
  `src/cli/command-manifest.ts` - register the verb, help, manifest.
- `src/mcp/brain/` (current observability/generation tool module) -
  register `brain_generation_reports` (action `list` | `summary`).
- `docs/observability.md` - document the `generation_report` kind and
  its fail-open / payload-safety rules.
- `docs/cli-reference.md`, `docs/mcp.md` - document the new verb/tool.
- `CHANGELOG.md` - entry.
- Tests: `tests/core/brain/continuity-generation-report.test.ts`,
  `tests/cli/brain-generation-reports.test.ts`, MCP parity test for
  `brain_generation_reports`, no-consumer regression test (gate off =>
  no payload built), and a test asserting no raw prompt text reaches
  disk.

### Acceptance

A focused test suite passes that proves:

- Emitting a `generation_report` with the gate ON writes one continuity
  record under `Brain/log/continuity/<month>.jsonl` with envelope
  `o2b.continuity.v1`, `kind: "generation_report"`, and a content-hash
  `id` (same inputs => same id).
- With the gate OFF, no payload object is built and no record is
  written (the `emitGatedTelemetry` no-consumer guarantee).
- The record carries `prompt_hash` and `prompt_chars` and usage counts
  only; an assertion reads the persisted file and confirms no raw
  prompt or model output is stored.
- `local_estimate.input_tokens` is always present; the agent-reported
  `usage` block is optional and its absence is reported as absent, not
  fabricated.
- `sourceRefs` join the report to the handoff target (write-session
  session id, context-receipt id, or dream run id) and the memory
  paths involved, so `summary` links a memory path back to its
  generation reports.
- A throwing build thunk is swallowed and the primary operation
  completes normally (fail-open).
- With the feature off, existing continuity records, the write-session
  envelope, the context_receipt record, and recall_telemetry keep their
  current shapes byte-for-byte.
- No `fetch`/provider HTTP call was added under `src/core` for this
  feature (grep-guarded regression test).

Suggested verification command for the worker:

```bash
bun test tests/core/brain/continuity-generation-report.test.ts tests/cli/brain-generation-reports.test.ts <new MCP parity test>
bun run typecheck
bun run lint
```

### Depends on

No sibling task needs to land first. Build this card FIRST on the
branch: it establishes the `prompt_hash` convention, the inbound-report
write path, and the read surface that the prompt-prefix card reuses.

## t_d8c1f7d9 - [upstream:hindsight] LLM prompt-prefix caching for retain/consolidate/reflect

### Files

- `src/core/brain/prompt-prefix.ts` - new pure helper:
  `deterministicPrefix(inputs)` returning `{ prefix, hash, chars }`
  (stable inputs only: no `Date.now`, no random, sorted keys) and
  `isStable(current, prior)` (true when hashes match for the same
  handoff kind).
- `src/core/brain/write-session/panel.ts` (and `engine.ts` where the
  `needs-llm-step` envelope is built) - route the generation prompt
  preamble (`personaPrompt` / `synthesisPrompt`) through
  `deterministicPrefix`. NOTE: no prompt builder lives in `validate.ts`
  (only `buildCorrectionPrompt`, unrelated and out of scope); the design
  was corrected in Phase 1 review to point at the real builders.
- `src/core/brain/context-pack.ts` - route the stable preamble segment
  of `packContext`'s output through `deterministicPrefix`.
- `src/core/brain/metrics.ts` - NO change for the metric itself: the
  reader is surface-agnostic. The emission point calls
  `appendMetric(vault, { surface: "prompt_prefix", runAt, payload })`
  and `listMetrics` discovers it automatically. This mirrors how
  `dream-stage.ts` already emits the `dream_stage` surface with no
  registration anywhere.
- Emission point for the run-level `prompt_prefix` metric (a dream pass
  or write-session batch emits one record per pass), opt-in via the
  existing metrics fail-soft path. Lives at the call site that runs a
  generation pass, NOT in `metrics.ts`.
- `docs/metrics.md` - document the `prompt_prefix` surface, payload,
  and the explicit "stability (structural), not provider cache-hit
  rate" framing.
- `docs/observability.md` - cross-reference the prefix-stability layer
  if needed.
- `CHANGELOG.md` - entry.
- Tests: `tests/core/brain/prompt-prefix.test.ts`,
  `tests/core/brain/metrics-prompt-prefix.test.ts`, and a regression
  test asserting byte-stable prefixes for identical inputs across
  repeated calls plus byte-identical default write-session envelope and
  context_receipt when no option is set.

### Acceptance

A focused test suite passes that proves:

- `deterministicPrefix` returns byte-identical `prefix` and `hash` for
  identical inputs across repeated calls, and differs predictably when
  inputs change.
- Routing the write-session prompt preamble and the context-pack
  preamble through the helper does not change the default
  `WriteSessionEnvelope` or `context_receipt` shape when no option is
  set (byte-identical regression).
- A generation pass with the metric ON writes one run-level
  `prompt_prefix` record under `Brain/metrics/prompt_prefix.jsonl` with
  envelope `o2b.metrics.v1`, carrying `prefix_hash`, `prefix_chars`,
  `call_count`, and `stable_count`.
- With the metric OFF, no `prompt_prefix` record is written and the
  pass output is byte-identical to today.
- The metric and docs name the measure "stability" (structural) and do
  not claim provider cache-hit measurement the kernel cannot observe.
- `listMetrics(vault, { surface: "prompt_prefix" })` returns the new
  surface with no `metrics.ts` change (the reader is surface-agnostic;
  emission via `appendMetric` is sufficient, exactly as for
  `dream_stage`).

Suggested verification command for the worker:

```bash
bun test tests/core/brain/prompt-prefix.test.ts tests/core/brain/metrics-prompt-prefix.test.ts
bun run typecheck
bun run lint
```

### Depends on

Run AFTER `t_281c3edc` on the same branch. The prefix helper reuses
the `prompt_hash` convention the tracing card established, and the
run-level metric emission can reuse the same fail-soft metrics path.
The implementation must build on the tracing card's commits (git aware)
and must not re-introduce a parallel store or a new architectural seam.
