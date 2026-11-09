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
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveAgentName } from "../config.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { AUDIT_STORE_LEDGER_NAME, appendAuditRecord } from "../reliability/audit.ts";
import { withFileLock } from "../reliability/lock.ts";
import { authorityFromOrigin } from "../store/dual-write.ts";
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
    const auditPath = appendAuditRecord(
      join(brainDirs(vault).log, SCHEMA_MUTATION_AUDIT_DIR),
      {
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
      },
      vault,
    );
    return {
      applied: mutations.length,
      // The row's store shard is a device path; the result names the ledger.
      audit_path: auditPath === "" ? "" : SCHEMA_AUDIT_STORE_NAME,
      pack: nextPack,
      pack_digest: packDigest,
    };
  });
}
