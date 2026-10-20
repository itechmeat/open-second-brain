/**
 * Cross-topic rule promotion (t_642bc2b8): the pure planner that elects
 * ONE recurring cross-topic rule per owner token per calendar day, plus
 * the `Brain/cross-topic-rules.json` ledger that carries that budget.
 *
 * One reason to change: what makes a pattern "recurring across topics"
 * and what may be promoted about it. The deterministic, always-available
 * signal is shared principle text across distinct topic buckets - the
 * lexical layer the same-topic merge machinery (`findSimilarPairs`,
 * `findMergeCandidates`) is blind to by construction, since both bucket
 * entries by topic before comparing. This module inverts that walk:
 * pairs are only considered ACROSS buckets, so a cluster is by
 * construction something no same-topic pass could have acted on.
 *
 * The promoted artifact is an ordinary unconfirmed preference
 * (`provenance: "inferred"`, `evidenced_by` wikilinks to every source,
 * `related` lineage), written by the dream apply stage through
 * `writePreferenceTxn` and left to the normal refresh/confirm/retire
 * machinery afterwards. The planner is pure - no I/O, no wall clock;
 * the ledger is read by the caller and the date comes from the pass's
 * injected `now`, so the same corpus elects the same rule on every
 * machine and a rerun plans nothing.
 *
 * Deliberate limits, named rather than hidden:
 *
 *   - Sources are never modified or retired. The planner only reads
 *     `scan.preferences` and enqueues one new entry; the promotion is
 *     append-only by construction.
 *   - A source the same pass plans to retire is not eligible: citing a
 *     rule the run is about to move into `retired/` would hang evidence
 *     off a moved file.
 *   - Sources must share one normalized owner token (ownerless counts
 *     as the shared token). A cross-owner cluster is never promoted, so
 *     owner-scoped recall cannot leak one agent's rules into another's
 *     rule body.
 *   - Because the rule restates a source verbatim, the hygiene dedup
 *     detector and the digest's merge suggestions WILL eventually
 *     nominate it against its own sources. Teaching those predicates to
 *     skip pairs where one side cites the other is a follow-up unit;
 *     this module only keeps its own output idempotent: the
 *     content-derived slug dedups the exact source set, and the
 *     duplicate-rule guard below keeps membership churn (a source
 *     joining or leaving a promoted cluster, which mints a fresh slug)
 *     from re-creating a live rule for a principle the owner's existing
 *     inferred rules already carry.
 *   - Topic-keyed recall (`query.ts` compares raw topic bytes) will not
 *     surface the rule: its synthetic topic is a key no signal carries.
 *     The `related` lineage and evidence wikilinks are the way back to
 *     it; stretching recall into that key is deliberately out of scope.
 */

