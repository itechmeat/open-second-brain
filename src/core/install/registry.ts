/**
 * Adapter registry for the install orchestrator.
 *
 * The default registry is populated by each adapter file at import time
 * (`defaultRegistry.register(cursorAdapter)`). Tests get isolated
 * registries via `createRegistry()` so adapter registration doesn't
 * leak across cases.
 */

import type {
  DetectResult,
  InstallAdapter,
  InstallEnv,
} from "./types.ts";

export interface Registry {
  register(adapter: InstallAdapter): void;
  get(target: string): InstallAdapter | undefined;
  list(): ReadonlyArray<InstallAdapter>;
  targets(): ReadonlyArray<string>;
  detectAll(env: InstallEnv): ReadonlyArray<DetectResult>;
}

export function createRegistry(): Registry {
  const order: string[] = [];
  const byTarget = new Map<string, InstallAdapter>();
  return {
    register(adapter) {
      if (byTarget.has(adapter.target)) {
        throw new Error(`duplicate adapter registration for target "${adapter.target}"`);
      }
      byTarget.set(adapter.target, adapter);
      order.push(adapter.target);
    },
    get(target) {
      return byTarget.get(target);
    },
    list() {
      return order.map((t) => byTarget.get(t)!) as ReadonlyArray<InstallAdapter>;
    },
    targets() {
      return [...order];
    },
    detectAll(env) {
      return order.map((t) => byTarget.get(t)!.detect(env));
    },
  };
}

export const defaultRegistry = createRegistry();
