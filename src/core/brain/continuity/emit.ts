/**
 * Lazy gated telemetry emit kernel (Memory Observability Suite,
 * t_5d7aa7c5).
 *
 * One helper enforces the two telemetry invariants structurally instead
 * of by convention at every call site:
 *
 *   1. No consumer, no payload work - with the gate off (`undefined`,
 *      `false`, or `null`) the build thunk is NEVER invoked, so no
 *      payload object, hash, or continuity write happens on the
 *      no-listener path.
 *   2. Fail-open - telemetry must never fail the primary operation. A
 *      throwing thunk (or a throwing continuity write inside it) is
 *      swallowed and reported as `null`.
 *
 * The gate doubles as the payload-options carrier: passing
 * `opts.telemetry` directly keeps TypeScript narrowing inside the thunk
 * without non-null assertions. Boolean config gates pass `true`.
 *
 * Scope note: this kernel covers GATED telemetry surfaces (context-pack
 * receipts/telemetry, pre-compress receipts/telemetry, recall-gate
 * telemetry). Writers whose continuity append IS the primary operation
 * (session-recall import, pre-compact extract) stay fail-fast and do
 * not route through here.
 */

export function emitGatedTelemetry<G, T>(
  gate: G | false | null | undefined,
  build: (gate: G) => T,
): T | null {
  if (gate === false || gate === null || gate === undefined) return null;
  try {
    return build(gate);
  } catch {
    return null;
  }
}
