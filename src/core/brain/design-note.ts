/**
 * One-shot design notes (salience-lifecycle-enrichment, unit 7,
 * t_c87644b4).
 *
 * `o2b brain panel` already deliberates: it opens a durable write session,
 * walks personas over several turns, and commits under
 * `Brain/decisions/panels/`. That is the right shape when a decision is
 * worth several rounds, and the wrong one when somebody wants a design note
 * now. This module is the one-shot sibling, built like `diarization.ts`:
 * read-only grounding, no session, no model, and exactly one
 * needs-llm-step envelope handed back to the caller.
 *
 * What "grounded" means here is the whole point. A design note written from
 * nothing is prose; this one is written from three vault stores that
 * already know what the project has argued about, decided, and asserted:
 *
 *   - TENSIONS - the contradictions the vault has materialized and, in
 *     particular, the ones nobody has resolved.
 *   - DECISIONS - what was chosen before on a similar question, and how it
 *     turned out.
 *   - TRUTH - the claim-ledger projection: what is currently asserted about
 *     the entities in play, and which of those slots are contested.
 *
 * Matching is the vault's own deterministic token overlap - `tokenise` and
 * `jaccard` from `similarity.ts`, the same pair `findSimilarDecisions`
 * ranks with - so a topic reaches the same records from every surface and
 * no model is consulted to decide relevance.
 *
 * An EMPTY store is not a failure and not an absence: it is named. A vault
 * with no decisions yet and a vault whose decisions all missed the topic
 * are different answers to "what grounds this note", and a report that
 * rendered both as an empty list would be the misleading silence this
 * project forbids.
 *
 * The payload contract is one recommendation. A design note listing three
 * alternatives and recommending none has not been written yet, and one
 * recommending two has not been decided; both are refused by the semantic
 * check, which states the count it found.
 */

import { mkdirSync } from "node:fs";
import { join, posix } from "node:path";

import { slugify, writeFrontmatterAtomic } from "../vault.ts";
import {
  DECISION_SIMILARITY_THRESHOLD,
  findSimilarDecisions,
  listDecisions,
} from "./decisions/record.ts";
import { buildNeedsLlmStep, type NeedsLlmStep } from "./llm-step.ts";
import { decisionsDir } from "./paths.ts";
import {
  assertResponseCheck,
  registerResponseCheck,
  SEMANTIC_VIOLATION_CODES,
  semanticViolation,
  type SemanticViolation,
} from "./response-checks.ts";
import {
  assertResponseShape,
  DESIGN_NOTE_SHAPE,
  DESIGN_NOTE_SURFACE,
  SHAPE_ROOT_PATH,
} from "./response-shape.ts";
import { jaccard, tokenise } from "./similarity.ts";
import { isoDate } from "./time.ts";
import { listTensions, TENSION_UNRESOLVED_STATUSES, type TensionRecord } from "./tensions.ts";
import { readTruthState } from "./truth/store.ts";
import type { ClaimSlot, TruthConflict } from "./truth/types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Vault-relative directory a committed design note lands in. */
export const DESIGN_NOTE_DIR_REL = "Brain/decisions";

/** The needs-llm-step step name for the deferred design note. */
export const DESIGN_NOTE_STEP = "design-note";

/** Frontmatter discriminator of a committed design note. */
export const DESIGN_NOTE_KIND = "brain-design-note";

/**
 * Token-overlap floor a record must clear to ground the note. The decision
 * store's own floor is reused for all three stores rather than three
 * numbers being picked: a topic that reaches a decision should reach the
 * tension arguing about the same words, and a second threshold would make
 * "related" mean two things in one report.
 */
export const DESIGN_NOTE_MATCH_THRESHOLD = DECISION_SIMILARITY_THRESHOLD;

/** Most records per store the grounding carries into one prompt. */
export const DESIGN_NOTE_PER_STORE_LIMIT = 10;

/**
 * The three grounding stores, named so an empty one can be reported as
 * itself. "The decision store is empty" and "no decision matched" are
 * different facts about the vault and lead to different next moves.
 */
export const DESIGN_NOTE_STORE = Object.freeze({
  tensions: "tensions",
  decisions: "decisions",
  truth: "truth",
} as const);

export type DesignNoteStore = (typeof DESIGN_NOTE_STORE)[keyof typeof DESIGN_NOTE_STORE];

/** A design note could not be produced, and the reason is in the message. */
export class DesignNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignNoteError";
  }
}

/** One tension the topic reaches. */
export interface GroundedTension {
  readonly id: string;
  readonly slug: string;
  readonly subject: string;
  readonly status: string;
  /** True while the tension is open or confirmed - nobody has settled it. */
  readonly unresolved: boolean;
  readonly jaccard: number;
}

