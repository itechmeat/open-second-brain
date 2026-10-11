/**
 * Store-learned entity lexicon (recall-quality wave, A1 / t_11d51443).
 *
 * A derived artifact over the vault's operator pages that learns, per
 * lowercased token, how often the store saw it in lowercase, capitalised,
 * and ALL-CAPS form - the case evidence the admission predicate's
 * `function-word-run` verdict needs to tell a common word from a name.
 * There is no shipped vocabulary and no natural-language word list: the
 * standing invariant in `canonical.ts`, `unlinked-mentions.ts`,
 * `co-occurrence.ts` and `search/entities.ts` holds here too, and the
 * only vocabulary source is the corpus itself.
 *
 * The artifact follows the shared derived-artifact convention extracted
 * in S2 (`src/core/brain/derived-artifact.ts`): schema-versioned,
 * dataset-hashed over the walked input set, fail-open on read - a
 * missing, torn, or stale artifact reads as `null` and every consumer
 * degrades to the pre-lexicon structural gate. It never mis-rejects.
 *
 * The dataset hash is a deliberately COARSE corpus signature (recall-quality
 * review M5): the sorted page set plus a per-page TOKEN-COUNT bucket, with
 * no mtimes. A learned lexicon is a snapshot of statistics, not a cache of
 * bytes: a small in-place edit keeps the gate resolving while the entries
 * lag the live corpus slightly, and that lag is what a learned lexicon IS.
 * Real corpus shifts - pages added or removed, a page's token count
 * crossing its bucket - expire the artifact honestly, and the fail-open
 * read then degrades every verdict to the structural gate until the next
 * `entity lexicon rebuild`.
 *
 * Corpus scope, asserted in the artifact header: `listVaultPages` at
 * `MAINTENANCE_LANE_REACH` with the Brain root excluded - which excludes
 * session transcripts, the continuity ledger and every other
 * Brain-resident page along with it, so a session miner's output can
 * never skew the case statistics it is later gated by.
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import { EXCLUDED_DIRS, listVaultPages, parseFrontmatter } from "../../vault.ts";
import { MAINTENANCE_LANE_REACH } from "../../graph/transport-reach.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";
import { isoSecond } from "../time.ts";
import {
  deriveDatasetHash,
  readDerivedArtifact,
  writeDerivedArtifact,
  type DerivedArtifact,
} from "../derived-artifact.ts";
import type { EntityLexiconHandle } from "./canonical.ts";

/** Schema tag of the lexicon payload shape. */
export const ENTITY_LEXICON_SCHEMA_VERSION = "o2b.entity-lexicon.v1";

/** Vault-relative home of the derived lexicon artifact. */
export const ENTITY_LEXICON_ARTIFACT_REL = join("Brain", "entities", "lexicon.json");

/**
 * Cap on the number of learned entries, ranked by total sightings - the
 * same bound class as CLAIM_GRAPH_MAX_NODES. A vault-wide corpus fold
 * sees every word once; without a cap the artifact would be a copy of
 * the operator's lexicon rather than a vocabulary.
 */
export const ENTITY_LEXICON_TOP_K = 5000;

/** Corpus-scope sentence carried in the artifact header. */
export const ENTITY_LEXICON_CORPUS_SCOPE =
  "operator pages at maintenance-lane reach; the Brain root is excluded, " +
  "which excludes session transcripts and derived artifacts with it";

/**
 * Width of one per-page token-count bucket in the corpus signature. A
 * page contributes `floor(tokens / width)` to its signature part, so an
 * in-place edit of a few words keeps the bucket - and the artifact's
 * freshness - while a genuine growth or prune of a page's prose crosses
 * it. Fixed width rather than logarithmic so the smallest pages (the
 * ones an everyday edit touches) do not cross a bucket every few words.
 */
export const ENTITY_LEXICON_TOKEN_BUCKET = 64;

/** Per-token case evidence, keyed by the LOWERCASED token. */
export interface EntityLexiconEntry {
  /** Sightings in all-lowercase form - common-word evidence. */
  readonly lower: number;
  /** Sightings with internal uppercase (Title/mixed case) - name evidence. */
  readonly capitalised: number;
  /** Sightings in ALL-CAPS form - name evidence. */
  readonly upper: number;
}

