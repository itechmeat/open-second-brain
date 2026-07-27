/**
 * The `sessions:` block — which sessions and messages the capture
 * boundary lets through.
 *
 * One reason to change: how an operator excludes traffic from capture.
 * Session patterns are anchored globs; message patterns are regexes
 * validated lazily at compile time - an invalid regex degrades to a
 * capture-boundary warning, never a config error, so a typo cannot take
 * the whole Brain config down.
 */

import type { BrainConfig, BrainSessionsConfig, ResolvedBrainSessionsConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "sessions";

const LIST_KEYS = ["ignore_patterns", "stateless_patterns", "ignore_message_patterns"] as const;

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

/**
 * Shape:
 *   sessions:
 *     ignore_patterns:        ["cron-*"]
 *     stateless_patterns:     ["probe-*"]
 *     ignore_message_patterns: ["^\\[heartbeat\\]"]
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
  warnUnknownKeys(ctx, sessionsObj, LIST_KEYS, BLOCK);
  return partial as BrainSessionsConfig;
}
