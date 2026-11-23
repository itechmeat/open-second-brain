/**
 * Topic planning (design D9; spec `topics` "Automatic grouping during
 * dream", "Merges and splits are proposed", "Topic status lifecycle";
 * task 3.4): the pure decision of what the dream pass does with the
 * records no topic holds yet. No I/O and no model call: the same fold,
 * candidates and answers give the same plan on every machine. A closed
 * question is decided only by an answer; the plan lists what it still
 * asks.
 *
 *  - **Route.** An unassigned record of a project is routed only by a
 *    model's answer (change `dream-closed-questions`): the active topics of
 *    its scope whose head (title, description, goal and item texts) shares
 *    the most subject words with it - at least two words and a fifth of the
 *    record's - are the options of its routing question (`asks.routes`),
 *    and until an answer names one of them the record stays as it is. A
 *    route the user took back (`blockedRoutes`) is never offered.
 *  - **Create.** The records of one project that no topic holds, none ever
 *    held (`touched`) and no routing question waits for are grouped by
 *    shared subject words; a group of at least `minRecords` records from
 *    at least `minSessions` sessions is asked about (`asks.groups`) and
 *    becomes a topic only with an approval and a wording (the title and
 *    goal the launched agent wrote, `asks.wordings` while it waits; the
 *    title drafted from its most frequent words is only part of the
 *    approval question). Records with no
 *    project never make a topic on their own; a personal topic is made on
 *    request.
 *  - **Propose.** Two active topics of one scope whose heads share half
 *    their words are proposed for a merge; a topic whose records fall into
 *    two groups that would each make a topic is proposed for a split.
 *    Nothing proposed is applied.
 *  - **Ask.** An active topic with no record for `quietDays` is offered to
 *    the user for a status decision; its status does not change.
 */

import { compareCodeUnits } from "../store/compare.ts";
import { DAY_MS } from "../store/constants.ts";
import { TOPIC_PERSONAL_SCOPE, TOPIC_PROJECT_SCOPE_PREFIX } from "./constants.ts";
import { subjectTokens, type TopicCandidate, type TopicCandidateKind } from "./candidates.ts";
import { TOPIC_TITLE_MAX } from "./records.ts";
import { routeKey, type TopicFold, type TopicHeadField, type TopicState } from "./fold.ts";
import { topicGroupKey, type TopicVerdictBody, type TopicVerdicts } from "./verdicts.ts";

/** At least this many shared subject words route a record or join it to a group. */
const MIN_SHARED = 2;
/** And at least this share of the record's words. */
const MIN_ROUTE_SHARE = 0.2;
/** Two topic heads that share this much (Jaccard) are proposed for a merge. */
const MERGE_JACCARD = 0.5;
/** Words in a drafted title. */
const TITLE_WORDS = 3;

export interface PlanSettings {
  readonly minRecords: number;
  readonly minSessions: number;
  readonly quietDays: number;
}

export interface PlannedRoute {
  readonly record: string;
  readonly topic: string;
  readonly private: boolean;
  /** Set when a model verdict chose this route in enforce (design D10): the assign carries it, with `authority: "model"`. */
  readonly verdict?: TopicVerdictBody;
}

export interface PlannedCreate {
  readonly title: string;
  readonly goal: string;
  readonly scope: string;
  readonly private: boolean;
  /** Record ids the topic is made from, in record order. */
  readonly members: ReadonlyArray<string>;
  readonly sessions: number;
  /** Set when the model was asked about this group and let it through (`topic_new`): the create record carries it. */
  readonly verdict?: TopicVerdictBody;
  /** Who wrote the title and goal (the launched agent's wording answer). */
  readonly author?: { readonly agent: string; readonly model: string; readonly item: string };
}

