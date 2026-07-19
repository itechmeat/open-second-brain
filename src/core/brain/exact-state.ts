/**
 * Overwrite-only exact-state lane (t_b0c9d0a3).
 *
 * Operational "current value" state - the deploy target, the active branch,
 * the current sprint - accumulates badly in a free-form scratchpad: an old
 * value stays in the text and can resurface through semantic recall. This
 * lane stores that state STRUCTURALLY, keyed by aspect: each write to an
 * aspect overwrites its canonical value entirely, with no history and no
 * versioned copies. One file per aspect at `Brain/state/<aspect>.md`.
 *
 * The lane is excluded from the search index by the index-admission
 * predicate ({@link ../vault-scope/index-admission.ts}) and from retrieval
 * by the staleness barrier ({@link ../search/result-filters.ts}), so a
 * superseded value can never leak back through FTS/vector/graph recall.
 *
 * Language-agnostic: the aspect is an opaque slug; nothing here inspects the
 * natural-language content of the value.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sanitiseTextField } from "../redactor.ts";
import { parseFrontmatterText } from "../vault.ts";
import { brainStateDir, exactStatePath, validateSlug } from "./paths.ts";

/** Frontmatter `kind` marking a page as an exact-state lane artifact. */
export const EXACT_STATE_KIND = "exact-state";

/** Hard ceiling on a single aspect's value. Mirrors the pinned-context budget. */
export const MAX_EXACT_STATE_VALUE_LEN = 20_000;

export type ExactStateErrorCode = "budget_exceeded" | "invalid_aspect";

/** Typed failure so callers surface a structured error instead of opaque prose. */
export class ExactStateError extends Error {
  readonly code: ExactStateErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ExactStateErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ExactStateError";
    this.code = code;
    this.details = details;
  }
}

export interface ExactStateEntry {
  /** The aspect slug this entry is keyed by. */
  readonly aspect: string;
  /** The canonical value (the latest overwrite). */
  readonly value: string;
  /** Absolute path of the aspect's lane file. */
  readonly path: string;
  /** ISO-8601 instant of the last write. */
  readonly updatedAt: string;
}

function normaliseValue(value: unknown): string {
  return sanitiseTextField(value, { maxLen: Number.POSITIVE_INFINITY }).trim();
}

function renderPage(aspect: string, value: string, updatedAt: string): string {
  // Fixed, machine-safe frontmatter fields (slug aspect, ISO instant,
  // constant kind) - no user text reaches the YAML, so no quoting hazard.
  return `---\nkind: ${EXACT_STATE_KIND}\naspect: ${aspect}\nupdated_at: ${updatedAt}\n---\n\n${value}\n`;
}

/**
 * Write (overwrite) an aspect's canonical value. Returns the stored entry.
 * Over-budget input is rejected with {@link ExactStateError} BEFORE any
 * write - never silently truncated. An invalid aspect slug throws.
 */
export function writeExactState(
  vault: string,
  aspect: string,
  value: unknown,
  now: number = Date.now(),
): ExactStateEntry {
  const slug = validateSlug(aspect);
  const normalised = normaliseValue(value);
  if (normalised.length > MAX_EXACT_STATE_VALUE_LEN) {
    throw new ExactStateError(
      "budget_exceeded",
      `exact-state value of ${normalised.length} chars exceeds the ${MAX_EXACT_STATE_VALUE_LEN} budget`,
      { aspect: slug, length: normalised.length, budget: MAX_EXACT_STATE_VALUE_LEN },
    );
  }
  const path = exactStatePath(vault, slug);
  const updatedAt = new Date(now).toISOString();
  atomicWriteFileSync(path, renderPage(slug, normalised, updatedAt));
  return Object.freeze({ aspect: slug, value: normalised, path, updatedAt });
}

/** Read an aspect's canonical value, or null when it was never written. */
export function readExactState(vault: string, aspect: string): ExactStateEntry | null {
  const slug = validateSlug(aspect);
  const path = exactStatePath(vault, slug);
  if (!existsSync(path)) return null;
  return parseEntry(slug, path, readFileSync(path, "utf8"));
}

/** Every aspect in the lane, sorted by aspect slug ascending. */
export function listExactState(vault: string): ExactStateEntry[] {
  const dir = brainStateDir(vault);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ExactStateEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const aspect = name.slice(0, -3);
    try {
      const entry = readExactState(vault, aspect);
      if (entry !== null) out.push(entry);
    } catch {
      // A malformed aspect filename is not a valid lane entry; skip it.
    }
  }
  out.sort((a, b) => (a.aspect < b.aspect ? -1 : a.aspect > b.aspect ? 1 : 0));
  return out;
}

/** Remove an aspect. Returns whether it existed before the call. */
export function clearExactState(vault: string, aspect: string): boolean {
  const path = exactStatePath(vault, aspect);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

function parseEntry(aspect: string, path: string, raw: string): ExactStateEntry {
  const [meta, body] = parseFrontmatterText(raw);
  const updatedAt = typeof meta["updated_at"] === "string" ? meta["updated_at"] : "";
  return Object.freeze({ aspect, value: body.trim(), path, updatedAt });
}