import { basename, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { strictestVisibilityOf } from "../graph/visibility.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sha256Hex } from "../integrity/digest.ts";
import {
  preferenceSlug,
  topicKey,
  RETIRED_ID_PREFIX,
  type PlanState,
  type ScanResult,
} from "./dream-plan.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import { JACCARD_MERGE_SUGGEST_THRESHOLD } from "./merge-candidates.ts";
import { preferenceOwner } from "./owner-scoped-facts.ts";
import { crossTopicLedgerPath } from "./paths.ts";
import { jaccard, tokenise } from "./similarity.ts";
import { isoDate } from "./time.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainConfig } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * Minimum distinct folded topic buckets before a cluster may fire.
 * Two is the smallest honest "across topics"; one would re-implement
 * the same-topic merge machinery.
 */
export const DEFAULT_CROSS_TOPIC_MIN_TOPICS = 2;

/**
 * Principle-similarity floor for a cross-bucket pair. Matches the
 * merge-suggestion detector's level (`merge-candidates.ts`): strict
 * enough that a fired cluster reads as "the same rule stated twice in
 * two subjects", loose enough that paraphrase counts.
 */
export const DEFAULT_CROSS_TOPIC_JACCARD = 0.6;

/**
 * The resolver's floor for `min_topics`, the figure the block contract
 * clamps to. Same number as the default, for the reason the default
 * gives: two is the smallest honest "across topics", and a declared 1
 * would elect singletons - each pass copying an arbitrary confirmed
 * preference under a `cross-` slug, the same-topic duplication the
 * floor exists to prevent.
 */
export const MIN_CROSS_TOPIC_MIN_TOPICS = DEFAULT_CROSS_TOPIC_MIN_TOPICS;

/**
 * The resolver's floor for `jaccard`: the merge-suggestion detector's
 * level, the calibration both detectors share. Below it a fired cluster
 * no longer reads as "the same rule stated twice"; at 0 every
 * same-owner cross-bucket pair edges and the whole pool unions into one
 * giant cluster whose representative principle is whatever the sort
 * order put first.
 */
export const MIN_CROSS_TOPIC_JACCARD = JACCARD_MERGE_SUGGEST_THRESHOLD;

/** On-disk ledger schema version. */
export const CROSS_TOPIC_LEDGER_VERSION = 1;

/** Slug prefix of every promoted rule, reserved by content shape. */
const CROSS_SLUG_PREFIX = "cross-";

/** Separator of the slug hash input (sorted source ids). */
const SLUG_ID_JOIN = "\n";

/** Separator of the synthetic topic display. */
const TOPIC_JOIN = " + ";

/**
 * Disclosure code carried by every promotion the duplicate-rule guard
 * declined. The skips ride the planner's result summary - the same
 * channel the daily budget's skips answer on (`fired: false`, nothing
 * written) - so a caller can lift them onto its own warning surface
 * without the planner owning one.
 */
export const CROSS_TOPIC_DUPLICATE_RULE_CODE = "cross-topic-duplicate-rule";

/** Frozen empty skips, shared by every pass that declined nothing. */
const NO_SKIPS: ReadonlyArray<CrossTopicSkip> = Object.freeze([]);

/** Resolved knobs the planner plans against. */
export interface ResolvedCrossTopicConfig {
  readonly minTopics: number;
  readonly jaccard: number;
}

/**
 * One clamp the resolver applied to a declared knob, delivered as a
 * (code, message) pair so the caller files it on whatever warning
 * surface it owns (the dream pass: `DreamRunSummary.warnings`).
 */
export type CrossTopicClampDisclosure = (code: string, message: string) => void;

/**
 * Resolve the planner knobs from the `cross_topic:` block. The block
 * absent, or present with `enabled: false`, is OFF: `null` tells the
 * caller to skip the planner (and the ledger read) entirely, which is
 * what keeps an un-opted-in vault byte-identical.
 *
 * Declared-but-underfloor values resolve to the floors, per the block
 * parser's contract ("an out-of-range but well-formed number is stored
 * by the parser and clamped - and the clamp disclosed - by the consumer
 * that resolves it"): every clamp is delivered through `disclose` when
 * the caller provides one. The parser still refuses wrong-SHAPE values,
 * so what reaches here is always a number; only the range is corrected.
 */
export function resolveCrossTopicConfig(
  cfg: BrainConfig,
  disclose?: CrossTopicClampDisclosure,
): ResolvedCrossTopicConfig | null {
  const block = cfg.cross_topic;
  if (!block?.enabled) return null;
  const declaredMinTopics = block.min_topics ?? DEFAULT_CROSS_TOPIC_MIN_TOPICS;
  const minTopics = Math.max(declaredMinTopics, MIN_CROSS_TOPIC_MIN_TOPICS);
  if (minTopics !== declaredMinTopics) {
    disclose?.(
      "cross-topic-config-clamped",
      `cross_topic.min_topics: ${declaredMinTopics} is below the floor ` +
        `${MIN_CROSS_TOPIC_MIN_TOPICS}; using ${minTopics} (a cluster spans ` +
        `distinct topic buckets)`,
    );
  }
  const declaredJaccard = block.jaccard ?? DEFAULT_CROSS_TOPIC_JACCARD;
  const jaccard = Math.max(declaredJaccard, MIN_CROSS_TOPIC_JACCARD);
  if (jaccard !== declaredJaccard) {
    disclose?.(
      "cross-topic-config-clamped",
      `cross_topic.jaccard: ${declaredJaccard} is below the floor ` +
        `${MIN_CROSS_TOPIC_JACCARD}; using ${jaccard}`,
    );
  }
  return Object.freeze({
    minTopics,
    jaccard,
  });
}

/**
 * Persisted daily budget: the last calendar date each owner token
 * promoted a cross-topic rule. Read fail-open (absent or unparseable
 * treats every owner as under budget - a corrupt ledger must never
 * block the pass it audits).
 */
export interface CrossTopicLedger {
  readonly version: number;
  readonly last_promoted: Readonly<Record<string, string>>;
}

/** Read the ledger, or null when absent or unparseable (treated as fresh). */
export function readCrossTopicLedger(vault: string): CrossTopicLedger | null {
  const path = crossTopicLedgerPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CrossTopicLedger>;
    return Object.freeze({
      version: typeof parsed.version === "number" ? parsed.version : CROSS_TOPIC_LEDGER_VERSION,
      last_promoted: Object.freeze({ ...parsed.last_promoted }),
    });
  } catch {
    return null;
  }
}