/** One prior decision the topic reaches, with how it turned out. */
export interface GroundedDecision {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly chosen: string;
  /** Hindsight outcome; empty until a backfill records one. */
  readonly outcome: string;
  readonly jaccard: number;
}

/** One claim slot the topic reaches. */
export interface GroundedClaim {
  readonly entity: string;
  readonly aspect: string;
  readonly value: string;
  /** True when an unresolved conflict involves this slot. */
  readonly contested: boolean;
  readonly jaccard: number;
}

/** One materialized contradiction in the claim ledger. */
export interface GroundedConflict {
  readonly entity: string;
  readonly aspect: string;
  readonly values: ReadonlyArray<string>;
}

export interface DesignNoteGrounding {
  readonly topic: string;
  readonly tensions: ReadonlyArray<GroundedTension>;
  readonly decisions: ReadonlyArray<GroundedDecision>;
  readonly truthSlots: ReadonlyArray<GroundedClaim>;
  readonly conflicts: ReadonlyArray<GroundedConflict>;
  readonly counts: {
    readonly tensions: number;
    readonly decisions: number;
    readonly truthSlots: number;
    readonly conflicts: number;
  };
  /**
   * Stores that hold NOTHING AT ALL in this vault, named. A store absent
   * from this list held records and simply matched none of them.
   */
  readonly emptyStores: ReadonlyArray<DesignNoteStore>;
}

export interface DesignNoteReport {
  readonly topic: string;
  readonly slug: string;
  readonly generatedAt: string;
  readonly grounding: DesignNoteGrounding;
  /** Vault-relative path the committed note will occupy. */
  readonly targetPath: string;
  readonly llmStep: NeedsLlmStep;
}

export interface PlanDesignNoteOptions {
  readonly now: Date;
}

export interface CommitDesignNoteOptions {
  readonly agent: string;
  readonly now: Date;
}

/** One alternative the note weighs. */
export interface DesignNoteAlternative {
  readonly name: string;
  readonly approach: string;
  readonly tradeoffs: string;
  readonly recommended: boolean;
}

export interface CommitDesignNoteResult {
  readonly topic: string;
  readonly slug: string;
  /** Absolute path of the committed note. */
  readonly path: string;
  /** Name of the single recommended alternative. */
  readonly recommended: string;
  readonly alternativeCount: number;
}

// ----- The cardinality rule the descriptor language cannot express ----------

/**
 * Exactly one alternative may carry `recommended: true`.
 *
 * This is the canonical case for the semantic registry: the rule reads
 * every element of an array at once, so no per-value descriptor can state
 * it, and the refusal has to carry the COUNT - "zero" and "three" are
 * different mistakes with different fixes.
 */
registerResponseCheck(DESIGN_NOTE_SURFACE, (payload) => {
  const violations: SemanticViolation[] = [];
  if (typeof payload !== "object" || payload === null) return violations;
  const alternatives = (payload as { alternatives?: unknown }).alternatives;
  if (!Array.isArray(alternatives)) return violations;
  const recommended = alternatives.filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { recommended?: unknown }).recommended === true,
  );
  if (recommended.length !== 1) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.cardinality,
        `${SHAPE_ROOT_PATH}.alternatives`,
        `exactly one alternative must set recommended: true; found ${recommended.length} of ${alternatives.length}`,
      ),
    );
  }
  return violations;
});

// ----- Grounding ------------------------------------------------------------

/**
 * Read the three stores and keep what the topic reaches. Pure read; writes
 * nothing, calls no model, and never fails on an empty vault.
 */