export interface MergeProposal {
  readonly topics: readonly [string, string];
  readonly score: number;
  /** Set when the model judged this pair (`topic_same`, design D10): a Jaccard proposal it called `different` is listed last; a pair it called `same` is added. Never applied. */
  readonly verdict?: TopicVerdictBody;
  /** What the model judged the pair, with {@link verdict}. */
  readonly judged?: string;
}

export interface SplitProposal {
  readonly topic: string;
  readonly groups: ReadonlyArray<ReadonlyArray<string>>;
}

export interface QuietPrompt {
  readonly topic: string;
  readonly days: number;
}

export interface TopicReview {
  readonly merges: ReadonlyArray<MergeProposal>;
  readonly quiet: ReadonlyArray<QuietPrompt>;
}

/**
 * Why a project whose records no topic holds got no topic this pass: the
 * counts a person needs to tell a threshold not yet reached from records
 * held back, without reading the store.
 */
export interface ProjectShortfall {
  readonly project: string;
  /** Records of the project that no topic holds, none ever held and no route took. */
  readonly free: number;
  /**
   * The group of those records closest to a topic (the fewest records and
   * sessions short of the thresholds, then the most records): its size,
   * sessions and kinds. Zero records when none is free.
   */
  readonly closest: {
    readonly records: number;
    readonly sessions: number;
    readonly kinds: Readonly<Record<TopicCandidateKind, number>>;
  };
  /**
   * Records of the project no topic holds that an `assign`, `unassign` or
   * `split` once named (an undone topic, a record taken back): routed when
   * a topic fits, never grouped again.
   */
  readonly heldBack: number;
  /** Groups of the project that qualified and a decision model vetoed (`topic_new`). */
  readonly vetoed: number;
  /** Groups of the project that qualified and wait for an answer (`topic_new`). */
  readonly asked: number;
}

/** A closed question the plan cannot decide without an answer. */
export interface PlanAsks {
  /** Unassigned records and the topics their routing question offers, best first. */
  readonly routes: ReadonlyArray<{
    readonly record: string;
    readonly topics: ReadonlyArray<string>;
  }>;
  /** Qualifying groups that wait for an approval or a veto. */
  readonly groups: ReadonlyArray<PlanAskedGroup>;
  /** Approved groups that wait for the wording of their topic (`topic-wording`). */
  readonly wordings: ReadonlyArray<PlanAskedGroup>;
}

export interface PlanAskedGroup {
  readonly key: string;
  readonly members: ReadonlyArray<string>;
  readonly title: string;
  readonly scope: string;
  readonly private: boolean;
}

export interface TopicPlan extends TopicReview {
  readonly routes: ReadonlyArray<PlannedRoute>;
  readonly creates: ReadonlyArray<PlannedCreate>;
  readonly splits: ReadonlyArray<SplitProposal>;
  /** The projects with records no topic holds that got no topic this pass, most free records first. */
  readonly shortfalls: ReadonlyArray<ProjectShortfall>;
  /** What the plan asks and cannot decide without an answer. */
  readonly asks: PlanAsks;
}

const isActive = (t: TopicState): boolean => t.mergedInto === null && t.status === "active";

/**
 * The subject words of a topic's head. Private text decides only a route
 * that lands in `private` (a private record, or a private topic): a
 * private item, or a title, description or goal whose winning record is
 * private, would otherwise let private words pull a shared record into a
 * topic by a shared assign.
 */
