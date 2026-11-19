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
import {
  AUTO_MIGRATION_LOCK_JUDGE,
  AUTO_MIGRATION_MANUAL_COMMAND,
  readAutoMigrationFailure,
  readLostAutoMigrationWorker,
  readAutoMigrationNotice,
  readAutoMigrationRunning,
  readAutoMigrationWaiting,
  printable,
  reportableText,
} from "../store-migration/auto-state.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { refusalReason } from "../store-migration/auto-report.ts";
import type { AutoMigrationFailure } from "../store-migration/auto-state.ts";
import type { GateDecision } from "../store-migration/gate-decision.ts";
import { gatherGate, stoppedGateOf } from "../store-migration/gate-state.ts";

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
  /**
   * Include the one-time notices: the store migration's success notice,
   * which only a session start shows (and then clears, `active-context.ts`).
   */
  readonly oneTime?: boolean;
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

  // The automatic store migration (change auto-store-migration, design
  // D6): at most one short line, about a failure or a waiting state, and
  // the one-time success notice when the caller is a session start. Reads
  // three small device-local files; clears nothing.
  try {
    const line = storeMigrationNotice(vault, opts.oneTime === true, opts.configPath);
    if (line !== null) notices.push(line);
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

/** Longest the quoted failure reason may be, so the line stays short. */
const MIGRATION_REASON_CHARS = 160;

/**
 * The reason as a session may see it: the doctor's sanitising (control
 * characters, home directories) first, then clipped.
 */
function clipped(text: string): string {
  const clean = reportableText(text);
  return clean.length <= MIGRATION_REASON_CHARS
    ? clean
    : `${clean.slice(0, MIGRATION_REASON_CHARS - 3)}...`;
}

/**
 * The store migration's one line, or null. The success notice wins (the
 * attempt that wrote it cleared the other two), then a failure, then the
 * waiting state. No registered command: the failure line names its own
 * manual command, which differs per failure.
 */
function storeMigrationNotice(
  vault: string,
  oneTime: boolean,
  configPath: string | undefined,
): RuntimeNotice | null {
  if (oneTime) {
    const done = readAutoMigrationNotice(vault);
    if (done !== null) {
      const where =
        done.snapshot !== null
          ? `the snapshot taken before the move is ${printable(done.snapshot)}`
          : "its backups are kept in this machine's device-local state";
      return notice(
        "store_migration_done",
        "info",
        `Open Second Brain moved this machine's brain into the brain store; ${where}. To undo ` +
          `it, run ${done.rollbackCommand}.`,
      );
    }
  }
  // A failure or a waiting state of an attempt is moot on a machine that
  // writes to the store only (it switched, by any path): never shown there.
  if (isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) })) return null;
  const failure = readAutoMigrationFailure(vault);
  // The record of an attempt in flight is not a failure while its worker runs.
  const inFlight =
    failure?.attempt === true &&
    readAutoMigrationRunning(vault, new Date(), { judge: AUTO_MIGRATION_LOCK_JUDGE.cheap }) !==
      null;
  if (failure !== null && !inFlight) {
    // What the next start does about it is the gate decision's answer, the
    // one the worker takes (judged cheaply: a session never waits on a
    // subprocess), worded by `failureNoticeTail`.
    const g = gatherGate({
      vault,
      configPath,
      asker: "worker",
      now: new Date(),
      judge: "cheap",
    });
    const message = failureNoticeTail(g.decision, {
      setting: g.state.setting,
      failure,
      stoppedGate: stoppedGateOf(g),
    });
    if (message !== null) return notice("store_migration_failed", "warning", message);
  }
  if (failure === null) {
    // A worker an earlier start spawned that exited before it started:
    // the next start records it; until then it is named here too.
    const lost = readLostAutoMigrationWorker(vault, new Date(), {
      judge: AUTO_MIGRATION_LOCK_JUDGE.cheap,
    });
    if (lost !== null) {
      return notice(
        "store_migration_failed",
        "warning",
        `The automatic store migration did not run: its worker (process ${lost.pid}) exited ` +
          `before it started; o2b doctor names its error output and log. Run ` +
          `${AUTO_MIGRATION_MANUAL_COMMAND} to run it yourself.`,
      );
    }
  }
  const waiting = readAutoMigrationWaiting(vault);
  if (waiting !== null) {
    return notice(
      "store_migration_waiting",
      "info",
      waiting.reason !== null
        ? `The automatic store migration waits: ${clipped(waiting.reason)}.`
        : `The automatic store migration waits for the first migration of ` +
            `${printable(waiting.firstMachines.join(", ")) || "another device"} to arrive by sync.`,
    );
  }
  return null;
}

/**
 * The failure line of the session notices for the gate decision `d`:
 * what the next start does about a recorded failure, from the decision's
 * answer and its reason alone, never inferred from the state (a stopped
 * gate the next start opens says only that, never which steps the run
 * took). Null when the decision leaves nothing to say (nothing to
 * migrate, nothing left to finish). Pure.
 */
export function failureNoticeTail(
  d: GateDecision,
  c: {
    readonly setting: boolean;
    readonly failure: AutoMigrationFailure;
    readonly stoppedGate: "own-run" | "other" | null;
  },
): string | null {
  const failed = `The automatic store migration failed (${clipped(c.failure.error)})`;
  const run = `run ${c.failure.manualCommand}`;
  // The stopped gate is its own sentence: the run that left it may be a
  // later manual run, not the automatic attempt whose failure is named.
  const gate = "A migration run of this vault, automatic or manual, stopped with its gate closed:";
  switch (d.act) {
    case "open":
      if (d.why === "rolled-back") {
        // The operator rolled this machine back, or began to: the gate is
        // opened, and nothing offered migrates it again.
        return (
          `${failed}. A stopped run left this vault's migration gate closed on a machine that ` +
          "was rolled back, or whose rollback began: the next start opens the gate, and no " +
          "start migrates it again on its own."
        );
      }
      return `${failed}. ${gate} the next start opens the gate, or ${run}.`;
    case "migrate":
      if (c.stoppedGate === "own-run") {
        return `${failed}. ${gate} the next start finishes that run, or ${run}.`;
      }
      if (c.stoppedGate === "other") {
        return `${failed}. ${gate} the next start goes on with the migration, or ${run}.`;
      }
      return `${failed}; the next start tries again, or ${run}.`;
    case "refuse": {
      const refusal = refusalReason(d);
      const or = refusal.stay === null ? "" : `, or ${refusal.stay}`;
      return `${failed}; the next start refuses while ${refusal.text}: run ${refusal.command}${or}.`;
    }
    case "finish":
      return `${failed}; the next start finishes the switch, or ${run}.`;
    case "none":
      switch (d.why) {
        case "backoff":
          return `${failed}; it tries again after ${printable(c.failure.retryAfter)}, or ${run}.`;
        case "disabled":
        case "skipped":
          return `${failed}; it is off on this machine, so no start retries it: ${run}.`;
        case "rolled-back":
          return `${failed}; this machine was rolled back, and no start migrates it again on its own: ${run}.`;
        case "run-unreadable":
          return `${failed}; this machine's migration run state cannot be read, so no start retries it until it can: ${run}.`;
        case "switch-unproven":
          return `${failed}; this machine switched, but its migration run state does not say the switch finished, so no start finishes it: ${run}.`;
        case "waiting":
          return `${failed}; it waits for a store to arrive by sync, or ${run}.`;
        case "running":
        case "other-vault-running":
          return `${failed}; a migration runs now, and the next start leaves it alone.`;
        case "not-available":
        case "nothing-left":
          return null;
      }
      return null;
    default:
      return null;
  }
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
