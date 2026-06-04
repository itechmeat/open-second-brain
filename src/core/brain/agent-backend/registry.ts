/**
 * Memory backend registry (Agent Write Contract Suite, t_53f9f67f).
 *
 * Frozen map of registered format adapters with config-driven
 * selection: the `memory_backend` device-config key picks the backend,
 * `claude` is the default, and an unknown id fails loudly with the
 * registered list - never a silent fallback to the wrong format.
 */

import { discoverConfig } from "../../config.ts";
import { claudeMemoryBackend } from "./claude.ts";
import type { MemorySourceBackend } from "./types.ts";

export const DEFAULT_MEMORY_BACKEND_ID = "claude";

const REGISTRY: ReadonlyMap<string, MemorySourceBackend> = new Map([
  [claudeMemoryBackend.id, claudeMemoryBackend],
]);

/** Registered backends in registration order. */
export function listMemoryBackends(): ReadonlyArray<MemorySourceBackend> {
  return Object.freeze([...REGISTRY.values()]);
}

/** Backend by id; throws with the registered list on an unknown id. */
export function getMemoryBackend(id: string): MemorySourceBackend {
  const backend = REGISTRY.get(id);
  if (backend === undefined) {
    throw new Error(
      `unknown memory backend '${id}' - registered: ${[...REGISTRY.keys()].join(", ")}`,
    );
  }
  return backend;
}

/**
 * Resolve the active backend from the device config. A missing config
 * file or absent key means the default - existing setups see zero
 * behavior change.
 */
export function resolveMemoryBackend(configPath?: string | null): MemorySourceBackend {
  const discovery = discoverConfig(configPath ?? undefined);
  const id = discovery.data["memory_backend"]?.trim() || DEFAULT_MEMORY_BACKEND_ID;
  return getMemoryBackend(id);
}
