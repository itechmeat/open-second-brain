/**
 * U1 - is the schema pack still the one that was applied?
 *
 * The `schema:` block of `Brain/_brain.yaml` is the operator-curated
 * ontology that gates every Brain write. Until now four distinct
 * conditions rendered identically on every read surface: the pack is
 * exactly what the last audited apply produced; it has been hand-edited
 * since; nothing has ever been applied so there is no expectation to
 * compare against; and there is no config file at all. A reader that
 * cannot tell those apart is being told nothing, which is the failure this
 * wave exists to remove.
 *
 * The mechanism is a digest recorded at apply time and recomputed at read
 * time:
 *
 *   - `ok`         - the pack on disk digests to the value the newest
 *                    audited apply recorded.
 *   - `modified`   - it does not, and the mismatch names both sides.
 *   - `unverified` - no honest comparison could be made, with a reason
 *                    saying which of the three ways that happened.
 *
 * ## Why the digest is over the RENDERED block, not the raw file
 *
 * {@link computeSchemaPackDigest} hashes `renderSchemaBlock(pack)`. That
 * reuses the canonical serializer the apply path already writes through,
 * so the read side and the write side cannot drift into two encodings of
 * one ontology. It also makes the digest invariant to everything in
 * `_brain.yaml` that is not ontology - comments, blank lines, key order
 * elsewhere in the file - so only a real change of the declared schema
 * moves it, and an operator who reflows a comment is not accused of
 * tampering.
 *
 * ## There is exactly one pack
 *
 * `listSchemaPacks` returns a hardcoded single entry: there is no pack
 * registry, no external pack, and a prior release explicitly refused
 * pack-by-URL. There is also no signature machinery anywhere in this
 * project. So `unverified` never means "the signature could not be
 * checked" - it means precisely one of the three named reasons below, and
 * nothing here should be read as a stronger claim than that.
 *
 * ## Not a degradation code
 *
 * `DEGRADATION_CODE` in `../integrity/degradation.ts` is consumed by
 * exhaustive switches with `never` defaults, so widening it is a
 * compile-breaking edit for unrelated consumers. This unit owns its own
 * closed vocabulary instead, registered in the verdict-vocabulary census.
 * The mismatch it reports, on the other hand, IS the shared
 * {@link StampMismatch} shape, so `modified` renders through the same
 * `formatStampMismatch` every other integrity surface uses.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../integrity/digest.ts";
import { compareStamps, type StampMismatch } from "../integrity/stamp.ts";
import { brainDirs } from "./paths.ts";
import { readSchemaPackSource, renderSchemaBlock, type SchemaPack } from "./schema-pack.ts";

/** The three answers a schema-pack integrity read can honestly give. */
export const SCHEMA_PACK_INTEGRITY = Object.freeze({
  /** The pack on disk matches the digest the newest audited apply recorded. */
  ok: "ok",
  /** It does not match; `mismatches` names the recorded and the live digest. */
  modified: "modified",
  /** No comparison was possible; `unverified_reason` says why. */
  unverified: "unverified",
} as const);

/** Closed union over {@link SCHEMA_PACK_INTEGRITY}. */
export type SchemaPackIntegrityStatus =
  (typeof SCHEMA_PACK_INTEGRITY)[keyof typeof SCHEMA_PACK_INTEGRITY];

