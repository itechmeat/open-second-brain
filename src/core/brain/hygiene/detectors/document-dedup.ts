/**
 * Document-dedup detector (storage lifecycle, Lane 4; plan task 4.1).
 *
 * Ingest summary pages (kind `brain-source`, `Brain/sources/`) written
 * from different sources can carry near-identical bodies - the same
 * material ingested twice, or one source copied over another. Each
 * redundant copy keeps its own source link, manifest entry and archive
 * stamp, so the vault pays for one fact several times. This detector
 * groups such pages and nominates the group for retirement: one page
 * survives as canonical, the others are retired through the hygiene
 * apply plan (action `retire`), which routes to the retirement core
 * (`document-retire.ts`).
 *
 * Two similarity layers, matching the preference dedup detector:
 *
 *   - Lexical: token jaccard over the page body at
 *     {@link DOCUMENT_DEDUP_LEXICAL_THRESHOLD}, bucketed by the folded
 *     composite scope key so identical text in two scopes never groups
 *     (per-scope keying, t_37c05a34). This is the layer the hygiene scan
 *     registry runs.
 *   - Embedding (`detectSemanticDocumentDedup`): cosine over a
 *     configured provider's vectors at
 *     {@link DOCUMENT_DEDUP_EMBEDDING_THRESHOLD}, crossing scope
 *     buckets is deliberately NOT done here - documents are grouped
 *     within scope only, because a scope boundary is an operator
 *     decision a similarity score must not overrule. Any provider
 *     problem falls back to the lexical layer, labeled as such.
 *     WIRING STATUS (review L6): this layer is exported and tested but
 *     NO scan path calls it yet - the scan registry is synchronous and
 *     this layer is async, so reaching it needs the scan's signature to
 *     go async across its callers first. Until that lands, the 0.97
 *     embedding threshold is unreachable from every surface, and the
 *     scan's similarity answers are lexical only; the CHANGELOG must not
 *     claim the embedding layer for the wired detector.
 *
 * Canonical selection is keep-newest on `created_at`. A group holding
 * ANY member without `created_at` is ineligible: the page-dedup lane's
 * mtime fallback is merge-unstable (GitHub #180 - the merge itself
 * moves the mtime it falls back to), so such a group is reported for
 * review with the reason in evidence, never for retirement.
 *
 * The candidate cap bounds files READ; a cap that bound the read set
 * emits the {@link withCandidateCapNotice} coverage row, so a truncated
 * scan never answers clean (review M9).
 *
 * Union-find components can be CHAINS (A~B, B~C, A!~C): one group, but
 * not one similarity. A member therefore retires only on its OWN
 * above-threshold pair against the chosen canonical; a member the
 * grouping reached only transitively is split into a review finding
 * with the reason in evidence, so keep-newest can never retire a page
 * no score tied to the survivor.
 *
 * Pages a merge already resolved leave the pool through the one shared
 * predicate every duplicate detector in the project asks
 * ({@link isMergeResolved}). The detector never mutates anything.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../../vault.ts";
import { resolveSearchConfig } from "../../../search/index.ts";
import { makeProvider } from "../../../search/embeddings/provider.ts";
import { providerProducesVectors } from "../../../search/embeddings/contract.ts";
import type { EmbeddingProvider } from "../../../search/embeddings/contract.ts";
import { compositeScopeKey, scopeFromFrontmatter } from "../../../scope-key.ts";
import { BRAIN_SOURCES_REL } from "../../paths.ts";
import { BRAIN_SOURCE_KIND } from "../../ingest/ingest.ts";
import { NEAR_DUPLICATE_MIN_TOKENS, roundScore } from "../../near-duplicate.ts";
import { findSimilarPairs, tokenise } from "../../similarity.ts";
import { isMergeResolved, mergePointerLookup, readMergedInto } from "../../page-meta/page-id.ts";
import { DEDUP_EMBEDDING_THRESHOLD, DEDUP_LEXICAL_THRESHOLD, type DedupMethod } from "./dedup.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneDetectorContext, HygieneFinding } from "../types.ts";

/** Inclusive token-jaccard lower bound for nominating a document pair. */
export const DOCUMENT_DEDUP_LEXICAL_THRESHOLD = DEDUP_LEXICAL_THRESHOLD;
/** Inclusive embedding-cosine lower bound for nominating a document pair. */
export const DOCUMENT_DEDUP_EMBEDDING_THRESHOLD = DEDUP_EMBEDDING_THRESHOLD;

