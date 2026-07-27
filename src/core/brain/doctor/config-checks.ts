/**
 * Operator-declared configuration that cannot do what it says.
 *
 * `_brain.yaml` itself, the `vault.ignore_paths` block, and the capture
 * boundary's message patterns are all things the operator wrote down and
 * the runtime then has to honour. When one of them is unreadable, names a
 * schema this build does not know, points at nothing, or fails to
 * compile, the declaration and the behaviour have silently diverged -
 * which is the single condition this module reports.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveVaultScope } from "../../vault-scope/index.ts";
import { buildCaptureBoundary } from "../capture-boundary.ts";
import { brainConfigPath } from "../paths.ts";
import {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  loadBrainConfigDetailed,
} from "../policy.ts";
import type { DoctorCheck } from "./check.ts";

export const configCheck: DoctorCheck = {
  failSoft: false,
  run({ vault }, { issues }) {
    const cfgPath = brainConfigPath(vault);
    if (!existsSync(cfgPath)) {
      issues.push({
        severity: "error",
        code: "config-missing",
        path: cfgPath,
        message: "_brain.yaml is missing; run `o2b brain init` to bootstrap the Brain layer",
      });
      return;
    }
    try {
      const { config, warnings } = loadBrainConfigDetailed(vault);
      if (!BRAIN_CONFIG_SUPPORTED_VERSIONS.includes(config.schema_version)) {
        issues.push({
          severity: "error",
          code: "schema-version-unknown",
          path: cfgPath,
          message:
            `_brain.yaml schema_version ${config.schema_version} is not in the supported set ` +
            `(${BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", ")})`,
        });
      }
      for (const w of warnings) {
        issues.push({
          severity: "warning",
          code: "config-warning",
          path: cfgPath,
          message: w.message,
        });
      }
    } catch (err) {
      if (err instanceof BrainConfigError) {
        issues.push({
          severity: "error",
          code: "config-invalid",
          path: cfgPath,
          message: err.message,
        });
      } else {
        issues.push({
          severity: "error",
          code: "config-invalid",
          path: cfgPath,
          message: `_brain.yaml could not be loaded: ${(err as Error).message ?? String(err)}`,
        });
      }
    }
  },
};

/**
 * v0.10.9 hygiene lint: surface path-style entries in
 * `vault.ignore_paths` that do not resolve to anything on disk. Such
 * entries are typically typos — they look like exclusions but cannot
 * fire. Bare-name rules are skipped (a missing `.git` directory is
 * not an error).
 *
 * Only runs when the operator declared the block themselves; the
 * built-in default set may legitimately list paths that do not exist
 * in a given vault.
 */
export const vaultIgnoreCheck: DoctorCheck = {
  failSoft: false,
  run({ vault }, { issues }) {
    let scope;
    try {
      scope = resolveVaultScope(vault);
    } catch {
      // `configCheck` already reports the malformed/unreadable _brain.yaml.
      // Do not let this follow-on lint mask the primary config issue.
      return;
    }
    if (scope.source !== "_brain.yaml") return;
    for (const rule of scope.rules) {
      if (rule.kind !== "path") continue;
      if (existsSync(join(vault, rule.raw))) continue;
      issues.push({
        severity: "warning",
        code: "vault-ignore-missing-path",
        message: `vault.ignore_paths entry '${rule.raw}' does not exist in this vault`,
      });
    }
  },
};

/**
 * Memory Integrity Suite: capture-boundary patterns that failed to
 * compile (invalid regex in sessions.ignore_message_patterns or the
 * machine-local additions). Capture itself degrades gracefully; the
 * doctor makes the skipped pattern visible.
 */
export const capturePatternCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues }) {
    for (const warning of buildCaptureBoundary(vault).warnings) {
      issues.push({
        severity: "warning",
        code: "invalid-capture-pattern",
        message: warning,
      });
    }
  },
};
