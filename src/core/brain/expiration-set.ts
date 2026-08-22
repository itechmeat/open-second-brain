/**
 * Post-creation expiration mutation for signals and preferences
 * (unit 3c / t_5e338af1).
 *
 * `expiration.ts` has had a validator, a read filter and a writer
 * parameter on both artifact kinds since C5, and nothing has ever been
 * able to CHANGE the field once written. The gap is the whole of this
 * module: an operator who set "until 2026-07-15" and then extended the
 * migration had no way to say so, and one who set nothing had no way to
 * add a lifetime to a rule that turned out to be temporary.
 *
 * ## Why the mutation lives here and not on the note surfaces
 *
 * `brain_update_note` and `note_lifecycle` both run every path through
 * `resolveNoteTarget`, which refuses the `Brain/` machinery root for
 * every note path it is given. That refusal is load-bearing - it is what
 * keeps a note-editing surface from rewriting a preference - so reaching
 * signals and preferences from there would mean carving an exception
 * into the one guard that makes those surfaces safe. This module
 * addresses the artifacts by ID instead, exactly as `retireSignal` does,
 * and never accepts a path at all.
 *
 * ## One chokepoint
 *
 * Every value written here goes through
 * {@link normalizeExpirationDate}, which is also the only door
 * `writeSignal` and `writePreference` use. That matters more than it
 * looks: the READ side deliberately fails open on an unparseable date so
 * a corrupted value surfaces rather than silently hiding a memory, and
 * that tolerance is only safe while every write is validated. A second
 * writer skipping the validator would turn a documented fail-open into a
 * memory that never expires and nobody notices.
 *
 * Clearing is explicit, and it REMOVES the key rather than writing an
 * empty one. An empty `expiration_date` parses to nothing, fails open on
 * read, and reads on disk as a lifetime somebody meant to set.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { EXPIRATION_DATE_FIELD, normalizeExpirationDate } from "./expiration.ts";
import { appendLogEvent } from "./log.ts";
import { brainDirsForWrite, ensureInsideVault } from "./paths.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * The value that CLEARS an expiration.
 *
 * A word rather than an empty string, and that is the point: `--expires
 * ""` is what a shell produces when a variable did not expand, so
 * accepting it would let a broken script silently un-expire a memory.
 * Clearing has to be something a caller can only type on purpose.
 */
export const EXPIRATION_CLEAR = "none";

/** The artifact kinds this surface can address. */
export const EXPIRATION_TARGET_KIND = Object.freeze({
  signal: "signal",
  preference: "preference",
} as const);

/** Closed union over {@link EXPIRATION_TARGET_KIND}. */
export type ExpirationTargetKind =
  (typeof EXPIRATION_TARGET_KIND)[keyof typeof EXPIRATION_TARGET_KIND];

/**
 * An id shape that could never name an artifact, so no filesystem path is
 * formed from it. The regexes also close path traversal: no separator
 * survives either of them.
 */
const SIGNAL_ID_RE = /^sig-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREFERENCE_ID_RE = /^(?:pref|ret)-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The caller named something this surface cannot address. */
export class InvalidExpirationTargetError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `invalid expiration target ${JSON.stringify(id)} - expected sig-<date>-<slug>, ` +
        "pref-<slug> or ret-<slug>",
    );
    this.name = "InvalidExpirationTargetError";
    this.id = id;
  }
}

/** The id is well-formed and no file carries it. Never a silent no-op. */
export class ExpirationTargetNotFoundError extends Error {
  readonly id: string;
  readonly searched: ReadonlyArray<string>;
  constructor(id: string, searched: ReadonlyArray<string>) {
    super(`no signal or preference with id ${JSON.stringify(id)}; searched ${searched.join(", ")}`);
    this.name = "ExpirationTargetNotFoundError";
    this.id = id;
    this.searched = Object.freeze([...searched]);
  }
}

/**
 * The value is not a date this project can compare against a clock.
 *
 * A typed wrapper around {@link normalizeExpirationDate}'s message rather
 * than a second validator: the surfaces branch on the class, and the
 * sentence a caller reads is still the chokepoint's own.
 */
export class ExpirationValueError extends Error {
  readonly value: string;
  constructor(value: string, reason: string) {
    super(reason);
    this.name = "ExpirationValueError";
    this.value = value;
  }
}

export interface SetExpirationResult {
  readonly id: string;
  readonly kind: ExpirationTargetKind;
  /** Vault-relative path of the artifact that was rewritten. */
  readonly path: string;
  /** The normalised value now on the artifact; `null` once cleared. */
  readonly expiration: string | null;
  /** What the artifact carried before this call; `null` when it carried none. */
  readonly previous: string | null;
  /** False when the artifact already said exactly this - no bytes were written. */
  readonly changed: boolean;
}

