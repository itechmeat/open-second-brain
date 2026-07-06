/**
 * Semantic (embedding cosine) entity dedup
 * (semantic-retrieval-precision, parent t_47fd9523).
 *
 * OSB's entity identity is purely deterministic string-normalization:
 * `normalizeEntityName` + `entityIdentityKey` in `canonical.ts`. That key
 * silently treats lexical variants of the same real-world entity as
 * distinct records ("Google LLC" vs "Google Inc", "OpenAI" vs "Open AI"),
 * fragmenting the graph. This pass complements the key with an OPT-IN,
 * PROPOSAL-ONLY layer that surfaces those variants as alias-merge
 * CANDIDATES. Modeled on the proven hygiene dedup detector
 * (`hygiene/detectors/dedup.ts`): an embedding-cosine layer over the
 * canonical registry, with a clearly-labeled `method: "lexical"` jaccard
 * fallback when vectors are unavailable.
 *
 * It NOMINATES pairs only — it never rewrites `entityIdentityKey`, never
 * touches an entity file. Candidates feed the doctor-lint / registry
 * alias-resolution seam, where a human (or an apply plan) owns the merge,
 * preserving OSB's deterministic, audit-friendly core.
 */

import { discoverConfig } from "../../config.ts";
import { parseFrontmatter } from "../../vault.ts";
import { envOrConfig, parseBool, parseFloat01 } from "../../validate.ts";
import { resolveConfiguredEmbeddingProvider } from "../../search/embeddings/provider-resolve.ts";
import type { EmbeddingProvider } from "../../search/embeddings/provider.ts";
import { jaccard, tokenise } from "../similarity.ts";
import { buildEntityIndex } from "./index-builder.ts";
import { normalizeEntityName } from "./canonical.ts";
import { BRAIN_ENTITY_STATUS, type BrainEntity } from "./types.ts";

/**
 * Cosine threshold for the embedding layer. Default deliberately high so
 * only near-duplicates surface (few false positives; the deterministic
 * core plus a human own the merge).
 */
export const ENTITY_DEDUP_EMBEDDING_THRESHOLD = 0.92;
/** Jaccard threshold for the lexical fallback. */
export const ENTITY_DEDUP_LEXICAL_THRESHOLD = 0.8;
/** Bound on how many active entities enter pairwise comparison. */
const ENTITY_DEDUP_CANDIDATE_CAP = 500;

export type EntityDedupMethod = "embedding" | "lexical";

/** A nominated alias-merge candidate pair — never auto-applied. */
export interface EntityAliasCandidate {
  /** Deterministic pair id: `<entity-id-a>::<entity-id-b>` (ids sorted). */
  readonly id: string;
  readonly method: EntityDedupMethod;
  readonly category: string;
  /** Lexicographically smaller entity id. */
  readonly a: string;
  readonly b: string;
  readonly name_a: string;
  readonly name_b: string;
  /** Cosine (embedding) or jaccard (lexical) similarity, rounded to 4dp. */
  readonly similarity: number;
  /** Structural identity type when present in frontmatter; absent otherwise. */
  readonly identity_type_a?: string;
  readonly identity_type_b?: string;
}

export interface EntitySemanticDedupResult {
  readonly method: EntityDedupMethod;
  readonly candidates: ReadonlyArray<EntityAliasCandidate>;
}

export interface EntitySemanticDedupOptions {
  /**
   * Embedding provider override. `undefined` resolves the vault's
   * configured provider; `null` (or an unusable provider) falls back to
   * the lexical layer.
   */
  readonly provider?: EmbeddingProvider | null;
  readonly threshold?: number;
  readonly lexicalThreshold?: number;
  readonly configPath?: string;
}

export interface EntityLexicalOptions {
  readonly threshold?: number;
}

/** Resolved default-off config surface for the pass. */
export interface EntitySemanticDedupConfig {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly lexicalThreshold: number;
}

/**
 * Resolve the `entity_semantic_dedup_*` config family (env wins over the
 * config file). Off by default: with no config the pass never runs, so
 * registry / doctor / search behavior is byte-identical to the baseline.
 */
