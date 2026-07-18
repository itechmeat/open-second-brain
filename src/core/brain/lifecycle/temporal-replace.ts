/**
 * Atomic temporal fact-replacement (Belief lifecycle suite, A2,
 * t_3ba9c404).
 *
 * One operation closes a predecessor fact (`valid_until = T`) and opens
 * a successor fact (`valid_from = T`) at one shared instant, reusing
 * `superseded_by` as the successor link. Intervals are half-open
 * `[valid_from, valid_until)`: at exactly T the predecessor is no longer
 * valid and the successor is, so point-in-time evaluation of the pair
 * has no gap and no overlap. Date-only facts (`YYYY-MM-DD`) keep
 * whole-day semantics - the boundary is a whole day, evaluated as its
 * `T00:00:00Z` start.
 *
 * The pair is written atomically (both or neither): both files are
 * validated and their new content computed before any write, and a
 * failed second write rolls the first back to its captured bytes.
 *
 * This layer does NOT touch the existing conflict-resolution supersede
 * in `hygiene/resolve-conflicts.ts`; it is a distinct, explicit
 * operator/agent operation over bi-temporal validity fields.
 *
 * Import direction (design invariant): imports from `types.ts` and the
 * shared vault/log helpers plus the sibling `tombstone.ts` link
 * conventions, never the reverse.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { resolveNotePath } from "../note-path.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { normalizeChainLink, SUPERSEDED_BY_KEY } from "./tombstone.ts";

// ----- Constants ------------------------------------------------------------

/** Frontmatter key: bi-temporal event-time start (inclusive). */
export const VALID_FROM_KEY = "valid_from";
/** Frontmatter key: bi-temporal event-time end (exclusive, half-open). */
export const VALID_UNTIL_KEY = "valid_until";
/** Date-only fact shape (whole-day validity). */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Full ISO-8601 UTC instant shape. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class TemporalReplaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemporalReplaceError";
  }
}

// ----- Point-in-time evaluation ---------------------------------------------

/** A bi-temporal fact's validity bounds, as stored in frontmatter. */
export interface ValidityBounds {
  readonly valid_from?: unknown;
  readonly valid_until?: unknown;
}

/**
 * Convert a stored boundary to a UTC-milliseconds instant. A date-only
 * boundary (`YYYY-MM-DD`) resolves to that day's `T00:00:00Z` start so
 * whole-day facts evaluate consistently against any probe within the
 * day. Returns `null` for an absent or unparseable boundary.
 */
export function boundaryToMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const iso = DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Evaluate whether a fact is valid at `probeMs` under half-open
 * `[valid_from, valid_until)` semantics. An absent bound is unbounded on
 * that side. `valid_from` is inclusive, `valid_until` exclusive - so two
 * facts sharing a boundary T (predecessor `valid_until = T`, successor
 * `valid_from = T`) never overlap at T and leave no gap around it.
 */
export function isValidAt(fact: ValidityBounds, probeMs: number): boolean {
  const from = boundaryToMs(fact.valid_from);
  const until = boundaryToMs(fact.valid_until);
  if (from !== null && probeMs < from) return false;
  if (until !== null && probeMs >= until) return false;
  return true;
}

// ----- Replacement ----------------------------------------------------------

interface NormalizedInstant {
  /** The exact string stored on disk (date-only preserved verbatim). */
  readonly stored: string;
}

function normalizeInstant(at: string | Date): NormalizedInstant {
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) {
      throw new TemporalReplaceError("temporalReplace: 'at' is an invalid Date");
    }
    return { stored: isoSecond(at) };
  }
  const value = at.trim();
  if (DATE_ONLY_RE.test(value)) return { stored: value };
  if (ISO_INSTANT_RE.test(value)) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new TemporalReplaceError(`temporalReplace: 'at' is not a valid instant: ${at}`);
    }
    // Canonicalize sub-second precision away to the log/heading shape.
    return { stored: isoSecond(new Date(ms)) };
  }
  throw new TemporalReplaceError(
    `temporalReplace: 'at' must be an ISO-8601 UTC instant or a YYYY-MM-DD date; got ${JSON.stringify(at)}`,
  );
}

