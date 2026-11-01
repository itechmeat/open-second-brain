/**
 * Does Syncthing carry key material to other machines?
 *
 * A WARNING rather than an error: nothing in the vault is broken and the
 * operator may sync to machines they own on purpose. But the keyfile and
 * the ciphertext it decrypts travel together, so a peer holds the secrets
 * in the clear-equivalent - which contradicts the "stays on this machine"
 * reading of the secrets store unless the operator decided otherwise. The
 * finding names the exact `.stignore` line; the doctor never edits it.
 *
 * The attestation signing key answers the same question under the same
 * code: keygen seeds only git exclusion for the keys directory, and the
 * signing module's own header hands file-syncer exclusion to the
 * operator's `.stignore` "which the doctor names" - so this is the
 * naming. Its finding is its own row, and stays silent while no key
 * directory exists.
 */

import {
  attestationKeysSyncExposure,
  formatAttestationKeysSyncExposure,
  formatSecretsSyncExposure,
  secretsSyncExposure,
} from "../secrets/sync-exposure.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

export const SECRETS_SYNC_EXPOSED_CODE = "secrets-sync-exposed";

export const secretsSyncExposureCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const exposure = secretsSyncExposure(ctx.vault);
    if (exposure !== null) {
      out.issues.push({
        severity: "warning",
        code: SECRETS_SYNC_EXPOSED_CODE,
        path: exposure.stignorePath,
        message: formatSecretsSyncExposure(exposure),
      } satisfies DoctorIssue);
    }
    const keysExposure = attestationKeysSyncExposure(ctx.vault);
    if (keysExposure === null) return;
    out.issues.push({
      severity: "warning",
      code: SECRETS_SYNC_EXPOSED_CODE,
      path: keysExposure.stignorePath,
      message: formatAttestationKeysSyncExposure(keysExposure),
    } satisfies DoctorIssue);
  },
};
