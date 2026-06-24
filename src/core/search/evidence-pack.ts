import {
  buildCompletenessReport,
  buildCoverageReport,
  significantTerms,
  termIncludedIn,
} from "./coverage.ts";
import type { CompletenessReport, CoverageReport } from "./coverage.ts";
import { formatLinePointer } from "./line-numbering.ts";
import type { BrainSearchResult } from "./types.ts";

export interface EvidenceRecord {
  readonly path: string;
  readonly documentId: number;
  readonly chunkId: number;
  /**
   * Read-time line-anchored citation for this chunk, formatted
   * `path:Lstart-Lend` (or `path:Lstart` for a single line) from the chunk's
   * 1-based `startLine`/`endLine`. Resolves by opening the file and slicing
   * the range with {@link extractLineRange}; the stored bytes are never
   * mutated, so the pointer stays valid across idempotent re-mining.
   */
  readonly linePointer: string;
  readonly matchedTerms: ReadonlyArray<string>;
  readonly missingTerms: ReadonlyArray<string>;
  readonly supportCoverage: number;
  readonly terminalState: boolean;
  readonly whyRetrieved: ReadonlyArray<string>;
  readonly droppedCandidateReasons: ReadonlyArray<string>;
}

/**
 * One per-token recall-union record (recall-trust-suite, Feature C): a
 * document fetched specifically because it covers a significant term
 * the ranked result set left uncovered. Union records live in the pack
 * only — the primary `results` contract stays untouched.
 */
export interface EvidenceUnionRecord {
  readonly term: string;
  readonly path: string;
  readonly documentId: number;
  readonly chunkId: number;
}

/**
 * Verification extras computed by the coverage engine when the search
 * runs in evidence-pack mode (recall-trust-suite, Features C and E).
 */
export interface EvidenceVerification {
  readonly coverage: CoverageReport;
  readonly unionRecords: ReadonlyArray<EvidenceUnionRecord>;
}

export interface EvidencePack {
  readonly significantTerms: ReadonlyArray<string>;
  readonly matchedTerms: ReadonlyArray<string>;
  readonly missingTerms: ReadonlyArray<string>;
  readonly supportCoverage: number;
  readonly records: ReadonlyArray<EvidenceRecord>;
  readonly droppedCandidates: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
  readonly abstention: string | null;
  /**
   * IDF-weighted support coverage (Feature C): the share of the query's
   * IDF mass the covered terms carry. Present only when the search ran
   * with coverage verification.
   */
  readonly idfWeightedCoverage?: number;
  /** Rare (high-signal) significant terms per the corpus statistics. */
  readonly rareTerms?: ReadonlyArray<string>;
  /** Rare terms no returned record covers — the abstention trigger. */
  readonly uncoveredRareTerms?: ReadonlyArray<string>;
  /** Per-token recall union for uncovered significant terms. */
  readonly unionRecords?: ReadonlyArray<EvidenceUnionRecord>;
  /**
   * Search-completeness guard (Feature E): verdict + false-absence
   * report from the same coverage engine. Present only when the search
   * ran with coverage verification.
   */
  readonly completeness?: CompletenessReport;
}

/**
 * Controlled terminal-status vocabulary. These are accepted values of
 * the frontmatter `status:` field - a controlled enum the system owns -
 * NOT words scanned inside a note's prose. A note is terminal when its
 * DECLARED status is one of these, so the language the note is written
 * in is irrelevant (the old regex scanned path/title/content for these
 * English words and false-fired on any note that merely mentioned them).
 */
const TERMINAL_STATUS_VALUES: ReadonlySet<string> = new Set([
  "archived",
  "closed",
  "deprecated",
  "done",
  "resolved",
  "retired",
  "superseded",
  "terminal",
]);

/** True when a frontmatter `status` value denotes a terminal state. */
export function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_STATUS_VALUES.has(status.trim().toLowerCase());
}

function includesTerm(result: BrainSearchResult, term: string): boolean {
  return termIncludedIn(`${result.path}\n${result.title ?? ""}\n${result.content}`, term);
}

function supportCoverage(
  matched: ReadonlyArray<string>,
  significant: ReadonlyArray<string>,
): number {
  if (significant.length === 0) return 1;
  return matched.length / significant.length;
}