/** Persist the ledger. Called only when a promotion fired. */
export function writeCrossTopicLedger(vault: string, ledger: CrossTopicLedger): void {
  // Vault-identity write guard (context-integrity-gates, Unit J), the
  // same discipline as the rollup ledger: the shared atomic writer
  // keeps the write-site census exactly as it was.
  assertVaultIdentityForWrite(vault);
  atomicWriteFileSync(crossTopicLedgerPath(vault), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** One eligible source preference, projected for the pair walk. */
interface Source {
  /** Raw scanned id (`pref-<slug>`, or a hand-authored bare id). */
  readonly id: string;
  /** Normalized slug behind {@link id}. */
  readonly slug: string;
  /** The normalized `pref-<slug>` form used for output and hashing. */
  readonly normalizedId: string;
  /** Folded topic key (the same fold the consolidation pass uses). */
  readonly key: string;
  /** Raw topic display as the file spells it. */
  readonly topic: string;
  readonly principle: string;
  readonly tokens: ReadonlySet<string>;
  /** Budget token: the owner's normalized token, or "" when ownerless. */
  readonly ownerKey: string;
  /**
   * The record's normalised `visibility:` tokens; empty (the default)
   * for an untagged source.
   */
  readonly visibility: ReadonlyArray<string>;
}

export interface CrossTopicPlannerInput {
  readonly scan: ScanResult;
  /**
   * Post-refresh status: a preference the refresh pass promotes to
   * `confirmed` THIS run is an eligible source even though its scanned
   * frontmatter still says `unconfirmed` - the apply stage will have
   * promoted it before the cross-topic write lands.
   */
  readonly refresh: RefreshResult;
  /** Resolved knobs, or null when the feature is off. */
  readonly config: ResolvedCrossTopicConfig | null;
  /** Prior ledger, or null when none has been written yet. */
  readonly ledger: CrossTopicLedger | null;
  /** The pass's injected clock; the budget date comes from here. */
  readonly now: Date;
  /** Entries are pushed onto `plan.crossTopicRules`. */
  readonly plan: PlanState;
}

/** One promotion the duplicate-rule guard declined, with its reason. */
export interface CrossTopicSkip {
  readonly code: string;
  readonly message: string;
}

export interface CrossTopicPlannerResult {
  readonly fired: boolean;
  /**
   * The complete updated ledger to persist when `fired`; null otherwise,
   * so a below-threshold or budgeted-out pass never touches the file -
   * the same byte-identical opt-out the rollup ledger uses.
   */
  readonly ledger: CrossTopicLedger | null;
  /**
   * Promotions the duplicate-rule guard declined this pass, each naming
   * the live rule it would have duplicated. Disclosed, never written: a
   * skipped cluster spends no daily budget, stamps no ledger, and on
   * the run summary reads exactly like the budget's skips -
   * `cross_topic_rules` simply stays absent.
   */
  readonly skips: ReadonlyArray<CrossTopicSkip>;
}

/**
 * Plan the pass's cross-topic promotions. Deterministic in its inputs:
 * sources are walked in code-unit id order, edges in that order, roots
 * are the smallest member index, clusters are elected by their sorted
 * source-id join, and at most one cluster per owner token fires (the
 * daily budget, stamped into the returned ledger).
 *
 * Each elected cluster survives three gates in order: the daily budget
 * (a budgeted-out pass is a no-op), the content-slug check (the exact
 * source set promoted before, live or dead), and the duplicate-rule
 * guard (M8) - a near-identical principle, or a superset of a live
 * rule's evidence, skips the promotion with a disclosure instead of
 * minting a second live rule.
 */
export function planCrossTopicRules(input: CrossTopicPlannerInput): CrossTopicPlannerResult {
  const { scan, refresh, config, ledger, now, plan } = input;
  if (config === null) return { fired: false, ledger: null, skips: NO_SKIPS };
  const today = isoDate(now);

  const sources = collectSources(scan, refresh, plan);
  const clusters = electClusters(sources, config);
  const existingRules = collectExistingRules(scan, plan);
  const lastPromoted: Record<string, string> = { ...ledger?.last_promoted };
  let fired = false;
  const skips: CrossTopicSkip[] = [];

  for (const cluster of clusters) {
    const ownerKey = cluster.members[0]!.ownerKey;
    // The daily budget: one promotion per owner token per calendar
    // day, checked BEFORE anything else so a budgeted-out pass is a
    // no-op rather than a changed run that wrote nothing.
    if (lastPromoted[ownerKey] === today) continue;
    const normalizedIds = cluster.members.map((m) => m.normalizedId);
    const slug = `${CROSS_SLUG_PREFIX}${sha256Hex(normalizedIds.join(SLUG_ID_JOIN)).slice(0, 12)}`;
    if (slugTaken(slug, scan)) continue;
    const duplicate = findDuplicateRule(cluster, existingRules.get(ownerKey), config.jaccard);
    if (duplicate !== null) {
      // The dedup guard: membership churn mints a new content slug, so
      // the exact-set check above cannot catch a re-statement of a live
      // rule. Skip with a disclosure, and spend no budget - nothing was
      // promoted, so nothing is stamped into the ledger.
      skips.push(skipDuplicate(duplicate, config.jaccard));
      continue;
    }
    lastPromoted[ownerKey] = today;
    fired = true;
    const representative = cluster.members[0]!;
    plan.crossTopicRules.push(
      Object.freeze({
        slug,
        topic: [...new Set(cluster.members.map((m) => m.topic))].sort().join(TOPIC_JOIN),
        principle: representative.principle,
        evidencedBy: Object.freeze(normalizedIds.map((id) => `[[${id}]]`)),
        related: Object.freeze(normalizedIds),
        // The strictest visibility of the sources: the rule restates a
        // source's principle verbatim, so it may never be more public
        // than the most restricted member (the topic plan's own
        // strictestVisibilityOf rule; an intersection that misses falls
        // closed on the reserved token). Empty is default visibility.
        visibility: strictestVisibilityOf(cluster.members.map((m) => m.visibility)),
        ...(ownerKey ? { owner: ownerKey } : {}),
      }),
    );
  }

  return {
    fired,
    ledger: fired
      ? Object.freeze({
          version: CROSS_TOPIC_LEDGER_VERSION,
          last_promoted: Object.freeze(lastPromoted),
        })
      : null,
    skips: skips.length > 0 ? Object.freeze(skips) : NO_SKIPS,
  };
}

/**
 * The eligible source pool: confirmed preferences (at scan time or by
 * this run's refresh) that the pass is not retiring, projected and
 * sorted by raw id in code-unit order so every downstream choice is a
 * property of the corpus alone.
 *
 * A promoted cross-topic rule is NEVER a source. It restates its
 * representative source's principle verbatim (jaccard 1.0) and folds to
 * its own synthetic topic key, so once the refresh machinery confirms it
 * - one applied event does - an admitted rule would put every later pass
 * one `cross-` slug away from "discovering" a new cross-topic cluster
 * containing it and minting another promotion, one per owner per day
 * until the daily budget was the only thing left stopping it. Two
 * identifiers, because the artifact is user-editable: the reserved slug
 * prefix, and the `inferred` provenance every promoted rule carries
 * (which also keeps one inferred fact from citing another inferred fact
 * as its cross-topic evidence).
 *
 * The same two identifiers are what let {@link collectExistingRules}
 * find those records again as duplicate-rule guards: excluded from the
 * sources, admitted against them.
 */
function collectSources(scan: ScanResult, refresh: RefreshResult, plan: PlanState): Source[] {
  const retiring = new Set(plan.retires.map((r) => r.slug));
  const sources: Source[] = [];
  for (const record of scan.preferences) {
    const slug = preferenceSlug(record.pref.id);
    const confirmed =
      record.pref.status === BRAIN_PREFERENCE_STATUS.confirmed || refresh.confirmed.has(slug);
    if (!confirmed || retiring.has(slug)) continue;
    if (slug.startsWith(CROSS_SLUG_PREFIX) || record.pref.provenance === "inferred") continue;
    const owner = preferenceOwner(record.pref);
    sources.push({
      id: record.pref.id,
      slug,
      normalizedId: `pref-${slug}`,
      key: topicKey(record.pref.topic),
      topic: record.pref.topic,
      principle: record.pref.principle,
      tokens: tokenise(record.pref.principle),
      ownerKey: owner ?? "",
      visibility: record.visibility ?? [],
    });
  }
  sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sources;
}

interface Cluster {
  /** Members in code-unit id order (the source pool's order). */
  readonly members: Source[];
  /** Sorted-id join; the cluster's deterministic election key. */
  readonly idJoin: string;
}

/**
 * Union sources across bucket boundaries wherever their principles are
 * similar enough, then keep the components that span at least
 * `min_topics` distinct buckets and share one owner token, ordered by
 * their sorted source-id join.
 *
 * Same-bucket pairs never edge, so a bucket of mutual near-duplicates
 * is invisible here by construction - that is the merge machinery's
 * job, and it already has it.
 */
function electClusters(
  sources: ReadonlyArray<Source>,
  config: ResolvedCrossTopicConfig,
): Cluster[] {
  const parent = sources.map((_, i) => i);
  const find = (start: number): number => {
    let i = start;
    while (parent[i] !== i) {
      const grandparent = parent[parent[i]!]!;
      parent[i] = grandparent;
      i = grandparent;
    }
    return i;
  };
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i]!;
      const b = sources[j]!;
      if (a.key === b.key) continue;
      if (a.ownerKey !== b.ownerKey) continue;
      if (jaccard(a.tokens, b.tokens) < config.jaccard) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }

  const byRoot = new Map<number, Source[]>();
  for (let i = 0; i < sources.length; i++) {
    const root = find(i);
    const members = byRoot.get(root) ?? [];
    members.push(sources[i]!);
    byRoot.set(root, members);
  }

  const clusters: Cluster[] = [];
  for (const members of byRoot.values()) {
    const keys = new Set(members.map((m) => m.key));
    if (keys.size < config.minTopics) continue;
    clusters.push({ members, idJoin: members.map((m) => m.normalizedId).join(SLUG_ID_JOIN) });
  }
  clusters.sort((a, b) => (a.idJoin < b.idJoin ? -1 : a.idJoin > b.idJoin ? 1 : 0));
  return clusters;
}

