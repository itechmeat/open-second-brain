/**
 * Language-agnostic co-occurrence auto-relate (Recall & Working-Memory
 * Quality Suite, t_7a632707).
 *
 * Entities that are repeatedly co-referenced from the same notes are
 * statistically related even when no direct link connects them. This
 * pass reads ONLY link structure - the wikilink targets and typed
 * frontmatter relations each note already declares - and scores every
 * co-referenced pair with a PMI / document-frequency metric. There is no
 * natural-language word list in any language: the signal is purely the
 * incidence of one canonical target alongside another, so a vault in any
 * script scores identically for the same structure.
 *
 * Output is a derived SUGGESTION artifact, never a note mutation. It
 * persists under the same convention as the self-tuning artifact:
 * schema-versioned, dataset-hashed, re-validated on read, fail-soft to
 * null. A pair already joined by a direct link is never re-suggested.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { EXCLUDED_DIRS, extractWikilinks, listVaultPages, parseFrontmatter } from "../../vault.ts";
import {
  extractFrontmatterRelations,
  normalizeRelationTarget,
} from "../../graph/frontmatter-relations.ts";
import type { FrontmatterMap } from "../../types.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";

export const CO_OCCURRENCE_SCHEMA_VERSION = "o2b.cooccurrence.v1";

const DEFAULT_MIN_CO_DOCUMENTS = 2;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_LIMIT = 100;
const ARTIFACT_REL = join("Brain", "link-graph", "co-occurrence.json");

/** One suggested relationship edge between two co-referenced entities. */
export interface CoOccurrenceSuggestion {
  /** Lexicographically smaller canonical entity key. */
  readonly left: string;
  /** Lexicographically larger canonical entity key. */
  readonly right: string;
  /** Number of notes that referenced both entities. */
  readonly coDocumentCount: number;
  /** PMI-style association score (higher = more surprising co-occurrence). */
  readonly score: number;
}

export interface CoOccurrenceOptions {
  /** Minimum notes co-referencing a pair for a suggestion. Default 2. */
  readonly minCoDocuments?: number;
  /** Minimum score to keep a suggestion. Default 0. */
  readonly minScore?: number;
  /** Maximum suggestions returned, after ranking. Default 100. */
  readonly limit?: number;
}

export interface CoOccurrenceResult {
  readonly schema: string;
  /** Hash of the link incidence the suggestions were derived from. */
  readonly vaultHash: string;
  /** Number of notes that contributed at least one outbound reference. */
  readonly documentCount: number;
  readonly suggestions: ReadonlyArray<CoOccurrenceSuggestion>;
}

/**
 * Reduce a raw wikilink / relation target to a canonical entity key:
 * strip brackets/alias/heading (shared with the page contract), then the
 * directory, the `.md` extension, normalise to NFC, and lowercase. Purely
 * mechanical - no language assumptions.
 */
export function canonicalCoOccurrenceKey(raw: string): string | null {
  const target = normalizeRelationTarget(raw);
  if (target === null) return null;
  const leaf = basename(target.replaceAll("\\", "/"));
  const withoutExt = leaf.toLowerCase().endsWith(".md") ? leaf.slice(0, -3) : leaf;
  const normalized = withoutExt.normalize("NFC").toLowerCase().trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Compute co-occurrence suggestions over the vault's link structure.
 * Deterministic for a fixed vault: identical incidence yields identical
 * suggestions and order.
 */
export function computeCoOccurrenceSuggestions(
  vault: string,
  opts: CoOccurrenceOptions = {},
): CoOccurrenceResult {
  const minCoDocuments = Math.max(1, Math.floor(opts.minCoDocuments ?? DEFAULT_MIN_CO_DOCUMENTS));
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  const pages = listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL] });

  // pageKey -> set of canonical targets it references (for direct-link
  // exclusion). targetSets in stable insertion order for hashing.
  const outboundByPage = new Map<string, Set<string>>();
  const incidence: Array<{ readonly page: string; readonly targets: string[] }> = [];

  for (const page of pages) {
    const pageKey = canonicalCoOccurrenceKey(basename(page.path));
    if (pageKey === null) continue;
    const targets = referencedKeys(page.metadata, page.path, pageKey);
    outboundByPage.set(pageKey, new Set(targets));
    if (targets.length > 0) incidence.push({ page: pageKey, targets });
  }

  const documentFrequency = new Map<string, number>();
  const coCount = new Map<string, number>();
  for (const { targets } of incidence) {
    const unique = [...new Set(targets)].toSorted();
    for (const t of unique) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = pairKey(unique[i]!, unique[j]!);
        coCount.set(key, (coCount.get(key) ?? 0) + 1);
      }
    }
  }

  const documentCount = incidence.length;
  const suggestions: CoOccurrenceSuggestion[] = [];
  for (const [key, count] of coCount) {
    if (count < minCoDocuments) continue;
    const [left, right] = splitPairKey(key);
    if (isDirectlyLinked(outboundByPage, left, right)) continue;
    const dfLeft = documentFrequency.get(left) ?? 1;
    const dfRight = documentFrequency.get(right) ?? 1;
    const score = round6(Math.log2((count * documentCount) / (dfLeft * dfRight)));
    if (score < minScore) continue;
    suggestions.push({ left, right, coDocumentCount: count, score });
  }

  suggestions.sort(
    (a, b) =>
      b.score - a.score ||
      (a.left < b.left ? -1 : a.left > b.left ? 1 : 0) ||
      (a.right < b.right ? -1 : a.right > b.right ? 1 : 0),
  );

  return Object.freeze({
    schema: CO_OCCURRENCE_SCHEMA_VERSION,
    vaultHash: hashIncidence(incidence),
    documentCount,
    suggestions: Object.freeze(suggestions.slice(0, limit)),
  });
}