/** Membership list, in reporting order from best-known to least-known. */
export const SCHEMA_PACK_INTEGRITY_STATUSES: ReadonlyArray<SchemaPackIntegrityStatus> =
  Object.freeze([
    SCHEMA_PACK_INTEGRITY.ok,
    SCHEMA_PACK_INTEGRITY.modified,
    SCHEMA_PACK_INTEGRITY.unverified,
  ]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isSchemaPackIntegrityStatus(value: unknown): value is SchemaPackIntegrityStatus {
  return (
    typeof value === "string" &&
    (SCHEMA_PACK_INTEGRITY_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Why no comparison could be made. Each member is a fact about this
 * vault's files, never a guess about intent: none of them is a softer way
 * of saying `ok`.
 */
export const SCHEMA_PACK_UNVERIFIED_REASON = Object.freeze({
  /**
   * The mutation-audit directory does not exist, or holds no
   * `schema_apply_mutations` record. Nothing was ever applied through the
   * audited path, so there is no recorded expectation to compare against.
   */
  noApplyRecorded: "no-apply-recorded",
  /**
   * The audit trail exists but could not be believed: a shard would not
   * read, a line would not parse, a record carried an unusable timestamp,
   * or the newest apply record carried no digest. Deliberately NOT `ok` -
   * an unreadable expectation is an absent one.
   */
  auditUnreadable: "audit-unreadable",
  /** `Brain/_brain.yaml` does not exist, so there is no pack to digest. */
  configAbsent: "config-absent",
} as const);

/** Closed union over {@link SCHEMA_PACK_UNVERIFIED_REASON}. */
export type SchemaPackUnverifiedReason =
  (typeof SCHEMA_PACK_UNVERIFIED_REASON)[keyof typeof SCHEMA_PACK_UNVERIFIED_REASON];

/** Membership list for {@link SCHEMA_PACK_UNVERIFIED_REASON}. */
export const SCHEMA_PACK_UNVERIFIED_REASONS: ReadonlyArray<SchemaPackUnverifiedReason> =
  Object.freeze([
    SCHEMA_PACK_UNVERIFIED_REASON.noApplyRecorded,
    SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable,
    SCHEMA_PACK_UNVERIFIED_REASON.configAbsent,
  ]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isSchemaPackUnverifiedReason(value: unknown): value is SchemaPackUnverifiedReason {
  return (
    typeof value === "string" &&
    (SCHEMA_PACK_UNVERIFIED_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Directory under `Brain/log/` holding the schema-mutation audit shards.
 * The writer and this reader must agree on it, so it is a constant rather
 * than the literal that used to sit at the apply site alone.
 */
export const SCHEMA_MUTATION_AUDIT_DIR = "schema-mutations";

/** The `action` value the apply path stamps on every mutation record. */
export const SCHEMA_MUTATION_AUDIT_ACTION = "schema_apply_mutations";

/** Key under an audit record's `details` holding the resulting pack digest. */
export const SCHEMA_PACK_DIGEST_FIELD = "pack_digest";

/** Audit shards are JSON Lines, one record per line. */
const AUDIT_SHARD_EXTENSION = ".jsonl";

/**
 * The shape of a digest this project writes: lowercase hex, nothing else.
 * The length is deliberately not asserted - the algorithm belongs to
 * `../integrity/digest.ts` and a future migration there must not have to
 * edit a number here - but a blank or non-hex value is not a digest and is
 * treated as an unreadable record rather than as a mismatch.
 */
const HEX_DIGEST_RE = /^[0-9a-f]+$/;

/** Frozen empty list, so every no-mismatch result shares one instance. */
const NO_MISMATCHES: ReadonlyArray<StampMismatch> = Object.freeze([]);

/**
 * The recorded expectation, or the named reason there is not one.
 *
 * A discriminated union rather than a nullable digest: a caller cannot
 * read the digest without having first established that one was found, so
 * "no expectation" can never be mistaken for "an empty expectation".
 */
export type RecordedSchemaPackDigest =
  | {
      readonly found: true;
      /** Digest of the pack the newest audited apply produced. */
      readonly digest: string;
      /** That apply's ISO-8601 timestamp, verbatim from the record. */
      readonly recorded_at: string;
      /** The shard the record was read from. */
      readonly audit_path: string;
    }
  | { readonly found: false; readonly reason: SchemaPackUnverifiedReason };

/** The verdict on one vault's schema pack. */
export interface SchemaPackIntegrity {
  readonly status: SchemaPackIntegrityStatus;
  /**
   * Digest of the pack currently on disk, or `null` when there is no
   * config file to digest. Never a digest of the substituted default:
   * digesting a file that is not there would be the fabrication this
   * whole unit exists to prevent.
   */
  readonly digest: string | null;
  /** The recorded digest, present only when one was found. */
  readonly expected?: string;
  /** When that digest was recorded, present only when one was found. */
  readonly recorded_at?: string;
  /** Which shard it was read from, present only when one was found. */
  readonly audit_path?: string;
  /** Present exactly when `status` is `unverified`. */
  readonly unverified_reason?: SchemaPackUnverifiedReason;
  /**
   * Non-empty exactly when `status` is `modified`, carrying the shared
   * mismatch shape so it renders through `formatStampMismatch`.
   */
  readonly mismatches: ReadonlyArray<StampMismatch>;
}

/** Absolute path of this vault's schema-mutation audit directory. */
export function schemaMutationAuditDir(vault: string): string {
  return join(brainDirs(vault).log, SCHEMA_MUTATION_AUDIT_DIR);
}

/**
 * Digest of a pack's canonical rendering - see the module docblock for why
 * the rendered block rather than the file is the thing that is hashed.
 */
export function computeSchemaPackDigest(pack: SchemaPack): string {
  return sha256Hex(renderSchemaBlock(pack));
}

/**
 * Read the digest recorded by the newest audited apply.
 *
 * "Newest" is by the record's own timestamp, not by shard name or line
 * order, so a replicated shard arriving out of order cannot make an older
 * apply win. Any shard that will not read, any line that will not parse,
 * and any record whose timestamp is unusable fails the whole read as
 * {@link SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable} rather than being
 * skipped: a partially-read audit trail would let a missing record present
 * as a clean one.
 */
export function readRecordedSchemaPackDigest(vault: string): RecordedSchemaPackDigest {
  const dir = schemaMutationAuditDir(vault);
  if (!existsSync(dir)) return notFound(SCHEMA_PACK_UNVERIFIED_REASON.noApplyRecorded);

  let shards: ReadonlyArray<string>;
  try {
    shards = readdirSync(dir)
      .filter((entry) => entry.endsWith(AUDIT_SHARD_EXTENSION))
      .toSorted();
  } catch {
    return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
  }

  let newest: { record: Record<string, unknown>; at: number; path: string } | null = null;
  for (const shard of shards) {
    const path = join(dir, shard);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
      }
      if (!isRecord(parsed)) return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
      if (parsed["action"] !== SCHEMA_MUTATION_AUDIT_ACTION) continue;
      const timestamp = parsed["timestamp"];
      if (typeof timestamp !== "string") {
        return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
      }
      const at = Date.parse(timestamp);
      if (!Number.isFinite(at)) return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
      if (newest === null || at >= newest.at) newest = { record: parsed, at, path };
    }
  }
  if (newest === null) return notFound(SCHEMA_PACK_UNVERIFIED_REASON.noApplyRecorded);

  const details = newest.record["details"];
  const digest = isRecord(details) ? details[SCHEMA_PACK_DIGEST_FIELD] : undefined;
  // An apply predating this feature recorded which mutations were
  // requested but no digest of the pack they produced. That record cannot
  // support a comparison, and reporting `ok` off the back of it would be a
  // claim nothing checked.
  if (typeof digest !== "string" || !HEX_DIGEST_RE.test(digest)) {
    return notFound(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
  }
  const recordedAt = newest.record["timestamp"] as string;
  return Object.freeze({
    found: true as const,
    digest,
    recorded_at: recordedAt,
    audit_path: newest.path,
  });
}

/**
 * Compare the pack on disk against the digest the newest audited apply
 * recorded, and say which of the four conditions this vault is in.
 */
export function assessSchemaPackIntegrity(vault: string): SchemaPackIntegrity {
  const source = readSchemaPackSource(vault);
  if (!source.present) {
    return Object.freeze({
      status: SCHEMA_PACK_INTEGRITY.unverified,
      digest: null,
      unverified_reason: SCHEMA_PACK_UNVERIFIED_REASON.configAbsent,
      mismatches: NO_MISMATCHES,
    });
  }

  const digest = computeSchemaPackDigest(source.pack);
  const recorded = readRecordedSchemaPackDigest(vault);
  if (!recorded.found) {
    return Object.freeze({
      status: SCHEMA_PACK_INTEGRITY.unverified,
      digest,
      unverified_reason: recorded.reason,
      mismatches: NO_MISMATCHES,
    });
  }

  // The ungated comparison: this surface reports what it finds regardless
  // of any operator gate, and it reports it in the shape every other
  // integrity surface in this project emits.
  const mismatches = compareStamps(
    { [SCHEMA_PACK_DIGEST_FIELD]: recorded.digest },
    { [SCHEMA_PACK_DIGEST_FIELD]: digest },
  );
  return Object.freeze({
    status: mismatches.length === 0 ? SCHEMA_PACK_INTEGRITY.ok : SCHEMA_PACK_INTEGRITY.modified,
    digest,
    expected: recorded.digest,
    recorded_at: recorded.recorded_at,
    audit_path: recorded.audit_path,
    mismatches,
  });
}

function notFound(reason: SchemaPackUnverifiedReason): RecordedSchemaPackDigest {
  return Object.freeze({ found: false as const, reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