/** One live inferred cross-topic rule the duplicate guard compares against. */
interface ExistingCrossRule {
  /** The `pref-<slug>` id a disclosure names. */
  readonly id: string;
  readonly tokens: ReadonlySet<string>;
  /** The rule's evidenced_by wikilinks, normalized to source slugs. */
  readonly evidenceSlugs: ReadonlySet<string>;
}

/** The first live rule a cluster would duplicate, and which gate caught it. */
interface DuplicateHit {
  readonly rule: ExistingCrossRule;
  /** True when the principles matched at the floor; false means evidence. */
  readonly byPrinciple: boolean;
  /** The representative-vs-rule score, for the principle disclosure. */
  readonly score: number;
}

/**
 * The owner's live cross-topic rules, grouped by owner token, projected
 * from the very records the source pool excludes: a preference carrying
 * the reserved `cross-` slug prefix, or the `inferred` provenance every
 * promotion carries.
 *
 * An UNCONFIRMED rule guards too - the churn window this guard closes
 * sits exactly in the trial days before a promoted rule's first applied
 * evidence confirms it - but a rule this same pass plans to retire does
 * not, by the same discipline that keeps retiring sources ineligible:
 * replacing a rule the run is moving into `retired/` is how a
 * principle's evidence is allowed to grow.
 */