/** The persisted lexicon document (an S2 derived artifact). */
export interface EntityLexiconDocument extends DerivedArtifact {
  /** {@link ENTITY_LEXICON_CORPUS_SCOPE} - the walked input set, named. */
  corpus_scope: string;
  /** False when the corpus showed no cased letter: case stats are meaningless. */
  caseful: boolean;
  /** Learned entries, ranked by total sightings (top-K), keyed lowercased. */
  entries: Record<string, EntityLexiconEntry>;
}

export interface DeriveEntityLexiconOptions {
  /** Injected clock for a deterministic `generated_at`. Defaults to now. */
  readonly now?: Date;
  /** Entry cap; defaults to (and never exceeds) {@link ENTITY_LEXICON_TOP_K}. */
  readonly topK?: number;
}

/** One run of letters/digits in any script: a token. Punctuation splits. */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
/** Fenced code block - its tokens are code, not prose. */
const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
/** Inline code span - same. */
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Which case bucket one token sighting lands in. A token equal to its
 * lowercase is lowercase evidence; equal to its uppercase (and carrying
 * a cased letter) is ALL-CAPS evidence; anything else carries internal
 * uppercase and lands in the capitalised bucket.
 */
function bucketOf(token: string): keyof EntityLexiconEntry {
  if (token === token.toLowerCase()) return "lower";
  if (token === token.toUpperCase()) return "upper";
  return "capitalised";
}

/**
 * One page's foldable tokens: the body below the frontmatter, code
 * fences and inline spans stripped. Null when the page could not be
 * read - it vanished between the enumeration and the read, or the
 * bytes are unreadable - and it is then skipped BY NAME in both the
 * fold and the corpus signature, so a derive that raced a deletion
 * bakes the signature of the corpus it actually saw.
 */
type CorpusPageTokens = ReadonlyArray<string> | null;

/**
 * Read one corpus page down to its foldable tokens. A page that does
 * not exist - it vanished between the enumeration and the read - reads
 * as null and is skipped BY NAME in both the fold and the corpus
 * signature, exactly as the freshness walk (which cannot enumerate it
 * anymore) sees the corpus; `parseFrontmatter` never throws on a
 * missing or unreadable file, so the existence gate has to be explicit
 * here. Pure with respect to its input path; the caller owns error
 * policy (null, never throw).
 */
function readCorpusPage(path: string): CorpusPageTokens {
  try {
    statSync(path);
  } catch {
    return null;
  }
  try {
    const [, body] = parseFrontmatter(path);
    return body.replace(FENCED_CODE_RE, " ").replace(INLINE_CODE_RE, " ").match(TOKEN_RE) ?? [];
  } catch {
    return null;
  }
}

/**
 * Fold the case statistics over the corpus pages. Body prose only: a
 * page's filename stem is not authored text and would couple the
 * learned vocabulary to how files are named. Entries accumulate in
 * first-seen order - the caller ranks and caps them. Per-page token
 * arrays are returned alongside so the dataset signature is computed
 * from the SAME reads the entries came from - one read per page, never
 * two.
 */
function foldCorpus(paths: ReadonlyArray<string>): {
  entries: Map<string, { lower: number; capitalised: number; upper: number }>;
  caseful: boolean;
  pageTokens: CorpusPageTokens[];
} {
  const entries = new Map<string, { lower: number; capitalised: number; upper: number }>();
  let caseful = false;
  const pageTokens: CorpusPageTokens[] = [];
  for (const path of paths) {
    const tokens = readCorpusPage(path);
    pageTokens.push(tokens);
    if (tokens === null) continue;
    for (const token of tokens) {
      const bucket = bucketOf(token);
      if (bucket !== "lower") caseful = true;
      const key = token.toLowerCase();
      const entry = entries.get(key) ?? { lower: 0, capitalised: 0, upper: 0 };
      entry[bucket] += 1;
      entries.set(key, entry);
    }
  }
  return { entries, caseful, pageTokens };
}

/**
 * The corpus signature over one read of the enumerated pages: a part
 * per READABLE page carrying its vault-relative path and its
 * token-count bucket - `floor(tokens / ENTITY_LEXICON_TOKEN_BUCKET)` -
 * and NO timestamps. The page SET and the prose VOLUME are what a
 * learned vocabulary is statistics over; an mtime is not, and folding
 * one into the freshness check expired the artifact on every small
 * edit, switching the gate off in any vault that was being used
 * (recall-quality review M5). A page whose read failed contributes no
 * part - the same skip-by-name rule the fold applies, so the derive
 * and the freshness check agree over the corpus each actually saw.
 */
