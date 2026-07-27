/**
 * Presentation of a {@link SearchOutcome} for `o2b search <query>`: the
 * `--json` payload and the human transcript. Every byte either function
 * produces is a CLI contract.
 */

import { serializeEvidencePack, serializeSearchCard } from "../../core/search/index.ts";
import type { SearchOutcome } from "../../core/search/index.ts";

/** Field separator in the human transcript's header lines. */
const BULLET = "  •  ";

/** What an empty result set renders as, in both disclosure modes. */
const NO_RESULTS = "(no results)";

/** Longest snippet body shown per hit before it is elided. */
const SNIPPET_MAX_CHARS = 140;

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

export function jsonForOutcome(o: SearchOutcome): unknown {
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
    })),
    warnings: o.warnings,
    total: o.total,
    ...(o.cards ? { cards: o.cards.map(serializeSearchCard) } : {}),
    ...(o.evidencePack ? { evidence_pack: serializeEvidencePack(o.evidencePack) } : {}),
    ...(o.surface !== undefined ? { surface: o.surface } : {}),
  };
}

export function renderOutcomeHuman(o: SearchOutcome, verbose: boolean): string {
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
    const snippet = r.content.trim().replace(/\s+/g, " ").slice(0, SNIPPET_MAX_CHARS);
    lines.push(`    ${snippet}${r.content.length > SNIPPET_MAX_CHARS ? "…" : ""}`);
    if (verbose && r.reasons.length > 0) {
      lines.push(`    why: ${r.reasons.join(", ")}`);
    }
    if (r.relations && r.relations.length > 0) {
      const rel = r.relations.map((x) => `${x.relation} ${x.target}`).join(", ");
      lines.push(`    relations: ${rel}`);
    }
    lines.push("");
  });
  for (const w of o.warnings) lines.push(`warning: ${w}`);
  return joinLines(lines);
}
