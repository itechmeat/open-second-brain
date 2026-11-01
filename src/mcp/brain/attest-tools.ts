/**
 * Read-only MCP exposure of the attestation family (delivery trust, card
 * t_3bdb82b0, lane D task D6).
 *
 * The `brain_secrets` split applied to signatures: the agent-facing
 * subset is READ-ONLY (list the signed records, verify the store against
 * the newest one), and every operation that mints or holds a key -
 * keygen, sign - stays on the operator CLI (`o2b brain attest`). A
 * signing key is an operator credential the way the custody store is:
 * an agent that could mint one would attest nothing an operator vouches
 * for, so no mutation operation exists in this schema to widen later by
 * accident.
 *
 * Both operations carry no vault note content - ids, timestamps, device
 * ids, shard names, hashes and verdicts only - so they answer at every
 * reach; the withheld-row and local-only refusals of the content tools
 * have nothing to refuse here.
 */

import {
  listAttestationRecordFiles,
  readAttestationRecordFile,
} from "../../core/brain/attestation/record.ts";
import { verifyAttestation } from "../../core/brain/attestation/verify.ts";
import { unknownOperationError } from "../coerce.ts";
import { INTERNAL_ERROR, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { vaultRelativeSafe } from "./shared.ts";

async function toolBrainAttestations(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = args["operation"];
  if (operation !== "list" && operation !== "verify") {
    // The shared dispatch refusal: every operation-dispatching tool
    // answers an out-of-set operation with the unknown_operation code.
    throw unknownOperationError(
      "brain_attestations: operation must be list|verify " +
        "(keygen and sign are operator CLI verbs: o2b brain attest)",
    );
  }

  try {
    if (operation === "list") {
      // Name order is time order (the id is the compact UTC instant);
      // newest first, the way an operator scans for "the latest word".
      const attestations = listAttestationRecordFiles(ctx.vault)
        .toReversed()
        .map((entry) => {
          const record = readAttestationRecordFile(entry.path);
          return {
            id: record.id,
            created_at: record.createdAt,
            device_id: record.deviceId,
            store_digest: record.storeDigest,
            path: vaultRelativeSafe(ctx.vault, entry.path),
          };
        });
      return { attestations };
    }

    const newest = listAttestationRecordFiles(ctx.vault).at(-1);
    if (newest === undefined) return { verified: null };
    // The K4 AttestationVerification shape, returned as-is: the CLI's
    // `--json` emits the same object, and the two faces must not disagree
    // about what a verification result contains. Spread rather than cast:
    // the kernel's readonly interface has no index signature, and a fresh
    // object literal is what Record<string, unknown> admits without one -
    // same fields, same order, nothing invented.
    return { ...verifyAttestation(ctx.vault, readAttestationRecordFile(newest.path)) };
  } catch (exc) {
    if (exc instanceof MCPError) throw exc;
    // A record file that exists but cannot be read is damage to name,
    // never an empty answer: silently dropping evidence is the one
    // failure this family exists to prevent.
    throw new MCPError(
      INTERNAL_ERROR,
      `brain_attestations: ${(exc as Error).message ?? String(exc)}`,
    );
  }
}

/**
 * The `brain_attestations` tool. One name, two read operations, kind
 * `read` - the dispatch class is stated here at registration, and the
 * writer-partitioned tool table excludes it by construction.
 */
export const ATTEST_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "brain_attestations",
    kind: "read",
    description:
      "List Ed25519-signed store attestations (newest first: id, created-at, device, digest) " +
      "or verify the store against the newest one (per-shard verdicts and the signature). " +
      "Report-only store evidence, no note content; keygen and sign are operator CLI verbs " +
      "(o2b brain attest).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "verify"],
          description:
            "list returns the attestation records newest-first; verify re-measures the store " +
            "against the newest attestation and returns per-shard verdicts.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainAttestations,
  },
];