/**
 * Whether a result is in a terminal state for the current query.
 * Terminality is decided structurally by the caller (reading the
 * frontmatter `status:` field via {@link isTerminalStatus}) and handed
 * in as the set of terminal paths - this function never inspects the
 * note's text.
 */
export function evidenceTerminalState(
  result: BrainSearchResult,
  terminalPaths: ReadonlySet<string>,
): boolean {
  return terminalPaths.has(result.path);
}

function withTerminalReason(
  result: BrainSearchResult,
  terminalPaths: ReadonlySet<string>,
): BrainSearchResult {
  if (!evidenceTerminalState(result, terminalPaths)) return result;
  if (result.reasons.some((reason) => reason.startsWith("evidence_terminal_downrank:"))) {
    return result;
  }
  return Object.freeze({
    ...result,
    reasons: Object.freeze([...result.reasons, "evidence_terminal_downrank: true"]),
  });
}

export function downrankTerminalEvidenceResults(
  results: ReadonlyArray<BrainSearchResult>,
  terminalPaths: ReadonlySet<string>,
): ReadonlyArray<BrainSearchResult> {
  return results
    .map((result) => withTerminalReason(result, terminalPaths))
    .toSorted((left, right) => {
      const leftTerminal = evidenceTerminalState(left, terminalPaths);
      const rightTerminal = evidenceTerminalState(right, terminalPaths);
      if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
      if (right.score !== left.score) return right.score - left.score;
      return left.chunkId - right.chunkId;
    });
}

function abstentionMessage(
  missing: ReadonlyArray<string>,
  verification: EvidenceVerification | undefined,
): string | null {
  // Rare-term gate (Feature C): an uncovered rare term is the strongest
  // abstention signal — high-signal evidence is absent from the answer set.
  const uncoveredRare = verification?.coverage.uncoveredRareTerms ?? [];
  if (uncoveredRare.length > 0) {
    return `Rare significant terms uncovered: ${uncoveredRare.join(", ")}`;
  }
  return missing.length > 0 ? `Unsupported significant terms: ${missing.join(", ")}` : null;
}

export function buildEvidencePack(
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
  verification?: EvidenceVerification,
  terminalPaths: ReadonlySet<string> = new Set(),
): EvidencePack {
  const significant = Object.freeze(significantTerms(query));
  const matchedSet = new Set<string>();
  const records = results.map((result) => {
    const matched = significant.filter((term) => includesTerm(result, term));
    for (const term of matched) matchedSet.add(term);
    const missing = significant.filter((term) => !matched.includes(term));
    const terminalState = evidenceTerminalState(result, terminalPaths);
    const terminalDownranked = result.reasons.some((reason) =>
      reason.startsWith("evidence_terminal_downrank:"),
    );
    return Object.freeze({
      path: result.path,
      documentId: result.documentId,
      chunkId: result.chunkId,
      linePointer: formatLinePointer(result.path, result.startLine, result.endLine),
      matchedTerms: Object.freeze(matched),
      missingTerms: Object.freeze(missing),
      supportCoverage: supportCoverage(matched, significant),
      terminalState,
      whyRetrieved: Object.freeze([...result.reasons]),
      droppedCandidateReasons: Object.freeze(
        terminalDownranked ? ["terminal_state_downranked"] : [],
      ),
    });
  });
  const matched = significant.filter((term) => matchedSet.has(term));
  const missing = significant.filter((term) => !matchedSet.has(term));
  return Object.freeze({
    significantTerms: significant,
    matchedTerms: Object.freeze(matched),
    missingTerms: Object.freeze(missing),
    supportCoverage: supportCoverage(matched, significant),
    records: Object.freeze(records),
    droppedCandidates: Object.freeze([]),
    abstention: abstentionMessage(missing, verification),
    ...(verification !== undefined
      ? {
          idfWeightedCoverage: verification.coverage.idfWeightedCoverage,
          rareTerms: verification.coverage.rareTerms,
          uncoveredRareTerms: verification.coverage.uncoveredRareTerms,
          unionRecords: verification.unionRecords,
          completeness: buildCompletenessReport(verification.coverage),
        }
      : {}),
  });
}

export { buildCoverageReport, significantTerms };
