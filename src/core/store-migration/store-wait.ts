/**
 * What a machine that waits for another device's brain store says (patch
 * 2.0.1): never only "waiting for sync". The store travels inside the
 * vault, in its reserved hidden folder, so the waiting machine names what
 * it waits for and what to check: that the other device runs a release
 * that keeps its store in the vault, that a store 2.0.0 left outside the
 * vault on that device was moved in (`o2b store move-into-vault`, run
 * there by a person; nothing moves it by itself), that it is online and
 * the sync ran, and that the sync tool carries hidden folders.
 *
 * One wording for every surface: the worker's recorded reason, the
 * session notice (once a day), the MCP status block and the doctor.
 */

import { MOVE_INTO_VAULT_COMMAND, STORE_VAULT_DIR } from "../store/constants.ts";

/** The plain waiting text for a store another device created (no store here yet). */
export function storeNotArrivedText(devices: ReadonlyArray<string>, since: string | null): string {
  const who = devices.length > 0 ? `device ${devices.join(", ")}` : "another device";
  const when = since !== null && since !== "" ? ` (waiting since ${since.slice(0, 10)})` : "";
  return (
    `${who} moved this vault's brain into the brain store, and that store has not arrived on ` +
    `this machine yet${when}. The store travels inside the vault, in the hidden folder ` +
    `${STORE_VAULT_DIR}/, and this machine joins it by itself once it arrives. Check that ` +
    `${who} runs Open Second Brain 2.0.1 or later. If it switched on 2.0.0, its store sits ` +
    `outside the vault until someone moves it in: on that machine, close its agent sessions ` +
    `and run ${MOVE_INTO_VAULT_COMMAND}. Check too that it is online and the vault's sync has ` +
    "run on both machines, and that the sync tool carries hidden folders (Obsidian Sync, for " +
    "one, skips folders whose name starts with a dot). Until then this machine's records " +
    "still reach the other machine, but its new records do not reach this one"
  );
}