export interface TemporalReplaceInput {
  readonly vault: string;
  /** Vault-relative POSIX path of the predecessor fact being closed. */
  readonly predecessor: string;
  /** Vault-relative POSIX path of the successor fact being opened. */
  readonly successor: string;
  /** Shared instant T: ISO-8601 UTC instant or `YYYY-MM-DD` date. */
  readonly at: string | Date;
  readonly agent?: string;
  readonly configPath?: string;
}

export interface TemporalReplaceResult {
  /** The shared instant as stored on disk. */
  readonly at: string;
  /** Vault-relative predecessor path. */
  readonly predecessor: string;
  /** Vault-relative successor path. */
  readonly successor: string;
  readonly agent: string;
  readonly loggedAt: string;
}

function relForVault(vault: string, absPath: string): string {
  return relative(vault, absPath).split("\\").join("/");
}

/**
 * Close the predecessor and open the successor at one shared instant.
 * Writes both files atomically (both or neither) and logs one
 * `temporal-replace` event.
 */
export function temporalReplace(input: TemporalReplaceInput): TemporalReplaceResult {
  let absPred: string;
  let absSucc: string;
  try {
    absPred = resolveNotePath(input.vault, input.predecessor, { mustExist: true });
    absSucc = resolveNotePath(input.vault, input.successor, { mustExist: true });
  } catch (err) {
    throw new TemporalReplaceError(
      `temporalReplace: a fact does not resolve inside the vault: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (absPred === absSucc) {
    throw new TemporalReplaceError("temporalReplace: predecessor and successor must differ");
  }

  const relPred = relForVault(input.vault, absPred);
  const relSucc = relForVault(input.vault, absSucc);
  const { stored } = normalizeInstant(input.at);

  const [predMeta, predBody] = parseFrontmatter(absPred);
  const [succMeta, succBody] = parseFrontmatter(absSucc);
  const successorLink = `[[${normalizeChainLink(input.successor)}]]`;

  const predNext: FrontmatterMap = { ...(predMeta as FrontmatterMap) };
  predNext[VALID_UNTIL_KEY] = stored;
  predNext[SUPERSEDED_BY_KEY] = successorLink;

  const succNext: FrontmatterMap = { ...(succMeta as FrontmatterMap) };
  succNext[VALID_FROM_KEY] = stored;

  // Capture original bytes so a failed second write can be rolled back:
  // the pair is written atomically (both or neither).
  const origPred = readFileSync(absPred, "utf8");
  let predWritten = false;
  try {
    writeFrontmatterAtomic(absPred, predNext, predBody, { overwrite: true });
    predWritten = true;
    writeFrontmatterAtomic(absSucc, succNext, succBody, { overwrite: true });
  } catch (err) {
    if (predWritten) {
      try {
        atomicWriteFileSync(absPred, origPred);
      } catch (restoreErr) {
        throw new TemporalReplaceError(
          `temporalReplace: successor write failed AND predecessor rollback failed for ${relPred}: ${(restoreErr as Error).message}`,
          { cause: restoreErr },
        );
      }
    }
    throw new TemporalReplaceError(
      `temporalReplace: failed to write the fact pair (${relPred} -> ${relSucc}): ${(err as Error).message}`,
      { cause: err },
    );
  }

  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);
  const loggedAt = isoSecond(new Date());
  appendLogEvent(input.vault, {
    timestamp: loggedAt,
    eventType: BRAIN_LOG_EVENT_KIND.temporalReplace,
    body: {
      predecessor: relPred,
      successor: relSucc,
      at: stored,
      agent,
    },
  });

  return { at: stored, predecessor: relPred, successor: relSucc, agent, loggedAt };
}