/** Bound on how many summary pages enter pairwise comparison. */
export const DOCUMENT_DEDUP_CANDIDATE_CAP = 200;

/**
 * Why a group is reported for review instead of retirement. Stated once
 * so the finding evidence and the docs cannot drift apart.
 */
export const DOCUMENT_DEDUP_INELIGIBLE_REASON =
  "a group member has no created_at; the mtime fallback is merge-unstable (GitHub #180)";

/**
 * Why a grouped member is held out of a retirement finding: the
 * union-find component it sits in can be CHAINED (A~B, B~C, A!~C), so
 * membership alone proves nothing about the member the canonical was
 * picked to be. Retirement acts only on a member with its OWN
 * above-threshold pair against the chosen canonical; everyone else is
 * reported for review with this reason. Stated once so the finding
 * evidence and the docs cannot drift apart.
 */
export const DOCUMENT_DEDUP_TRANSITIVE_REASON =
  "a grouped member has no direct above-threshold similarity to the canonical; retirement never acts on transitive similarity";

export interface DocumentDedupOptions {
  readonly lexicalThreshold?: number;
}

export interface SemanticDocumentDedupOptions {
  /**
   * Embedding provider override. `undefined` resolves the vault's
   * configured provider; `null` (or an unusable provider) falls back
   * to the lexical layer.
   */
  readonly provider?: EmbeddingProvider | null;
  readonly threshold?: number;
  readonly lexicalThreshold?: number;
  /**
   * The caller's reach predicate, the same admission filter the lexical
   * layer applies: a page it refuses is absent - never embedded, never
   * scored, never named. Absent means read-everything.
   */
  readonly readable?: (rel: string) => boolean;
}

export interface SemanticDocumentDedupResult {
  readonly method: DedupMethod;
  readonly findings: ReadonlyArray<HygieneFinding>;
}

/** One ingest summary page the detector admitted. */
interface DocumentRecord {
  /** Vault-relative POSIX path - the id every source surface addresses. */
  readonly path: string;
  readonly body: string;
  /** ISO `created_at`, or `null` when absent, blank or unparseable. */
  readonly createdAtIso: string | null;
  /** The `merged_into:` pointer the page carries, or `null`. */
  readonly mergedInto: string | null;
  /** Folded composite scope key; empty when the page declares no scope. */
  readonly scopeKey: string;
}

/** One scored pair, carried into finding evidence. */
interface PairScore {
  readonly pair: readonly [string, string];
  readonly similarity: number;
}

/**
 * Every ingest summary page under `Brain/sources/`, in deterministic
 * order, after the three admission filters:
 *
 *   - the caller's `readable` predicate (a refused page is absent - it
 *     is not scored, not grouped, not named, and not read);
 *   - the candidate cap, which bounds files READ: entries past the cap
 *     are still COUNTED on {@link CollectedDocuments.listed}, never
 *     opened;
 *   - the merge-resolved predicate (GitHub #180), applied to the read
 *     set the same way the preference dedup detector applies it.
 *
 * A page whose frontmatter does not parse is skipped, as in every other
 * detector; corruption is the doctor's job, not a scan abort. The count
 * of what the cap left unread is what lets both layers name their
 * coverage ({@link withCandidateCapNotice}) instead of answering clean
 * over a truncated scan (review M9).
 */
