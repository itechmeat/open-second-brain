/**
 * Structural fact extraction (Memory Integrity Suite, t_d0782ab2;
 * made language-agnostic in t_80cbefa1).
 *
 * Captures structured facts from USER turns in real time, without an
 * LLM call. The families are deliberately limited to signals that can
 * be recognised WITHOUT knowing any human language: a URL, an e-mail
 * address, and a quantity bound to a language-neutral symbol (currency
 * symbol, ISO-4217 code, or percent). Prose-framed families that used
 * to depend on English trigger phrases ("my name is", "I prefer",
 * "yes, the X is ...") were removed: we cannot enumerate the world's
 * languages, so a per-language phrase list is a defect, not a feature
 * (see PR #84, which applied the same rule to search and classification).
 *
 * The HANDOFF carve-out is applied at its conservative core: callers
 * only feed user-authored text (role === "user"); bare assistant
 * output is never auto-extracted. The capture boundary runs FIRST -
 * suppressed or ignored input never reaches these patterns.
 *
 * Precision beats recall: fenced/inline code is stripped, quoted lines
 * (`> ...`) are dropped, and a quantity needs an explicit unit symbol
 * so arbitrary numbers never match. A missed fact costs nothing (the
 * dream pass has other sources); a hallucinated fact pollutes memory.
 */

import { createHash } from "node:crypto";

import { writeSignal } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";
import type { DedupIndexEntry } from "./dedup-hash.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { normalizeEntityName } from "./entities/canonical.ts";
import { BRAIN_ENTITY_STATUS } from "./entities/types.ts";

export type FactFamily = "url" | "email" | "quantity";

export interface ExtractedFact {
  readonly family: FactFamily;
  /** Whitespace-collapsed matched span, length-capped. */
  readonly text: string;
  /** 1-based line number in the (sanitised) input. */
  readonly line: number;
}

const MAX_FACT_CHARS = 200;

// Defence-in-depth cap: extractFacts runs on raw user turns, so a single
// pathologically long line is never scanned in full. A real fact lives well
// within this bound; anything longer is sliced before matching so the capture
// hot path can never be turned into a CPU sink by crafted input.
const MAX_LINE_SCAN_CHARS = 4000;

// ----- Quantity structuring (t_220c313e; language-agnostic in t_80cbefa1) ----

// A number tied to a language-neutral unit: a leading currency glyph, or a
// trailing percent sign or ISO-4217-style 3-letter code. The English action
// verbs and grammar stop-word list that used to frame this were removed.
//
// The trailing-unit branch is anchored with `(?<![\d.])` so a match can only
// begin at the start of a number, never mid-run. Without it, a long digit run
// lets the engine retry the greedy `\d+` at every interior offset (each retry
// backtracks the whole run before failing the unit assertion), which is
// quadratic on untrusted input - extractFacts runs on raw user turns.
const QUANTITY_SPAN_RE = /([$€£¥])\d+(?:\.\d+)?|(?<![\d.])\d+(?:\.\d+)?\s?(%|[A-Z]{3}\b)/gu;

// Currency glyph -> canonical ISO-4217 code. These are standardised symbols,
// not natural-language words, so the map is language-neutral.
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  $: "usd",
  "€": "eur",
  "£": "gbp",
  "¥": "jpy",
});

// Family patterns. Each regex is line-scoped (callers split lines) and
// recognises a language-neutral structural signal only - no human-language
// trigger words. Quantity must carry an explicit unit symbol (currency
// glyph, ISO-4217 code, or percent) so arbitrary numbers never match.
const FAMILY_PATTERNS: ReadonlyArray<readonly [FactFamily, RegExp]> = Object.freeze([
  ["url", /\bhttps?:\/\/[^\s)>\]]+/giu],
  ["email", /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/giu],
  ["quantity", QUANTITY_SPAN_RE],
] as const);

export interface ParsedQuantityFact {
  readonly value: number;
  /** Canonical unit token (`usd`, `eur`, `percent`, lowercased ISO code). */
  readonly unit: string;
}

/**
 * Structure a quantity span into (value, unit). A leading currency glyph
 * maps to its ISO code; a trailing `%` normalizes to `percent`; a trailing
 * 3-letter code lowercases to the unit. Returns null when the text carries
 * no unit-bound number - the caller treats that as "not a quantity".
 */
export function parseQuantityFact(text: string): ParsedQuantityFact | null {
  if (!text || text.trim() === "") return null;
  const re = new RegExp(QUANTITY_SPAN_RE.source, "u");
  const m = re.exec(text);
  if (m === null) return null;
  const value = Number(m[0].replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value)) return null;
  let unit: string;
  if (m[1] !== undefined) {
    unit = CURRENCY_SYMBOLS[m[1]] ?? m[1];
  } else if (m[2] === "%") {
    unit = "percent";
  } else {
    unit = m[2]!.toLowerCase();
  }
  return Object.freeze({ value, unit });
}

