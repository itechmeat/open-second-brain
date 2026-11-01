/**
 * The attestation manifest and the store digest over it (delivery trust,
 * card t_3bdb82b0).
 *
 * An attestation answers one operator question: "is the store still the
 * store it was when the log last linked up here?" Answering it needs a
 * definition of store state that is reproducible across a synced,
 * concurrently-appended vault. A whole-tree byte hash is neither (the
 * snapshot module's derived-store analysis documents why: Markdown twins,
 * sync-conflict copies and a live SQLite WAL make the bytes depend on
 * when you looked), so the manifest binds the STAMPS the store already
 * records about itself:
 *
 *   - the vault identity id (`Brain/vault-id.json`),
 *   - one chain head per Brain log JSONL shard, each collected under the
 *     appender's own log-directory lock (`collectLogShardHeads`),
 *   - a file-name inventory of every ledger directory the doctor sweeps,
 *   - the search index's recorded embedding-ABI stamp, hashed to one
 *     token, or null when no index exists - an index that exists but
 *     cannot be read refuses the manifest instead of reading as absent.
 *
 * The digest of that manifest - `sha256Hex(canonicalJson(manifest))`, the
 * one encoding `src/core/integrity/digest.ts` persists - is what a
 * signature is computed over in `signing.ts`. Never `brain.sqlite`'s
 * bytes: a WAL in flight makes them meaningless, which is why the index
 * contributes its stamp token instead.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { peekEmbeddingAbiSync } from "../../search/store/embedding-abi.ts";
import { resolveConfiguredIndexPath } from "../../search/paths.ts";
import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import { AUDIT_WEEK_SHARD_GRAMMAR } from "../../reliability/audit.ts";
import { BRAIN_LOG_AUDIT_DIRS } from "../audit-dirs.ts";
import { parseShardedName, type LedgerShardGrammar } from "../ledger-shards.ts";
import { CONTINUITY_GRAMMAR, continuityLogDir } from "../continuity/store.ts";
import { COMMITS_GRAMMAR, gitStoreRootDir } from "../git/store.ts";
import { IDEMPOTENCY_GRAMMAR, idempotencyLogDir } from "../idempotency-ledger.ts";
import { LINEAGE_STATE_GRAMMARS, brainStateDirPath } from "../lineage/ledger.ts";
import { ANY_SURFACE_GRAMMAR, metricsDir } from "../metrics.ts";
import { BRAIN_SKILL_PROPOSALS_REL } from "../path-constants.ts";
import { brainDirs, hookAuditDir, prefAuditDir } from "../paths.ts";
import { PREF_AUDIT_GRAMMAR } from "../pref-audit.ts";
import { schemaMutationAuditDir } from "../schema-integrity.ts";
import { watchdogFallbackAuditDir } from "../watchdog.ts";
import type { Safeguard } from "../safeguard.ts";
import type { ProgressSink } from "../progress.ts";
import { readVaultIdentity } from "../vault-identity.ts";
import { collectLogShardHeads } from "../log.ts";

/** The manifest schema version, sealed into every manifest and record. */
export const ATTESTATION_MANIFEST_SCHEMA_VERSION = "o2b.attestation.manifest.v1";

/**
 * The store state one attestation vouches for.
 *
 * Every field is a point-in-time measurement of a named surface, keyed
 * so a verifier can re-measure the same surfaces and compare per surface
 * rather than only through the whole digest.
 */
export interface AttestationManifest {
  readonly schemaVersion: "o2b.attestation.manifest.v1";
  /** The `vault_id` of `Brain/vault-id.json`, empty when none was minted yet. */
  readonly vaultIdentityId: string;
  /**
   * One chain head per Brain log JSONL shard, keyed by shard file name.
   * A map, never a single head: the log shards per device per day and
   * there is no total order across shards. Empty when the vault has no
   * log yet.
   */
  readonly logHeads: Readonly<Record<string, string>>;
  /**
   * Per doctor-swept ledger directory, the sorted names of the files it
   * holds, keyed by vault-relative directory path. Directories that do
   * not exist contribute nothing. Transient `.lock` artifacts are
   * excluded - they are created and removed by the writers that made
   * them and are no more state than a process is (the state-surface
   * registry's own reasoning) - so an attestation never fails a verify
   * because a writer happened to hold a lock.
   */
  readonly ledgerInventories: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * The search index's recorded embedding-ABI stamp, hashed to one token.
   * Null when no index exists. Never the database's bytes: a live WAL
   * makes those meaningless.
   */
  readonly indexStamp: string | null;
}