interface CollectedDocuments {
  readonly records: DocumentRecord[];
  /**
   * The count the cap bounds: how many pages were collected BEFORE the
   * merge-resolved filter thinned them, i.e. the size of the read set.
   * The coverage notice gates on THIS count - gating on
   * {@link records}.length would let a merge-resolved page inside the
   * capped read set read as an under-cap scan and silence the notice
   * while pages past the cap were never opened (review M9).
   */
  readonly read: number;
  /** Every `.md` entry listed under the reach, read or not, sorted order. */
  readonly listed: number;
}

function collectDocumentRecords(
  vault: string,
  readable?: (rel: string) => boolean,
): CollectedDocuments {
  const dir = join(vault, BRAIN_SOURCES_REL);
  if (!existsSync(dir)) return { records: [], read: 0, listed: 0 };
  const out: DocumentRecord[] = [];
  let listed = 0;
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = `${BRAIN_SOURCES_REL}/${name}`;
    if (readable !== undefined && !readable(path)) continue;
    listed += 1;
    // The cap bounds files READ: past it the walk only counts, it never
    // opens the page. The count is what the coverage notice reports.
    if (out.length >= DOCUMENT_DEDUP_CANDIDATE_CAP) continue;
    const abs = join(dir, name);
    let meta: Record<string, unknown>;
    let body: string;
    try {
      [meta, body] = parseFrontmatter(abs);
    } catch {
      continue;
    }
    if (meta["kind"] !== BRAIN_SOURCE_KIND) continue;
    const rawCreated = meta["created_at"];
    const createdAtIso =
      typeof rawCreated === "string" && Number.isFinite(Date.parse(rawCreated)) ? rawCreated : null;
    out.push({
      path,
      body,
      createdAtIso,
      mergedInto: readMergedInto(meta),
      scopeKey: compositeScopeKey(scopeFromFrontmatter(meta)),
    });
  }
  const pointerOf = mergePointerLookup(out.map((r) => [r.path, r.mergedInto] as const));
  return {
    records: out.filter((r) => !isMergeResolved(r.path, pointerOf)),
    read: out.length,
    listed,
  };
}

/**
 * Append the coverage notice a reached cap owes the caller (review M9):
 * only the first {@link DOCUMENT_DEDUP_CANDIDATE_CAP} summary pages in
 * path order were compared, so duplicates sorting after it were never
 * read, and without this row a truncated scan looks clean. The notice is
 * review-only - it never retires anything - and it fires only when the
 * cap actually bound the read set (`read` at the cap with pages left
 * listed), so a small vault with a few non-summary `.md` files never
 * sees it. `read` is the pre-filter collected count: the merge-resolved
 * pages a read set loses AFTERWARD cannot shrink what the cap bound.
 * Returned findings stay in the deterministic target order.
 */
function withCandidateCapNotice(
  listed: number,
  read: number,
  findings: HygieneFinding[],
): HygieneFinding[] {
  if (read < DOCUMENT_DEDUP_CANDIDATE_CAP || listed <= DOCUMENT_DEDUP_CANDIDATE_CAP) {
    return findings;
  }
  const notice = Object.freeze({
    id: hygieneFindingId("document-dedup", [BRAIN_SOURCES_REL]),
    detector: "document-dedup" as const,
    severity: "warning" as const,
    title:
      `Document-dedup compared only the first ${DOCUMENT_DEDUP_CANDIDATE_CAP} of ` +
      `${listed} listed pages; duplicates past the cap were never read`,
    targets: Object.freeze([BRAIN_SOURCES_REL]),
    proposed_action: "review" as const,
    evidence: Object.freeze({
      candidate_cap_reached: true,
      cap: DOCUMENT_DEDUP_CANDIDATE_CAP,
      scanned: read,
      total: listed,
    }),
  });
  return [...findings, notice].toSorted((a, b) => (a.targets[0]! < b.targets[0]! ? -1 : 1));
}

/**
 * Union-find over scored pairs: the groups retirement acts on. Pairs in
 * different scope buckets never share a component, because the bucket
 * walk below never produced such a pair.
 */
