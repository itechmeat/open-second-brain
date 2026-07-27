/**
 * Whether a vault directory is there, with "not there" kept apart from
 * "cannot look".
 *
 * The ordinary probes (`isDir`, `existsSync`) answer `false` for both,
 * which is right for a caller asking only "is this worth opening". It is
 * wrong for a status payload, where that difference IS the product:
 * `vault_exists: false` reads as "this install was never set up", and
 * whatever the field gates then reads as a set of confident negatives -
 * for what is usually one missing execute bit on a parent directory,
 * under a remedy telling the operator to create a vault they already have.
 *
 * This lives in core rather than beside either caller because two
 * independent runtimes publish a `second_brain_status` payload with this
 * field, and one formulation of the condition has to reach the operator
 * from both.
 */

import { statOrAbsent } from "./fs-utils.ts";

/** A declared field whose value could not be resolved, with the reason. */
export type UnresolvedField = { readonly error: string };

export interface VaultPresence {
  /** True only when the path was examined and is a directory. */
  readonly present: boolean;
  /** Non-null when the answer is UNKNOWN rather than known-false. */
  readonly unexaminable: UnresolvedField | null;
}

/**
 * The reason a vault directory could not be examined, as a degraded field.
 *
 * The remedy rides in the message rather than in each reporting surface,
 * the same call the config read failure makes and for the same reason:
 * this condition reaches the operator through a payload field, several
 * degraded blocks and a tool-level refusal, and a remedy rendered per
 * surface would drift between them or be dropped.
 */
export function vaultUnexaminable(vault: string, err: unknown): UnresolvedField {
  const reason = (err as Error)?.message ?? String(err);
  return {
    error:
      `cannot determine whether the vault directory ${vault} exists: ${reason}. ` +
      "It is NOT reported as absent - a path that cannot be examined is not a " +
      "path that is not there; make it and every parent directory traversable " +
      "(chmod u+rx), or set VAULT_DIR to a vault this process can read.",
  };
}

export function probeVaultDirectory(vault: string): VaultPresence {
  try {
    return { present: statOrAbsent(vault)?.isDirectory() === true, unexaminable: null };
  } catch (err) {
    return { present: false, unexaminable: vaultUnexaminable(vault, err) };
  }
}
