/**
 * Doctor finding: machine state a switch kept aside (task 2.10, Golem
 * review finding 3).
 *
 * When a machine switches, every fresh vault's state folder moves into the
 * one switched folder (`state/machine-state.ts`). A file two vaults both
 * held with different bytes is never dropped: the first vault's copy stays
 * live and the other's is kept under `adopt-conflicts/<vault key>/`. The
 * finding names each such folder, how many files it holds and the live
 * folder they met, with the remedy: compare, copy over what is still
 * needed, then delete the folder. No command can choose between the two
 * copies, so the remedy is manual.
 *
 * Silent when nothing was kept aside. Read-only.
 */

import { adoptConflictFolders } from "../../state/machine-state.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

/** Files a switch kept aside under `adopt-conflicts/`. */
export const ADOPT_CONFLICTS_CODE = "machine-state-adopt-conflicts";

export const adoptConflictsCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    for (const { folder, live, files } of adoptConflictFolders(ctx.configPath)) {
      out.issues.push({
        severity: "warning",
        code: ADOPT_CONFLICTS_CODE,
        path: folder,
        message:
          `${files} file(s) of machine state were kept aside in ${folder} when this machine ` +
          `switched: two vaults held them with different bytes, and the copies in ${live} are ` +
          "the live ones. Compare each kept file (its path below the vault key folder is its " +
          "path in the live folder) with the live copy, copy over what is still needed, then " +
          "delete the folder",
      });
    }
  },
};