function connectedGroups(
  paths: ReadonlyArray<string>,
  pairs: ReadonlyArray<PairScore>,
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const path of paths) adjacency.set(path, []);
  for (const { pair } of pairs) {
    adjacency.get(pair[0])?.push(pair[1]);
    adjacency.get(pair[1])?.push(pair[0]);
  }
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const start of paths) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      group.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    if (group.length >= 2) groups.push(group.toSorted());
  }
  return groups;
}

/**
 * One finding per connected group. Canonical is the newest `created_at`
 * (ties broken by path ascending); any member without `created_at`
 * makes the whole group ineligible - the mtime fallback that ordering
 * would need is the one the merge itself moves (GitHub #180).
 */
function findingsFromGroups(
  records: ReadonlyArray<DocumentRecord>,
  pairs: ReadonlyArray<PairScore>,
  meta: { readonly method: DedupMethod; readonly threshold: number; readonly model?: string },
): HygieneFinding[] {
  const byPath = new Map(records.map((r) => [r.path, r]));
  const paths = records.map((r) => r.path);
  const findings: HygieneFinding[] = [];
  for (const group of connectedGroups(paths, pairs)) {
    const members = group.map((path) => byPath.get(path)!);
    const membersWithoutCreated = members.filter((m) => m.createdAtIso === null).map((m) => m.path);
    const groupPairs = pairs
      .filter((p) => group.includes(p.pair[0]) && group.includes(p.pair[1]))
      .toSorted((a, b) => (a.pair[0] < b.pair[0] ? -1 : a.pair[0] > b.pair[0] ? 1 : 0));
    const shared = {
      method: meta.method,
      threshold: meta.threshold,
      similarities: groupPairs,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
    };
    if (membersWithoutCreated.length > 0) {
      const targets = members.map((m) => m.path);
      findings.push(
        Object.freeze({
          id: hygieneFindingId("document-dedup", targets),
          detector: "document-dedup" as const,
          severity: "warning" as const,
          title: `Near-duplicate documents ${targets.join(", ")} (not retirement-eligible)`,
          targets: Object.freeze(targets),
          proposed_action: "review" as const,
          evidence: Object.freeze({
            ...shared,
            ineligible: true,
            reason: DOCUMENT_DEDUP_INELIGIBLE_REASON,
            members_without_created_at: Object.freeze(membersWithoutCreated),
          }),
        }),
      );
      continue;
    }
    // Keep-newest: the newest created_at wins, ties break on the path
    // ascending. Deterministic and merge-stable - no field this decision
    // writes can move the field it sorted on.
    const canonical = members.toSorted((a, b) => {
      const diff = Date.parse(b.createdAtIso!) - Date.parse(a.createdAtIso!);
      if (diff !== 0) return diff;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })[0]!;
    // The transitive-similarity gate. The component the union-find built
    // can be a chain (A~B, B~C, A!~C): keep-newest then picks a canonical
    // that one END of the chain is not similar to at all, and retiring
    // that end would delete a page no score ever tied to the survivor.
    // So a member retires only on its OWN recorded pair against the
    // canonical; the rest fall to review with the reason named.
    const directToCanonical = new Set<string>([canonical.path]);
    for (const pair of pairs) {
      const [x, y] = pair.pair;
      if (pair.similarity < meta.threshold) continue;
      if (x === canonical.path && byPath.has(y)) directToCanonical.add(y);
      if (y === canonical.path && byPath.has(x)) directToCanonical.add(x);
    }
    const heldForReview = members.filter((m) => !directToCanonical.has(m.path));
    if (heldForReview.length > 0) {
      const retiring = members.filter((m) => directToCanonical.has(m.path));
      const reviewTargets = [...heldForReview.map((m) => m.path), canonical.path].toSorted();
      findings.push(
        Object.freeze({
          id: hygieneFindingId(
            "document-dedup",
            members.map((m) => m.path),
          ),
          detector: "document-dedup" as const,
          severity: "warning" as const,
          title: `Near-duplicate documents ${reviewTargets.join(", ")} (not retirement-eligible)`,
          targets: Object.freeze(reviewTargets),
          proposed_action: "review" as const,
          evidence: Object.freeze({
            ...shared,
            canonical: canonical.path,
            ineligible: true,
            reason: DOCUMENT_DEDUP_TRANSITIVE_REASON,
            members_without_direct_pair: Object.freeze(heldForReview.map((m) => m.path).toSorted()),
          }),
        }),
      );
      // The similar subgroup still retires; its evidence narrows to the
      // pairs inside it, so the finding never cites a similarity the
      // canonical itself does not answer for.
      const retiringPaths = new Set(retiring.map((m) => m.path));
      const createdAt: Record<string, string> = {};
      for (const member of retiring) createdAt[member.path] = member.createdAtIso!;
      findings.push(
        Object.freeze({
          id: hygieneFindingId(
            "document-dedup",
            retiring.map((m) => m.path),
          ),
          detector: "document-dedup" as const,
          severity: "warning" as const,
          title: `Near-duplicate documents ${retiring.map((m) => m.path).join(", ")}`,
          targets: Object.freeze(retiring.map((m) => m.path)),
          proposed_action: "retire" as const,
          evidence: Object.freeze({
            ...shared,
            similarities: groupPairs.filter(
              (p) => retiringPaths.has(p.pair[0]) && retiringPaths.has(p.pair[1]),
            ),
            canonical: canonical.path,
            created_at: createdAt,
          }),
        }),
      );
      continue;
    }
    const createdAt: Record<string, string> = {};
    for (const member of members) createdAt[member.path] = member.createdAtIso!;
    findings.push(
      Object.freeze({
        id: hygieneFindingId(
          "document-dedup",
          members.map((m) => m.path),
        ),
        detector: "document-dedup" as const,
        severity: "warning" as const,
        title: `Near-duplicate documents ${members.map((m) => m.path).join(", ")}`,
        targets: Object.freeze(members.map((m) => m.path)),
        proposed_action: "retire" as const,
        evidence: Object.freeze({
          ...shared,
          canonical: canonical.path,
          created_at: createdAt,
        }),
      }),
    );
  }
  // Deterministic report order: by the group's first (lexicographically
  // smallest) target path, never by discovery order.
  return findings.toSorted((a, b) => (a.targets[0]! < b.targets[0]! ? -1 : 1));
}