export interface CollectAttestationManifestOptions {
  /**
   * Cooperative deadline guard, consulted at each surface boundary. The
   * walk is a bounded scan of small files, but it is the operator's
   * deadline and it is honoured whenever offered.
   */
  readonly safeguard?: Safeguard;
  /**
   * Accepted per the progress census. Nothing is emitted today: a
   * `ProgressEvent` names an operation from the closed `OPERATION`
   * vocabulary, and no attestation member exists there yet - a
   * mislabelled operation would put an unresolvable name on every live
   * progress stream. Wiring one member into `OPERATION` plus a
   * `progressCounter` here is the whole change when the vocabulary
   * opens to attestation.
   */
  readonly onProgress?: ProgressSink;
}

/**
 * The directories whose file inventory the manifest records: the same
 * ledger directories `syncConflictLogCheck` sweeps in
 * `doctor/store-integrity.ts`, resolved through the same exported path
 * builders that file names, and descended the same way - the per-
 * preference audit parent and the per-repository git store contribute
 * their SUBDIRECTORIES only, because "the root itself holds no ledger"
 * is the doctor's own ruling and a stray file at either root would
 * otherwise flip the store digest with no shard or directory naming
 * why.
 *
 * The doctor's `LEDGER_DIRS` list is module-private, and this module
 * deliberately does not grow a second authority by exporting it from a
 * third place: the binding is this comment plus the digest tests, which
 * drop files into swept directories and assert they surface. A ledger
 * directory added to the doctor's sweep without joining the list here
 * attests a state that can change invisibly - the tests are where that
 * drift is caught.
 */
function ledgerSweepDirs(vault: string): string[] {
  const logDir = brainDirs(vault).log;
  const dirs = [
    logDir,
    ...BRAIN_LOG_AUDIT_DIRS.map((name) => join(logDir, name)),
    schemaMutationAuditDir(vault),
    watchdogFallbackAuditDir(vault),
    hookAuditDir(vault),
    continuityLogDir(vault),
    idempotencyLogDir(vault),
    prefAuditDir(vault),
    metricsDir(vault),
    brainStateDirPath(vault),
    join(vault, BRAIN_SKILL_PROPOSALS_REL),
    brainDirs(vault).preferences,
  ];
  // Two of the swept roots hold one directory per subject (per
  // preference, per repository), exactly as the doctor's own sweep
  // descends one level for them.
  for (const parent of [prefAuditDir(vault), gitStoreRootDir(vault)]) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(parent, entry.name));
    }
  }
  return dirs;
}

/**
 * For every swept directory that is an APPEND-ONLY ledger, the file-name
 * grammar its producer appends under, keyed the way the inventories are
 * keyed. This is the growth half of the same authority
 * {@link ledgerSweepDirs} is the inventory half of: a verifier may treat
 * a name that parses under the directory's grammar as legitimate
 * post-signing growth, while every other directory stays strict, because
 * an addition there is not something this build's writers produce.
 *
 * The grammars are imported from the producer modules - never restated -
 * so a writer and this map cannot disagree on what one of its shards is
 * called. Directories left out of the map on purpose:
 *
 *   - `Brain/preferences` holds operator-authored state, so ANY addition
 *     is drift;
 *   - the skill-proposals root and the preference-audit ROOT hold no
 *     appendable ledger (proposals live in their phase subdirectories;
 *     the flat per-preference trail is legacy, still read, never
 *     written);
 *   - `Brain/log` itself is the log-shard rule the verifier applies
 *     (a new shard's JSONL beside its markdown twin), which a name
 *     grammar cannot express.
 *
 * A ledger directory added to the sweep without joining this map simply
 * verifies strict - the failure is an honest one, and the digest tests
 * are where the drift is caught.
 */
export function ledgerGrowthGrammars(
  vault: string,
): ReadonlyMap<string, ReadonlyArray<LedgerShardGrammar>> {
  const logDir = brainDirs(vault).log;
  const grammars = new Map<string, ReadonlyArray<LedgerShardGrammar>>();
  const put = (dir: string, layout: ReadonlyArray<LedgerShardGrammar>): void => {
    grammars.set(inventoryKey(vault, dir), layout);
  };
  // The per-device ISO-week audit directories: the four Brain/log audit
  // families, the schema-mutation audit beside them, the hook audit and
  // the watchdog fallback under the derived store - one writer
  // (`appendAuditRecord`) names them all.
  for (const name of BRAIN_LOG_AUDIT_DIRS) put(join(logDir, name), [AUDIT_WEEK_SHARD_GRAMMAR]);
  put(schemaMutationAuditDir(vault), [AUDIT_WEEK_SHARD_GRAMMAR]);
  put(watchdogFallbackAuditDir(vault), [AUDIT_WEEK_SHARD_GRAMMAR]);
  put(hookAuditDir(vault), [AUDIT_WEEK_SHARD_GRAMMAR]);
  put(continuityLogDir(vault), [CONTINUITY_GRAMMAR]);
  put(idempotencyLogDir(vault), [IDEMPOTENCY_GRAMMAR]);
  put(metricsDir(vault), [ANY_SURFACE_GRAMMAR]);
  put(brainStateDirPath(vault), LINEAGE_STATE_GRAMMARS);
  // One shard directory per preference and per repository, the same
  // one-level descent the sweep performs.
  const prefRoot = prefAuditDir(vault);
  const gitRoot = gitStoreRootDir(vault);
  for (const [parent, layout] of [
    [prefRoot, [PREF_AUDIT_GRAMMAR]],
    [gitRoot, [COMMITS_GRAMMAR]],
  ] as const) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) put(join(parent, entry.name), layout);
    }
  }
  return grammars;
}

