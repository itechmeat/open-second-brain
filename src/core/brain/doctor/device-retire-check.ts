/**
 * The doctor finding for a retired device that writes again (design D6,
 * FORMAT.md "State digests"): a human retired it with
 * `o2b store device retire`, and a record it wrote after that retirement
 * has arrived. The device is on the digest roster again, so it is either a
 * machine brought back on purpose (nothing to do but migrate it if it is
 * still on the legacy layout) or a reused device id; only the user knows
 * which.
 */

import type { StorePartition } from "../../store/constants.ts";
import { returnedRetiredDevices } from "../../store/device-roster.ts";
import type { PartitionShard } from "../../store/state-digest.ts";
import type { DoctorIssue } from "../types.ts";

/** A retired device wrote a record after its retirement. */
export const STORE_DEVICE_RETIRED_RETURNED_CODE = "store-device-retired-returned";

/**
 * One warning per retired device that wrote again, over the partitions
 * read in full (the retirements live in `shared`, so without it nothing
 * is reported).
 */
export function returnedRetiredIssues(
  shards: ReadonlyMap<StorePartition, ReadonlyArray<PartitionShard>>,
  sharedRoot: string,
): DoctorIssue[] {
  if (!shards.has("shared")) return [];
  const records = [...shards.values()].flatMap((own) => own.flatMap((s) => s.all));
  return returnedRetiredDevices(records).map(({ device, retire, lastRecordMs }) => ({
    severity: "warning",
    code: STORE_DEVICE_RETIRED_RETURNED_CODE,
    path: sharedRoot,
    message:
      `device ${device} was retired (record ${retire.id}) and wrote again at ` +
      `${new Date(lastRecordMs).toISOString()}, so it is on the digest roster again. If the ` +
      "machine is back on purpose, nothing is wrong (run `o2b brain migrate-store` there if it " +
      `still keeps the legacy layout); if its id was reused by mistake, give that machine its own device_id and ` +
      `run \`o2b store device retire ${device}\` again`,
  }));
}
