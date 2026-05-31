import type { BrainSearchResult } from "./types.ts";

export interface EvidenceRecord {
  readonly path: string;
  readonly documentId: number;
  readonly chunkId: number;
  readonly matchedTerms: ReadonlyArray<string>;
  readonly missingTerms: ReadonlyArray<string>;
  readonly supportCoverage: number;
  readonly terminalState: boolean;
  readonly whyRetrieved: ReadonlyArray<string>;
  readonly droppedCandidateReasons: ReadonlyArray<string>;
}

export interface EvidencePack {
  readonly significantTerms: ReadonlyArray<string>;
  readonly matchedTerms: ReadonlyArray<string>;
  readonly missingTerms: ReadonlyArray<string>;
  readonly supportCoverage: number;
  readonly records: ReadonlyArray<EvidenceRecord>;
  readonly droppedCandidates: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly abstention: string | null;
}

const STOPWORDS = new Set([
  "about",
  "and",
  "are",
  "for",
  "from",
  "how",
  "the",
  "this",
  "that",
  "what",
  "when",
  "where",
  "with",
]);

const TERMINAL_STATE_RE =
  /\b(?:archived|closed|deprecated|done|resolved|retired|superseded|terminal)\b/iu;

function significantTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (token.length >= 3 && !STOPWORDS.has(token)) terms.add(token);
  }
  return [...terms];
}

function includesTerm(result: BrainSearchResult, term: string): boolean {
  const haystack = `${result.path}\n${result.title ?? ""}\n${result.content}`.toLocaleLowerCase();
  return haystack.includes(term);
}

function supportCoverage(
  matched: ReadonlyArray<string>,
  significant: ReadonlyArray<string>,
): number {
  if (significant.length === 0) return 1;
  return matched.length / significant.length;
}

export function evidenceTerminalState(result: BrainSearchResult): boolean {
  return TERMINAL_STATE_RE.test(`${result.path}\n${result.title ?? ""}\n${result.content}`);
}

function withTerminalReason(result: BrainSearchResult): BrainSearchResult {
  if (!evidenceTerminalState(result)) return result;
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
): ReadonlyArray<BrainSearchResult> {
  return results.map(withTerminalReason).toSorted((left, right) => {
    const leftTerminal = evidenceTerminalState(left);
    const rightTerminal = evidenceTerminalState(right);
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    if (right.score !== left.score) return right.score - left.score;
    return left.chunkId - right.chunkId;
  });
}

export function buildEvidencePack(
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
): EvidencePack {
  const significant = Object.freeze(significantTerms(query));
  const matchedSet = new Set<string>();
  const records = results.map((result) => {
    const matched = significant.filter((term) => includesTerm(result, term));
    for (const term of matched) matchedSet.add(term);
    const missing = significant.filter((term) => !matched.includes(term));
    const terminalState = evidenceTerminalState(result);
    return Object.freeze({
      path: result.path,
      documentId: result.documentId,
      chunkId: result.chunkId,
      matchedTerms: Object.freeze(matched),
      missingTerms: Object.freeze(missing),
      supportCoverage: supportCoverage(matched, significant),
      terminalState,
      whyRetrieved: Object.freeze([...result.reasons]),
      droppedCandidateReasons: Object.freeze(terminalState ? ["terminal_state_downranked"] : []),
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
    abstention: missing.length > 0 ? `Unsupported significant terms: ${missing.join(", ")}` : null,
  });
}
