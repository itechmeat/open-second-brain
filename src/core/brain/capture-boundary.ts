/**
 * Capture-boundary matcher (Memory Integrity Suite, t_0532ed5a).
 *
 * The single decision point for what runtime output may become Brain
 * evidence. Both ingestion seams consult it BEFORE any extraction:
 * `session-lifecycle.ts` (live hooks) and `sessions/import.ts`
 * (batch import). The pipeline order is fixed - classify/suppress
 * first, extract second - so suppressed or ignored input can never
 * produce signals, facts, or log entries.
 *
 * Session patterns are anchored globs (`*` any run, `?` one char,
 * everything else literal) matched against the session id and, when
 * known, the transcript path. Message patterns are regexes; an
 * invalid one degrades to a warning and is skipped - a typo in
 * `_brain.yaml` must never take capture down. Everything fails soft
 * to "capture" because losing real evidence is worse than admitting
 * noise the doctor can surface later.
 */

import { defaultConfigPath, discoverConfig } from "../config.ts";
import { BRAIN_SESSIONS_DEFAULTS, loadBrainConfigDetailed, resolveSessions } from "./policy.ts";
import type { ResolvedBrainSessionsConfig } from "./types.ts";

export type SessionCaptureDecision = "capture" | "ignore" | "stateless";

export interface CaptureBoundary {
  /**
   * Decide what a session may do: `ignore` produces nothing,
   * `stateless` reads but never writes, `capture` is full capture.
   * Ignore outranks stateless when both match.
   */
  sessionDecision(sessionId: string | undefined, transcriptPath?: string): SessionCaptureDecision;
  /** True when the message text must not reach extraction or storage. */
  suppressMessage(text: string): boolean;
  /** Invalid patterns skipped at compile time (doctor surfaces these). */
  readonly warnings: ReadonlyArray<string>;
  /** The resolved pattern lists, for diagnostics surfaces. */
  readonly policy: ResolvedBrainSessionsConfig;
}

/** Translate one anchored glob (`*`, `?`) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

function matchesAny(regexps: ReadonlyArray<RegExp>, id?: string, path?: string): boolean {
  return regexps.some(
    (re) => (id !== undefined && re.test(id)) || (path !== undefined && re.test(path)),
  );
}

export function compileCaptureBoundary(policy: ResolvedBrainSessionsConfig): CaptureBoundary {
  const warnings: string[] = [];
  const ignore = policy.ignore_patterns.map(globToRegExp);
  const stateless = policy.stateless_patterns.map(globToRegExp);
  const suppress: RegExp[] = [];
  for (const pattern of policy.ignore_message_patterns) {
    try {
      suppress.push(new RegExp(pattern));
    } catch (err) {
      warnings.push(
        `invalid sessions.ignore_message_patterns regex ${JSON.stringify(pattern)}: ` +
          `${(err as Error).message} - pattern skipped`,
      );
    }
  }

  return Object.freeze({
    sessionDecision(sessionId: string | undefined, transcriptPath?: string) {
      if (matchesAny(ignore, sessionId, transcriptPath)) return "ignore" as const;
      if (matchesAny(stateless, sessionId, transcriptPath)) return "stateless" as const;
      return "capture" as const;
    },
    suppressMessage(text: string) {
      return suppress.some((re) => re.test(text));
    },
    warnings: Object.freeze(warnings),
    policy,
  });
}

export interface BuildCaptureBoundaryOptions {
  /** Device-local config override for tests; defaults to the standard chain. */
  readonly localConfigPath?: string;
}

/** Comma-separated machine-local additions from the device config. */
function localAdditions(localConfigPath: string | undefined, key: string): string[] {
  try {
    const data = discoverConfig(localConfigPath ?? defaultConfigPath()).data;
    const raw = data[key];
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Resolve the effective boundary for a vault: the vault-portable
 * `sessions:` policy unioned with machine-local additions
 * (`sessions_ignore_patterns` / `sessions_stateless_patterns` /
 * `sessions_ignore_message_patterns`, comma-separated, in the
 * device config). Local config can ADD patterns, never remove
 * vault policy. Any load failure resolves to capture-everything.
 */
export function buildCaptureBoundary(
  vault: string,
  opts: BuildCaptureBoundaryOptions = {},
): CaptureBoundary {
  let vaultPolicy: ResolvedBrainSessionsConfig;
  try {
    vaultPolicy = resolveSessions(loadBrainConfigDetailed(vault).config);
  } catch {
    vaultPolicy = BRAIN_SESSIONS_DEFAULTS;
  }
  const merged: ResolvedBrainSessionsConfig = Object.freeze({
    ignore_patterns: Object.freeze([
      ...vaultPolicy.ignore_patterns,
      ...localAdditions(opts.localConfigPath, "sessions_ignore_patterns"),
    ]),
    stateless_patterns: Object.freeze([
      ...vaultPolicy.stateless_patterns,
      ...localAdditions(opts.localConfigPath, "sessions_stateless_patterns"),
    ]),
    ignore_message_patterns: Object.freeze([
      ...vaultPolicy.ignore_message_patterns,
      ...localAdditions(opts.localConfigPath, "sessions_ignore_message_patterns"),
    ]),
  });
  return compileCaptureBoundary(merged);
}