/** Whether one file name is a lawful shard of one of `layout`'s grammars. */
export function isGrammarValidName(
  name: string,
  layout: ReadonlyArray<LedgerShardGrammar>,
): boolean {
  return layout.some((grammar) => parseShardedName(name, grammar) !== null);
}

/** A directory's file inventory as the manifest records it, or null when absent. */
function inventoryOf(dir: string): ReadonlyArray<string> | null {
  if (!existsSync(dir)) return null;
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir).toSorted();
  } catch {
    // A directory the sweep cannot list is not an empty one. Refusing the
    // whole manifest is the honest answer - an attestation that silently
    // skipped a surface would sign a store it never looked at.
    throw new Error(`attestation: ledger directory ${dir} could not be listed`);
  }
  return Object.freeze(entries.filter((name) => !name.endsWith(".lock")));
}

/** The vault-relative key for a directory: posix separators, deterministic. */
function inventoryKey(vault: string, dir: string): string {
  return relative(vault, dir).split(sep).join("/");
}

/**
 * The index stamp token, or null when no index exists.
 *
 * An index that EXISTS but cannot be read is not "no index": the peek's
 * three outcomes are kept apart, and an unreadable one refuses the
 * manifest - signing a corrupt index as the null stamp would make it
 * digest-identical to a vault with no index, and the recomputed
 * manifest at verify time would call the same corruption a match.
 */
function indexStampToken(vault: string): string | null {
  const peek = peekEmbeddingAbiSync(resolveConfiguredIndexPath(vault));
  if (peek.kind === "absent") return null;
  if (peek.kind === "unreadable") {
    throw new Error(`attestation: the search index exists but could not be read: ${peek.detail}`);
  }
  return sha256Hex(canonicalJson(peek.value));
}

/**
 * Measure every attested surface of `vault` once.
 *
 * Between two calls with no intervening write the manifest is identical
 * and so is its digest - that reproducibility is what makes the digest
 * signable. Each surface boundary consults the {@link Safeguard} when
 * one is offered.
 *
 * Refuses rather than guesses: a vault whose log lock is held, or whose
 * ledger directories cannot be listed, throws instead of producing a
 * partial manifest, because a signature over a partial measurement is
 * worse than no signature at all.
 */
export function collectAttestationManifest(
  vault: string,
  opts: CollectAttestationManifestOptions = {},
): AttestationManifest {
  const checkpoint = (): void => opts.safeguard?.checkpoint();
  checkpoint();
  const identity = readVaultIdentity(vault);
  checkpoint();
  const logHeads = collectLogShardHeads(vault);
  checkpoint();
  const ledgerInventories: Record<string, ReadonlyArray<string>> = {};
  for (const dir of ledgerSweepDirs(vault).toSorted()) {
    const inventory = inventoryOf(dir);
    if (inventory === null) continue;
    ledgerInventories[inventoryKey(vault, dir)] = inventory;
  }
  checkpoint();
  const indexStamp = indexStampToken(vault);
  return Object.freeze({
    schemaVersion: ATTESTATION_MANIFEST_SCHEMA_VERSION,
    vaultIdentityId: identity?.vault_id ?? "",
    logHeads: Object.freeze({ ...logHeads }),
    ledgerInventories: Object.freeze(
      Object.fromEntries(
        Object.entries(ledgerInventories)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, Object.freeze([...v])]),
      ),
    ),
    indexStamp,
  });
}

/**
 * The store digest: the one hash a signature is computed over.
 *
 * `sha256Hex(canonicalJson(manifest))` byte-for-byte, the persisted-
 * digest doctrine's own encoding, so a record signed by one build
 * verifies under every build that ships this module.
 */
export function attestationStoreDigest(manifest: AttestationManifest): string {
  return sha256Hex(canonicalJson(manifest));
}
