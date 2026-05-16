/**
 * Adapter registry. The single place that knows about every concrete
 * session adapter. Adding a fourth runtime is:
 *
 *   1. Drop `sessions/<new>.ts` with a `SessionAdapter` export.
 *   2. Append to {@link SESSION_ADAPTERS}.
 *   3. Add the new id to the `SessionAdapterId` union in `types.ts`.
 *
 * No other code path changes.
 */

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { hermesAdapter } from "./hermes.ts";
import type { SessionAdapter, SessionAdapterId } from "./types.ts";

export const SESSION_ADAPTERS: ReadonlyArray<SessionAdapter> = Object.freeze([
  claudeAdapter,
  codexAdapter,
  hermesAdapter,
]);

/**
 * Probe each adapter's `detect()` in registry order, return the first
 * match. Adapters identify on structural fields rather than fuzzy
 * heuristics, so two adapters matching the same line would be a
 * design bug — `tests/core/brain.sessions.registry.test.ts` locks
 * the cross-table.
 */
export function detectAdapter(firstLine: string): SessionAdapter | null {
  for (const a of SESSION_ADAPTERS) {
    if (a.detect(firstLine)) return a;
  }
  return null;
}

export function getAdapter(id: SessionAdapterId): SessionAdapter {
  for (const a of SESSION_ADAPTERS) {
    if (a.id === id) return a;
  }
  // The union type makes this unreachable at compile time, but a
  // runtime guard keeps the failure mode honest if SESSION_ADAPTERS
  // is ever mutated out from under us.
  throw new Error(`no SessionAdapter registered with id '${id}'`);
}