/** Lexical pairing: token jaccard within scope buckets at the threshold. */
function lexicalPairs(records: ReadonlyArray<DocumentRecord>, threshold: number): PairScore[] {
  const entries = records.map((r) => ({
    id: r.path,
    bucketKey: r.scopeKey,
    tokens: tokenise(r.body),
    source: r,
  }));
  return findSimilarPairs(entries, { threshold }).map((pair) => ({
    pair: [pair.a.id, pair.b.id] as const,
    similarity: roundScore(pair.jaccard),
  }));
}

/**
 * Document-dedup detector, lexical layer. Deterministic, provider-free;
 * this is the form the hygiene scan registry runs.
 */
export function detectDocumentDedup(
  vault: string,
  ctx: HygieneDetectorContext,
  opts: DocumentDedupOptions = {},
): ReadonlyArray<HygieneFinding> {
  const threshold = opts.lexicalThreshold ?? DOCUMENT_DEDUP_LEXICAL_THRESHOLD;
  const { records, read, listed } = collectDocumentRecords(vault, ctx.readable);
  const compared = records.filter((r) => tokenise(r.body).size >= NEAR_DUPLICATE_MIN_TOKENS);
  if (compared.length < 2) return withCandidateCapNotice(listed, read, []);
  return withCandidateCapNotice(
    listed,
    read,
    findingsFromGroups(compared, lexicalPairs(compared, threshold), {
      method: "lexical",
      threshold,
    }),
  );
}

