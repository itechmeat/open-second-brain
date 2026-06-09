/**
 * Idempotent edit of the `primary_agent` line in `Brain/_brain.yaml`.
 *
 * The `primary_agent` field declares which runtime owns the `dream`
 * consolidation pass for a vault. This module exists so the CLI verb
 * `o2b brain set-primary` can flip the declaration without rewriting
 * the entire YAML (which would forget user-overridden thresholds in
 * adjacent blocks).
 *
 * Surface:
 *
 *   - {@link setPrimaryAgent} reads the existing config, replaces the
 *     `^primary_agent:` line (or inserts it after `schema_version:`
 *     when absent), and writes back atomically. Returns the previous
 *     and next values plus a `changed` flag so callers can shape an
 *     exit message without a second read.
 *
 *   - The function re-validates the config after the edit by piping it
 *     through {@link validateBrainConfig}. A non-conforming source file
 *     (someone broke the YAML by hand) surfaces as a typed
 *     {@link BrainConfigError} pointing at the offending field, with
 *     the live file untouched.
 *
 * Pure I/O — no logging side effects. The CLI wraps the call in a
 * `log` event when it wants the audit trail.
 */

import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { brainConfigPath } from "./paths.ts";
import { parseBrainYaml } from "./yaml-parse.ts";
import { BrainConfigError, formatPrimaryAgentYamlValue, validateBrainConfig } from "./policy.ts";

/**
 * Result of {@link setPrimaryAgent}. `previous` is the value on disk
 * before the call (parsed and trimmed; `null` when the file lacked the
 * field or carried `null`). `next` is the value the file now carries.
 * `changed` is `true` iff the on-disk bytes were rewritten.
 */
export interface SetPrimaryAgentResult {
  readonly previous: string | null;
  readonly next: string | null;
  readonly changed: boolean;
}

const LINE_RE = /^primary_agent:.*$/m;

/**
 * Set or clear the vault's `primary_agent` declaration.
 *
 * Pass `null` (or omit the second argument by spelling `null`) to
 * clear an existing declaration.
 *
 * Re-validates the YAML after substitution so a malformed source file
 * surfaces as a typed error instead of writing back something that
 * the loader will reject on the next read.
 */
export function setPrimaryAgent(vault: string, name: string | null): SetPrimaryAgentResult {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) {
    throw new BrainConfigError(
      "config file does not exist; run `o2b brain init` first",
      null,
      path,
    );
  }
  const text = readFileSync(path, "utf8");

  // Normalise the target value: trim non-null strings; reject empty
  // strings explicitly so an accidental `--primary-agent ""` from the
  // CLI never silently clears the field (the user must use `--clear`).
  let nextValue: string | null;
  if (name === null) {
    nextValue = null;
  } else {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new BrainConfigError(
        "primary agent name must be non-empty; use --clear to remove the declaration",
        "primary_agent",
        path,
      );
    }
    nextValue = trimmed;
  }

  // Parse to recover the current value (also validates the source).
  // We deliberately load the full config rather than peeking at the
  // line: a malformed neighbouring block should surface here, before
  // the write, rather than masking corruption.
  const parsed = parseBrainYaml(text);
  const currentCfg = validateBrainConfig(parsed, path);
  const previous = currentCfg.primary_agent;

  if (previous === nextValue) {
    return Object.freeze({ previous, next: nextValue, changed: false });
  }

  const replacement = `primary_agent: ${formatPrimaryAgentYamlValue(nextValue, path)}`;

  let updated: string;
  if (LINE_RE.test(text)) {
    updated = text.replace(LINE_RE, replacement);
  } else {
    // Insert after the schema_version line — keeps top-of-file order
    // predictable when a hand-edited config skipped the optional key.
    const sv = /^schema_version:.*$/m;
    updated = sv.test(text)
      ? text.replace(sv, (m) => `${m}\n\n${replacement}`)
      : `${replacement}\n\n${text}`;
  }

  // Verify the rewritten YAML still validates before persisting.
  validateBrainConfig(parseBrainYaml(updated), path);

  atomicWriteFileSync(path, updated);
  return Object.freeze({ previous, next: nextValue, changed: true });
}
