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
 * Fold the case statistics over the corpus pages. Body prose only: a
 * page's filename stem is not authored text and would couple the
 * learned vocabulary to how files are named. Pure with respect to its
 * inputs; the caller owns the walk. Entries accumulate in first-seen
 * order - the caller ranks and caps them.
 */
function foldCorpus(paths: ReadonlyArray<string>): {
  entries: Map<string, { lower: number; capitalised: number; upper: number }>;
  caseful: boolean;
} {
  const entries = new Map<string, { lower: number; capitalised: number; upper: number }>();
  let caseful = false;
  const count = (text: string): void => {
    for (const token of text.match(TOKEN_RE) ?? []) {
      const bucket = bucketOf(token);
      if (bucket !== "lower") caseful = true;
      const key = token.toLowerCase();
      const entry = entries.get(key) ?? { lower: 0, capitalised: 0, upper: 0 };
      entry[bucket] += 1;
      entries.set(key, entry);
    }
  };
  for (const path of paths) {
    let body = "";
    try {
      [, body] = parseFrontmatter(path);
    } catch {
      body = "";
    }
    count(body.replace(FENCED_CODE_RE, " ").replace(INLINE_CODE_RE, " "));
  }
  return { entries, caseful };
}

/**
 * The dataset fingerprint: one part per walked corpus page, carrying its
 * vault-relative path, mtime and size. The artifact lives under the Brain
 * root, which the walk excludes, so writing it never stales itself.
 */
export function entityLexiconDatasetHash(vault: string): string {
  const pages = listVaultPages(vault, {
    skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL],
    reach: MAINTENANCE_LANE_REACH,
  });
  const parts = pages.map((page) => {
    const rel = page.path.slice(vault.length).replace(/\\/g, "/").replace(/^\//, "");
    let stamp = "unreadable";
    try {
      const st = statSync(page.path, { bigint: true });
      stamp = `${st.mtimeNs}:${st.size}`;
    } catch {
      stamp = "unreadable";
    }
    return `${rel}\u0000${stamp}`;
  });
  return deriveDatasetHash(parts);
}

/**
 * Derive the lexicon from the current corpus. Deterministic for a fixed
 * vault and clock: the same pages fold to the same entries, ranking and
 * hash. Reads only - the walk is a read, and the write is a separate,
 * explicit step ({@link writeEntityLexicon}).
 */
export function deriveEntityLexicon(
  vault: string,
  opts: DeriveEntityLexiconOptions = {},
): EntityLexiconDocument {
  const pages = listVaultPages(vault, {
    skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL],
    reach: MAINTENANCE_LANE_REACH,
  });
  const { entries, caseful } = foldCorpus(pages.map((page) => page.path));
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
    dataset_hash: entityLexiconDatasetHash(vault),
    corpus_scope: ENTITY_LEXICON_CORPUS_SCOPE,
    caseful,
    entries: capped,
  };
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
