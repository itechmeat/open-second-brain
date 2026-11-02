/**
 * The attestation verification kernel (delivery trust, card t_3bdb82b0).
 *
 * The operator question is "did the state these surfaces stamp change
 * since the attestation", and the answer is a REPORT, per surface:
 *
 *   - `intact`  - the shard's current head is still the attested head;
 *   - `appended`- the head moved, and walking forward from the attested
 *     head through `prev` links reaches the new head with every row
 *     hashing to itself: the shard grew legitimately since signing;
 *   - `diverged`- the attested head is gone, or the forward walk meets a
 *     row whose hash does not recompute, whose `prev` does not link, or
 *     whose links were stripped: an edit, deletion or rewrite after the
 *     signed point;
 *   - `missing` - the shard file is gone.
 *
 * ## Report-only, and forward-only, exactly like the log chain
 *
 * Nothing here writes, and nothing here throws - "could not verify" is
 * never folded into "verified clean" (a store whose manifest cannot be
 * recomputed reads as `storeDigestMatches: false`, which is the honest
 * answer the contract's shape can carry). The walk starts AT the attested
 * head on purpose: an attestation anchors a point in each shard's
 * history, not the whole history, and integrity of the rows BEFORE that
 * point is the log-chain verifier's standing question (`o2b brain log
 * verify`), not this one. The attested row itself and everything after
 * it are this walk's question, held to the full standard: the attested
 * row's own hash must recompute from its fields, and a row at or after
 * it that the walk cannot chain (unparseable, stripped links) reads as
 * `diverged`, never as silence between chained rows.
 *
 * The per-shard classification reads lock-free, like `verifyLogChain`:
 * a verifier's misread is a report the operator re-runs, where a wrong
 * head gets SIGNED and a signature is permanent. The manifest recompute
 * for the store digest is the one place a verify waits - it rides the
 * collector's bounded-retry log lock, so an append in progress delays a
 * report by at most that retry window, and a lock that is still held
 * when the retries end is a store this run could not measure, reported
 * as `storeDigestMatches: false` beside the intact shard verdicts.
 *
 * ## What a legitimately advanced store reads as
 *
 * Appends after signing are the NORMAL case. The verdict says so per
 * shard, and `storeDigestMatches` reports `false` because the recomputed
 * manifest really does differ from the attested one - with the appended
 * shards naming why. The record's own seal and signature still verify;
 * a false store digest beside nothing but `appended` shards is a store
 * that moved, not a store that was broken.
 */

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  attestationStoreDigest,
  collectAttestationManifest,
  isGrammarValidName,
  ledgerGrowthGrammars,
  type AttestationManifest,
  type CollectAttestationManifestOptions,
} from "./digest.ts";
import type { LedgerShardGrammar } from "../ledger-shards.ts";
import { verifyAttestationSignature } from "./signing.ts";
import type { AttestationRecord } from "./record.ts";
import { LOG_CHAIN_FIELDS, logChainHash } from "../log.ts";
import { scanJsonlRows } from "../log-jsonl.ts";
import { BRAIN_LOG_REL } from "../path-constants.ts";
import { gitStoreRootDir } from "../git/store.ts";
import { brainDirs } from "../paths.ts";
import { SafeguardAbortError, type Safeguard } from "../safeguard.ts";
import type { ProgressSink } from "../progress.ts";

/** The state of one attested shard, as verification reports it. */
export type AttestationShardState = "intact" | "appended" | "diverged" | "missing";

export interface AttestationVerification {
  readonly recordId: string;
  readonly createdAt: string;
  readonly signatureValid: boolean;
  /** One verdict per ATTESTED shard, in shard-name order. */
  readonly shards: ReadonlyArray<{
    readonly shardId: string;
    readonly state: AttestationShardState;
  }>;
  /**
   * Whether the manifest recomputed NOW still digests to the record's
   * `storeDigest`. False for a legitimately advanced store too - the
   * per-shard states are what distinguish "moved" from "broken".
   */
  readonly storeDigestMatches: boolean;
  /**
   * Whether the recomputed manifest differs from the attested one in a
   * way normal growth cannot explain: a vault-identity or index change,
   * ledger damage (an attested file gone, an invalid name, an addition
   * to a strict directory), or growth neither the new-shard rule nor the
   * ledger grammars cover. The one boolean both faces exit and warn on,
   * so the CLI and the doctor cannot drift about what counts as damage.
   */
  readonly unexplainedDrift: boolean;
  /**
   * Whether the manifest could be recomputed at all. False for a run
   * that could not measure - a log lock still held after the retries, a
   * directory that could not be listed, an index that could not be
   * read - which is a different fact from drift, and the faces word it
   * differently: "re-run" for the CLI, the uncertain stream for the
   * doctor, never ledger-damage prose.
   */
  readonly storeMeasured: boolean;
}