export function resolveEntitySemanticDedupConfig(configPath?: string): EntitySemanticDedupConfig {
  const env = process.env;
  const config = discoverConfig(configPath).data;
  const enabled = parseBool(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED",
      "entity_semantic_dedup_enabled",
    ),
    false,
    "entity_semantic_dedup_enabled",
  );
  const threshold = parseFloat01(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_THRESHOLD",
      "entity_semantic_dedup_threshold",
    ),
    ENTITY_DEDUP_EMBEDDING_THRESHOLD,
    "entity_semantic_dedup_threshold",
  );
  const lexicalThreshold = parseFloat01(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD",
      "entity_semantic_dedup_lexical_threshold",
    ),
    ENTITY_DEDUP_LEXICAL_THRESHOLD,
    "entity_semantic_dedup_lexical_threshold",
  );
  return Object.freeze({ enabled, threshold, lexicalThreshold });
}

/**
 * Structural identity type: the operator-set `identity_type` frontmatter
 * key (e.g. `org` / `person` / `product`), validated as a slug. Derived
 * from frontmatter / structural signals, NEVER from parsing the name for
 * natural-language keywords — language-agnostic by construction. Absent
 * (undefined) unless the key is present and well-formed.
 */
export function deriveIdentityType(entity: BrainEntity): string | undefined {
  let raw: unknown;
  try {
    raw = parseFrontmatter(entity.path)[0]["identity_type"];
  } catch {
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  const t = raw.normalize("NFC").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(t) ? t : undefined;
}

/**
 * Evolution chain: the canonical name followed by its aliases in file
 * order (deduplicated by normalized form). This is the structural record
 * of how a name evolved as variants merged into the canonical entity —
 * read-only, deterministic (the file is the single source of truth).
 */
export function entityEvolutionChain(entity: BrainEntity): ReadonlyArray<string> {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const name of [entity.name, ...entity.aliases]) {
    const norm = normalizeEntityName(name);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    chain.push(name);
  }
  return Object.freeze(chain);
}

/** Active entities, id-sorted, capped — the comparison universe. */
function activeEntities(vault: string): BrainEntity[] {
  const entities = buildEntityIndex(vault).entities.filter(
    (e) => e.status === BRAIN_ENTITY_STATUS.active,
  );
  return entities.slice(0, ENTITY_DEDUP_CANDIDATE_CAP);
}

/** True when a and b already reference each other by canonical name / alias. */
function alreadyLinked(a: BrainEntity, b: BrainEntity): boolean {
  const aNames = new Set([a.name, ...a.aliases].map(normalizeEntityName));
  const bNames = new Set([b.name, ...b.aliases].map(normalizeEntityName));
  for (const n of bNames) if (aNames.has(n)) return true;
  return false;
}

interface Pairing {
  readonly a: BrainEntity;
  readonly b: BrainEntity;
}

/**
 * Enumerate comparable pairs: same category, distinct entities, not
 * already linked by an alias. Cross-category pairs are excluded — aliases
 * resolve within a category, so a cross-category "match" is noise.
 */
function comparablePairs(entities: ReadonlyArray<BrainEntity>): Pairing[] {
  const byCategory = new Map<string, BrainEntity[]>();
  for (const e of entities) {
    const bucket = byCategory.get(e.category) ?? [];
    bucket.push(e);
    byCategory.set(e.category, bucket);
  }
  const pairs: Pairing[] = [];
  for (const bucket of byCategory.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        if (alreadyLinked(a, b)) continue;
        pairs.push({ a, b });
      }
    }
  }
  return pairs;
}

function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const identityTypeCache = new WeakMap<BrainEntity, string | undefined>();
function cachedIdentityType(entity: BrainEntity): string | undefined {
  if (identityTypeCache.has(entity)) return identityTypeCache.get(entity);
  const t = deriveIdentityType(entity);
  identityTypeCache.set(entity, t);
  return t;
}

