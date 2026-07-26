/**
 * Runtime-state notice channel.
 *
 * Open Second Brain's health signals are otherwise pull-only (brain_doctor,
 * brain_health, vault_health): the agent must poll to learn that semantic
 * search fell back to lexical, that the index is not built or is rebuilding,
 * or that the vault is read-only. This collector computes those transient
 * conditions deterministically - no network, no LLM, no DB open - so they can
 * ride the existing SessionStart injection surface (and vault_health) as a
 * proactive push, letting the agent adjust behaviour without a diagnostic
 * round-trip.
 *
 * Notices only exist while a real condition holds, so a healthy vault yields
 * none and the injected context stays byte-identical. Scope is OSB's own
 * subsystems (embeddings/index availability, read-only mode); it is not a
 * third-party plugin notice bus and does not classify quota errors.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { resolveSearchConfig } from "../search/index.ts";
import { checkVaultWriteable } from "../doctor.ts";
import { BRAIN_ROOT_REL } from "./paths.ts";
import { brainConfigReadFailure } from "./policy.ts";
import { vaultMarkerAbsentNotice } from "./vault-identity.ts";

export type RuntimeNoticeSeverity = "info" | "warning";

export interface RuntimeNotice {
  readonly code: string;
  readonly severity: RuntimeNoticeSeverity;
  readonly message: string;
}

export interface RuntimeNoticeOptions {
  readonly configPath?: string;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Collect the current runtime-state notices for `vault`. Never throws: any
 * probe failure is swallowed so the channel can be called from the fail-soft
 * inject path. Returns an empty list when everything is nominal or when the
 * channel is opted out via `OPEN_SECOND_BRAIN_RUNTIME_NOTICES`.
 */
export function collectRuntimeNotices(
  vault: string,
  opts: RuntimeNoticeOptions = {},
): RuntimeNotice[] {
  const env = opts.env ?? process.env;
  const optOut = env["OPEN_SECOND_BRAIN_RUNTIME_NOTICES"]?.trim().toLowerCase();
  if (optOut === "false" || optOut === "0") return [];

  const notices: RuntimeNotice[] = [];

  // Vault writability: a read-only vault means every memory write will fail.
  try {
    const writeable = checkVaultWriteable(vault);
    if (!writeable.ok) {
      notices.push({
        code: "vault_read_only",
        severity: "warning",
        message: `Vault is not writable, so memory writes will fail (${writeable.message}). Fix permissions on ${vault} or point VAULT_DIR at a writable vault.`,
      });
    }
  } catch {
    // best-effort
  }

  // Vault identity: a Brain tree with no identity marker cannot tell an
  // old vault from a mis-resolved root, and the write guard can only warn
  // about it (context-integrity-gates, Unit J). Gated on the tree already
  // existing, because a root nothing has written to yet is not a wrong
  // store - it is a vault waiting for `o2b brain init`, and nagging before
  // that command runs would make the notice noise instead of signal.
  try {
    if (existsSync(join(vault, BRAIN_ROOT_REL))) {
      const absent = vaultMarkerAbsentNotice(vault);
      if (absent !== null) {
        notices.push({
          code: "vault_marker_absent",
          severity: "warning",
          message: `${absent.detail} (${absent.path})`,
        });
      }
    }
  } catch {
    // best-effort
  }

  // An unreadable `_brain.yaml`: every `load*ConfigSafe` reader falls
  // back, and for the integrity gates that fallback is now the STRICT
  // one rather than the defaults. Either way the operator's settings are
  // not the ones in force, so the condition has to be visible instead of
  // inferable from a gate that suddenly refuses.
  try {
    const failure = brainConfigReadFailure(vault);
    if (failure !== null) {
      notices.push({
        code: "brain_config_unreadable",
        severity: "warning",
        message: `Brain/_brain.yaml could not be read, so configured settings are not in force and the integrity gates fall back to their strictest mode (${failure}). Fix the file, then re-run.`,
      });
    }
  } catch {
    // best-effort
  }

  // Search index availability + semantic degradation.
  try {
    const config = resolveSearchConfig({ vault, configPath: opts.configPath });
    const dbPath = config.dbPath;
    const indexExists = existsSync(dbPath);

    if (!indexExists) {
      notices.push({
        code: "search_index_missing",
        severity: "info",
        message: "Search index is not built yet, so recall returns nothing. Run: o2b search index",
      });
    } else if (reindexInProgress(dbPath)) {
      notices.push({
        code: "reindex_in_progress",
        severity: "info",
        message: "Search index is rebuilding; recent recall results may lag until it completes.",
      });
    }

    const semantic = config.semantic;
    const networked = semantic.provider !== "local" && semantic.provider !== "disabled";
    if (semantic.enabled && networked && !semantic.apiKey) {
      notices.push({
        code: "semantic_degraded",
        severity: "warning",
        message:
          "Semantic search is enabled but no embedding key resolved, so search has fallen back to lexical. Run: o2b search check",
      });
    }
  } catch {
    // best-effort
  }

  return notices;
}

/**
 * A live reindex holds a heartbeated writer lock on the index path (see
 * search/store.ts). Detecting a non-stale lock is the "reindex in progress"
 * signal. Best-effort: any probe error means "not detectable", not a notice.
 */
function reindexInProgress(dbPath: string): boolean {
  try {
    return lockfile.checkSync(dbPath, { realpath: false });
  } catch {
    return false;
  }
}

/** Render notices as a compact injectable block; empty string when clean. */
export function renderRuntimeNotices(notices: ReadonlyArray<RuntimeNotice>): string {
  if (notices.length === 0) return "";
  const lines = notices.map((n) => `- [${n.severity}] ${n.message}`);
  return `Runtime notices:\n${lines.join("\n")}`;
}