export interface VerifyAttestationOptions {
  /**
   * The public half to verify the signature against. When offered, the
   * explicit-path contract applies: a missing or unreadable file is an
   * invalid signature, never a fall back to deriving the key from the
   * private seed - agent-facing callers name the vault's exported half
   * so a verification they trigger never reads operator key material.
   * The operator CLI omits it, because deriving the public half from
   * the operator's own seed on the operator's own machine is what makes
   * a missing export file survivable there.
   */
  readonly publicPath?: string;
  /** Cooperative deadline guard, consulted per shard and per manifest surface. */
  readonly safeguard?: Safeguard;
  /**
   * Accepted per the kernel contract. Nothing is emitted today: a
   * `ProgressEvent` names an operation from the closed `OPERATION`
   * vocabulary, and no attestation member exists there yet - a
   * mislabelled operation would put an unresolvable name on every live
   * progress stream. Wiring one member into `OPERATION` plus a
   * `progressCounter` here is the whole change when the vocabulary
   * opens to attestation.
   */
  readonly onProgress?: ProgressSink;
}

/** One shard row as the chain walk needs it, or null when it is not that shape. */
interface ChainRow {
  readonly h: string;
  readonly prev: string | null;
  readonly ts: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, string | ReadonlyArray<string>>>;
}

/** Strict projection: the exact shape `renderJsonlLine` can emit. */
function chainRow(row: Readonly<Record<string, unknown>>): ChainRow | null {
  const prev = row[LOG_CHAIN_FIELDS.prev];
  if (prev !== null && typeof prev !== "string") return null;
  const ts = row["ts"];
  const kind = row["kind"];
  const payload = row["payload"];
  if (typeof ts !== "string" || typeof kind !== "string") return null;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const projected: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === "string") {
      projected[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      projected[key] = value as string[];
      continue;
    }
    return null;
  }
  const h = row[LOG_CHAIN_FIELDS.h];
  if (typeof h !== "string" || h === "") return null;
  return { h, prev, ts, kind, payload: projected };
}

/**
 * Classify one attested shard. Never throws: an unreadable shard is
 * damage to name (`diverged`), never a crash and never a clean bill.
 */
function classifyShard(
  vault: string,
  shardName: string,
  attestedHead: string,
): AttestationShardState {
  let logDir: string;
  try {
    logDir = brainDirs(vault).log;
  } catch {
    return "missing";
  }
  const path = join(logDir, shardName);
  if (!existsSync(path)) return "missing";
  const scan = scanJsonlRows(path);
  if (!scan.readable) return "diverged";

  const rows: ChainRow[] = [];
  let currentHead: string | null = null;
  let anchorIndex = -1;
  for (const line of scan.lines) {
    const row = line.row === null ? null : chainRow(line.row);
    if (row === null) {
      // Before the attested point a row the projection refuses is
      // pre-chain history - the log-chain verifier's standing question,
      // not this walk's. At or after it, a row that cannot be chained
      // (unparseable JSON, stripped links, a payload shape the
      // projection refuses) is an edit: skipping it would read a
      // garbled or rewritten row as legitimate growth.
      if (anchorIndex >= 0) return "diverged";
      continue;
    }
    rows.push(row);
    currentHead = row.h;
    if (anchorIndex < 0 && row.h === attestedHead) anchorIndex = rows.length - 1;
  }
  if (anchorIndex < 0) return "diverged";

  // The attested row is what the attestation vouches for, so its stored
  // hash must recompute from its own fields: a row edited after signing
  // with its `h` field left in place would otherwise ride both the
  // `intact` verdict and the forward walk's anchor.
  const anchor = rows[anchorIndex]!;
  if (logChainHash(anchor.prev, anchor.ts, anchor.kind, anchor.payload) !== attestedHead) {
    return "diverged";
  }
  if (currentHead === attestedHead) return "intact";

  // Forward walk from the attested head: every row after it must hash to
  // itself and link to its predecessor, ending exactly at the head.
  let previous = attestedHead;
  for (let i = anchorIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prev !== previous) return "diverged";
    if (logChainHash(row.prev, row.ts, row.kind, row.payload) !== row.h) return "diverged";
    previous = row.h;
  }
  return previous === currentHead ? "appended" : "diverged";
}

