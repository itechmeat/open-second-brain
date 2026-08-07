/**
 * Presentation of a {@link SearchOutcome} for `o2b search <query>`: the
 * `--json` payload and the human transcript. Every byte either function
 * produces is a CLI contract.
 */

import { serializeEvidencePack, serializeSearchCard } from "../../core/search/index.ts";
import type { SearchOutcome } from "../../core/search/index.ts";
import {
  EXPLAIN_OFF,
  explainEnvelope,
  retrievalTraceUnavailableReason,
  type ExplainRequest,
} from "../../core/search/explain-envelope.ts";
import { formatLinePointer } from "../../core/search/line-numbering.ts";
import type { DuplicatePassageLocation } from "../../core/search/search-result.ts";
import {
  ELLIPSIS,
  markWindow,
  matchOffset,
  windowStart,
} from "../../core/search/snippet-window.ts";

/** Field separator in the human transcript's header lines. */
const BULLET = "  •  ";

/** What an empty result set renders as, in both disclosure modes. */
const NO_RESULTS = "(no results)";

/** Longest snippet body shown per hit before it is elided. */
const SNIPPET_MAX_CHARS = 140;

/**
 * Merged-away exact-duplicate locations for the `--json` payload, in the
 * snake_case grammar the rest of that payload uses.
 */
function jsonDuplicates(
  duplicates: ReadonlyArray<DuplicatePassageLocation>,
): ReadonlyArray<Record<string, unknown>> {
  return duplicates.map((d) => ({
    path: d.path,
    title: d.title,
    start_line: d.startLine,
    end_line: d.endLine,
    document_id: d.documentId,
    chunk_id: d.chunkId,
  }));
}

/**
 * The snippet body for one hit: whitespace-collapsed content, windowed on
 * the first significant query term it contains (task E). With no
 * occurrence the window is the head of the chunk — the same bytes this
 * line has always carried.
 *
 * The trailing marker stays keyed on the RAW content length, which is the
 * condition this transcript has always used: it answers "there is more
 * chunk than is shown", which remains true for an anchored window.
 */
function hitSnippet(content: string, query: string): string {
  const collapsed = content.trim().replace(/\s+/g, " ");
  const start = windowStart(matchOffset(collapsed, query), SNIPPET_MAX_CHARS);
  // The trailing marker asks about the text the window is cut from, which
  // is the COLLAPSED string - keying it on the raw length claimed a cut
  // whenever whitespace collapse alone brought the chunk under the cap.
  return markWindow(
    collapsed.slice(start, start + SNIPPET_MAX_CHARS),
    start,
    collapsed.length > start + SNIPPET_MAX_CHARS,
    ELLIPSIS,
  );
}

/** Cross-vault origin label, appended only when the hit carries one. */
function originSuffix(origin: string | undefined): string {
  return origin !== undefined ? `${BULLET}${origin}` : "";
}

/**
 * A rendered transcript ends with a newline exactly once: the lines are
 * newline-joined, and an empty transcript contributes the newline itself.
 */
function joinLines(lines: ReadonlyArray<string>): string {
  return lines.join("\n") + (lines.length > 0 ? "" : "\n");
}

