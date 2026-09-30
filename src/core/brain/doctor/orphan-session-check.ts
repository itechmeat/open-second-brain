/**
 * Orphan observations: `session_ref` resolved, at last (t_6cc80627).
 *
 * An observation signal carries `session_ref` - the portable session
 * coordinates the capture writer (`session:<id>#<event>`) and the import
 * writer (`<transcript basename>#<turn>`) stamp - and nothing anywhere
 * resolved it. An observation whose parent session was gone was silently
 * accepted, which for a provenance field is the same as the field not
 * existing. This check is the read-only half of the answer: it parses
 * every signal and resolves the ref against the two halves of the
 * sessions/continuity store. The write half - a repair verb that DETACHES
 * the dangling reference, keeping the observation - is
 * `src/core/brain/link-graph/orphan-repair.ts`, reachable only through
 * the command the `fix` field carries. The doctor never repairs.
 *
 * ## What resolves
 *
 * A ref's identity half (everything before the first `#`, with the
 * writer's `session:` prefix dropped) is resolved against:
 *
 *   - the continuity ledger, whose records carry `session_id` in their
 *     payload - the surface both writers also stamp; and
 *   - the Brain log's `session-lifecycle` events, whose body carries the
 *     session id of a captured host session.
 *
 * An imported transcript ref (`<transcript basename>#<turn>`, the only
 * writer form with a turn half and no `session:` prefix) is NOT judged.
 * Its parent is a transcript file outside the vault, and the import
 * leaves no record it is guaranteed to keep: the resume checkpoint is
 * cleared when the file drains, and the recall, skill-invocation and
 * dedup records are each conditional. A missing record therefore proves
 * nothing about such a ref, and a repair run on that report would strip
 * valid provenance. The capture form (`session:<id>#<event>`) and the
 * extract-signals form (the bare raw-turn session id, whose turns live
 * in the continuity ledger) are judged.
 *
 * `session:unknown` is the capture writer's stand-in for a payload that
 * named no session at all. It is a statement that there was no session,
 * not a pointer to a missing one, so it resolves by vocabulary: detaching
 * it would erase the honesty rather than repair a dangle.
 *
 * ## What may never be judged
 *
 * A resolution surface this check could not read is not an empty one.
 * Reading it as empty would name every observation an orphan, and a
 * repair run on that report would strip provenance off healthy signals -
 * so an incomplete universe emits what it could not read into the
 * `uncertain` stream and raises NO finding. The same holds for the
 * signals subtree itself: an unreadable directory is swept uncertainty
 * (the shared `vault-walk-entry-skipped` code), never silence.
 *
 * Signal files that fail to parse are skipped: the record check already
 * reports them under `signal-invalid`, and saying it twice says nothing
 * new.
 */

import { join } from "node:path";

import { continuityLogDir, listContinuityRecords } from "../continuity/store.ts";
import { CONTINUITY_SESSION_ID_KEY } from "../continuity/types.ts";
import type { BrainLogEntry } from "../log.ts";
import { parseSignal } from "../signal.ts";
import { brainDirs } from "../paths.ts";
import type { DoctorIssue } from "../types.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import type { DoctorUncertainEntry } from "./report.ts";
import { readLogSnapshot, type UnreadableLogDay } from "./records.ts";
import {
  readSweptDir,
  reportSweptFailure,
  reportSweptSkip,
  SWEEP_ORIGIN,
  type SweptPath,
} from "./unreadable-path.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** An observation's `session_ref` resolves to no session or continuity record. */
export const ORPHAN_SESSION_REF_CODE = "orphan-session-ref";

/**
 * The exact repair command, carried on the issue's `fix` field.
 *
 * The verb it names detaches the stale reference and keeps the
 * observation, under the repair-lane discipline (dry-run default, exact
 * confirm phrase, hard per-run write cap). It is a structural CLI
 * string, never prose, and nothing in this module runs it.
 */
export const ORPHAN_SESSION_REPAIR_COMMAND = "o2b brain orphan-repair";

/** Subsystem name the check's sweeps report an unreadable path under. */
export const ORPHAN_SESSION_SITE = "brain.doctor.orphanSession";