/**
 * Verify one attestation against the store as it stands now.
 *
 * Performs no writes and reports every attested shard even when the
 * signature is invalid - the operator needs the whole picture, and a
 * signature check alone would hide how far the store moved. Every
 * failure mode lands in the report; the one throw is the caller's OWN
 * {@link SafeguardAbortError}, which propagates from a deadline rather
 * than reading as a verdict.
 */
export function verifyAttestation(
  vault: string,
  record: AttestationRecord,
  opts: VerifyAttestationOptions = {},
): AttestationVerification {
  const checkpoint = (): void => opts.safeguard?.checkpoint();
  const signatureValid =
    opts.publicPath !== undefined
      ? verifyAttestationSignature(record, vault, { publicPath: opts.publicPath })
      : verifyAttestationSignature(record, vault);
  checkpoint();

  const shards = Object.entries(record.manifest.logHeads)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([shardId, head]) => {
      checkpoint();
      return { shardId, state: classifyShard(vault, shardId, head) };
    });
  checkpoint();

  let storeDigestMatches = false;
  let storeMeasured = false;
  let unexplainedDrift = false;
  try {
    const recomputeOptions: CollectAttestationManifestOptions = { safeguard: opts.safeguard };
    const recomputed = collectAttestationManifest(vault, recomputeOptions);
    storeDigestMatches = attestationStoreDigest(recomputed) === record.storeDigest;
    unexplainedDrift = unexplainedManifestDrift(vault, record.manifest, recomputed);
    storeMeasured = true;
  } catch (err) {
    // The caller's own deadline is not a store fact: a run the safeguard
    // aborts must surface as the abort, never as a normal-looking report
    // whose digest happens to differ.
    if (err instanceof SafeguardAbortError) throw err;
    // A manifest that cannot be recomputed (a held log lock, an
    // unlistable ledger directory) is a store this run could not
    // measure. "Not measured" is not "matching", and it is not drift
    // either - it is its own fact, and the faces word it as one.
    storeDigestMatches = false;
  }

  return Object.freeze({
    recordId: record.id,
    createdAt: record.createdAt,
    signatureValid,
    shards: Object.freeze(shards),
    storeDigestMatches,
    unexplainedDrift,
    storeMeasured,
  });
}

function sameFiles(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Whether one inventoried directory's entry list is explained: every
 * attested entry must still be there, and every name that was not
 * attested must be normal growth for that directory - a file parsing
 * under the directory's ledger grammar (a new ISO-week audit shard, a
 * new continuity month, a new metric surface) or the entry of a known
 * ledger subdirectory created beneath it (a first continuity month
 * inside `Brain/log`, a first per-preference trail inside the
 * preference-audit root). A directory with no grammar entry is strict -
 * additions there are not something this build's writers produce.
 */
function ledgerGrowthExplained(
  grammars: ReadonlyMap<string, ReadonlyArray<LedgerShardGrammar>>,
  dir: string,
  attestedFiles: ReadonlyArray<string>,
  now: ReadonlyArray<string>,
): boolean {
  const layout = grammars.get(dir);
  if (layout === undefined) return sameFiles(attestedFiles, now);
  const attestedSet = new Set(attestedFiles);
  return (
    attestedFiles.every((name) => now.includes(name)) &&
    now.every(
      (name) =>
        attestedSet.has(name) || isGrammarValidName(name, layout) || grammars.has(`${dir}/${name}`),
    )
  );
}

/**
 * Whether the recomputed manifest differs from the attested one beyond
 * what normal growth explains. Growth is the NORMAL case, and every
 * append-only producer has it: a log shard appended after signing is
 * classified `appended`, a shard created after signing joins the log
 * directory's inventory and `logHeads`, and the append-only ledger
 * directories gain their time-window shards (a new hook-audit week, a
 * new continuity month, a new metric surface) - allowed exactly when the
 * new names parse under the producer's own grammar, with every attested
 * entry still present. Known ledger subdirectories of `Brain/log` that
 * were created entirely after signing follow the same rule against an
 * empty attested list. Everything else is drift no verdict names: the
 * vault identity, the index stamp, an attested entry gone, an invalid
 * name, or ANY addition to `Brain/preferences`, whose files are
 * authored state.
 */