export function jsonForOutcome(o: SearchOutcome, options: ExplainRequest = EXPLAIN_OFF): unknown {
  return {
    results: o.results.map((r) => ({
      path: r.path,
      title: r.title,
      content: r.content,
      score: r.score,
      keyword_score: r.keywordScore,
      semantic_score: r.semanticScore,
      link_boost: r.linkBoost,
      recency_boost: r.recencyBoost,
      start_line: r.startLine,
      end_line: r.endLine,
      search_type: r.searchType,
      reasons: r.reasons,
      // Conversation chronology (S1): present only for a note carrying an
      // authored_at instant, so the shape stays byte-identical otherwise.
      ...(r.authoredAt !== undefined ? { authored_at: r.authoredAt } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
      ...(o.evidencePack ? { why_retrieved: r.reasons } : {}),
      document_id: r.documentId,
      chunk_id: r.chunkId,
      ...(r.relations && r.relations.length > 0 ? { relations: r.relations } : {}),
      // Exact-duplicate merge (task D): the locations this row was folded
      // from. Absent, never null, when nothing was merged.
      ...(r.duplicates && r.duplicates.length > 0
        ? { duplicates: jsonDuplicates(r.duplicates) }
        : {}),
    })),
    warnings: o.warnings,
    total: o.total,
    ...(o.cards ? { cards: o.cards.map(serializeSearchCard) } : {}),
    ...(o.evidencePack ? { evidence_pack: serializeEvidencePack(o.evidencePack) } : {}),
    ...(o.surface !== undefined ? { surface: o.surface } : {}),
    // Retrieval receipts (task F): the trace and the trust assessment the
    // gate already built, appended only when --explain asks. Absent, never
    // null, otherwise.
    ...explainEnvelope(o, options),
  };
}

/**
 * The `--explain` block of the human transcript: the decision trace as
 * counts plus one line per excluded candidate, or the single line naming
 * why there is no trace to show. The trust assessment is the same
 * exclusion set folded into a reason histogram, so the transcript renders
 * the trace (the superset) and `--json` carries both receipts verbatim.
 */
function explainLines(o: SearchOutcome, request: ExplainRequest): ReadonlyArray<string> {
  const trace = o.retrievalDecisionTrace;
  const assessment = o.memoryTrustAssessment;
  // The trailing empty entry terminates the block with a newline, the way
  // a result entry does - `joinLines` adds no separator of its own.
  if (trace === undefined || assessment === undefined) {
    return [`explain: ${retrievalTraceUnavailableReason(request.crossVault)}`, ""];
  }
  const lines = [
    `explain: evaluated ${trace.evaluated}${BULLET}surfaced ${trace.surfaced}${BULLET}excluded ${trace.excluded}`,
  ];
  for (const exclusion of trace.exclusions) {
    lines.push(`    excluded: ${exclusion.path}${BULLET}${exclusion.reasons.join(", ")}`);
  }
  lines.push("");
  return lines;
}

/**
 * `query` is the query text the outcome answers. It anchors each hit's
 * snippet window on the match (task E) and is required, not optional: a
 * transcript that silently fell back to the head of the chunk is the
 * defect this parameter exists to prevent.
 */
export function renderOutcomeHuman(
  o: SearchOutcome,
  verbose: boolean,
  query: string,
  options: ExplainRequest = EXPLAIN_OFF,
): string {
  // Progressive disclosure layer 1: render compact cards. The agent
  // drills a hit with `o2b search expand --chunk <chunk_id>`.
  if (o.cards !== undefined) {
    const lines: string[] = [];
    if (o.cards.length === 0) lines.push(NO_RESULTS);
    o.cards.forEach((c, i) => {
      lines.push(`[${i + 1}] ${c.pointer}${BULLET}${c.score.toFixed(2)}${originSuffix(c.origin)}`);
      lines.push(`    ${c.snippet}`);
      lines.push(`    expand: o2b search expand --chunk ${c.chunkId}`);
      if (verbose && c.reasons.length > 0) lines.push(`    why: ${c.reasons.join(", ")}`);
      lines.push("");
    });
    for (const w of o.warnings) lines.push(`warning: ${w}`);
    if (options.explain) lines.push(...explainLines(o, options));
    return joinLines(lines);
  }
  const lines: string[] = [];
  if (o.results.length === 0) {
    lines.push(NO_RESULTS);
  }
  o.results.forEach((r, i) => {
    const score = r.score.toFixed(2);
    lines.push(`[${i + 1}] ${r.path}${BULLET}${score}${originSuffix(r.origin)}`);
    // Conversation chronology (S1): show the authoring instant only for a
    // note that carries one; a note without stays byte-identical.
    const authoredSuffix =
      r.authoredAt !== undefined
        ? `${BULLET}authored ${new Date(r.authoredAt * 1000).toISOString()}`
        : "";
    lines.push(
      `    line ${r.startLine}-${r.endLine}${BULLET}${r.searchType}${authoredSuffix}` +
        (verbose
          ? `${BULLET}kw=${r.keywordScore.toFixed(2)} sem=${r.semanticScore.toFixed(2)} link=${r.linkBoost.toFixed(2)} rec=${r.recencyBoost.toFixed(2)}`
          : ""),
    );
    lines.push(`    ${hitSnippet(r.content, query)}`);
    if (verbose && r.reasons.length > 0) {
      lines.push(`    why: ${r.reasons.join(", ")}`);
    }
    if (r.relations && r.relations.length > 0) {
      const rel = r.relations.map((x) => `${x.relation} ${x.target}`).join(", ");
      lines.push(`    relations: ${rel}`);
    }
    // Exact-duplicate merge (task D): the same bytes live at these other
    // locations. Rendered only when the merge actually folded something.
    if (r.duplicates && r.duplicates.length > 0) {
      const dup = r.duplicates
        .map((d) => formatLinePointer(d.path, d.startLine, d.endLine))
        .join(", ");
      lines.push(`    duplicates: ${dup}`);
    }
    lines.push("");
  });
  for (const w of o.warnings) lines.push(`warning: ${w}`);
  if (options.explain) lines.push(...explainLines(o, options));
  return joinLines(lines);
}
