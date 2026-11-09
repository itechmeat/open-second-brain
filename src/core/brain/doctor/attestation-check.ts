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

import { isStoreOnly } from "../../store/store-only.ts";
import { resolveAppendShardId } from "../ledger-shards.ts";
import { brainDirs } from "../paths.ts";
import { msToWholeDays } from "../time.ts";
import {
  attestationsDir,
  listAttestationRecordFiles,
  readAttestationEntry,
  type AttestationEntry,
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
    let files: ReadonlyArray<AttestationEntry>;
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
    let newest = files.at(-1);
    if (newest === undefined) return;

    let record;
    try {
      record = readAttestationEntry(newest);
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
    // A store-only machine lists the attestations every device signed.
    // This machine's own newest one is the one its key vouches for; a
    // peer's record is checked only when this machine signed none.
    const local = resolveAppendShardId();
    if (record.deviceId !== local) {
      for (let i = files.length - 2; i >= 0; i--) {
        const entry = files[i]!;
        let own;
        try {
          own = readAttestationEntry(entry);
        } catch {
          continue;
        }
        if (own.deviceId !== local) continue;
        newest = entry;
        record = own;
        break;
      }
    }
    const signedHere = record.deviceId === local;

    const facts: string[] = [];

    // A missing key matters only here, where signed evidence exists that
    // the operator can no longer extend. The fact states exactly what is
    // lost - the ability to SIGN: while the exported public half
    // survives, every past attestation still verifies against it, and
    // keygen itself refuses while either half exists, so the remedy
    // never destroys evidence.
    const { privatePath } = attestationKeyPaths(ctx.vault);
    const keyMissing = !existsSync(privatePath);
    if (keyMissing) {
      facts.push(
        "the private half of the attestation signing key is missing, so no new " +
          "attestation can be signed (the surviving public half, if present, still " +
          "verifies the past ones; keygen refuses while either half exists)",
      );
    }

    const ageMs = ctx.now.getTime() - Date.parse(record.createdAt);
    if (!Number.isFinite(ageMs)) {
      // An unparseable created-at cannot count as fresh: failed reads
      // are named, never flattened into a clean bill.
      pushUncertain(out.uncertain, {
        code: ATTESTATION_STATE_UNMEASURED_CODE,
        path: newest.path,
        message:
          `the newest attestation (${record.id}) carries a created_at this pass cannot ` +
          "parse, so whether it is past its window is unknown",
      });
    } else {
      const ageDays = msToWholeDays(ageMs);
      if (ageDays > ATTESTATION_STALE_DAYS) {
        facts.push(
          `the newest attestation (${record.id}) is ${ageDays} days old, past the ` +
            `${ATTESTATION_STALE_DAYS}-day window - the store point it vouches for recedes`,
        );
      }
    }

    let verification;
    try {
      verification = verifyAttestation(ctx.vault, record, {
        publicPath: attestationKeyPaths(ctx.vault).publicPath,
      });
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
    // Once the switch removed the legacy log, the day files an attestation
    // binds are gone by design: no shard can be checked, which is not
    // damage but a verification this machine can no longer make.
    const legacyLogGone =
      isStoreOnly({
        vault: ctx.vault,
        ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      }) && !existsSync(brainDirs(ctx.vault).log);
    if (legacyLogGone) {
      pushUncertain(out.uncertain, {
        code: ATTESTATION_STATE_UNMEASURED_CODE,
        path: attestationsDir(ctx.vault),
        message:
          `the newest attestation (${record.id}) binds legacy log day files this vault no ` +
          "longer holds (the brain moved to the store), so it can no longer be verified",
      });
    }
    const diverged = legacyLogGone
      ? []
      : verification.shards.filter(
          (shard) => shard.state === "diverged" || shard.state === "missing",
        );
    const unexplainedDrift = !legacyLogGone && verification.unexplainedDrift;
    // The kernel could not re-measure the manifest: whether the store
    // still matches is unknown, which is the uncertain stream's question
    // - never a clean bill and never a damage fact.
    if (!verification.storeMeasured) {
      pushUncertain(out.uncertain, {
        code: ATTESTATION_STATE_UNMEASURED_CODE,
        path: attestationsDir(ctx.vault),
        message:
          `the store could not be measured against the newest attestation (${record.id}) ` +
          "this pass - a log lock was held or a surface could not be read - so whether it " +
          "still matches the signed point is unknown",
      });
    }
    // Another device signs with its own key, so a peer's record never
    // verifies against this machine's: that is no fact about this vault.
    if (!verification.signatureValid && signedHere) {
      facts.push("the newest attestation's signature does not verify against this vault's key");
    }
    if (unexplainedDrift) {
      // The same rule `o2b brain attest verify` exits on, computed once
      // in the kernel: a manifest change no shard verdict explains.
      facts.push(
        "the store no longer matches the attested manifest beyond the log shards - an " +
          "inventoried ledger directory, the vault identity or the search index changed since " +
          "signing",
      );
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
    // Damage first (verify): the shard walk and the manifest diff need
    // no key, so a store with diverged shards is inspected before any
    // key decision. Keygen REFUSES while either half exists, so it is
    // the remedy only when both are gone and nothing is damaged;
    // otherwise a missing key is answered by the verdict the surviving
    // half still verifies, and age alone by a re-sign.
    const publicMissing = !existsSync(attestationKeyPaths(ctx.vault).publicPath);
    let nextCommand = "o2b brain attest sign";
    if (diverged.length > 0 || unexplainedDrift || !verification.storeMeasured) {
      // An unmeasured store is not one to vouch for either: inspect (or
      // re-run) before any key or signing decision.
      nextCommand = "o2b brain attest verify";
    } else if (keyMissing && publicMissing) {
      nextCommand = "o2b brain attest keygen";
    } else if (keyMissing || (signedHere && !verification.signatureValid)) {
      nextCommand = "o2b brain attest verify";
    }
    out.issues.push({
      severity: "warning",
      code: ATTESTATION_CHECK_CODE,
      path: attestationsDir(ctx.vault),
      message: `${facts.join("; ")} - inspect with ${nextCommand}`,
    } satisfies DoctorIssue);
  },
};