function resolveConfiguredProvider(vault: string): EmbeddingProvider | null {
  try {
    const config = resolveSearchConfig({ vault });
    // The consent travels with the configuration that would spend it:
    // this semantic configuration was resolved env-only (no config path),
    // so the consent reads the same source instead of whatever file the
    // process happens to default to.
    const provider = makeProvider({ ...config.semantic, configPath: config.configPath });
    return providerProducesVectors(provider) ? provider : null;
  } catch {
    return null;
  }
}

/**
 * Cosine of two EQUAL-dimension vectors - the caller guarantees the
 * dimension check above, because truncating a shorter vector into a
 * longer space scores a similarity over incomparable coordinates.
 */
function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Document-dedup detector, embedding layer: embed every eligible body
 * (bounded by the same cap as the lexical layer) and group pairs whose
 * cosine reaches the threshold, within scope buckets. Any provider
 * problem falls back to the deterministic lexical layer, labeled as
 * such - a report never passes lexical similarity off as semantic.
 */
export async function detectSemanticDocumentDedup(
  vault: string,
  opts: SemanticDocumentDedupOptions = {},
): Promise<SemanticDocumentDedupResult> {
  const provider = opts.provider === undefined ? resolveConfiguredProvider(vault) : opts.provider;
  const lexical = (): SemanticDocumentDedupResult =>
    Object.freeze({
      method: "lexical" as const,
      findings: detectDocumentDedup(
        vault,
        {
          now: new Date(0),
          ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
        },
        opts.lexicalThreshold !== undefined ? { lexicalThreshold: opts.lexicalThreshold } : {},
      ),
    });
  // An INJECTED provider reaches here without passing through
  // `resolveConfiguredProvider`, so the contract predicate is asked again
  // rather than assumed - the same provenance-at-the-boundary rule the
  // preference dedup detector applies.
  if (provider === null || !providerProducesVectors(provider)) return lexical();

  const { records, read, listed } = collectDocumentRecords(vault, opts.readable);
  const compared = records.filter((r) => tokenise(r.body).size >= NEAR_DUPLICATE_MIN_TOKENS);
  // The same coverage notice the lexical layer owes (review M9), wrapped
  // around whichever result this run answers.
  const withCap = (result: SemanticDocumentDedupResult): SemanticDocumentDedupResult =>
    Object.freeze({
      ...result,
      findings: Object.freeze(withCandidateCapNotice(listed, read, [...result.findings])),
    });
  if (compared.length < 2) return lexical();
  const threshold = opts.threshold ?? DOCUMENT_DEDUP_EMBEDDING_THRESHOLD;

  let vectors: number[][];
  try {
    vectors = await provider.embed(compared.map((r) => r.body));
  } catch {
    return lexical();
  }
  if (vectors.length !== compared.length) return lexical();
  // A ragged batch - vectors of differing dimensions - is the same
  // broken-provider shape as a count mismatch: the cosine below would
  // silently truncate to the shorter vector and fabricate a similarity
  // out of incomparable spaces, so the whole run answers lexical, labeled.
  const dimension = vectors[0]!.length;
  if (vectors.some((v) => v.length !== dimension)) return lexical();

  const pairs: PairScore[] = [];
  for (let i = 0; i < compared.length; i++) {
    for (let j = i + 1; j < compared.length; j++) {
      // Scope buckets fold here too: a similarity score must not
      // overrule the operator's scope boundary.
      if (compared[i]!.scopeKey !== compared[j]!.scopeKey) continue;
      const similarity = cosine(vectors[i]!, vectors[j]!);
      if (similarity < threshold) continue;
      pairs.push({
        pair: [compared[i]!.path, compared[j]!.path],
        similarity: roundScore(similarity),
      });
    }
  }
  return withCap({
    method: "embedding" as const,
    findings: Object.freeze(
      findingsFromGroups(compared, pairs, {
        method: "embedding",
        threshold,
        model: provider.model,
      }),
    ),
  });
}