/** What the check can no longer claim for a signals subtree it could not list. */
const SIGNALS_CONSEQUENCE =
  "no observation in it had its session_ref resolved, so an orphaned one is missing from this report";

/** The capture writer's stand-in identity for a payload that named no session. */
const NO_SESSION_STAND_IN = "unknown";

/** Filename prefix of a signal file; every walked record carries it. */
const SIGNAL_FILE_PREFIX = "sig-";

/** The two halves of a `session_ref`, split the way both writers spell it. */
export interface ParsedSessionRef {
  /**
   * Everything before the first `#`, with the `session:` prefix the
   * capture writer puts on dropped. Empty only for a ref that never
   * named an identity at all.
   */
  readonly identity: string;
  /** The turn or event half, when the ref carried one. */
  readonly turn: string | null;
}

export function parseSessionRef(ref: string): ParsedSessionRef {
  const hash = ref.indexOf("#");
  const identityRaw = hash === -1 ? ref : ref.slice(0, hash);
  const turn = hash === -1 ? null : ref.slice(hash + 1);
  const identity = (
    identityRaw.startsWith("session:") ? identityRaw.slice("session:".length) : identityRaw
  ).trim();
  return { identity, turn: turn !== null && turn.trim().length > 0 ? turn.trim() : null };
}

/**
 * True for the import writer's `<transcript basename>#<turn>` form: a
 * turn half and no `session:` prefix. See the module docblock for why
 * such a ref is never judged.
 */
export function isImportedTranscriptRef(ref: string): boolean {
  const trimmed = ref.trim();
  return !trimmed.startsWith("session:") && parseSessionRef(trimmed).turn !== null;
}

/**
 * The session-id universe one vault's store holds.
 *
 * `complete` is the load-bearing half: a surface that could not be read
 * makes the set PARTIAL, and a partial universe resolves nothing - every
 * judgement taken from it would be a guess dressed as a finding. What
 * could not be read is named in `uncertain` (the shared swept-path
 * shape) so the caller reports the gap rather than inferring it.
 */