function headTokens(topic: TopicState, withPrivate: boolean): Set<string> {
  const field = (name: TopicHeadField, value: string | null): string =>
    topic.privateFields[name] && !withPrivate ? "" : (value ?? "");
  const parts = [
    field("title", topic.title),
    field("description", topic.description),
    field("goal", topic.goal),
    ...topic.items.filter((i) => withPrivate || !i.private).map((i) => i.text),
  ];
  return subjectTokens(parts.join(" "));
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function scopeOf(candidate: TopicCandidate): string {
  return candidate.project === null
    ? TOPIC_PERSONAL_SCOPE
    : `${TOPIC_PROJECT_SCOPE_PREFIX}${candidate.project}`;
}

/** The canonical topic that holds `candidate`, or `null`. */
function holder(fold: TopicFold, candidate: TopicCandidate): string | null {
  if (fold.assignments.has(candidate.id)) return fold.assignments.get(candidate.id)!;
  return candidate.topic === null ? null : fold.canonical(candidate.topic);
}

/**
 * The topics a routing question may offer for `candidate` (design D10,
 * `topic_route`): the active topics of its scope that the deterministic
 * rule would not refuse - never a blocked route - the deterministic best
 * first, then by shared-word count, then by creation. Empty when the
 * deterministic rule routes nowhere.
 */
export function rankedRouteTopics(fold: TopicFold, candidate: TopicCandidate): string[] {
  const words = subjectTokens(candidate.text);
  if (words.size === 0) return [];
  return [...fold.topics.values()]
    .filter(isActive)
    .filter((topic) => topic.scope === scopeOf(candidate))
    .filter((topic) => !fold.blockedRoutes.has(routeKey(candidate.id, topic.id)))
    .map((topic) => ({
      id: topic.id,
      createdAt: topic.createdAt,
      n: shared(
        words,
        candidate.private || topic.private ? headTokens(topic, true) : headTokens(topic, false),
      ),
    }))
    .filter(({ n }) => n >= MIN_SHARED && n / words.size >= MIN_ROUTE_SHARE)
    .toSorted((a, b) => b.n - a.n || a.createdAt - b.createdAt || compareCodeUnits(a.id, b.id))
    .map((entry) => entry.id);
}

export interface Group {
  readonly members: TopicCandidate[];
  readonly words: Map<string, number>;
}

/** Greedy grouping by shared subject words, in record order: deterministic. */
export function groups(candidates: ReadonlyArray<TopicCandidate>): Group[] {
  const out: Group[] = [];
  for (const candidate of candidates) {
    const words = subjectTokens(candidate.text);
    const home = out.find((g) => shared(words, new Set(g.words.keys())) >= MIN_SHARED);
    const group = home ?? { members: [], words: new Map<string, number>() };
    if (home === undefined) out.push(group);
    group.members.push(candidate);
    for (const w of words) group.words.set(w, (group.words.get(w) ?? 0) + 1);
  }
  return out;
}

/**
 * The group closest to becoming a topic, summed up: the fewest records and
 * sessions short of `settings` (the two shortfalls added), then the most
 * records, then the most sessions, the first on a tie. Not simply the
 * largest: a 6-record group from one session is further from a topic at
 * 5/2 than a 4-record group from two sessions, which one more record makes.
 */
function closestGroup(
  made: ReadonlyArray<Group>,
  settings: PlanSettings,
): ProjectShortfall["closest"] {
  let best: { short: number; records: number; sessions: number; group: Group | null } = {
    short: Number.POSITIVE_INFINITY,
    records: 0,
    sessions: 0,
    group: null,
  };
  for (const group of made) {
    const records = group.members.length;
    const sessions = new Set(group.members.map((m) => m.session)).size;
    const short =
      Math.max(0, settings.minRecords - records) + Math.max(0, settings.minSessions - sessions);
    if (
      short < best.short ||
      (short === best.short &&
        (records > best.records || (records === best.records && sessions > best.sessions)))
    ) {
      best = { short, records, sessions, group };
    }
  }
  const kinds: Record<TopicCandidateKind, number> = { note: 0, signal: 0, decision: 0 };
  for (const member of best.group?.members ?? []) kinds[member.kind] += 1;
  return { records: best.records, sessions: best.sessions, kinds };
}

/** Whether a group has the records and sessions a topic needs. */
export function qualifies(group: Group, settings: PlanSettings): boolean {
  return (
    group.members.length >= settings.minRecords &&
    new Set(group.members.map((m) => m.session)).size >= settings.minSessions
  );
}

/** A run of letters, marks and digits joined by hyphens, as the records write it. */
const WRITTEN_WORD_RE = /[\p{L}\p{M}\p{N}]+(?:[-\u2010\u2011][\p{L}\p{M}\p{N}]+)*/gu;
const HYPHEN_RE = /[-\u2010\u2011]/u;

/**
 * How the group's records write each subject word: alone, or inside a
 * hyphenated compound ("тема-три", "release-checklist"), counted over
 * every occurrence, a compound once for each distinct part it holds. Subject words split at hyphens, and a part shorter
 * than a subject word ("три") is not one, so a title built from subject
 * words alone cut a project name in half.
 */
function writtenForms(group: Group): {
  readonly alone: Map<string, number>;
  readonly compounds: Map<string, Map<string, number>>;
} {
  const alone = new Map<string, number>();
  const compounds = new Map<string, Map<string, number>>();
  for (const member of group.members) {
    const text = member.text.normalize("NFC").toLowerCase();
    for (const [written] of text.matchAll(WRITTEN_WORD_RE)) {
      if (!HYPHEN_RE.test(written)) {
        alone.set(written, (alone.get(written) ?? 0) + 1);
        continue;
      }
      // Once per distinct part: "peer-to-peer" writes "peer" in one place.
      for (const part of new Set(written.split(HYPHEN_RE))) {
        const forms = compounds.get(part) ?? new Map<string, number>();
        forms.set(written, (forms.get(written) ?? 0) + 1);
        compounds.set(part, forms);
      }
    }
  }
  return { alone, compounds };
}

/**
 * The group's most frequent subject words, a tie going to the word its
 * first record says first, each as the records write it: a word they
 * write inside one compound more often than alone is titled by that
 * compound ("Тема-три release checklist", not "Тема release checklist"),
 * named once even when two of its parts are subject words. A compound
 * that would repeat a word the title already has is not used; the word
 * stands alone then.
 */
function draftTitle(group: Group): string {
  const first = [...subjectTokens(group.members[0]!.text)];
  const rank = (w: string): number => (first.includes(w) ? first.indexOf(w) : first.length);
  const ranked = [...group.words]
    .toSorted(([a, na], [b, nb]) => nb - na || rank(a) - rank(b) || compareCodeUnits(a, b))
    .map(([w]) => w);
  const { alone, compounds } = writtenForms(group);
  const words: string[] = [];
  const named = new Set<string>();
  for (const word of ranked) {
    if (words.length === TITLE_WORDS) break;
    if (named.has(word)) continue;
    const [compound, count] = [...(compounds.get(word) ?? new Map<string, number>())].toSorted(
      ([a, na], [b, nb]) => nb - na || compareCodeUnits(a, b),
    )[0] ?? ["", 0];
    const parts = compound === "" ? [] : compound.split(HYPHEN_RE);
    if (count > (alone.get(word) ?? 0) && !parts.some((p) => named.has(p))) {
      words.push(compound);
      for (const part of parts) named.add(part);
    } else {
      words.push(word);
      named.add(word);
    }
  }
  // A word of a script written without spaces can be a whole sentence:
  // the title is cut to the longest a record may carry, in the unit the
  // record check counts (UTF-16 code units), after the capital letter
  // (which can grow: "ß" becomes "SS"), never inside a surrogate pair.
  const joined = words.join(" ");
  const [lead = ""] = joined;
  return clampUnits(lead.toUpperCase() + joined.slice(lead.length), TOPIC_TITLE_MAX).trim();
}

/** `text` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
function clampUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

const byRecordOrder = (a: TopicCandidate, b: TopicCandidate): number =>
  a.at - b.at || compareCodeUnits(a.id, b.id);

/**
 * Topic pairs of one scope whose head tokens share at least `minJaccard`
 * (design D10, `topic_same`), best score first (ids break ties), at most `maxPairs`.
 * The same head fields `reviewTopics` ranks merges by; `admit` leaves a
 * topic out before the cap (the decide pass: one the egress rule keeps home).
 */
export function topicPairsForSame(
  fold: TopicFold,
  minJaccard: number,
  maxPairs: number,
  admit: (topic: TopicState) => boolean = () => true,
): Array<{ readonly a: string; readonly b: string; readonly score: number }> {
  const active = [...fold.topics.values()]
    .filter((topic) => isActive(topic) && admit(topic))
    .toSorted((a, b) => compareCodeUnits(a.id, b.id));
  const heads = active.map((topic) => ({
    topic,
    tokens: subjectTokens([topic.title, topic.description ?? "", topic.goal ?? ""].join(" ")),
  }));
  const pairs: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const a = heads[i]!;
      const b = heads[j]!;
      if (a.topic.scope !== b.topic.scope) continue;
      const n = shared(a.tokens, b.tokens);
      const union = a.tokens.size + b.tokens.size - n;
      const score = union === 0 ? 0 : n / union;
      if (score >= minJaccard) pairs.push({ a: a.topic.id, b: b.topic.id, score });
    }
  }
  // The best-scoring pairs first, ids breaking ties: when more pairs
  // qualify than one pass asks, the likeliest merges are asked.
  return pairs
    .toSorted(
      (x, y) => y.score - x.score || compareCodeUnits(x.a, y.a) || compareCodeUnits(x.b, y.b),
    )
    .slice(0, maxPairs);
}