function unexplainedManifestDrift(
  vault: string,
  attested: AttestationManifest,
  recomputed: AttestationManifest,
): boolean {
  if (attested.vaultIdentityId !== recomputed.vaultIdentityId) return true;
  if (attested.indexStamp !== recomputed.indexStamp) return true;
  const logDirKey = BRAIN_LOG_REL;
  const grammars = ledgerGrowthGrammars(vault);
  const newShards = Object.keys(recomputed.logHeads)
    .filter((shard) => !(shard in attested.logHeads))
    .toSorted();
  // A new JSONL shard lands beside its markdown twin (the appender
  // writes the pair), and only the JSONL half carries a chain head - so
  // the log directory's allowed growth is both files of each new shard.
  const newLogFiles = newShards
    .flatMap((shard) =>
      shard.endsWith(".jsonl") ? [shard, `${shard.slice(0, -".jsonl".length)}.md`] : [shard],
    )
    .toSorted();
  // The log directory's inventory also names the ledger subdirectories
  // under it (a first continuity month, a first audit family), so its
  // allowed set grows by exactly those known names.
  const logLedgerSubdirs = [...grammars.keys()].flatMap((key) =>
    key.startsWith(`${BRAIN_LOG_REL}/`) && !key.slice(BRAIN_LOG_REL.length + 1).includes("/")
      ? [key.slice(BRAIN_LOG_REL.length + 1)]
      : [],
  );
  for (const [dir, attestedFiles] of Object.entries(attested.ledgerInventories)) {
    const now = recomputed.ledgerInventories[dir];
    if (now === undefined) return true; // an inventoried directory vanished
    if (dir === logDirKey) {
      if (!explainedLogGrowth(attestedFiles, newShards, newLogFiles, logLedgerSubdirs, now)) {
        return true;
      }
      continue;
    }
    if (!ledgerGrowthExplained(grammars, dir, attestedFiles, now)) return true;
  }
  for (const dir of Object.keys(recomputed.ledgerInventories)) {
    if (dir in attested.ledgerInventories) continue;
    // A directory that gained ledger status since signing is only
    // explained when it is the log directory filling with the new
    // shards and known ledger subdirectories, one of those known
    // subdirectories itself (a first continuity month, a first audit
    // week), or a first repository store directory - each judged against
    // its producer's grammar, so every name it brings must parse and an
    // unrelated file stays drift.
    if (
      dir === logDirKey &&
      explainedLogGrowth(
        [],
        newShards,
        newLogFiles,
        logLedgerSubdirs,
        recomputed.ledgerInventories[dir] ?? [],
      )
    ) {
      continue;
    }
    if (
      (dir.startsWith(`${BRAIN_LOG_REL}/`) || isFirstRepoStoreDir(vault, dir)) &&
      ledgerGrowthExplained(grammars, dir, [], recomputed.ledgerInventories[dir] ?? [])
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether `dir` (an inventory key) is one repository store directory
 * directly under the store root: the shape a repository's first link
 * creates, which may happen entirely after signing. One level only -
 * the sweep inventories exactly these directories, and the layout rule
 * (watermark, digest, commits shards) belongs to the store, not to
 * anything nested deeper.
 */
function isFirstRepoStoreDir(vault: string, dir: string): boolean {
  const rootRel = relative(vault, gitStoreRootDir(vault)).split(sep).join("/");
  return dir.startsWith(`${rootRel}/`) && !dir.slice(rootRel.length + 1).includes("/");
}

/**
 * Whether the log directory's entry list is explained by growth, in set
 * semantics: every attested file and every new shard's JSONL must still
 * be there, the new shards' markdown twins MAY be there (a twin can
 * predate its JSONL on a legacy md-only day, and the appender's own
 * partial-failure path can leave a JSONL without one), the known ledger
 * subdirectories under the log MAY appear (their own inventories are
 * judged by the ledger rule), and nothing else may appear or vanish.
 */
function explainedLogGrowth(
  attestedFiles: ReadonlyArray<string>,
  newShards: ReadonlyArray<string>,
  newLogFiles: ReadonlyArray<string>,
  ledgerSubdirs: ReadonlyArray<string>,
  now: ReadonlyArray<string>,
): boolean {
  const allowed = new Set([...attestedFiles, ...newLogFiles, ...ledgerSubdirs]);
  const required = [...attestedFiles, ...newShards];
  return required.every((name) => now.includes(name)) && now.every((name) => allowed.has(name));
}