export function designNoteGrounding(vault: string, topic: string): DesignNoteGrounding {
  const trimmed = requireTopic(topic);
  const queryTokens = tokenise(trimmed);
  const emptyStores: DesignNoteStore[] = [];

  const allTensions = listTensions(vault);
  if (allTensions.length === 0) emptyStores.push(DESIGN_NOTE_STORE.tensions);
  const tensions = allTensions
    .map((record) => ({ record, score: tensionScore(queryTokens, record) }))
    .filter((row) => row.score >= DESIGN_NOTE_MATCH_THRESHOLD)
    .toSorted((a, b) => b.score - a.score || a.record.slug.localeCompare(b.record.slug))
    .slice(0, DESIGN_NOTE_PER_STORE_LIMIT)
    .map(({ record, score }) =>
      Object.freeze({
        id: record.id,
        slug: record.slug,
        subject: record.subject,
        status: record.status,
        unresolved: TENSION_UNRESOLVED_STATUSES.has(record.status),
        jaccard: score,
      }),
    );

  // The decision store owns its own matcher; reusing it keeps one ranking
  // rule for "a decision like this one" across every surface that asks.
  if (listDecisions(vault).length === 0) emptyStores.push(DESIGN_NOTE_STORE.decisions);
  const decisions = findSimilarDecisions(
    vault,
    { title: trimmed },
    { threshold: DESIGN_NOTE_MATCH_THRESHOLD, limit: DESIGN_NOTE_PER_STORE_LIMIT },
  ).map((match) =>
    Object.freeze({
      id: match.id,
      slug: match.slug,
      title: match.title,
      chosen: match.chosen,
      outcome: match.outcome,
      jaccard: match.jaccard,
    }),
  );

  const truth = readTruthState(vault);
  // A truth state that is absent and one that is unreadable are the same
  // fact for this report - there is no projection to ground anything in -
  // and `readTruthState` already collapses them to null by design.
  if (truth === null || truth.slots.length === 0) emptyStores.push(DESIGN_NOTE_STORE.truth);
  const truthSlots = (truth?.slots ?? [])
    .map((slot) => ({ slot, score: claimScore(queryTokens, slot) }))
    .filter((row) => row.score >= DESIGN_NOTE_MATCH_THRESHOLD)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        `${a.slot.entity}/${a.slot.aspect}`.localeCompare(`${b.slot.entity}/${b.slot.aspect}`),
    )
    .slice(0, DESIGN_NOTE_PER_STORE_LIMIT)
    .map(({ slot, score }) =>
      Object.freeze({
        entity: slot.entity,
        aspect: slot.aspect,
        value: slot.current.value,
        contested: slot.contested,
        jaccard: score,
      }),
    );
  const conflicts = (truth?.conflicts ?? [])
    .filter((conflict) => conflictScore(queryTokens, conflict) >= DESIGN_NOTE_MATCH_THRESHOLD)
    .slice(0, DESIGN_NOTE_PER_STORE_LIMIT)
    .map((conflict) =>
      Object.freeze({
        entity: conflict.entity,
        aspect: conflict.aspect,
        values: Object.freeze(conflict.values.map((v) => v.value)),
      }),
    );

  return Object.freeze({
    topic: trimmed,
    tensions: Object.freeze(tensions),
    decisions: Object.freeze(decisions),
    truthSlots: Object.freeze(truthSlots),
    conflicts: Object.freeze(conflicts),
    counts: Object.freeze({
      tensions: tensions.length,
      decisions: decisions.length,
      truthSlots: truthSlots.length,
      conflicts: conflicts.length,
    }),
    emptyStores: Object.freeze(emptyStores),
  });
}

// ----- Phase one: the request -----------------------------------------------

/**
 * Ground a topic and return the one envelope that asks for the note.
 * Read-only. An empty vault yields a report, not a refusal: the caller can
 * still write a design note, and the report says exactly how little it
 * rests on.
 */
export function planDesignNote(
  vault: string,
  topic: string,
  opts: PlanDesignNoteOptions,
): DesignNoteReport {
  const trimmed = requireTopic(topic);
  const grounding = designNoteGrounding(vault, trimmed);
  const slug = slugify(trimmed);
  const targetPath = posix.join(DESIGN_NOTE_DIR_REL, noteBasename(slug, opts.now));
  return Object.freeze({
    topic: trimmed,
    slug,
    generatedAt: opts.now.toISOString(),
    grounding,
    targetPath,
    llmStep: buildNeedsLlmStep({
      step: DESIGN_NOTE_STEP,
      prompt:
        `Write a design note on '${trimmed}'. Weigh at least two NAMED alternatives, each with ` +
        "its approach and its tradeoffs, and mark EXACTLY ONE of them recommended - a note that " +
        "recommends none has not been written and one that recommends two has not been decided. " +
        "Ground every claim in the records below; where they say nothing, say so rather than " +
        "filling the gap.\n\n" +
        renderGrounding(grounding),
      schema_hints: [
        'payload: { "title", "summary"?, "alternatives": [ { "name", "approach", "tradeoffs", "recommended" } ] }',
        "alternatives: at least two, each field non-empty",
        "recommended: boolean; exactly one alternative may set it true",
      ],
      target_path: targetPath,
    }),
  });
}

// ----- Phase two: the note --------------------------------------------------

/**
 * Validate the returned note and commit it beside the panel outputs.
 *
 * The write is exclusive. A second note for the same topic on the same day
 * is refused by name rather than overwriting the first: two design notes
 * that disagree are a fact worth keeping, and silently replacing one is
 * how the disagreement disappears.
 */