/**
 * Model merge verdicts (design D10, `topic_same`): a `same` at or above
 * the threshold joins the proposals (the model adds, never removes); a
 * `different` at or above it annotates its Jaccard proposal and lists it
 * last. Below the threshold, invalid, or on any failure today's
 * proposals stand unchanged.
 */
function mergePairKey(pair: readonly [string, string]): string {
  return [...pair].toSorted().join(",");
}

function applySameVerdicts(
  fold: TopicFold,
  merges: MergeProposal[],
  same?: TopicVerdicts["sameTopics"],
): MergeProposal[] {
  if (same === undefined || same.length === 0) return merges;
  const keyOf = mergePairKey;
  const judged = new Map(same.map((entry) => [keyOf([entry.a, entry.b]), entry]));
  const kept: MergeProposal[] = [];
  const added: MergeProposal[] = [];
  const annotated: MergeProposal[] = [];
  for (const merge of merges) {
    const entry = judged.get(keyOf(merge.topics));
    // The decide pass keeps only verdicts at or above the stored `same_min`.
    if (entry !== undefined) {
      if (entry.option === "same") {
        kept.push({ ...merge, verdict: entry.verdict, judged: entry.option });
      } else annotated.push({ ...merge, verdict: entry.verdict, judged: entry.option });
      continue;
    }
    kept.push(merge);
  }
  // A model-only pair was judged before the planning lock: it is
  // proposed only while both topics are still active in one scope.
  const stillPair = (x: string, y: string): boolean => {
    const tx = fold.topics.get(x);
    const ty = fold.topics.get(y);
    return (
      tx !== undefined && ty !== undefined && isActive(tx) && isActive(ty) && tx.scope === ty.scope
    );
  };
  for (const entry of same) {
    if (entry.option !== "same") continue;
    if (!stillPair(entry.a, entry.b)) continue;
    const key = keyOf([entry.a, entry.b]);
    const present = (m: MergeProposal): boolean => keyOf(m.topics) === key;
    if (kept.some(present) || added.some(present) || annotated.some(present)) continue;
    added.push({ topics: [entry.a, entry.b], score: 0, verdict: entry.verdict, judged: "same" });
  }
  return [...kept, ...added, ...annotated];
}