function makeCandidate(
  method: EntityDedupMethod,
  a: BrainEntity,
  b: BrainEntity,
  similarity: number,
): EntityAliasCandidate {
  // Sort the pair by id so `id`, `a`, `b` are stable regardless of walk order.
  const [lo, hi] = a.id.localeCompare(b.id) <= 0 ? [a, b] : [b, a];
  const typeLo = cachedIdentityType(lo);
  const typeHi = cachedIdentityType(hi);
  return Object.freeze({
    id: `${lo.id}::${hi.id}`,
    method,
    category: lo.category,
    a: lo.id,
    b: hi.id,
    name_a: lo.name,
    name_b: hi.name,
    similarity: Number(similarity.toFixed(4)),
    ...(typeLo !== undefined ? { identity_type_a: typeLo } : {}),
    ...(typeHi !== undefined ? { identity_type_b: typeHi } : {}),
  });
}

/** Stable ordering: category, then the two ids. */
function sortCandidates(candidates: EntityAliasCandidate[]): EntityAliasCandidate[] {
  return candidates.toSorted((x, y) => {
    const byCategory = x.category.localeCompare(y.category);
    if (byCategory !== 0) return byCategory;
    const byA = x.a.localeCompare(y.a);
    if (byA !== 0) return byA;
    return x.b.localeCompare(y.b);
  });
}

/**
 * Deterministic lexical fallback: token jaccard over entity names within
 * a category. Synchronous and pure-read — this is the layer the doctor
 * lint uses (the doctor is sync and never embeds).
 */
export function entityLexicalAliasCandidates(
  vault: string,
  opts: EntityLexicalOptions = {},
): ReadonlyArray<EntityAliasCandidate> {
  const threshold = opts.threshold ?? ENTITY_DEDUP_LEXICAL_THRESHOLD;
  const pairs = comparablePairs(activeEntities(vault));
  const out: EntityAliasCandidate[] = [];
  for (const { a, b } of pairs) {
    const similarity = jaccard(tokenise(a.name), tokenise(b.name));
    if (similarity < threshold) continue;
    out.push(makeCandidate("lexical", a, b, similarity));
  }
  return Object.freeze(sortCandidates(out));
}

/**
 * Surface alias-merge candidates. Prefers the embedding-cosine layer when
 * a usable provider is available; any provider problem falls back to the
 * deterministic lexical layer, labeled `method: "lexical"` so a report
 * never passes lexical similarity off as semantic. Never writes.
 */
export async function detectEntityAliasCandidates(
  vault: string,
  opts: EntitySemanticDedupOptions = {},
): Promise<EntitySemanticDedupResult> {
  const provider =
    opts.provider === undefined
      ? resolveConfiguredEmbeddingProvider(
          vault,
          opts.configPath ? { configPath: opts.configPath } : {},
        )
      : opts.provider;

  const lexical = (): EntitySemanticDedupResult =>
    Object.freeze({
      method: "lexical" as const,
      candidates: entityLexicalAliasCandidates(
        vault,
        opts.lexicalThreshold !== undefined ? { threshold: opts.lexicalThreshold } : {},
      ),
    });

  if (provider === null || provider.name === "null") return lexical();

  const entities = activeEntities(vault);
  const pairs = comparablePairs(entities);
  if (pairs.length === 0) return Object.freeze({ method: "embedding" as const, candidates: [] });

  const threshold = opts.threshold ?? ENTITY_DEDUP_EMBEDDING_THRESHOLD;

  let vectors: number[][];
  try {
    vectors = await provider.embed(entities.map((e) => e.name));
  } catch {
    return lexical();
  }
  if (vectors.length !== entities.length) return lexical();

  const vectorById = new Map<string, number[]>();
  for (let i = 0; i < entities.length; i++) vectorById.set(entities[i]!.id, vectors[i]!);

  const out: EntityAliasCandidate[] = [];
  for (const { a, b } of pairs) {
    const va = vectorById.get(a.id);
    const vb = vectorById.get(b.id);
    if (!va || !vb) continue;
    const similarity = cosine(va, vb);
    if (similarity < threshold) continue;
    out.push(makeCandidate("embedding", a, b, similarity));
  }
  return Object.freeze({
    method: "embedding" as const,
    candidates: Object.freeze(sortCandidates(out)),
  });
}