export interface SetExpirationOptions {
  /** Agent stamped on the audit event; defaults to the surface's own name. */
  readonly agent?: string;
  /** Injected clock, so a run stays reproducible. */
  readonly now?: Date;
}

/** Agent recorded when the caller names none. */
const DEFAULT_AGENT = "set_expiration";

/** Where an id of each shape can live, in search order. */
function candidatePaths(vault: string, id: string): { kind: ExpirationTargetKind; dirs: string[] } {
  const dirs = brainDirsForWrite(vault);
  if (SIGNAL_ID_RE.test(id)) {
    // A signal outlives the inbox: the dream pass moves consumed signals
    // to `inbox/processed/` and `retireSignal` moves retired ones to
    // `Brain/retired/`. All three are still readable memories, so all
    // three can carry a lifetime.
    return {
      kind: EXPIRATION_TARGET_KIND.signal,
      dirs: [dirs.inbox, dirs.processed, dirs.retired],
    };
  }
  if (PREFERENCE_ID_RE.test(id)) {
    return {
      kind: EXPIRATION_TARGET_KIND.preference,
      dirs: [dirs.preferences, dirs.retired],
    };
  }
  throw new InvalidExpirationTargetError(id);
}

/**
 * Set, change, or clear the `expiration_date` of one signal or
 * preference, addressed by id.
 *
 * `expires` is a date-only `YYYY-MM-DD`, a full ISO-8601 timestamp, or
 * {@link EXPIRATION_CLEAR}. Every other value is refused before any file
 * is opened.
 */
export function setExpiration(
  vault: string,
  id: string,
  expires: string,
  opts: SetExpirationOptions = {},
): SetExpirationResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const trimmed = id.trim();
  const { kind, dirs } = candidatePaths(vault, trimmed);

  // Validate BEFORE the walk, so a junk date cannot depend on whether the
  // artifact happened to exist for whether it is reported as junk.
  const clearing = expires.trim() === EXPIRATION_CLEAR;
  let normalized: string | null = null;
  if (!clearing) {
    try {
      normalized = normalizeExpirationDate(expires);
    } catch (err) {
      throw new ExpirationValueError(expires, (err as Error).message);
    }
  }

  const searched: string[] = [];
  let abs: string | null = null;
  for (const dir of dirs) {
    const candidate = ensureInsideVault(join(dir, `${trimmed}.md`), vault);
    searched.push(
      candidate
        .slice(vault.length + 1)
        .split("\\")
        .join("/"),
    );
    if (existsSync(candidate)) {
      abs = candidate;
      break;
    }
  }
  if (abs === null) throw new ExpirationTargetNotFoundError(trimmed, searched);
  const relPath = abs
    .slice(vault.length + 1)
    .split("\\")
    .join("/");

  const [meta, body] = parseFrontmatter(abs);
  const priorRaw = meta[EXPIRATION_DATE_FIELD];
  const previous = typeof priorRaw === "string" && priorRaw.length > 0 ? priorRaw : null;
  if (previous === normalized) {
    // Byte-identical no-op, including the clear-what-is-already-clear
    // case. Reporting `changed: false` rather than rewriting keeps a
    // re-run out of the audit log and off the disk.
    return Object.freeze({
      id: trimmed,
      kind,
      path: relPath,
      expiration: normalized,
      previous,
      changed: false,
    });
  }

  const nextMeta: FrontmatterMap = { ...meta };
  if (normalized === null) delete nextMeta[EXPIRATION_DATE_FIELD];
  else nextMeta[EXPIRATION_DATE_FIELD] = normalized;
  writeFrontmatterAtomic(abs, nextMeta, body, { overwrite: true });

  const at = isoSecond(opts.now ?? new Date());
  appendLogEvent(vault, {
    timestamp: at,
    eventType: BRAIN_LOG_EVENT_KIND.expirationSet,
    body: {
      target: `[[${trimmed}]]`,
      kind,
      // Both sides of the change, because "cleared" and "set to X" are
      // different events and the log is where an operator reconstructs
      // which one happened.
      expiration: normalized ?? EXPIRATION_CLEAR,
      previous: previous ?? EXPIRATION_CLEAR,
      agent: opts.agent?.trim() ? opts.agent.trim() : DEFAULT_AGENT,
    },
  });

  return Object.freeze({
    id: trimmed,
    kind,
    path: relPath,
    expiration: normalized,
    previous,
    changed: true,
  });
}
