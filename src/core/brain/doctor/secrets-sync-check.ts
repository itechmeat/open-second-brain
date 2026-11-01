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

import { readFileSync } from "node:fs";

import { attestationKeyPaths, attestationKeysDir } from "../attestation/signing.ts";
import {
  attestationKeysSyncExposure,
  formatAttestationKeysSyncExposure,
  formatAttestationWrappedKeysSyncExposure,
  formatSecretsSyncExposure,
  secretsSyncExposure,
} from "../secrets/sync-exposure.ts";
import { isEnvelopeBytes } from "../secrets/envelope.ts";
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
    // The row's path is the keys directory, not the shared .stignore:
    // two rows under one code stay machine-distinguishable instead of
    // separating only by prose (and a consumer deduping on code+path
    // cannot drop one). A wrapped private half gets the envelope wording:
    // what would sync is the envelope, and the passphrase is the
    // protection left on a peer.
    let wrapped = false;
    try {
      wrapped = isEnvelopeBytes(readFileSync(attestationKeyPaths(ctx.vault).privatePath));
    } catch {
      // The sweep already proved the private half exists; an unreadable
      // one keeps the plain wording.
    }
    out.issues.push({
      severity: "warning",
      code: SECRETS_SYNC_EXPOSED_CODE,
      path: attestationKeysDir(ctx.vault),
      message: wrapped
        ? formatAttestationWrappedKeysSyncExposure(keysExposure)
        : formatAttestationKeysSyncExposure(keysExposure),
    } satisfies DoctorIssue);
  },
};
