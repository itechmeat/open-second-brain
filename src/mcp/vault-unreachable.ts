/**
 * The re-raise of a vault that cannot be reached, ahead of a handler's
 * generic error mapping.
 *
 * The core raises the refusal as `VaultUnexaminableError` (a vault that
 * is not there, or one this process cannot examine). A handler that wraps
 * an unrecognised throw in an `INTERNAL_ERROR` MCPError would lose the
 * class, and the caller would read "internal error" where the answer is a
 * named refusal the error registry already carries: `vault_unreadable`.
 * Re-raising it here keeps the class, and the dispatch boundary answers
 * it as the refusal it is.
 */

import { VaultUnexaminableError } from "../core/vault-unexaminable.ts";

/**
 * Re-raise a vault that cannot be reached ahead of any generic error
 * mapping. A no-op for every other error, so a call site pays one
 * `instanceof`.
 */
export function rethrowVaultUnreadable(err: unknown): void {
  if (err instanceof VaultUnexaminableError) throw err;
}
