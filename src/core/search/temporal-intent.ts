/**
 * Query-side temporal intent (t_58fc4720).
 *
 * The Weibull freshness prior in `recency.ts` is query-INDEPENDENT: it
 * always favours recent notes, including when the query explicitly asks
 * about an older period, where it actively hurts ranking. This module is
 * the detection half of the correction. It resolves the window a query
 * declares, so the ranker can bias toward that window and damp the
 * misdirected freshness prior.
 *
 * LANGUAGE-AGNOSTIC INVARIANT (the same one `query-plan.ts` audits):
 * detection reads ONLY structural tokens -
 *
 *   - ISO date / datetime tokens anywhere in the query text, matched by
 *     digit-and-separator shape with digit/hyphen-only boundaries, so a
 *     token embedded in Han text with no whitespace at all is detected
 *     exactly as it is in English; and
 *   - the `<field>:<value>` grammar the surface router already uses,
 *     with the `since` / `until` field names the time-range parameters
 *     already own.
 *
 * No natural-language phrase ("last week", "recently", "before X") is
 * recognised, in any language: such a list is not portable to a system
 * that must behave identically across every script, so it is not
 * attempted.
 *
 * ## Exactly what a field value may say
 *
 * A `since:` / `until:` value in QUERY TEXT is admitted only in a
 * language-neutral form - an ISO date, an ISO datetime, or a `<n>h` /
 * `<n>d` / `<n>w` duration (`isLanguageNeutralTimePoint`). The word forms
 * `parseTimePoint` also accepts (`today`, `yesterday`, `last week`,
 * `last month`) belong to the explicit `since` / `until` PARAMETERS,
 * where an operator typed them deliberately; recognising them here would
 * make `since:yesterday` resolve while its translation into any other
 * language raised, which is precisely the asymmetry this module exists to
 * avoid. An inadmissible or unresolvable field value raises
 * `SearchError("INVALID_INPUT")`: the operator DECLARED a window, so a
 * value that cannot become one is an error, never a silent skip.
 *
 * Resolution itself is always `parseTimePoint`, the SAME parser the
 * parameters use - never a second one. The admission test above only
 * narrows what reaches it.
 *
 * ## A bare token is a shape, not a declaration
 *
 * A date-SHAPED run in free text (`invoice 2024-06-31`, a ticket number,
 * a version string) was not typed as an instruction. When such a token
 * does not resolve it declares NOTHING: it is skipped, it stays in the
 * query text as the content it is, and a previously-working search is not
 * aborted by it. Only the explicit field grammar above can fail loudly.
 *
 * Pure against an injected clock: same query and `nowMs`, same intent.
 */

import {
  resolveTimeRange,
  parseTimePoint,
  isLanguageNeutralTimePoint,
  type ResolvedTimeRange,
} from "./time-range.ts";
import { SearchError } from "./search-error.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A closed window whose end is older than this reads as a query about
 * the past rather than about the present, and the freshness prior is
 * damped for it. A window reaching the present (open `until`, or an
 * `until` inside this age) keeps the prior intact.
 */
export const HISTORICAL_WINDOW_MIN_AGE_DAYS = 7;

/**
 * Multiplier applied to the freshness prior when the declared window is
 * historical. Modest by construction: the prior is DAMPED, never
 * removed, so a genuinely fresh document still carries its recency
 * signal and the correction cannot invert ranking on its own.
 */
export const HISTORICAL_RECENCY_DAMPING = 0.5;

/**
 * `<field>:<value>` directive, anchored at a word boundary with the
 * value running to the next whitespace - the grammar `routeSummarySurface`
 * already uses for `kind:` / `type:` / `source:`.
 */
const FIELD_TOKEN_RE = /(?:^|\s)(since|until):(\S+)/giu;

/**
 * ISO date, optionally with a time component. The boundaries reject only
 * adjacent digits and hyphens, so the token is found identically whether
 * it is surrounded by spaces, by Cyrillic, or by Han characters with no
 * whitespace - while a date-shaped run inside a longer digit run
 * (`12024-06-155`) is not a date.
 */
const ISO_TOKEN_RE =
  /(?<![0-9-])\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?(?![0-9-])/gu;

export interface TemporalIntent {
  /** The window the query declares, in absolute unix ms. */
  readonly range: ResolvedTimeRange;
  /** True when the window closed longer ago than the minimum age. */
  readonly historical: boolean;
  /** Freshness-prior multiplier: `HISTORICAL_RECENCY_DAMPING` or 1. */
  readonly recencyDamping: number;
  /**
   * Stable fingerprint of the RESOLVED absolute bounds. Folded into the
   * query plan's hash, so a cache row is never served across two
   * different windows - including two calls of the same relative
   * directive that resolved differently.
   */
  readonly signature: string;
}