function collectExistingRules(scan: ScanResult, plan: PlanState): Map<string, ExistingCrossRule[]> {
  const retiring = new Set(plan.retires.map((r) => r.slug));
  const byOwner = new Map<string, ExistingCrossRule[]>();
  for (const record of scan.preferences) {
    const slug = preferenceSlug(record.pref.id);
    if (!slug.startsWith(CROSS_SLUG_PREFIX) && record.pref.provenance !== "inferred") continue;
    if (retiring.has(slug)) continue;
    const ownerKey = preferenceOwner(record.pref) ?? "";
    const rules = byOwner.get(ownerKey) ?? [];
    rules.push({
      id: `pref-${slug}`,
      tokens: tokenise(record.pref.principle),
      evidenceSlugs: new Set(
        record.pref.evidenced_by.map((link) => preferenceSlug(evidenceLinkId(link))),
      ),
    });
    byOwner.set(ownerKey, rules);
  }
  // Deterministic comparison order: the disclosure names the first
  // matching rule in code-unit id order, a property of the corpus alone.
  for (const rules of byOwner.values()) {
    rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byOwner;
}

/** The pref id a `[[pref-...]]` evidence wikilink spells (alias-tolerant). */
function evidenceLinkId(link: string): string {
  return link.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0] ?? "";
}