export function commitDesignNote(
  vault: string,
  topic: string,
  payload: unknown,
  opts: CommitDesignNoteOptions,
): CommitDesignNoteResult {
  // Vault-identity write guard (context-integrity-gates, Unit J): this is
  // the module's only write, and `tests/core/brain/vault-guard-census.test.ts`
  // counts every write-capable module in this tree.
  assertVaultIdentityForWrite(vault);
  const trimmed = requireTopic(topic);
  // Structure first, then the cardinality rule. Nothing is written until
  // both pass.
  assertResponseShape(DESIGN_NOTE_SURFACE, DESIGN_NOTE_SHAPE, payload);
  assertResponseCheck(DESIGN_NOTE_SURFACE, payload);

  const note = payload as {
    title: string;
    summary?: string;
    alternatives: ReadonlyArray<DesignNoteAlternative>;
  };
  const recommended = note.alternatives.find((a) => a.recommended)!;
  const slug = slugify(trimmed);
  const dir = decisionsDir(vault);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, noteBasename(slug, opts.now));

  writeFrontmatterAtomic(
    path,
    {
      schema_version: 1,
      kind: DESIGN_NOTE_KIND,
      slug,
      topic: trimmed,
      title: note.title.trim(),
      recommended: recommended.name.trim(),
      alternative_count: String(note.alternatives.length),
      agent: opts.agent,
      created_at: opts.now.toISOString(),
    },
    renderNote(trimmed, note),
    {
      overwrite: false,
      existsErrorKind: "design note",
      vaultForRelativePath: vault,
    },
  );

  return Object.freeze({
    topic: trimmed,
    slug,
    path,
    recommended: recommended.name.trim(),
    alternativeCount: note.alternatives.length,
  });
}

// ----- Internals ------------------------------------------------------------

function requireTopic(topic: string): string {
  const trimmed = topic.trim();
  if (trimmed.length === 0) throw new DesignNoteError("a design note needs a topic");
  return trimmed;
}

/** `design-<date>-<topic>.md`, the panel outputs' shape one directory up. */
function noteBasename(slug: string, now: Date): string {
  return `design-${isoDate(now)}-${slug}.md`;
}

function tensionScore(queryTokens: ReadonlySet<string>, record: TensionRecord): number {
  return jaccard(queryTokens, tokenise(`${record.subject} ${record.quoteA} ${record.quoteB}`));
}

function claimScore(queryTokens: ReadonlySet<string>, slot: ClaimSlot): number {
  return jaccard(queryTokens, tokenise(`${slot.entity} ${slot.aspect} ${slot.current.value}`));
}

function conflictScore(queryTokens: ReadonlySet<string>, conflict: TruthConflict): number {
  return jaccard(queryTokens, tokenise(`${conflict.entity} ${conflict.aspect}`));
}

/** The grounding set as the prompt shows it - identities, not prose. */
function renderGrounding(grounding: DesignNoteGrounding): string {
  const out: string[] = [];
  const section = (heading: string, lines: ReadonlyArray<string>, store: DesignNoteStore): void => {
    out.push(`## ${heading}`);
    if (grounding.emptyStores.includes(store)) {
      out.push(`(this vault holds no ${store} at all)`);
    } else if (lines.length === 0) {
      out.push(`(the ${store} store holds records, but none match this topic)`);
    } else {
      out.push(...lines);
    }
    out.push("");
  };

  section(
    "Unresolved and past tensions",
    grounding.tensions.map(
      (t) => `- ${t.id} [${t.status}${t.unresolved ? ", unresolved" : ""}] ${t.subject}`,
    ),
    DESIGN_NOTE_STORE.tensions,
  );
  section(
    "Prior decisions",
    grounding.decisions.map(
      (d) =>
        `- ${d.id} chose "${d.chosen}"${d.outcome ? ` -> ${d.outcome}` : " (no outcome recorded)"}`,
    ),
    DESIGN_NOTE_STORE.decisions,
  );
  const truthLines = [
    ...grounding.truthSlots.map(
      (s) => `- ${s.entity}/${s.aspect} = ${s.value}${s.contested ? " (contested)" : ""}`,
    ),
    ...grounding.conflicts.map(
      (c) => `- CONFLICT ${c.entity}/${c.aspect}: ${c.values.join(" vs ")}`,
    ),
  ];
  section("Current claims", truthLines, DESIGN_NOTE_STORE.truth);
  return out.join("\n");
}

function renderNote(
  topic: string,
  note: {
    title: string;
    summary?: string;
    alternatives: ReadonlyArray<DesignNoteAlternative>;
  },
): string {
  const out: string[] = [`# ${note.title.trim()}`, "", `Topic: ${topic}`, ""];
  if (note.summary?.trim()) out.push("## Summary", "", note.summary.trim(), "");
  out.push("## Alternatives", "");
  for (const alt of note.alternatives) {
    out.push(`### ${alt.name.trim()}${alt.recommended ? " (recommended)" : ""}`, "");
    out.push(alt.approach.trim(), "");
    out.push(`Tradeoffs: ${alt.tradeoffs.trim()}`, "");
  }
  return out.join("\n");
}
