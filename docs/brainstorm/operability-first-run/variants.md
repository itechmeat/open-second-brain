# Operability, Safety & First-Run - Architectural Variants

Three whole-release approaches for the eight in-scope tasks (guided
onboarding, config-validator remediation, runtime-state notices, hook
self-watchdog + fail-open inject, configurable 429 retry, expect/strict
mutation guards, hardened optional HTTP transport, per-skill invocation
telemetry). Hard constraint across all three: no new runtime dependency, no
ML runtime, kernel calls no LLM, safe-by-default HTTP.

## Variant 1 - Thin composition on existing seams

**Approach.** Each task extends the nearest existing module or seam rather
than introducing a subsystem:

- Retry budget: add `maxRetries` to the resolved embedding config, threaded
  through the existing `resolveSearchConfig` env/config reader and the
  existing `embedBatchWithRetry` loop. Raise the default 3 -> 6.
- Doctor remediation: add an optional `fix` field to the existing
  `CheckResult` shape; populate it in each failing `check*` branch; render it
  in the three existing consumers (`o2b doctor`, `vault_health`, OpenClaw).
- Runtime notices: a small deterministic collector rendered into the existing
  `active-inject` `additionalContext` surface and folded into the existing
  `vault_health` output. No new MCP tool.
- Hook resilience: a reusable process-ceiling primitive plus a fail-open
  context loader wired into the two lifecycle-hook entry points, reusing the
  existing `appendAuditRecord` writer.
- Mutation guards: a pure count-guard helper plus an opt-in content-equality
  short-circuit on the existing atomic writer, wired into the existing
  dry-run-capable ops and their CLI verbs.
- HTTP transport: harden the transport that already exists (`src/mcp/http.ts`)
  with a Host/Origin rebinding guard, a health endpoint, and an optional
  (loopback) / required (non-loopback) bearer.
- Skill telemetry: a new append-only continuity `kind` emitted from the
  existing session-import tool-call loop, derived read-side with the existing
  usage-signal decay math, surfaced through the existing
  `brain_skill_proposals` tool as a new view.
- Onboarding: extend the existing `cmdInit` post-init block into a state-driven
  multi-step checklist, reusing the doctor and notices surfaces, plus a
  re-runnable verb.

**Trade-offs.** Touches many files with small edits; each task is independently
testable and independently revertible. Preserves the codebase's narrow-module,
additive, byte-identical-when-off ethos and the frozen 98-tool MCP surface (no
tool added). Downside: the operability story is spread across the tree rather
than sitting in one named home, so the release's conceptual unity lives in the
docs, not in a package boundary.

**Complexity:** medium. **Risk:** low.

## Variant 2 - Unified operability core

**Approach.** Introduce `src/core/operability/` as a single cohesive
subsystem: notices, process watchdog, count-guard, doctor-remediation
catalogue, and onboarding checklist share types and helpers there, exposed
through one new MCP tool `brain_operability` with views (`doctor`, `notices`,
`onboarding`, `skill_usage`). The HTTP hardening and retry config still live
in their own modules but register their state through the operability core.

**Trade-offs.** Gives operability an obvious home and one discoverable tool;
future operability features have a clear landing zone. But it over-centralises
loosely-related concerns (a retry budget and a first-run checklist do not
belong to one module), fights the established narrow-module convention, and
grows the frozen MCP surface (98 -> 99), forcing the parity-test edits and a
deliberate surface-change decision. The single tool also becomes a
grab-bag with a wide `view` enum.

**Complexity:** large. **Risk:** medium.

## Variant 3 - Runtime-daemon-centric

**Approach.** Make the hardened HTTP transport the primary operability
surface: a long-lived server exposes `/health`, `/notices`, and `/doctor`
endpoints; the process watchdog and notices become server-side, pushed to
connected clients over SSE. Onboarding and the CLI doctor become thin clients
of the same endpoints.

**Trade-offs.** Elegant for HTTP consumers and centralises push. But it
couples first-run and CLI concerns to a running server, directly contradicts
the stdio-default / opt-in-HTTP posture the transport task mandates (the
transport must stay optional and off by default), and makes the safe-by-default
story harder (more surface listening). Heaviest to build and test; the
first-run experience should not require a daemon.

**Complexity:** large. **Risk:** high.

## Recommended: Variant 1

Variant 1 matches how every prior release in this codebase shipped: additive
surfaces, byte-identical when off, no new dependency, each task landing on the
seam nearest its concern with its own acceptance test. It keeps the frozen MCP
tool surface intact (notices fold into `vault_health`; skill usage folds into
`brain_skill_proposals`), which avoids a surface-change decision that the scope
does not require. It also isolates the one security-sensitive surface (the HTTP
transport) as a self-contained hardening of an existing module, so its guard
logic is reviewed and tested in one place rather than spread across a new
subsystem. Variant 2's unified core is attractive conceptually but buys
coupling and frozen-surface churn for concerns that are only thematically
related; Variant 3 inverts the transport task's own safe-by-default, opt-in
requirement. We take Variant 1.