/** Persist the suggestions artifact. Returns the absolute path written. */
export function writeCoOccurrenceSuggestions(
  vault: string,
  result: CoOccurrenceResult,
  opts: { readonly generatedAt: string },
): string {
  const path = join(vault, ARTIFACT_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema: result.schema,
        generated_at: opts.generatedAt,
        vault_hash: result.vaultHash,
        document_count: result.documentCount,
        suggestions: result.suggestions,
      },
      null,
      2,
    ) + "\n",
  );
  return path;
}

/**
 * Read the persisted suggestions, re-validated against the current
 * schema version. Fail-soft: missing file, torn JSON, wrong schema, or a
 * malformed payload all read as null.
 */
export function readCoOccurrenceSuggestions(vault: string): CoOccurrenceResult | null {
  const path = join(vault, ARTIFACT_REL);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record["schema"] !== CO_OCCURRENCE_SCHEMA_VERSION) return null;
    const rawSuggestions = record["suggestions"];
    if (!Array.isArray(rawSuggestions)) return null;
    const suggestions: CoOccurrenceSuggestion[] = [];
    for (const raw of rawSuggestions) {
      const parsedSuggestion = parseSuggestion(raw);
      if (parsedSuggestion === null) return null;
      suggestions.push(parsedSuggestion);
    }
    const vaultHash = typeof record["vault_hash"] === "string" ? record["vault_hash"] : "";
    const documentCount =
      typeof record["document_count"] === "number" ? record["document_count"] : 0;
    return Object.freeze({
      schema: CO_OCCURRENCE_SCHEMA_VERSION,
      vaultHash,
      documentCount,
      suggestions: Object.freeze(suggestions),
    });
  } catch {
    return null;
  }
}

function referencedKeys(meta: FrontmatterMap, absPath: string, selfKey: string): string[] {
  const targets = new Set<string>();
  let body = "";
  try {
    [, body] = parseFrontmatter(absPath);
  } catch {
    body = "";
  }
  for (const raw of extractWikilinks(body)) {
    const key = canonicalCoOccurrenceKey(raw);
    if (key !== null && key !== selfKey) targets.add(key);
  }
  for (const edge of extractFrontmatterRelations(meta)) {
    const key = canonicalCoOccurrenceKey(edge.target);
    if (key !== null && key !== selfKey) targets.add(key);
  }
  return [...targets];
}

function isDirectlyLinked(
  outboundByPage: ReadonlyMap<string, ReadonlySet<string>>,
  left: string,
  right: string,
): boolean {
  return (
    (outboundByPage.get(left)?.has(right) ?? false) ||
    (outboundByPage.get(right)?.has(left) ?? false)
  );
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

function splitPairKey(key: string): readonly [string, string] {
  const idx = key.indexOf(" ");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function hashIncidence(
  incidence: ReadonlyArray<{ readonly page: string; readonly targets: string[] }>,
): string {
  const stable = incidence
    .map((entry) => [entry.page, [...entry.targets].toSorted()] as const)
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function parseSuggestion(raw: unknown): CoOccurrenceSuggestion | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const left = record["left"];
  const right = record["right"];
  const coDocumentCount = record["coDocumentCount"];
  const score = record["score"];
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    typeof coDocumentCount !== "number" ||
    typeof score !== "number"
  ) {
    return null;
  }
  return Object.freeze({ left, right, coDocumentCount, score });
}
