/**
 * Attestation doctor check (delivery trust, card t_3bdb82b0, lane D).
 *
 * A failSoft liveness check over the attestation family. An attestation
 * is evidence with a shelf life: it vouches for a store that keeps
 * moving, a key that can be lost, and a signature whose verifier lives
 * in the same vault. Three facts age badly enough to name, and they fold
 * into ONE warning under one code because the operator's first move is
 * the same either way - look at the verdict, then re-sign:
 *
 *   - the private half of the signing key is GONE - reported ONLY when
 *     attestations exist, because a vault that never attests owes no key
 *     and a warning there would be an expectation nobody set;
 *   - the newest attestation is older than {@link ATTESTATION_STALE_DAYS}
 *     - the point it vouches for recedes as the store moves;
 *   - a shard DIVERGED from (or went missing since) the newest
 *     attestation, or its signature no longer verifies - damage, not
 *     progress. An appended store is NOT reported: `appended` shards are
 *     the normal case, and a store that moved is not a store that broke
 *     (the same reading `o2b brain attest verify` exits 0 on).
 *
 * Silences, each deliberate: no attestations at all (nothing to be stale,
 * nothing to diverge); a clean, fresh, keyed attestation; legitimate
 * appends. What cannot be read reaches the uncertain stream under
 * {@link ATTESTATION_STATE_UNMEASURED_CODE} rather than flattening to a
 * clean bill - evidence that cannot be read is exactly what this family
 * exists to keep visible.
 *
 * The clock is {@link DoctorCheckContext.now}, never a global read, so
 * every age below is pinnable from a test.
 */

import { existsSync } from "node:fs";

import { msToWholeDays } from "../time.ts";
import {
  attestationsDir,
  listAttestationRecordFiles,
  readAttestationRecordFile,
} from "../attestation/record.ts";
import { attestationKeyPaths } from "../attestation/signing.ts";
import { verifyAttestation } from "../attestation/verify.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** The one code every finding of this check carries. */
export const ATTESTATION_CHECK_CODE = "attestation-stale-or-diverged";

/** The attestation family could not be read, so its state is unknown. */
export const ATTESTATION_STATE_UNMEASURED_CODE = "attestation-state-unmeasured";

/**
 * How old the newest attestation may be before it is reported.
 *
 * Matches the recovery-point liveness window for the same reason that
 * check states: a month is the coarsest period over which "nothing
 * happened" is still a fact about this vault rather than about the
 * calendar. An attestation is a deliberate operator act (`o2b brain
 * attest sign`), not a side effect of a pass, so the window is a nag
 * threshold, not a freshness SLO.
 */
export const ATTESTATION_STALE_DAYS = 30;

/** At most this many diverged shards are named before the message counts. */
const MAX_NAMED_SHARDS = 3;

export const attestationCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let files: ReadonlyArray<{ path: string; name: string }>;
    try {
      files = listAttestationRecordFiles(ctx.vault);
    } catch {
      pushUncertain(out.uncertain, {
        code: ATTESTATION_STATE_UNMEASURED_CODE,
        path: attestationsDir(ctx.vault),
        message:
          "the attestation records could not be listed, so whether the vault has a " +
          "current attestation is unknown",
      });
      return;
    }
    // No attestations at all: no key is owed, nothing is stale, nothing
    // can have diverged. Silent, with or without a key.
    const newest = files.at(-1);
    if (newest === undefined) return;

    let record;
    try {
      record = readAttestationRecordFile(newest.path);
    } catch {
      pushUncertain(out.uncertain, {
        code: ATTESTATION_STATE_UNMEASURED_CODE,
        path: newest.path,
        message:
          "the newest attestation record could not be read, so whether the store still " +
          "matches the last signed point is unknown",
      });
      return;
    }

    const facts: string[] = [];

    // A missing key matters only here, where signed evidence exists that
    // the operator can no longer extend.
    const { privatePath } = attestationKeyPaths(ctx.vault);
    const keyMissing = !existsSync(privatePath);
    if (keyMissing) {
      facts.push(
        "the private half of the attestation signing key is missing, so no new " +
          "attestation can be signed (a lost key leaves every past one unverifiable)",
      );
    }

    const ageMs = ctx.now.getTime() - Date.parse(record.createdAt);
    const ageDays = msToWholeDays(ageMs);
    const stale = Number.isFinite(ageDays) && ageDays > ATTESTATION_STALE_DAYS;
    if (stale) {
      facts.push(
        `the newest attestation (${record.id}) is ${ageDays} days old, past the ` +
          `${ATTESTATION_STALE_DAYS}-day window - the store point it vouches for recedes`,
      );
    }

    let verification;
    try {
      verification = verifyAttestation(ctx.vault, record);
    } catch {
      pushUncertain(out.uncertain, {
        code: ATTESTATION_STATE_UNMEASURED_CODE,
        path: attestationsDir(ctx.vault),
        message:
          `the newest attestation (${record.id}) could not be verified, so whether the ` +
          "store still matches the signed point is unknown",
      });
      return;
    }
    const diverged = verification.shards.filter(
      (shard) => shard.state === "diverged" || shard.state === "missing",
    );
    if (!verification.signatureValid) {
      facts.push("the newest attestation's signature does not verify against this vault's key");
    }
    if (diverged.length > 0) {
      const named = diverged
        .slice(0, MAX_NAMED_SHARDS)
        .map((shard) => `${shard.shardId}: ${shard.state}`)
        .join(", ");
      const rest = diverged.length - Math.min(diverged.length, MAX_NAMED_SHARDS);
      facts.push(
        `${diverged.length} attested shard(s) diverged or went missing since it was ` +
          `signed (${named}${rest > 0 ? `, and ${rest} more` : ""})`,
      );
    }

    if (facts.length === 0) return;
    // The next command answers the worst fact: damage first (verify),
    // then the missing key (keygen), then age alone (sign).
    const nextCommand =
      diverged.length > 0 || !verification.signatureValid
        ? "o2b brain attest verify"
        : keyMissing
          ? "o2b brain attest keygen"
          : "o2b brain attest sign";
    out.issues.push({
      severity: "warning",
      code: ATTESTATION_CHECK_CODE,
      path: attestationsDir(ctx.vault),
      message: `${facts.join("; ")} - inspect with ${nextCommand}`,
    } satisfies DoctorIssue);
  },
};
