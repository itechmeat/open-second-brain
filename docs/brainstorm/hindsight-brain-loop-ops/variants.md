# Hindsight brain-loop ops variants

Branch: `feat/hindsight-brain-loop-ops`
In-scope cards: t_281c3edc (LLM request tracing), t_d8c1f7d9 (prompt-prefix caching).

## Consultant variants

The variants below were produced by the consultant (claude-opus-4-8)
from the brief at `cli-output/prompt.md`. They are reproduced verbatim
from `cli-output/claude.md`.

## Variant 1: Extend continuity + metrics layers (reuse-first)
Approach: Treat both cards as additive surfaces on the infrastructure
that already exists. Tracing becomes a new opt-in inbound continuity
kind, `generation_report`, that the agent posts back after fulfilling
any handoff (write-session submit, context-pack consume, dream
proposal), carrying agent-reported usage (provider/model, real
input/output/cached/total tokens, finish reason, latency) plus the
local token estimate for comparison. Caching becomes a deterministic
prefix-construction rule in the existing prompt builders plus a
`prompt_prefix` metric surface that reports prefix-stability across
repeated calls.
Trade-offs:
- Smallest blast radius: no new store, no new module, no new lifecycle.
  Both cards are pure additive surfaces under rules already audited
  (gate pattern, `safeContinuityPayload`, content-hash dedup).
- Memory <-> trace linkage falls out of `sourceRefs` (paths/ids the
  kernel already knows); honest by construction, since the kernel never
  invents an LLM message id.
- The asymmetry is surfaced cleanly: estimate is always present, real
  usage is present only when the inbound report arrives, and absent is
  reported as absent.
- Weaker uniformity: each of the three seams wires the inbound report
  itself, so there is mild duplication and no single "generation trace"
  abstraction to grow into later.
Complexity: small
Risk: low

## Variant 2: Write-session engine as the canonical trace unit
Approach: Anchor both cards on the write-session lifecycle, the one
seam that already has a durable record, audit event, attempts, and
terminal transitions. Tracing extends the submit path with an opt-in
agent-reported usage block and records latency/attempts into the
existing `write-session` audit event, with `session_id <->
target_path` as the memory link. Caching adds a deterministic,
separately hashed `cache_prefix` segment to the envelope plus advisory
cache-control hints the agent may honour.
Trade-offs:
- Highest-fidelity trace where it matters most: the write-session
  already models open -> needs-llm-step -> submit -> terminal, so usage,
  attempts, and latency attach to a real state machine rather than a
  fresh log line.
- Reuses the existing chokepoint (`appendLogEvent`), so audit ordering
  and the one-event-per-terminal-transition guarantee are preserved for
  free.
- Coverage gap: context-pack and dream handoffs are not write-sessions,
  so they get little or no tracing and no shared prefix builder; the
  release covers one seam deeply and two shallowly.
- Modifying the submit path and envelope risks shape drift on a
  load-bearing record; needs careful flag-gating to keep default bytes
  identical.
Complexity: medium
Risk: medium

## Variant 3: Dedicated generation-observability module
Approach: Introduce `src/core/brain/generation/` as a unified seam that
all three handoffs (write-session, context-pack, dream) describe
themselves through, emitting one "generation handoff descriptor" and
accepting one opt-in inbound "generation report" via a new CLI verb and
MCP tool. The module owns a single deterministic prefix builder shared
by all three seams and a `prompt_prefix` metric surface, giving one
consistent trace ledger and one caching guarantee across the whole brain
loop.
Trade-offs:
- Most coherent long-term shape: one abstraction, one reader, uniform
  linkage and prefix construction across every generation point.
- Best leverage for future handoff shapes, which only need to implement
  the descriptor rather than wire telemetry themselves.
- Largest change for a release the operator deliberately scoped to two
  minor, closely related tasks; it adds a new module, a new inbound
  path, and refactors three seams at once.
- Higher regression surface and review cost; risks introducing a
  parallel store/abstraction the brief explicitly cautions against, and
  front-loads design the two cards do not yet require.
Complexity: large
Risk: high

## Recommended: Variant 1
Rationale: It satisfies every binding constraint with the least new
surface area: opt-in, fail-open, payload-safe, additive-only, and
byte-identical by default, all by reusing the continuity gate and the
metrics layer rather than inventing a parallel store. It answers the
key design question honestly: the traced unit is the agent's inbound
generation report keyed by the paths/ids the kernel already owns, and
caching is delivered structurally as a byte-stable prefix with a
stability metric, never as a provider call. It covers all three handoff
shapes without committing to a premature abstraction, which is the right
altitude for a release deliberately scoped to two minor, closely related
cards. Variant 2 leaves context-pack and dream under-covered, and
Variant 3's uniformity is not yet earned and carries regression and
parallel-store risk that this scope does not justify.

## Final decision

Chosen variant: Variant 1, Extend continuity + metrics layers
(reuse-first).

I agree with the consultant recommendation. The operator scoped this
release to two minor, closely related tasks and asked for it to stay
deliberately small and low-risk, which Variant 1 honours directly: it
adds two opt-in, fail-open, additive surfaces on infrastructure the
project already audits (the continuity gate and the metrics layer)
instead of a new module or a modified load-bearing record. It also maps
both Hindsight features onto Open Second Brain's "kernel never calls an
LLM, the agent owns generation" model without distortion: tracing is the
agent's inbound usage report keyed by paths and ids the kernel already
knows, and caching is a structural, byte-stable prefix plus a stability
metric rather than a provider call the kernel cannot make. Variant 2's
coverage gap (context-pack and dream get little tracing) and Variant 3's
premature, high-regression abstraction are both poor fits for this
scope.