/**
 * Merge proposals and quiet-topic prompts: what the brief and digest ask
 * the user. `hints` are the standing `topic-same` answers (read from the
 * dream work queue): a `same` adds or confirms a pair, a `different`
 * annotates one and lists it last.
 */
export function reviewTopics(
  fold: TopicFold,
  nowMs: number,
  quietDays: number,
  hints?: TopicVerdicts["sameTopics"],
): TopicReview {
  const active = [...fold.topics.values()]
    .filter(isActive)
    .toSorted((a, b) => compareCodeUnits(a.id, b.id));
  const merges: MergeProposal[] = [];
  const heads = active.map((topic) => ({
    topic,
    tokens: subjectTokens([topic.title, topic.description ?? "", topic.goal ?? ""].join(" ")),
  }));
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const a = heads[i]!;
      const b = heads[j]!;
      if (a.topic.scope !== b.topic.scope) continue;
      const n = shared(a.tokens, b.tokens);
      const union = a.tokens.size + b.tokens.size - n;
      const score = union === 0 ? 0 : n / union;
      if (score >= MERGE_JACCARD) merges.push({ topics: [a.topic.id, b.topic.id], score });
    }
  }
  const quiet = active
    .map((t) => ({ topic: t.id, days: Math.floor((nowMs - t.updatedAt) / DAY_MS) }))
    .filter((q) => q.days >= quietDays);
  return { merges: applySameVerdicts(fold, merges, hints), quiet };
}