/**
 * Remove the `since:` / `until:` directives from a query. A directive is
 * an instruction, not content: left in the keyword lane it becomes an
 * implicit-AND term no document can match, which would turn this unit's
 * soft window into a hard exclusion - the opposite of its purpose.
 *
 * A query carrying no directive is returned unchanged, byte for byte.
 * Bare ISO tokens are content as well as signal and are always kept.
 */
export function stripTemporalDirectives(query: string): string {
  if (!new RegExp(FIELD_TOKEN_RE).test(query)) return query;
  return query.replace(new RegExp(FIELD_TOKEN_RE), " ").replace(/\s+/gu, " ").trim();
}

/**
 * Return a field value that query text is allowed to declare, or raise.
 * The gate is the language-neutral shape test; everything that passes is
 * handed to `parseTimePoint` unchanged, so this narrows the grammar
 * without becoming a second parser.
 */
function admitFieldValue(value: string): string {
  if (isLanguageNeutralTimePoint(value)) return value;
  throw new SearchError(
    "INVALID_INPUT",
    `unusable time point in query text: ${JSON.stringify(value)} ` +
      "(a query directive accepts an ISO date, an ISO datetime, or <n>h/<n>d/<n>w; " +
      "word forms are accepted only by the since / until parameters)",
  );
}

/** Collect the first occurrence of each directive. */
function readFieldTokens(query: string): {
  readonly since: string | undefined;
  readonly until: string | undefined;
} {
  let since: string | undefined;
  let until: string | undefined;
  for (const match of query.matchAll(new RegExp(FIELD_TOKEN_RE))) {
    const field = match[1]!.toLowerCase();
    const value = match[2]!;
    if (field === "since") since ??= value;
    else until ??= value;
  }
  return { since, until };
}

/**
 * Widest window spanned by the bare ISO tokens, or null when there are
 * none that RESOLVE. A token that matches the shape but names no instant
 * (`2024-06-31`, `2023-02-29`) is skipped rather than raised: see the
 * header - a shape found in free text is not a declaration, so it may not
 * abort a search that was working before the token was typed.
 */
function readIsoTokenRange(query: string, nowMs: number): ResolvedTimeRange | null {
  let sinceMs: number | null = null;
  let untilMs: number | null = null;
  for (const match of query.matchAll(new RegExp(ISO_TOKEN_RE))) {
    const resolved = resolveBareToken(match[0], nowMs);
    if (resolved === null) continue;
    sinceMs = sinceMs === null ? resolved.start : Math.min(sinceMs, resolved.start);
    untilMs = untilMs === null ? resolved.end : Math.max(untilMs, resolved.end);
  }
  if (sinceMs === null || untilMs === null) return null;
  return Object.freeze({ sinceMs, untilMs });
}

/**
 * Both edges of one bare token, or `null` when it names no instant. The
 * only place a `parseTimePoint` refusal is absorbed, and it is absorbed
 * as a NAMED outcome of this unit's grammar ("this token declares
 * nothing"), not as a swallowed failure.
 */
function resolveBareToken(token: string, nowMs: number): { start: number; end: number } | null {
  try {
    return {
      start: parseTimePoint(token, nowMs, "since"),
      end: parseTimePoint(token, nowMs, "until"),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the temporal window a query declares, or `null` when it
 * declares none. Explicit `since:` / `until:` directives win outright:
 * they state the window's edges, including which edge stays open, and a
 * bare token elsewhere in the query must not close it.
 */
export function detectTemporalIntent(query: string, nowMs: number): TemporalIntent | null {
  const fields = readFieldTokens(query);
  const range =
    fields.since !== undefined || fields.until !== undefined
      ? resolveTimeRange(
          {
            ...(fields.since !== undefined ? { since: admitFieldValue(fields.since) } : {}),
            ...(fields.until !== undefined ? { until: admitFieldValue(fields.until) } : {}),
          },
          nowMs,
        )
      : readIsoTokenRange(query, nowMs);
  if (range === null) return null;

  const historical =
    range.untilMs !== null && range.untilMs < nowMs - HISTORICAL_WINDOW_MIN_AGE_DAYS * DAY_MS;
  return Object.freeze({
    range,
    historical,
    recencyDamping: historical ? HISTORICAL_RECENCY_DAMPING : 1,
    signature: `${range.sinceMs ?? ""}:${range.untilMs ?? ""}`,
  });
}
