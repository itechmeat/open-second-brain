/**
 * Does Syncthing carry the secrets keyfile to other machines?
 *
 * A WARNING rather than an error: nothing in the vault is broken and the
 * operator may sync to machines they own on purpose. But the keyfile and
 * the ciphertext it decrypts travel together, so a peer holds the secrets
 * in the clear-equivalent - which contradicts the "stays on this machine"
 * reading of the secrets store unless the operator decided otherwise. The
 * finding names the exact `.stignore` line; the doctor never edits it.
 */

import { formatSecretsSyncExposure, secretsSyncExposure } from "../secrets/sync-exposure.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

export const SECRETS_SYNC_EXPOSED_CODE = "secrets-sync-exposed";

export const secretsSyncExposureCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const exposure = secretsSyncExposure(ctx.vault);
    if (exposure === null) return;
    out.issues.push({
      severity: "warning",
      code: SECRETS_SYNC_EXPOSED_CODE,
      path: exposure.stignorePath,
      message: formatSecretsSyncExposure(exposure),
    } satisfies DoctorIssue);
  },
};
