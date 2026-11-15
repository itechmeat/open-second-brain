/**
 * The store-only half of the schema mutation lane (design D14 item 3,
 * task 2.11): `applySchemaMutations` (`./schema-mutate.ts`) hands a
 * store-only machine's apply here.
 *
 * The next pack is computed from the pack in force (the shared
 * `brain.schema.<field>` records, read through `./schema-pack.ts`) by the
 * same function the file path uses, passed in as `next` so this module
 * does not import the lane back. It is written as shared settings records
 * through the one settings writer (`./schema-pack-store.ts`): human
 * authority from the CLI, agent authority from MCP, an agent never
 * changing a field the operator set. The apply is audited by one row of
 * the store's audit ledger (`appendAuditRecord` routes it there on a
 * store-only machine). Nothing under the vault's `Brain/` is written; the
 * lock is device-local.
 *
 * The audit row attests the shared pack records, so it is written to
 * `shared` too (task 3.11): a machine that holds only `shared` reads the
 * digest it must hold the pack against, and reports another device's
 * apply as attested instead of `modified`. The shared row carries no
 * reason on a machine that holds `private`, where the whole row goes as
 * before; see `sharedAttestation`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentName } from "../config.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import {
  AUDIT_STORE_LEDGER_NAME,
  appendAuditRecord,
  auditRowNamesPrivatePage,
  type AuditRecord,
} from "../reliability/audit.ts";
import { withFileLock } from "../reliability/lock.ts";
import { authorityFromOrigin } from "../store/dual-write.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import { storesStateDir } from "../store/store-paths.ts";
import { brainDirs } from "./paths.ts";
import {
  computeSchemaPackDigest,
  SCHEMA_MUTATION_AUDIT_ACTION,
  SCHEMA_MUTATION_AUDIT_DIR,
  SCHEMA_PACK_DIGEST_FIELD,
} from "./schema-integrity.ts";
import { loadSchemaPack, renderSchemaBlock, type SchemaPack } from "./schema-pack.ts";
import { STORE_SCHEMA_PACK_SOURCE, writeSchemaPackToStore } from "./schema-pack-store.ts";

/** Device-local lock of a store-only schema apply (under the stores state dir). */
const SCHEMA_PACK_STORE_LOCK = "schema-pack";

/** What a store-only apply names as its audit trail: the store's audit ledger. */
export const SCHEMA_AUDIT_STORE_NAME = AUDIT_STORE_LEDGER_NAME;

/** What a store-only apply returns: `ApplySchemaMutationsResult` of the lane. */
export interface StoreSchemaApplyResult {
  readonly applied: number;
  readonly audit_path: string;
  readonly pack: SchemaPack;
  readonly pack_digest: string;
}

export interface StoreSchemaApplyOptions {
  readonly actor: string;
  readonly now: Date;
  readonly reason?: string;
  readonly lockStaleMs?: number;
  /** Authority of the records (default: the process's origin). */
  readonly authority?: "human" | "agent";
  /** The next pack from the one in force (the lane's own validator runs here). */
  readonly next: (current: SchemaPack) => SchemaPack;
}

export async function applySchemaMutationsToStore(
  vault: string,
  /** The batch, recorded in the audit row as given. */
  mutations: ReadonlyArray<unknown>,
  opts: StoreSchemaApplyOptions,
): Promise<StoreSchemaApplyResult> {
  const lockDir = storesStateDir(processDirsEnv());
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, SCHEMA_PACK_STORE_LOCK);
  return await withFileLock(lockPath, { staleMs: opts.lockStaleMs ?? 30_000, retries: 3 }, () => {
    const nextPack = opts.next(loadSchemaPack(vault));
    writeSchemaPackToStore(
      {
        vault,
        authority: opts.authority ?? (authorityFromOrigin() === "human" ? "human" : "agent"),
        agent: resolveAgentName(),
      },
      renderSchemaBlock(nextPack),
    );
    const packDigest = computeSchemaPackDigest(nextPack);
    const record: AuditRecord = {
      timestamp: opts.now.toISOString(),
      actor: opts.actor,
      action: SCHEMA_MUTATION_AUDIT_ACTION,
      target: STORE_SCHEMA_PACK_SOURCE,
      ok: true,
      details: {
        applied: mutations.length,
        mutations,
        [SCHEMA_PACK_DIGEST_FIELD]: packDigest,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    };
    const auditRoot = join(brainDirs(vault).log, SCHEMA_MUTATION_AUDIT_DIR);
    const holdsPrivate = configuredStore()?.partitions.has("private") === true;
    const attestation = sharedAttestation(vault, record, holdsPrivate);
    const auditPath = appendAuditRecord(auditRoot, attestation, vault, { attestsShared: true });
    // The whole row, reason included, stays where audit rows always went:
    // `private` on a machine that holds it.
    if (holdsPrivate) appendAuditRecord(auditRoot, record, vault);
    return {
      applied: mutations.length,
      // The row's store shard is a device path; the result names the ledger.
      audit_path: auditPath === "" ? "" : SCHEMA_AUDIT_STORE_NAME,
      pack: nextPack,
      pack_digest: packDigest,
    };
  });
}

/** What the shared row says in place of a batch that names a private page. */
export const SCHEMA_AUDIT_WITHHELD = "the mutations name a private page";

/**
 * The audit row of an apply as the shared partition holds it (task 3.11,
 * design D15 item 3): what attests the pack (actor, time, target, count,
 * digest) and the mutation list, which the shared `brain.schema.*` records
 * hold anyway. The reason is free text an operator wrote: it is left off
 * the shared row on a machine that holds `private`, where the whole row
 * goes as every audit row does, and kept on it on a machine that does
 * not, as before. One privacy verdict covers the batch and the reason (a
 * private page named, by the rule every audit row is judged by, or a
 * `<private>` region): when it holds, the shared row keeps only the
 * attestation and says so.
 */
function sharedAttestation(vault: string, record: AuditRecord, holdsPrivate: boolean): AuditRecord {
  const details = record.details ?? {};
  const isPrivate =
    auditRowNamesPrivatePage(vault, record) || valueCarriesPrivateRegion(record.details);
  const { reason, mutations, ...attests } = details;
  return {
    ...record,
    details: {
      ...attests,
      ...(isPrivate ? { withheld: SCHEMA_AUDIT_WITHHELD } : { mutations }),
      ...(!isPrivate && !holdsPrivate && reason !== undefined ? { reason } : {}),
    },
  };
}
