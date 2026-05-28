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
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AgentSourceSummary {
  readonly id: string;
  readonly provider_ids: ReadonlyArray<string>;
  readonly contribution_count: number;
  readonly kinds: ReadonlyArray<AgentSourceContributionKind>;
  readonly topics: ReadonlyArray<string>;
}

export interface AgentSourceProvider {
  readonly id: string;
  readonly label: string;
  collect(vault: string): ReadonlyArray<AgentSourceContribution>;
}
