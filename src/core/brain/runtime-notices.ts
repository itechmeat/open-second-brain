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
 *
 * The command a notice points at is a FIELD, not a sentence (no-dead-ends,
 * task 3). It is resolved strictly through `next-step.ts`, so a condition
 * whose code has no registered exit carries no key at all rather than a
 * plausible command invented to make the shape uniform; four of the six
 * conditions below are in exactly that position and say why at their own
 * site. {@link renderRuntimeNotices} is the single place the command is
 * rendered back into prose, for the two human surfaces (the SessionStart
 * injection and the onboarding checklist) that share it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { resolveSearchConfig } from "../search/index.ts";
import { checkVaultWriteable } from "../doctor.ts";
import { NEXT_COMMAND_KEY, nextCommandField, type NextCommandField } from "./next-step.ts";
import { BRAIN_ROOT_REL } from "./paths.ts";
import { brainConfigUnreadableReport } from "./policy.ts";
import { vaultMarkerAbsentNotice } from "./vault-identity.ts";

export type RuntimeNoticeSeverity = "info" | "warning";

/**
 * One transient condition. The optional next command is spelled with the
 * shared machine-readable key rather than a camel-cased twin because this
 * record IS the wire shape on two surfaces - `o2b onboarding --json`
 * serializes it whole, and `vault_health` projects it field for field - so
 * a second spelling would be a second contract.
 */
export interface RuntimeNotice extends NextCommandField {
  readonly code: string;
  readonly severity: RuntimeNoticeSeverity;
  readonly message: string;
}

/**
 * Build one notice, resolving its next command from the diagnostics
 * registry. Strict resolution: an unregistered code contributes no key,
 * so the absence is visible instead of guessed at.
 */
function notice(code: string, severity: RuntimeNoticeSeverity, message: string): RuntimeNotice {
  return { code, severity, message, ...nextCommandField(code) };
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
  //
  // No registered command: the two exits are an OS permission change on
  // this root and a different `VAULT_DIR`, neither of them an `o2b` verb,
  // and which one is right depends on which vault the operator meant. The
  // message names both branches; the field stays absent rather than
  // picking one.
  try {
    const writeable = checkVaultWriteable(vault);
    if (!writeable.ok) {
      notices.push(
        notice(
          "vault_read_only",
          "warning",
          `Vault is not writable, so memory writes will fail (${writeable.message}). Fix permissions on ${vault} or point VAULT_DIR at a writable vault.`,
        ),
      );
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
  //
  // No registered command, and this one is the reason the field is
  // optional rather than uniform. An absent marker is ambiguous BY
  // CONSTRUCTION: `vault-identity.ts` documents that a cold-start
  // mis-resolution - a typo in `VAULT_DIR` - is indistinguishable from
  // the intended vault, because nothing durable records which vault the
  // process meant. `o2b brain init` is the exit for one reading and
  // materializes the wrong store under the other, so the conditional
  // sentence the guard already writes ("...if it is the intended vault")
  // is the honest form and a structural command would not be.
  try {
    if (existsSync(join(vault, BRAIN_ROOT_REL))) {
      const absent = vaultMarkerAbsentNotice(vault);
      if (absent !== null) {
        notices.push(notice("vault_marker_absent", "warning", `${absent.detail} (${absent.path})`));
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
  //
  // The sentence is `brainConfigUnreadableReport`'s, not this channel's:
  // a delivery surface that degraded because of the same condition
  // carries the same words, so an operator meets one fault and not two.
  //
  // No registered command: the repair is an edit to the YAML the parser
  // just rejected, and no `o2b` verb performs it. The failure detail the
  // report quotes is what the operator acts on; `o2b brain doctor` would
  // only re-report the same line, which is a round-trip, not an exit.
  try {
    const report = brainConfigUnreadableReport(vault);
    if (report !== null) {
      notices.push(notice("brain_config_unreadable", "warning", report));
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
      // The read path self-heals: `openReadOrSelfHeal` catches
      // INDEX_MISSING, builds the index and retries, so recall does not
      // come back empty - it comes back late. The notice said the
      // opposite until no-dead-ends (task 3) corrected it; what the
      // command buys is paying that build now rather than on the first
      // query.
      notices.push(
        notice(
          "search_index_missing",
          "info",
          "Search index is not built yet, so the first recall builds it before returning " +
            "(that call pays the full index build).",
        ),
      );
    } else if (reindexInProgress(dbPath)) {
      // No registered command: the condition clears itself when the
      // running rebuild finishes, and nothing an operator can type makes
      // it clear sooner.
      notices.push(
        notice(
          "reindex_in_progress",
          "info",
          "Search index is rebuilding; recent recall results may lag until it completes.",
        ),
      );
    }

    const semantic = config.semantic;
    const networked = semantic.provider !== "local" && semantic.provider !== "disabled";
    if (semantic.enabled && networked && !semantic.apiKey) {
      notices.push(
        notice(
          "semantic_degraded",
          "warning",
          "Semantic search is enabled but no embedding key resolved, so search has fallen back to lexical.",
        ),
      );
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

/**
 * Label the command is rendered behind on the human surfaces. The
 * spelling is the one the prose used to carry, so a notice whose text did
 * not change renders byte-for-byte what it rendered when the command was
 * part of the sentence - which matters because this block lands in an
 * agent's SessionStart context, not only in a terminal.
 */
const COMMAND_LABEL = "Run:";

/** The ` Run: <command>` tail, or nothing when the code has no exit. */
function commandTail(entry: RuntimeNotice): string {
  const command = entry[NEXT_COMMAND_KEY];
  return command === undefined ? "" : ` ${COMMAND_LABEL} ${command}`;
}

/**
 * Render notices as a compact injectable block; empty string when clean.
 *
 * This is the ONE place a structured command becomes prose again. Both
 * human surfaces - the SessionStart injection and the onboarding
 * checklist - render through here, so the machine-readable field and the
 * sentence a person reads cannot drift apart the way two hand-written
 * copies did.
 */
export function renderRuntimeNotices(notices: ReadonlyArray<RuntimeNotice>): string {
  if (notices.length === 0) return "";
  const lines = notices.map((n) => `- [${n.severity}] ${n.message}${commandTail(n)}`);
  return `Runtime notices:\n${lines.join("\n")}`;
}
