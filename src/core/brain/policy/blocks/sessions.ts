/**
 * The `sessions:` block — which sessions and messages the capture
 * boundary lets through, and how large a recalled turn may be stored
 * inline before the payload registry externalizes it.
 *
 * Session patterns are anchored globs; message patterns are regexes
 * validated lazily at compile time - an invalid regex degrades to a
 * capture-boundary warning, never a config error, so a typo cannot take
 * the whole Brain config down. The two payload thresholds are plain
 * positive integers and are validated here, because a wrong one changes
 * what lands on disk.
 */

import type {
  BrainConfig,
  BrainSessionsConfig,
  ResolvedBrainSessionsConfig,
  ResolvedSessionPayloadPolicy,
} from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, requireArrayField, requirePositiveInteger } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "sessions";

const LIST_KEYS = ["ignore_patterns", "stateless_patterns", "ignore_message_patterns"] as const;

const PAYLOAD_KEYS = ["payload_max_inline_chars", "payload_max_text_chars"] as const;

/**
 * Default `sessions:` block (Memory Integrity Suite). Empty lists
 * mean every session and message is captured - the pre-boundary
 * behaviour, bit-identical.
 */
export const BRAIN_SESSIONS_DEFAULTS: ResolvedBrainSessionsConfig = Object.freeze({
  ignore_patterns: Object.freeze([]) as ReadonlyArray<string>,
  stateless_patterns: Object.freeze([]) as ReadonlyArray<string>,
  ignore_message_patterns: Object.freeze([]) as ReadonlyArray<string>,
}) as ResolvedBrainSessionsConfig;

/**
 * Default payload-registry thresholds.
 *
 * `max_inline_chars` (512): a data URI or base64 run is never prose, and
 * half a kilobyte of it is already noise to recall - long enough that a
 * short hash, key id or inline icon stays inline.
 *
 * `max_text_chars` (32,000, roughly eight thousand tokens): a single turn
 * longer than this is almost always a pasted log or a tool dump. It is
 * well above any conversational turn, so ordinary sessions import
 * byte-identically, and well below the redactor's 1 MiB scan window, so
 * a stored row is always scanned in full.
 */
export const BRAIN_SESSION_PAYLOAD_DEFAULTS: ResolvedSessionPayloadPolicy = Object.freeze({
  max_inline_chars: 512,
  max_text_chars: 32_000,
});

/** Merge a parsed `sessions` block (or `undefined`) with the defaults. */
export function resolveSessions(cfg: BrainConfig): ResolvedBrainSessionsConfig {
  const block = cfg.sessions;
  if (block === undefined) return BRAIN_SESSIONS_DEFAULTS;
  return Object.freeze({
    ignore_patterns: Object.freeze([...(block.ignore_patterns ?? [])]) as ReadonlyArray<string>,
    stateless_patterns: Object.freeze([
      ...(block.stateless_patterns ?? []),
    ]) as ReadonlyArray<string>,
    ignore_message_patterns: Object.freeze([
      ...(block.ignore_message_patterns ?? []),
    ]) as ReadonlyArray<string>,
  }) as ResolvedBrainSessionsConfig;
}

/** The payload-registry thresholds of a parsed config, defaults filled. */
export function resolveSessionPayloadPolicy(cfg: BrainConfig): ResolvedSessionPayloadPolicy {
  const block = cfg.sessions;
  return Object.freeze({
    max_inline_chars:
      block?.payload_max_inline_chars ?? BRAIN_SESSION_PAYLOAD_DEFAULTS.max_inline_chars,
    max_text_chars: block?.payload_max_text_chars ?? BRAIN_SESSION_PAYLOAD_DEFAULTS.max_text_chars,
  });
}

/**
 * Shape:
 *   sessions:
 *     ignore_patterns:        ["cron-*"]
 *     stateless_patterns:     ["probe-*"]
 *     ignore_message_patterns: ["^\\[heartbeat\\]"]
 *     payload_max_inline_chars: 512
 *     payload_max_text_chars:   32000
 */
export function parseSessionsBlock(ctx: BlockParseContext): BrainSessionsConfig | undefined {
  const sessionsObj = openBlock(ctx, BLOCK);
  if (sessionsObj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  for (const key of LIST_KEYS) {
    if (!(key in sessionsObj)) continue;
    const list = requireArrayField(
      sessionsObj[key],
      `sessions.${key}`,
      ctx.source,
      "must be an array of pattern strings",
    );
    partial[key] = list.map((entry, idx) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new BrainConfigError(
          `must be a non-empty string; got ${describe(entry)}`,
          `sessions.${key}[${idx}]`,
          ctx.source,
        );
      }
      return entry.trim();
    });
  }
  for (const key of PAYLOAD_KEYS) {
    if (!(key in sessionsObj)) continue;
    requirePositiveInteger(`sessions.${key}`, sessionsObj[key], ctx.source);
    partial[key] = sessionsObj[key];
  }
  warnUnknownKeys(ctx, sessionsObj, [...LIST_KEYS, ...PAYLOAD_KEYS], BLOCK);
  return partial as BrainSessionsConfig;
}
