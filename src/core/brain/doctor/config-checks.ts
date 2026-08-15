/**
 * Operator-declared configuration that cannot do what it says.
 *
 * `_brain.yaml` itself, the `vault:` scope block, and the capture
 * boundary's message patterns are all things the operator wrote down and
 * the runtime then has to honour. When one of them is unreadable, names a
 * schema this build does not know, points at nothing, or fails to
 * compile, the declaration and the behaviour have silently diverged -
 * which is the single condition this module reports.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveVaultScope, walkVaultScope } from "../../vault-scope/index.ts";
import { buildCaptureBoundary } from "../capture-boundary.ts";
import { brainConfigPath } from "../paths.ts";
import {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  loadBrainConfigDetailed,
} from "../policy.ts";
import type { DoctorCheck } from "./check.ts";
import { sweptFailureReason } from "./unreadable-path.ts";
import type { DoctorIssue } from "../types.ts";

export const configCheck: DoctorCheck = {
  failSoft: false,
  run({ vault }, { issues }) {
    const cfgPath = brainConfigPath(vault);
    // Not `existsSync`: it answers false for a permission denial on the
    // file or on any parent component exactly as it does for a config
    // nobody has written, and this branch advises `o2b brain init` -
    // which on a populated store the doctor merely could not read is
    // advice to bootstrap over it. A read failure is the same finding
    // the catch arm below reports for a file that opens and does not
    // parse: the declaration could not be honoured, for a stated reason.
    const absence = configAbsence(cfgPath);
    if (absence !== null) {
      issues.push(absence);
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
 * The finding for a `_brain.yaml` that could not be opened at all, or
 * `null` when it is there to be loaded. Absence keeps its own code and
 * its own message, byte for byte; every other failure reports the same
 * `config-invalid` the load path already reports, naming the errno.
 */
function configAbsence(cfgPath: string): DoctorIssue | null {
  try {
    statSync(cfgPath);
    return null;
  } catch (err) {
    const reason = sweptFailureReason(err);
    if (reason === null) {
      return {
        severity: "error",
        code: "config-missing",
        path: cfgPath,
        message: "_brain.yaml is missing; run `o2b brain init` to bootstrap the Brain layer",
      };
    }
    return {
      severity: "error",
      code: "config-invalid",
      path: cfgPath,
      message: `_brain.yaml could not be read: ${reason}`,
    };
  }
}

/**
 * v0.10.9 hygiene lint, extended in v1.46.0: surface declared entries
 * under `vault:` that do not resolve to anything on disk. Such entries
 * are typically typos — they look like a boundary and cannot fire.
 *
 * The two polarities get different severities because their
 * consequences are not comparable. A dead EXCLUSION costs nothing: the
 * path it names is not there to exclude, so the vault behaves exactly
 * as the operator intended, and bare-name rules are skipped entirely
 * (a missing `.git` directory is not a finding). A dead INCLUDE ROOT
 * means the allowlist admits nothing under it — with one root declared
 * and misspelt, the index is empty and every recall returns nothing for
 * a reason no other check would name.
 *
 * The include side therefore checks BOTH kinds against the vault root.
 * A bare name still matches at any depth when the matcher runs, so the
 * finding says what was verified — that the root is not there — rather
 * than claiming the rule can never fire.
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
    // Each polarity is linted only when the OPERATOR declared it. A vault
    // that writes `include_paths` alone still resolves with the built-in
    // exclusions in force, and warning about one of those would name a key
    // the operator's config does not contain.
    if (scope.declared.ignore) {
      for (const rule of scope.rules.ignore) {
        if (rule.kind !== "path") continue;
        if (existsSync(join(vault, rule.raw))) continue;
        issues.push({
          severity: "warning",
          code: "vault-ignore-missing-path",
          message: `vault.ignore_paths entry '${rule.raw}' does not exist in this vault`,
        });
      }
    }
    if (!scope.declared.include) return;

    // A path-kind include root is anchored at the vault root, so its absence
    // there is decidable and worth naming on its own. A name-kind root is
    // NOT: the grammar matches a bare name at any depth, so `existsSync` at
    // the root answers a question the rule never asked and reported a
    // working allowlist as broken. Those are covered by the aggregate below
    // instead, which asks the question the check actually exists for.
    for (const rule of scope.rules.include ?? []) {
      if (rule.kind !== "path") continue;
      if (existsSync(join(vault, rule.raw))) continue;
      issues.push({
        severity: "error",
        code: "vault-include-missing-path",
        message:
          `vault.include_paths entry '${rule.raw}' names a path that does not exist in this vault; ` +
          "an include root that matches nothing narrows the index for no reason",
      });
    }

    // The aggregate: an allowlist that admits no file at all. This is the
    // failure the per-entry check was reaching for and could not see, and it
    // catches every shape of it - a typo in a bare name, a root that climbs
    // out of the vault, a set of roots that happen to hold no notes - by
    // measuring the walk rather than inferring from the rules. It is an
    // error because an empty index is not a degraded search, it is no
    // search: nothing is recalled, and nothing says why.
    if (walkVaultScope(vault, scope).includedFiles === 0) {
      issues.push({
        severity: "error",
        code: "vault-include-admits-nothing",
        message:
          `vault.include_paths (${scope.includePaths?.join(", ") ?? ""}) admits no file in this ` +
          "vault, so the index would be empty; check the roots against the vault layout",
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