function corpusSignatureForReads(
  vault: string,
  paths: ReadonlyArray<string>,
  pageTokens: ReadonlyArray<CorpusPageTokens>,
): string {
  const parts: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const tokens = pageTokens[i];
    if (tokens === null || tokens === undefined) continue;
    const rel = paths[i]!.slice(vault.length).replace(/\\/g, "/").replace(/^\//, "");
    parts.push(`${rel}\u0000${Math.floor(tokens.length / ENTITY_LEXICON_TOKEN_BUCKET)}`);
  }
  return deriveDatasetHash(parts);
}

/**
 * The corpus signature of the vault's operator pages as they stand NOW:
 * one fresh walk, one read per page, one part per readable page
 * ({@link corpusSignatureForReads}). This is the freshness side only -
 * a derive must fingerprint the enumeration it actually folded, which
 * {@link deriveEntityLexiconFromPaths} computes from its own reads.
 */
export function entityLexiconDatasetHash(vault: string): string {
  const pages = listVaultPages(vault, {
    skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL],
    reach: MAINTENANCE_LANE_REACH,
  });
  const paths = pages.map((page) => page.path);
  return corpusSignatureForReads(
    vault,
    paths,
    paths.map((path) => readCorpusPage(path)),
  );
}

/**
 * Derive the lexicon from an EXPLICIT enumeration of corpus pages - the
 * single-pass core {@link deriveEntityLexicon} delegates to. Each page is
 * read ONCE: the dataset signature is computed from the same reads the
 * entries were folded from, so the artifact's hash always describes the
 * corpus its statistics came from. A page that vanishes before its read
 * is folded as nothing and skipped in the signature by name (see the
 * signature helper): the artifact then reflects the surviving corpus
 * exactly, and a freshness check over that same surviving corpus
 * validates it. Deterministic for a fixed path list and clock.
 */
export function deriveEntityLexiconFromPaths(
  vault: string,
  paths: ReadonlyArray<string>,
  opts: DeriveEntityLexiconOptions = {},
): EntityLexiconDocument {
  const { entries, caseful, pageTokens } = foldCorpus(paths);
  const dataset_hash = corpusSignatureForReads(vault, paths, pageTokens);
  const topK = Math.min(
    Math.max(0, Math.floor(opts.topK ?? ENTITY_LEXICON_TOP_K)),
    ENTITY_LEXICON_TOP_K,
  );
  const ranked = [...entries.entries()]
    .map(([token, e]) => [token, e, e.lower + e.capitalised + e.upper] as const)
    .toSorted((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, topK);
  const capped: Record<string, EntityLexiconEntry> = {};
  for (const [token, e] of ranked) capped[token] = e;
  return {
    schema: ENTITY_LEXICON_SCHEMA_VERSION,
    generated_at: isoSecond(opts.now ?? new Date()),
    dataset_hash,
    corpus_scope: ENTITY_LEXICON_CORPUS_SCOPE,
    caseful,
    entries: capped,
  };
}

/**
 * Derive the lexicon from the current corpus. ONE walk: the enumeration
 * feeds both the dataset hash and the fold, so the baked hash always
 * describes the corpus the entries were read from - the previous
 * two-walk shape hashed a re-walk that could observe a corpus the fold
 * never saw, and a mid-derive deletion then baked a fingerprint the
 * artifact could never validate against again. Reads only - the write is
 * a separate, explicit step ({@link writeEntityLexicon}).
 */
export function deriveEntityLexicon(
  vault: string,
  opts: DeriveEntityLexiconOptions = {},
): EntityLexiconDocument {
  const pages = listVaultPages(vault, {
    skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL],
    reach: MAINTENANCE_LANE_REACH,
  });
  return deriveEntityLexiconFromPaths(
    vault,
    pages.map((page) => page.path),
    opts,
  );
}

/**
 * Persist the lexicon through the S2 helper: atomic write, vault-identity
 * guarded. Returns the absolute path written.
 */
export function writeEntityLexicon(vault: string, doc: EntityLexiconDocument): string {
  writeDerivedArtifact(vault, ENTITY_LEXICON_ARTIFACT_REL, doc);
  return join(vault, ENTITY_LEXICON_ARTIFACT_REL);
}

/**
 * Validate the payload beside the envelope the S2 reader already checked:
 * every entry must carry three numeric buckets. Returns null - never
 * throws - on any defect (fail-open, mirroring the tuning store).
 */