/**
 * The plan for `candidates` against `fold`. `verdicts` are the answers
 * planning holds (accepted ones and standing ones, design D2): a verdict
 * is applied only when its subject still matches this fold - the record
 * is still unassigned, the topic still exists and is active, the route is
 * not blocked, the group has exactly the same members. Without a verdict
 * a routing question or a qualifying group waits: it is listed in `asks`
 * and nothing is decided for it.
 */
export function planTopics(
  fold: TopicFold,
  candidates: ReadonlyArray<TopicCandidate>,
  settings: PlanSettings,
  nowMs: number,
  verdicts?: TopicVerdicts,
): TopicPlan {
  const ordered = candidates.toSorted(byRecordOrder);
  const active = [...fold.topics.values()]
    .filter(isActive)
    .toSorted((a, b) => a.createdAt - b.createdAt || compareCodeUnits(a.id, b.id))
    .map((topic) => ({ topic }));
  const routes: PlannedRoute[] = [];
  const askedRoutes: Array<{ record: string; topics: string[] }> = [];
  const askedGroups: PlanAskedGroup[] = [];
  const awaitingWording: PlanAskedGroup[] = [];
  const free: TopicCandidate[] = [];
  const heldBack = new Map<string, number>();
  for (const candidate of ordered) {
    if (holder(fold, candidate) !== null) continue;
    // The model's route (D10): a verdict that no longer matches this
    // fold - the record assigned meanwhile, the topic merged, closed or
    // of another scope, the route blocked - is ignored here, and the
    // record waits for an answer about the topics it has now.
    const routeVerdict = verdicts?.routes.get(candidate.id);
    let topic: string | null = null;
    let verdict: TopicVerdictBody | undefined;
    let privateInput = false;
    let modelNone = false;
    if (routeVerdict !== undefined) {
      if (routeVerdict.topic === null) {
        modelNone = true;
      } else {
        const target = fold.topics.get(routeVerdict.topic);
        if (
          target !== undefined &&
          isActive(target) &&
          target.scope === scopeOf(candidate) &&
          !fold.blockedRoutes.has(routeKey(candidate.id, target.id))
        ) {
          topic = routeVerdict.topic;
          verdict = routeVerdict.verdict;
          privateInput = routeVerdict.privateInput;
        }
      }
    }
    if (topic === null && !modelNone) {
      const options = rankedRouteTopics(fold, candidate);
      if (options.length > 0) {
        // A routing question waits: the record stays as it is.
        askedRoutes.push({ record: candidate.id, topics: options });
        continue;
      }
    }
    if (topic !== null) {
      const target = fold.topics.get(topic)!;
      routes.push({
        record: candidate.id,
        topic,
        // A model route whose question carried a private input is private too.
        private: candidate.private || target.private || privateInput,
        ...(verdict !== undefined ? { verdict } : {}),
      });
    } else if (candidate.project !== null && !fold.touched.has(candidate.id)) {
      // A model `none` verdict also leaves the record free for grouping.
      free.push(candidate);
    } else if (candidate.project !== null) {
      heldBack.set(candidate.project, (heldBack.get(candidate.project) ?? 0) + 1);
    }
  }
  const creates: PlannedCreate[] = [];
  const shortfalls: ProjectShortfall[] = [];
  const projects = [...new Set([...free.map((c) => c.project!), ...heldBack.keys()])].toSorted(
    compareCodeUnits,
  );
  for (const project of projects) {
    const own = free.filter((c) => c.project === project);
    const made = groups(own);
    let createdHere = 0;
    let vetoed = 0;
    let asked = 0;
    for (const group of made) {
      if (!qualifies(group, settings)) continue;
      // `topic_new`: a group becomes a topic only with an approval, which
      // rides the create record as its verdict; a veto holds while the
      // group keeps its members, and a group with no answer waits. The
      // count and session thresholds hold either way: the model can
      // never create a group that does not qualify.
      const key = topicGroupKey(group.members.map((m) => m.id));
      const verdictEntry = verdicts?.vetoes.get(key);
      if (verdictEntry !== undefined && verdictEntry.veto) {
        vetoed += 1;
        continue;
      }
      if (verdictEntry === undefined) {
        asked += 1;
        askedGroups.push({
          key,
          members: group.members.map((m) => m.id),
          title: draftTitle(group),
          scope: `${TOPIC_PROJECT_SCOPE_PREFIX}${project}`,
          private: group.members.some((m) => m.private),
        });
        continue;
      }
      // The title and goal are the launched agent's (change
      // `dream-launched-agent`, design D6): an approved group with no
      // wording yet waits; no rule names it.
      const wording = verdicts?.wordings.get(key);
      if (wording === undefined) {
        asked += 1;
        awaitingWording.push({
          key,
          members: group.members.map((m) => m.id),
          title: draftTitle(group),
          scope: `${TOPIC_PROJECT_SCOPE_PREFIX}${project}`,
          private: group.members.some((m) => m.private),
        });
        continue;
      }
      createdHere += 1;
      creates.push({
        title: wording.title,
        goal: wording.goal,
        scope: `${TOPIC_PROJECT_SCOPE_PREFIX}${project}`,
        private: group.members.some((m) => m.private),
        members: group.members.map((m) => m.id),
        sessions: new Set(group.members.map((m) => m.session)).size,
        verdict: verdictEntry.verdict,
        author: { agent: wording.agent, model: wording.model, item: wording.item },
      });
    }
    if (createdHere === 0) {
      shortfalls.push({
        project,
        free: own.length,
        closest: closestGroup(made, settings),
        heldBack: heldBack.get(project) ?? 0,
        vetoed,
        asked,
      });
    }
  }
  const splits: SplitProposal[] = [];
  for (const { topic } of active) {
    const members = ordered.filter((c) => holder(fold, c) === topic.id);
    const parts = groups(members).filter((g) => qualifies(g, settings));
    if (parts.length >= 2) {
      splits.push({ topic: topic.id, groups: parts.map((g) => g.members.map((m) => m.id)) });
    }
  }
  const review = reviewTopics(fold, nowMs, settings.quietDays);
  return {
    routes,
    creates,
    splits,
    shortfalls: shortfalls.toSorted(
      (a, b) =>
        b.free - a.free || b.heldBack - a.heldBack || compareCodeUnits(a.project, b.project),
    ),
    merges: applySameVerdicts(fold, [...review.merges], verdicts?.sameTopics),
    quiet: review.quiet,
    asks: { routes: askedRoutes, groups: askedGroups, wordings: awaitingWording },
  };
}
