/**
 * The ambient operation scope: every brain store record written while a
 * writer operation runs inherits that operation's privacy verdict, with no
 * per-site threading.
 *
 * A writer operation (a signal, a preference, apply-evidence, a Brain
 * note, a pin, a write batch, a direct note create) runs its body inside
 * {@link withOperationPrivacy}. The dual-write entry point (`dual-write.ts`)
 * reads {@link activeOperationPrivate} for every record it writes and
 * raises the record to `private` when the active verdict is private. So
 * any record written down the call chain (a ledger row, a permissions
 * decision row, an audit event, a receipt, a metric) follows the operation
 * it belongs to, including records the operation's own code never sees.
 *
 * Rules:
 *
 *  - **Raise-only.** The scope can send a record to `private`; it never
 *    lowers a record its builder or the `<private>` region backstop judged
 *    private.
 *  - **Nesting ORs.** An operation started inside another (a batch's note
 *    create, an evidence write's log event) is private when either verdict
 *    is: an inner operation can only raise what it writes.
 *  - **Lazy.** The verdict is called only when a record is written, so dual
 *    writes off judge nothing, exactly as before.
 *  - **Sync and async.** The scope is an `AsyncLocalStorage` store: it
 *    holds for the synchronous body and follows every promise, timer and
 *    callback the body starts, on every platform Node and Bun run on.
 *    Outside any operation there is no scope and nothing is raised.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A verdict as `operation-privacy.ts` spells it (`PrivacyVerdict`): a fixed
 * answer or one judged on first use. Declared here, not imported, because
 * the dual-write entry point reads this module and the privacy judges read
 * the dual-write records.
 */
type ScopeVerdict = boolean | (() => boolean);

const storage = new AsyncLocalStorage<() => boolean>();

function holds(verdict: ScopeVerdict | undefined): boolean {
  return typeof verdict === "function" ? verdict() : verdict === true;
}

/**
 * Run `fn` as one writer operation whose verdict is `verdict`, ORed with
 * the verdict of any enclosing operation. Returns what `fn` returns (a
 * promise for an async body, which keeps the scope across its awaits).
 */
export function withOperationPrivacy<T>(verdict: ScopeVerdict | undefined, fn: () => T): T {
  const outer = storage.getStore();
  let judged: boolean | undefined;
  const scoped = (): boolean => {
    if (judged === undefined) {
      try {
        judged = (outer !== undefined && outer()) || holds(verdict);
      } catch {
        judged = true;
      }
    }
    return judged;
  };
  return storage.run(scoped, fn);
}

/**
 * Whether the writer operation running now is private. `false` outside
 * any operation. Judged once per operation on first use; a verdict that
 * throws counts as private, the partition that leaks nothing.
 */
export function activeOperationPrivate(): boolean {
  return storage.getStore()?.() ?? false;
}