export interface SessionUniverse {
  readonly ids: ReadonlySet<string>;
  readonly complete: boolean;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

/**
 * The pass's pre-parsed log snapshot, as the doctor context carries it:
 * the entries it read and the days it could not.
 */
export interface SessionLogSnapshot {
  readonly entries: ReadonlyArray<BrainLogEntry>;
  readonly unreadableDays: ReadonlyArray<UnreadableLogDay>;
}

/**
 * Read both resolution surfaces.
 *
 * `logSnapshot` - the doctor pass's pre-parsed log snapshot - stands in
 * for a second log walk when the caller has one. Without it the log is
 * read here, under the same sweep sink, so both paths report an
 * unreadable surface the same way and neither reads it as empty. A log
 * day that could not be read makes the universe partial, exactly like an
 * unreadable directory: the session whose lifecycle lived in it would
 * otherwise read as an orphan.
 */
export function collectKnownSessionIds(
  vault: string,
  logSnapshot?: SessionLogSnapshot,
): SessionUniverse {
  const uncertain: DoctorUncertainEntry[] = [];
  const swept: SweptPath = {
    site: ORPHAN_SESSION_SITE,
    consequence:
      "session_ref values could not be resolved against it, so no orphan statement about them is trustworthy",
    uncertain,
  };
  // The stand-in is vocabulary, not a session: see the module docblock.
  const ids = new Set<string>([NO_SESSION_STAND_IN]);
  let complete = true;
  // The listing is probed through the swept reader, NOT through
  // `listShardedFiles`' own `existsSync` gate: that gate answers false
  // for a permission denial exactly as it does for an absent directory,
  // and a denial read as "no continuity records" would name every
  // observation an orphan.
  const before = uncertain.length;
  const continuityEntries = readSweptDir(continuityLogDir(vault), swept, SWEEP_ORIGIN.root);
  if (continuityEntries !== null) {
    try {
      for (const record of listContinuityRecords(vault)) {
        const sid = record.payload[CONTINUITY_SESSION_ID_KEY];
        if (typeof sid === "string" && sid.trim().length > 0) ids.add(sid.trim());
      }
    } catch (err) {
      reportSweptFailure(
        continuityLogDir(vault),
        "continuity ledger read failed",
        err,
        swept,
        SWEEP_ORIGIN.root,
      );
    }
  }
  const log = logSnapshot ?? readLogEntries(vault, swept);
  for (const day of log.unreadableDays) {
    reportSweptSkip(
      join(brainDirs(vault).log, day.date),
      `log day ${day.date} could not be read: ${day.detail}`,
      swept,
    );
  }
  for (const entry of log.entries) {
    if (entry.eventType !== BRAIN_LOG_EVENT_KIND.sessionLifecycle) continue;
    const sid = entry.body["session_id"];
    if (typeof sid === "string" && sid.trim().length > 0) ids.add(sid.trim());
  }
  if (uncertain.length > before) complete = false;
  return { ids, complete, uncertain };
}

function readLogEntries(vault: string, swept: SweptPath): SessionLogSnapshot {
  const snapshot = readLogSnapshot(vault, swept);
  return {
    entries: snapshot.records.flatMap((record) => record.entries),
    unreadableDays: snapshot.unreadableDays,
  };
}

/** One observation whose parent session could not be found. */
export interface OrphanFinding {
  /** Vault-absolute path of the signal file. */
  readonly path: string;
  /** The dangling value, verbatim - the repair's decision quotes it. */
  readonly session_ref: string;
  readonly identity: string;
}

/**
 * Walk the signal store and resolve every `session_ref` against
 * `universe`. Unreadable signal directories report through `swept`;
 * unparseable signal files are skipped (the record check owns them).
 */
export function scanOrphanedSessionRefs(
  vault: string,
  universe: SessionUniverse,
  swept: SweptPath,
): ReadonlyArray<OrphanFinding> {
  const dirs = brainDirs(vault);
  const findings: OrphanFinding[] = [];
  for (const dir of [dirs.inbox, dirs.processed, dirs.archived]) {
    const entries = readSweptDir(dir, swept, SWEEP_ORIGIN.root);
    if (entries === null) continue;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md") || !entry.name.startsWith(SIGNAL_FILE_PREFIX)) continue;
      const path = join(dir, entry.name);
      let sig;
      try {
        sig = parseSignal(path);
      } catch {
        // Parse failures are `signal-invalid`'s findings, not this
        // check's; a file with no readable frontmatter has no ref to
        // resolve either way.
        continue;
      }
      const ref = sig.session_ref;
      if (ref === undefined) continue;
      if (isImportedTranscriptRef(ref)) continue;
      const { identity } = parseSessionRef(ref);
      if (universe.ids.has(identity)) continue;
      findings.push({ path, session_ref: ref, identity });
    }
  }
  return findings;
}

/**
 * The registered check. Fail-soft: a store this module cannot read must
 * cost the pass an uncertainty, never a throw - and never a finding
 * either, for the reason the module docblock gives.
 */
export const orphanSessionCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const swept: SweptPath = {
      site: ORPHAN_SESSION_SITE,
      consequence: SIGNALS_CONSEQUENCE,
      uncertain: out.uncertain,
    };
    const universe = collectKnownSessionIds(ctx.vault, {
      entries: ctx.logs.flatMap((r) => r.entries),
      unreadableDays: ctx.unreadableLogDays ?? [],
    });
    if (!universe.complete) {
      // The id set is partial. Folding the gap into the stream and
      // reporting nothing is the only honest answer: a finding here
      // would be a resolution the check never managed to make.
      for (const entry of universe.uncertain) {
        pushUncertain(out.uncertain, entry, swept.consequence);
      }
      return;
    }
    for (const finding of scanOrphanedSessionRefs(ctx.vault, universe, swept)) {
      out.issues.push({
        severity: "warning",
        code: ORPHAN_SESSION_REF_CODE,
        path: finding.path,
        fix: ORPHAN_SESSION_REPAIR_COMMAND,
        message:
          `session_ref '${finding.session_ref}' resolves to no session or continuity record; ` +
          `the observation is orphaned. Run ${ORPHAN_SESSION_REPAIR_COMMAND} to detach the ` +
          "stale reference - the observation itself is kept",
      } satisfies DoctorIssue);
    }
  },
};
