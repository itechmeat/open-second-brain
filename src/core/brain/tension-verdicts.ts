/**
 * `brain_tension verify` (issue #213, Part 5, use `tension`): an advisory
 * decision-model verdict on persisted tensions.
 *
 * The negation-lexicon detector cannot tell "contradicts" from "one note
 * quotes or qualifies the other". `verify` sends the two quoted spans of
 * each tension as `pairs.A<i>` / `pairs.B<i>` and asks whether they
 * `contradicts`, are `compatible` or are `unrelated`.
 *
 * Read-only: detection, persistence and status transitions are
 * untouched, and no verdict is written into a tension record or a note.
 *
 *   - `off` or no active config: `{ available: false, reason:
 *     "decision_model_off" }` beside the unchanged rows.
 *   - `shadow`: sent and recorded; rows unchanged, `mode: "shadow"`.
 *   - `enforce`: rows gain `decision_model`; a confident `compatible` or
 *     `unrelated` is listed last with `decision_model_low_priority: true`.
 *   - every request degraded: `{ available: false, reason }`, rows in
 *     their usual order.
 *
 * A quote leaves the machine only when its subject note resolves, is not
 * private, and the quote carries no part of the note's `<private>`
 * regions; the tension page itself must not be private either.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

import {
  advisoryDecisionConfig,
  advisoryUseActive,
  pageEgressFacts,
  type AdvisoryDecisionOptions,
  type PageEgressFacts,
} from "../decision-model/advisory.ts";
import { decisionModelModeFor } from "../decision-model/config.ts";
import {
  orderByVerdicts,
  runPairVerdicts,
  type AnnotatedItem,
  type VerdictPairInput,
} from "../decision-model/pair-verdict.ts";
import { TENSION_QUESTIONS } from "../decision-model/questions.ts";
import { mayLeaveMachine } from "../decision-model/state.ts";
import { parseFrontmatter } from "../vault.ts";
import { buildNoteWalkRules, resolveNoteRoots, walkMarkdownFiles } from "./notes/note-walk.ts";
import type { TensionRecord } from "./tensions.ts";

export type TensionVerifyResult =
  | {
      readonly available: false;
      readonly reason: string;
      readonly rows: ReadonlyArray<AnnotatedItem<TensionRecord>>;
    }
  | {
      readonly available: true;
      readonly mode: "shadow" | "enforce";
      readonly rows: ReadonlyArray<AnnotatedItem<TensionRecord>>;
    };

function plain(records: ReadonlyArray<TensionRecord>): ReadonlyArray<AnnotatedItem<TensionRecord>> {
  return records.map((item) => ({ item, verdict: null, lowPriority: false }));
}

/** A vault-relative path inside the vault, or null. */
function insideVault(vault: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const abs = normalize(join(vault, rel));
  const back = relative(vault, abs);
  if (back.startsWith("..") || isAbsolute(back)) return null;
  return abs;
}

/**
 * Resolve subject ids (a note's frontmatter `id`, else its vault-relative
 * path, as the detector assigns them) to page files. Unresolved ids map
 * to nothing, and their pairs are never sent.
 */
function resolveSubjects(vault: string, ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const pending = new Set<string>();
  for (const id of ids) {
    const abs = id.endsWith(".md") ? insideVault(vault, id) : null;
    if (abs !== null && existsSync(abs)) out.set(id, abs);
    else pending.add(id);
  }
  if (pending.size === 0) return out;
  const ambiguous = new Set<string>();
  try {
    const roots = resolveNoteRoots(vault);
    if (roots.length === 0) return out;
    for (const file of walkMarkdownFiles(vault, roots, buildNoteWalkRules(vault))) {
      let meta: Readonly<Record<string, unknown>>;
      try {
        [meta] = parseFrontmatter(file.absPath);
      } catch {
        continue;
      }
      const rawId = meta["id"];
      const id = typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : file.relPath;
      if (!pending.has(id)) continue;
      // An id two notes declare cannot say which note the quote came
      // from, so it resolves to nothing and is never sent.
      if (out.has(id) || ambiguous.has(id)) {
        out.delete(id);
        ambiguous.add(id);
      } else out.set(id, file.absPath);
    }
  } catch {
    // An unreadable notes config leaves the rest unresolved: never sent.
  }
  return out;
}

function side(
  quote: string,
  facts: PageEgressFacts,
  pageAllowed: boolean,
): VerdictPairInput["sideA"] {
  if (!pageAllowed) return { text: "", visibility: null, privateRegions: null };
  return { text: quote, visibility: facts.visibility, privateRegions: facts.privateRegions };
}

/** Verify `records` (a slug's record, or the unresolved tensions). */
export async function verifyTensions(
  vault: string,
  records: ReadonlyArray<TensionRecord>,
  opts: AdvisoryDecisionOptions = {},
): Promise<TensionVerifyResult> {
  const cfg = advisoryDecisionConfig(vault, opts);
  if (!advisoryUseActive(cfg, "tension")) {
    return { available: false, reason: "decision_model_off", rows: plain(records) };
  }
  const mode = decisionModelModeFor(cfg, "tension") as "shadow" | "enforce";
  if (records.length === 0) return { available: true, mode, rows: [] };

  const subjects = resolveSubjects(
    vault,
    new Set(records.flatMap((t) => [t.subjectA, t.subjectB])),
  );
  const facts = new Map<string, PageEgressFacts>();
  const factsOf = (abs: string | undefined): PageEgressFacts => {
    if (abs === undefined) return pageEgressFacts(null);
    let f = facts.get(abs);
    if (f === undefined) {
      f = pageEgressFacts(abs);
      facts.set(abs, f);
    }
    return f;
  };
  const pairs: VerdictPairInput[] = records.map((t) => {
    const pageAllowed = mayLeaveMachine(factsOf(t.path).visibility);
    return {
      id: t.slug,
      a: t.subjectA,
      b: t.subjectB,
      sideA: side(t.quoteA, factsOf(subjects.get(t.subjectA)), pageAllowed),
      sideB: side(t.quoteB, factsOf(subjects.get(t.subjectB)), pageAllowed),
    };
  });

  const run = await runPairVerdicts(
    pairs,
    {
      use: "tension",
      pairKind: "tension",
      options: TENSION_QUESTIONS.options,
      clipChars: TENSION_QUESTIONS.clipChars,
      question: TENSION_QUESTIONS.question,
    },
    {
      config: cfg,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    },
  );
  if (run.status === "off") {
    return { available: false, reason: "decision_model_off", rows: plain(records) };
  }
  if (run.degraded !== undefined && run.verdicts.every((v) => v === null)) {
    return { available: false, reason: run.degraded, rows: plain(records) };
  }
  return {
    available: true,
    mode: run.mode,
    rows: orderByVerdicts(records, run.verdicts, run.mode, TENSION_QUESTIONS.lowPriority),
  };
}