function parseEntries(value: unknown): Record<string, EntityLexiconEntry> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, EntityLexiconEntry> = {};
  for (const [token, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    if (
      typeof e["lower"] !== "number" ||
      typeof e["capitalised"] !== "number" ||
      typeof e["upper"] !== "number"
    ) {
      return null;
    }
    out[token] = { lower: e["lower"], capitalised: e["capitalised"], upper: e["upper"] };
  }
  return out;
}

/**
 * Read the lexicon, re-validated against the caller's current dataset
 * hash. Null - never throws - when the file is missing, torn, carries a
 * foreign schema, or fingerprints a corpus that has moved on since
 * (dataset-hash expiry): the fail-open contract of every derived
 * artifact, so a stale lexicon degrades admission to the structural gate
 * instead of mis-rejecting against yesterday's statistics.
 */
export function loadEntityLexicon(
  vault: string,
  datasetHash: string,
): EntityLexiconDocument | null {
  const doc = readDerivedArtifact<EntityLexiconDocument>(
    vault,
    ENTITY_LEXICON_ARTIFACT_REL,
    ENTITY_LEXICON_SCHEMA_VERSION,
    datasetHash,
  );
  if (doc === null) return null;
  if (typeof doc["corpus_scope"] !== "string" || typeof doc["caseful"] !== "boolean") return null;
  const entries = parseEntries(doc["entries"]);
  if (entries === null) return null;
  return { ...doc, entries };
}

/**
 * The pinned common-word verdict over learned entries. The predicate
 * hands tokens over LOWERCASED (the `EntityLexiconHandle` contract), so
 * the lookup is exact. A token is a learned common word when the corpus
 * saw it at all in lowercase at least as often as in any name-shaped
 * form - a word that only ever appears capitalised or ALL-CAPS is
 * name evidence, not a common word, and stays admissible as a label.
 */
function isLearnedCommonWord(entries: Record<string, EntityLexiconEntry>, token: string): boolean {
  const e = entries[token];
  if (e === undefined) return false;
  return e.lower > 0 && e.lower >= e.capitalised + e.upper;
}

// ----- Resolver ---------------------------------------------------------------
//
// The resolved handle is memoized per vault, keyed on the artifact's own
// mtime+size: one stat per resolution, a full re-read (freshness walk
// included) only when the artifact changed or is first met in this
// process. Between rebuilds the handle is stable by design - a corpus
// that moved on without a rebuild keeps serving the last learned
// lexicon, the same accepted stale-window trade the tuning store makes.

interface ResolveCacheEntry {
  readonly key: string;
  readonly handle: EntityLexiconHandle | null;
}

const RESOLVE_CACHE = new Map<string, ResolveCacheEntry>();
const RESOLVE_CACHE_MAX = 16;

/** Test helper: drop every memoized handle (keyed by resolved vault root). */
export function __clearEntityLexiconCache(): void {
  RESOLVE_CACHE.clear();
}

/**
 * Resolve the lexicon handle the admission boundaries thread into
 * `validateEntityLabel` beside the denylist - `null` when no fresh
 * artifact is available, which is the fail-open default: with a null
 * handle the predicate is byte-identical to its pre-lexicon behavior.
 */
export function resolveEntityLexicon(vault: string): EntityLexiconHandle | null {
  const root = resolve(vault);
  let key = "absent";
  try {
    const st = statSync(join(root, ENTITY_LEXICON_ARTIFACT_REL), { bigint: true });
    key = `${st.mtimeNs}:${st.size}`;
  } catch {
    key = "absent";
  }
  const cached = RESOLVE_CACHE.get(root);
  if (cached !== undefined && cached.key === key) return cached.handle;

  let handle: EntityLexiconHandle | null = null;
  if (key !== "absent") {
    const doc = loadEntityLexicon(root, entityLexiconDatasetHash(root));
    if (doc !== null) {
      const entries = doc.entries;
      handle = {
        caseful: doc.caseful,
        isCommonWord: (token: string): boolean => isLearnedCommonWord(entries, token),
      };
    }
  }
  if (RESOLVE_CACHE.size >= RESOLVE_CACHE_MAX && !RESOLVE_CACHE.has(root)) {
    const oldest = RESOLVE_CACHE.keys().next().value;
    if (oldest !== undefined) RESOLVE_CACHE.delete(oldest);
  }
  RESOLVE_CACHE.set(root, { key, handle });
  return handle;
}
