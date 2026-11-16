/**
 * Stored model verdicts for the topic and agent-context uses (design
 * D10, "Verdicts stored once"): the `verdict` field a record written in
 * `enforce` carries, and the in-memory {@link TopicVerdicts} the decide
 * pass hands to the planner.
 *
 * A verdict that decided a store record names the use, the answering
 * model, the provider preset, the question version that was asked, the
 * mode (`enforce`) and the confidence the use acted on. Folds never call
 * a model: they read stored verdicts only, and the field is
 * informational there (it never changes precedence).
 */

import type { DecisionModelUse, DecisionResponse } from "../decision-model/contract.ts";
import { TOPIC_USE_QUESTION_VERSION, type TopicUse } from "../decision-model/questions-topics.ts";

/**
 * The `verdict` field of a store record a dream-time use wrote in
 * `enforce`. Identifiers and numbers only - never text.
 */
export interface TopicVerdictBody {
  readonly use: DecisionModelUse;
  /** The model id that answered, as the provider reported it. */
  readonly model: string;
  /** The provider preset name that was asked. */
  readonly provider: string;
  /** The question version of the use that produced the answer. */
  readonly version: number;
  readonly mode: "enforce";
  /** The probability of the option the use acted on. */
  readonly confidence: number;
}

/**
 * Build the `verdict` field for a store record a dream-time use wrote in
 * `enforce`. `provider` is the preset name; `confidence` is the
 * probability of the option the use acted on.
 */
export function verdictBody(
  use: TopicUse,
  response: Pick<DecisionResponse, "model">,
  provider: string,
  confidence: number,
): TopicVerdictBody {
  return {
    use,
    model: response.model,
    provider,
    version: TOPIC_USE_QUESTION_VERSION[use],
    mode: "enforce",
    confidence,
  };
}

/** The key of a create group: its member record ids, sorted, joined by commas. */
export function topicGroupKey(memberIds: ReadonlyArray<string>): string {
  return [...memberIds].toSorted().join(",");
}

/**
 * One model answer that `enforce` accepted, keyed by its subject. Built
 * by the decide pass before the dream pass (design D10, D20): the
 * planner reads it under the planning lock and applies a verdict only
 * when its subject still matches the fold read there; anything stale is
 * ignored and the deterministic rule applies.
 */
export interface TopicVerdicts {
  /**
   * Record id to the topic the model chose (`null` = none) for
   * `topic_route`. `privateInput` here and below: a private input other
   * than the subject and its topic reached the question (an offered
   * topic, a private head field, a side text with a `<private>` region),
   * so the record the verdict decides is written to `private`.
   */
  readonly routes: ReadonlyMap<
    string,
    {
      readonly topic: string | null;
      readonly privateInput: boolean;
      readonly verdict: TopicVerdictBody;
    }
  >;
  /** Record id to the derived kind, its holding topic and verdict for `event_kind`. */
  readonly kinds: ReadonlyMap<
    string,
    {
      readonly kind: string;
      readonly topic: string;
      readonly privateInput: boolean;
      readonly verdict: TopicVerdictBody;
    }
  >;
  /**
   * Group key ({@link topicGroupKey}) to the `topic_new` verdict: the
   * model asked about the group and `enforce` acted. `veto` is true when
   * p(yes) fell below the threshold (the group is not created this
   * pass); false when the model let it through (the create carries the
   * verdict).
   */
  readonly vetoes: ReadonlyMap<
    string,
    { readonly verdict: TopicVerdictBody; readonly veto: boolean }
  >;
  /**
   * Model merge verdicts for `topic_same` (the dream report lists
   * them): `option` is the chosen key - `same` adds the pair to the
   * proposals, `different` annotates a Jaccard proposal and lists it
   * last.
   */
  readonly sameTopics: ReadonlyArray<{
    readonly a: string;
    readonly b: string;
    readonly option: string;
    readonly verdict: TopicVerdictBody;
  }>;
  /**
   * Record id to the question it answers, for `question_resolved`: the
   * question by its id and its owner, the topic that recorded it (a
   * merged topic can show two questions with one id).
   */
  readonly resolutions: ReadonlyMap<
    string,
    {
      readonly topic: string;
      readonly question: string;
      readonly owner: string;
      readonly privateInput: boolean;
      readonly verdict: TopicVerdictBody;
    }
  >;
  /**
   * Model completion proposals for `milestone_done` (written as
   * proposals), by id and owner; `privateInput` also covers a private
   * evidence record the question carried.
   */
  readonly completions: ReadonlyArray<{
    readonly topic: string;
    readonly milestone: string;
    readonly owner: string;
    readonly privateInput: boolean;
    readonly verdict: TopicVerdictBody;
  }>;
  /** Note record id to the hide verdict for `human_readable`. */
  readonly hidden: ReadonlyMap<string, TopicVerdictBody>;
  /**
   * Note record id to the keep verdict for `human_readable`: stored as
   * `keep: true` so the note is settled and never asked about again.
   */
  readonly kept: ReadonlyMap<string, TopicVerdictBody>;
}

/** The empty verdicts: every lane behaves exactly as without the feature. */
export function emptyTopicVerdicts(): TopicVerdicts {
  return {
    routes: new Map(),
    kinds: new Map(),
    vetoes: new Map(),
    sameTopics: [],
    resolutions: new Map(),
    completions: [],
    hidden: new Map(),
    kept: new Map(),
  };
}
