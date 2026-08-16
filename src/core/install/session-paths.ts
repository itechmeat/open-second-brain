/**
 * The one implementation of `InstallAdapter.sessionPaths`.
 *
 * Ten adapters answer the question and none of them knows a path. That is
 * deliberate: an adapter that spelled its own session roots would be the
 * fifth place in this tree to know where a runtime keeps its transcripts,
 * and the whole argument of `src/core/runtime/host-facts.ts` is that there
 * is exactly one. So every adapter delegates here, and here reads the
 * declaration.
 *
 * Which means the member is not ceremony: it is the seam through which the
 * install layer - which already holds a resolved `InstallEnv` for the host
 * being installed into - can be asked about that host's logs without the
 * caller assembling a {@link HostContext} of its own.
 */

import { resolveSessionRoots, RUNTIME_FACTS, type InstallTargetId } from "../runtime/host-facts.ts";
import type { InstallEnv, SessionPathsResult } from "./types.ts";

/**
 * `target`'s session roots on the host `env` describes, or `null` when
 * this runtime writes no session logs at all.
 *
 * `null` is a stated answer rather than an absence: `generic` prints a
 * payload for a host it was never told the name of, and `aider` and `pi`
 * are wired without a transcript store, so there is nothing on disk for a
 * sweep to find. Reporting an empty root list instead would put three
 * runtimes into every coverage report with a permanent zero.
 */
export function sessionPathsFor(
  target: InstallTargetId,
  env: InstallEnv,
): SessionPathsResult | null {
  const runtime = RUNTIME_FACTS[target].sessionRuntime;
  if (runtime === null) return null;
  return Object.freeze({
    target,
    runtime,
    roots: resolveSessionRoots(target, { home: env.home, env: env.env }),
  });
}
