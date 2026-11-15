/**
 * Whether the work running now answers a caller below local reach (a
 * remote MCP transport), as an ambient scope.
 *
 * Most readers that serve a remote caller take the reach as an explicit
 * view (`brain/reach-view.ts`). A value that the store folds compute deep
 * below every such reader cannot take one: the evidence counters of a
 * preference (`applied_count`, `violated_count`, `outdated_count`) are
 * folded from every partition this machine holds, and a remote caller
 * must see them without the evidence of the `private` partition (task
 * 3.18, design D15 item 4). The MCP server runs each tool call and
 * resource read of a remote transport inside {@link withPrivateWithheld},
 * so every reader below it, the preference facades, the digests, the
 * operator snapshot and the review candidates, answers with the counters
 * a machine that holds only `shared` would fold. Outside any scope (the
 * CLI, hooks, a local transport) nothing is withheld.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<true>();

/**
 * Run `fn` for a caller below local reach when `withhold` is true, and as
 * it is otherwise. Returns what `fn` returns (a promise for an async body,
 * which keeps the scope across its awaits).
 */
export function withPrivateWithheld<T>(withhold: boolean, fn: () => T): T {
  return withhold ? storage.run(true, fn) : fn();
}

/** Whether the caller of the work running now is below local reach. */
export function privateWithheld(): boolean {
  return storage.getStore() === true;
}

/**
 * Run `fn` with nothing withheld, inside a caller's scope too: for work
 * whose result is shared with every later caller, such as a digest cache
 * a local reader is served (a caller below local reach is given its own
 * render, never the cache).
 */
export function withPrivateShown<T>(fn: () => T): T {
  return storage.exit(fn);
}