/** Strip fenced code blocks, inline code, and quoted lines. */
function sanitise(text: string): string {
  const noFences = text.replace(/```[\s\S]*?```/g, "");
  const noInline = noFences.replace(/`[^`\n]*`/g, "");
  return noInline
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith(">") ? "" : line))
    .join("\n");
}

function collapse(span: string): string {
  return span.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
}

/**
 * Extract every fact the seven families recognise, in (line, family
 * table) order. Deterministic: same input, same output.
 */
export function extractFacts(text: string): ExtractedFact[] {
  if (!text || text.trim().length === 0) return [];
  const lines = sanitise(text).split(/\r?\n/);
  const out: ExtractedFact[] = [];
  const seenSpans = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim().length === 0) continue;
    const line = raw.length > MAX_LINE_SCAN_CHARS ? raw.slice(0, MAX_LINE_SCAN_CHARS) : raw;
    // URLs are matched first (family-table order); their character ranges are
    // recorded so the email and quantity passes never re-read inside a URL -
    // a `user:pass@host` userinfo is not an e-mail, and a `?n=50USD` query is
    // not a measured quantity.
    const urlRanges: Array<readonly [number, number]> = [];
    for (const [family, pattern] of FAMILY_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        const start = m.index ?? 0;
        const end = start + m[0]!.length;
        if (family !== "url" && urlRanges.some(([s, e]) => start < e && end > s)) continue;
        const span = collapse(m[0]!);
        if (span.length === 0) continue;
        // NUL separator cannot collide with sanitised span text; written
        // as an escape so the file stays text-diffable.
        const spanKey = `${family}\u0000${span.toLowerCase()}`;
        if (seenSpans.has(spanKey)) continue;
        seenSpans.add(spanKey);
        if (family === "url") urlRanges.push([start, end] as const);
        out.push(Object.freeze({ family, text: span, line: i + 1 }));
      }
    }
  }
  return out;
}

/**
 * Stable dedup hash over (family, case/whitespace-normalised text).
 * Same shape as the pre-compact extraction hash so re-imports and
 * repeated prompts dedup identically.
 */
export function factDedupHash(fact: Pick<ExtractedFact, "family" | "text">): string {
  const normalised = fact.text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(`${fact.family}\n${normalised}`).digest("hex").slice(0, 16);
}

// ----- Routing ---------------------------------------------------------------

export interface RouteFactsInput {
  readonly facts: ReadonlyArray<ExtractedFact>;
  readonly agent: string;
  readonly now: Date;
  /** `<path-or-session>#<turn-id>` provenance pointer. */
  readonly sessionRef: string;
  /** Shared dedup index (the caller owns it across turns/files). */
  readonly dedup: Map<string, DedupIndexEntry>;
  readonly dryRun?: boolean;
}

export interface RouteFactsResult {
  readonly created: number;
  readonly deduped: number;
}

/**
 * Resolve canonical-entity anchors for a fact: every active registry
 * entity whose name or alias (normalised) appears in the fact text.
 * The canonicalization kernel is the comparison boundary, so facts and
 * the registry compare like with like.
 */
function entityAnchors(index: ReturnType<typeof buildEntityIndex>, factText: string): string[] {
  if (index.entities.length === 0) return [];
  const haystack = normalizeEntityName(factText);
  const ids: string[] = [];
  for (const entity of index.entities) {
    if (entity.status !== BRAIN_ENTITY_STATUS.active) continue;
    const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    if (forms.some((f) => f.length >= 3 && haystack.includes(f))) ids.push(entity.id);
  }
  return ids;
}

/**
 * Write extracted facts as `source_type: extracted` signals. Facts
 * that name a registered canonical entity (or alias) carry the
 * canonical id in the signal body - the anchor the entity task's
 * value proposition is about. Runs ONLY on text that already passed
 * the capture boundary; both seams pin that order with tests.
 */
export function routeExtractedFacts(vault: string, input: RouteFactsInput): RouteFactsResult {
  if (input.facts.length === 0) return { created: 0, deduped: 0 };
  let created = 0;
  let deduped = 0;
  let entityIndex: ReturnType<typeof buildEntityIndex>;
  try {
    entityIndex = buildEntityIndex(vault);
  } catch {
    entityIndex = { entities: [], byKey: new Map(), byAlias: new Map(), conflicts: [] };
  }

  for (const fact of input.facts) {
    const hash = factDedupHash(fact);
    if (input.dedup.has(hash)) {
      deduped++;
      continue;
    }
    if (input.dryRun) continue;
    const anchors = entityAnchors(entityIndex, fact.text);
    const topic = `fact-${fact.family}`;
    try {
      const result = writeSignal(vault, {
        topic,
        signal: "positive",
        agent: input.agent,
        principle: fact.text,
        created_at: isoSecond(input.now),
        date: isoDate(input.now),
        slug: topic,
        source: [`[[${input.sessionRef}]]`],
        source_type: BRAIN_SIGNAL_SOURCE_TYPE.extracted,
        dedup_hash: hash,
        session_ref: input.sessionRef,
        ...(anchors.length > 0 ? { raw: `entities: ${anchors.join(", ")}` } : {}),
      });
      input.dedup.set(hash, { id: result.id, path: result.path });
      created++;
    } catch {
      // One unwritable fact must not break capture; the next turn retries.
    }
  }
  return { created, deduped };
}
