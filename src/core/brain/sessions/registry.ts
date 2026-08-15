/**
 * Session-adapter registry. The single place that knows about every
 * concrete session adapter.
 *
 * Same shape as the memory-backend registry
 * (`src/core/brain/agent-backend/registry.ts`), and for the same reason its
 * protocol states: "adding a runtime means adding ONE module that satisfies
 * this interface and registering it - no changes to the import core, CLI, or
 * MCP surfaces" (`src/core/brain/agent-backend/types.ts:9-11`). A frozen
 * id-keyed map, lookup by id, and an unknown id that fails loudly with the
 * registered set rather than falling back to a wrong parser.
 *
 * Adding a runtime is therefore:
 *
 *   1. Drop `sessions/<new>.ts` with a `SessionAdapter` export.
 *   2. Append it to {@link BUILTIN_SESSION_ADAPTERS}, and its id to
 *      `SESSION_ADAPTER_ID` so `--format` accepts it.
 *
 * Every lookup takes an optional registry, so a caller can resolve against
 * its own adapter set ({@link createSessionAdapterRegistry}) without the
 * built-in map knowing that set exists.
 */

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";
import { hermesAdapter } from "./hermes.ts";
import { opencodeAdapter } from "./opencode.ts";
import { isSessionAdapterId, type SessionAdapter } from "./types.ts";

export { isSessionAdapterId };

/** An id-keyed adapter set. Insertion order is autodetect probe order. */
export type SessionAdapterRegistry = ReadonlyMap<string, SessionAdapter>;

const BUILTIN_SESSION_ADAPTERS: ReadonlyArray<SessionAdapter> = Object.freeze([
  claudeAdapter,
  codexAdapter,
  hermesAdapter,
  opencodeAdapter,
  grokAdapter,
]);

/**
 * Build a registry from an adapter list, preserving order. A repeated id is
 * refused: silently keeping one of two adapters claiming the same id would
 * decide which runtime's transcripts get parsed by insertion order alone.
 */
export function createSessionAdapterRegistry(
  adapters: ReadonlyArray<SessionAdapter>,
): SessionAdapterRegistry {
  const registry = new Map<string, SessionAdapter>();
  for (const adapter of adapters) {
    if (registry.has(adapter.id)) {
      throw new Error(`duplicate SessionAdapter id '${adapter.id}' in registry`);
    }
    registry.set(adapter.id, adapter);
  }
  return registry;
}

/** The adapters that ship in this tree, keyed by id. */
export const SESSION_ADAPTER_REGISTRY: SessionAdapterRegistry =
  createSessionAdapterRegistry(BUILTIN_SESSION_ADAPTERS);

/** Registered adapters in registration order. */
export function listSessionAdapters(
  registry: SessionAdapterRegistry = SESSION_ADAPTER_REGISTRY,
): ReadonlyArray<SessionAdapter> {
  return Object.freeze([...registry.values()]);
}

/**
 * Every shipped adapter, in registry order. Retained as the flat view the
 * cross-table tests and the CLI help enumerate.
 */
export const SESSION_ADAPTERS: ReadonlyArray<SessionAdapter> = listSessionAdapters();

export function sessionAdapterFormatChoices(
  registry: SessionAdapterRegistry = SESSION_ADAPTER_REGISTRY,
): string {
  return ["auto", ...registry.keys()].join("|");
}

/**
 * Probe each adapter's `detect()` in registry order, return the first
 * match. Adapters identify on structural fields rather than fuzzy
 * heuristics, so two adapters matching the same line would be a
 * design bug — `tests/core/brain.sessions.registry.test.ts` locks
 * the cross-table.
 */
export function detectAdapter(
  firstLine: string,
  registry: SessionAdapterRegistry = SESSION_ADAPTER_REGISTRY,
): SessionAdapter | null {
  for (const adapter of registry.values()) {
    if (adapter.detect(firstLine)) return adapter;
  }
  return null;
}

/** Adapter by id; throws with the registered list on an unknown id. */
export function getAdapter(
  id: string,
  registry: SessionAdapterRegistry = SESSION_ADAPTER_REGISTRY,
): SessionAdapter {
  const adapter = registry.get(id);
  if (adapter === undefined) {
    throw new Error(
      `no SessionAdapter registered with id '${id}' - registered: ${[...registry.keys()].join(", ")}`,
    );
  }
  return adapter;
}
