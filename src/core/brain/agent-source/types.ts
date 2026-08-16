export type AgentSourceContributionKind = "signal" | "preference" | "log";

export interface AgentSourceContribution {
  readonly provider_id: string;
  readonly kind: AgentSourceContributionKind;
  readonly id: string;
  readonly agents: ReadonlyArray<string>;
  readonly timestamp: string;
  readonly topic?: string;
  readonly scope?: string;
  readonly title: string;
  readonly text: string;
  readonly path?: string;
  /**
   * Owner token the underlying page declares, when it can declare one
   * (context-integrity-gates, Unit A). Absent means shared: either the
   * page carries no `owner:`, or the contribution has no page behind it
   * at all (a log event), which is not owner-taggable by construction.
   */
  readonly owner?: string;
  /**
   * Vault this contribution was mirrored from, when the record carries the
   * shared-namespace mirror's `origin_vault` attribution
   * (a-label-is-not-a-boundary, U5). Absent on locally written records,
   * which is every record on a vault with no shared namespace pointing at
   * it. This is the field's first reader anywhere in the repository: it was
   * written twice over and read nowhere.
   */
  readonly origin_vault?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * One agent's row in the per-vault roster.
 *
 * The roster carries exactly TWO metrics, `contribution_count` and
 * `last_activity`, and the count of open units of work is deliberately not
 * a third: nothing in this product persists a unit of work with an
 * open/closed state - no task store, no todo, no assignment - so the number
 * could only be invented. A test asserts this type's key set rather than
 * the two metric names, so a third metric cannot appear without the
 * assertion changing with it.
 */
export interface AgentSourceSummary {
  readonly id: string;
  readonly provider_ids: ReadonlyArray<string>;
  readonly contribution_count: number;
  /**
   * ISO timestamp of this agent's most recent contribution. Always present:
   * a row exists because something was written, so there is always a most
   * recent one.
   */
  readonly last_activity: string;
  /**
   * Whether `id` is a chosen identity or the placeholder every unconfigured
   * install writes under. Without it the roster folds every unconfigured
   * install into one row that reads as a single very busy agent, which is a
   * misleading non-empty - the same defect class as a misleading empty.
   */
  readonly identity_configured: boolean;
  readonly kinds: ReadonlyArray<AgentSourceContributionKind>;
  readonly topics: ReadonlyArray<string>;
}

export interface AgentSourceProvider {
  readonly id: string;
  readonly label: string;
  collect(vault: string): ReadonlyArray<AgentSourceContribution>;
}