/**
 * The first live rule this cluster would duplicate, or null. Either the
 * cluster's representative principle is near-identical to the rule's -
 * at the same jaccard floor the clusters themselves elect at, so an
 * operator who raised the knob raised it for both - or the cluster's
 * source set already superset-evidences the rule, which is membership
 * churn by another route: the sources are cited, only their membership
 * moved. Extending the existing rule's evidence is a future concern,
 * deliberately not planned here.
 */
function findDuplicateRule(
  cluster: Cluster,
  ownerRules: ReadonlyArray<ExistingCrossRule> | undefined,
  floor: number,
): DuplicateHit | null {
  if (!ownerRules) return null;
  const representative = cluster.members[0]!;
  const sourceSlugs = new Set(cluster.members.map((m) => m.slug));
  for (const rule of ownerRules) {
    const score = jaccard(representative.tokens, rule.tokens);
    if (score >= floor) {
      return { rule, byPrinciple: true, score };
    }
    // An empty evidence list never matches: the superset of nothing is
    // everything, and a hand-made inferred rule with no lineage must
    // not veto every cluster its owner ever elects.
    if (rule.evidenceSlugs.size === 0) continue;
    let covered = true;
    for (const slug of rule.evidenceSlugs) {
      if (!sourceSlugs.has(slug)) {
        covered = false;
        break;
      }
    }
    if (covered) return { rule, byPrinciple: false, score };
  }
  return null;
}

/** The disclosure for a declined promotion: the code, the rule, the reason. */
function skipDuplicate(hit: DuplicateHit, floor: number): CrossTopicSkip {
  const message = hit.byPrinciple
    ? `cross_topic: skipped a duplicate promotion; ${hit.rule.id} already carries this ` +
      `principle (jaccard ${hit.score.toFixed(2)} >= ${floor})`
    : `cross_topic: skipped a duplicate promotion; the cluster's sources already evidence ` +
      `${hit.rule.id}, and extending that rule's evidence is not planned here`;
  return Object.freeze({ code: CROSS_TOPIC_DUPLICATE_RULE_CODE, message });
}

/**
 * Whether the promoted file (or its tombstone) already exists. The
 * content-derived slug makes this exact: the same source set maps to
 * one slug forever, so a present id - live or retired - is proof the
 * cluster already promoted, and a rerun must plan nothing.
 *
 * A `pref-cross-*` path the scan could not parse into a record is just
 * as taken (finding 64): a tombstoned file keeps its bytes in place and
 * a corrupted one keeps its filename, and apply's `overwrite: false`
 * write would throw on either, blocking every later pass. The slug is
 * read off the filename, which is the only identity such a file still
 * carries.
 *
 * The corrupted check is directory-scoped (review round 2): `scan.corrupted`
 * also holds unparseable signal files (`inbox/`, `processed/`, `archived/`)
 * and retired files, none of which apply ever writes to. Only a file under
 * `Brain/preferences/` can occupy the exact path the `overwrite: false`
 * promotion targets, so the comparison considers that directory alone -
 * the scan's own preference records name it, every one of them having been
 * read from it. With no preference records nothing can fire anyway (no
 * sources, no clusters), so a null directory simply never matches.
 */
function slugTaken(slug: string, scan: ScanResult): boolean {
  const preferencesDir = scan.preferences.length > 0 ? dirname(scan.preferences[0]!.path) : null;
  for (const p of scan.preferences) {
    if (preferenceSlug(p.pref.id) === slug) return true;
  }
  for (const r of scan.retired) {
    const retiredSlug = r.id.startsWith(RETIRED_ID_PREFIX)
      ? r.id.slice(RETIRED_ID_PREFIX.length)
      : r.id;
    if (retiredSlug === slug) return true;
  }
  for (const t of scan.tombstonedPreferences ?? []) {
    if (unparsedSlug(t.path) === slug) return true;
  }
  for (const c of scan.corrupted) {
    if (preferencesDir === null || dirname(c.path) !== preferencesDir) continue;
    if (unparsedSlug(c.path) === slug) return true;
  }
  return false;
}

/** The slug a skipped preference file still carries in its basename. */
function unparsedSlug(path: string): string {
  return preferenceSlug(basename(path).replace(/\.md$/, ""));
}
