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
import { storePreferenceMeta } from "./preference.ts";
import { routePreferencePage } from "./preference-page-write.ts";
import { preferencesStoreOnly, storePreferenceEntry } from "./preference-store.ts";
import { PREFERENCE_OPAQUE_FIELDS, SIGNAL_OPAQUE_FIELDS } from "../store/operation-privacy.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { isPrivateFrontmatter } from "../store/private-page.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import { preferencePageRel, signalPageRel } from "../store/read/memory-ids.ts";
import { routeSignalState, storeSignal } from "./signal-state.ts";
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
 * The codes the three refusals below are reported under on the MCP wire:
 * each class's own name, which `brain_expire` has always sent as
 * `error.data.code`. One definition, so the class names and the boundary
 * registry cannot drift apart.
 */
export const EXPIRATION_REFUSAL_CODE = Object.freeze({
  invalidTarget: "InvalidExpirationTargetError",
  targetNotFound: "ExpirationTargetNotFoundError",
  invalidValue: "ExpirationValueError",
} as const);

/** Membership list over {@link EXPIRATION_REFUSAL_CODE}. */
export const EXPIRATION_REFUSAL_CODES = Object.freeze(Object.values(EXPIRATION_REFUSAL_CODE));

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
    this.name = EXPIRATION_REFUSAL_CODE.invalidTarget;
    this.id = id;
  }
}

/** The id is well-formed and no file carries it. Never a silent no-op. */
export class ExpirationTargetNotFoundError extends Error {
  readonly id: string;
  readonly searched: ReadonlyArray<string>;
  constructor(id: string, searched: ReadonlyArray<string>) {
    super(`no signal or preference with id ${JSON.stringify(id)}; searched ${searched.join(", ")}`);
    this.name = EXPIRATION_REFUSAL_CODE.targetNotFound;
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
    this.name = EXPIRATION_REFUSAL_CODE.invalidValue;
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
  /**
   * The vault-relative paths the caller may read. A candidate file it may
   * not read is passed over as if it were not there, so a record withheld
   * from the caller is refused with the unknown-id error and nothing is
   * written to it. Absent, every candidate counts.
   */
  readonly readable?: (rel: string) => boolean;
}

/** Agent recorded when the caller names none. */
const DEFAULT_AGENT = "set_expiration";

/**
 * Sentinel for a stored value the validator cannot parse. It is equal to
 * nothing, so the rewrite that repairs a corrupted date always happens -
 * a `null` there would collide with the clear-what-is-already-clear case
 * and leave the junk on disk.
 */
const UNPARSEABLE_EXPIRATION = Symbol("unparseable-expiration");

/**
 * The stored value in the form the new one is compared against.
 *
 * Both sides have to come through {@link normalizeExpirationDate} for
 * "already says exactly this" to be a statement about the LIFETIME rather
 * than about the spelling: `2026-07-15` and `2026-07-15T00:00:00Z` are
 * one date, and re-setting one over the other used to rewrite the file
 * and append an audit event describing no change at all.
 */
function comparableExpiration(previous: string | null): string | null | symbol {
  if (previous === null) return null;
  try {
    return normalizeExpirationDate(previous);
  } catch {
    return UNPARSEABLE_EXPIRATION;
  }
}

/** Where an id of each shape can live, in search order. */
function candidatePaths(vault: string, id: string): { kind: ExpirationTargetKind; dirs: string[] } {
  const dirs = brainDirsForWrite(vault);
  if (SIGNAL_ID_RE.test(id)) {
    // A signal outlives the inbox: the dream pass moves consumed signals
    // to `inbox/processed/`, archives unconsumed ones that left the
    // contradiction window to `inbox/archived/`, and `retireSignal` moves
    // retired ones to `Brain/retired/`. All four are still readable
    // memories, so all four can carry a lifetime.
    return {
      kind: EXPIRATION_TARGET_KIND.signal,
      dirs: [dirs.inbox, dirs.processed, dirs.archived, dirs.retired],
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

/** The artifact an expiration change addresses, wherever it lives. */
interface ExpirationTarget {
  /** Vault-relative path, `/`-separated (nominal once switched). */
  readonly relPath: string;
  readonly abs: string;
  readonly previous: string | null;
  /** The page's frontmatter on an unswitched machine; `null` once switched. */
  readonly frontmatter: Record<string, unknown> | null;
}

function previousOf(meta: Readonly<Record<string, unknown>>): string | null {
  const raw = meta[EXPIRATION_DATE_FIELD];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** The first candidate page that exists, in search order. */
function pageTarget(
  vault: string,
  id: string,
  dirs: ReadonlyArray<string>,
  opts: SetExpirationOptions,
): ExpirationTarget {
  const searched: string[] = [];
  for (const dir of dirs) {
    const candidate = ensureInsideVault(join(dir, `${id}.md`), vault);
    const rel = candidate
      .slice(vault.length + 1)
      .split("\\")
      .join("/");
    searched.push(rel);
    if (existsSync(candidate) && (opts.readable === undefined || opts.readable(rel))) {
      const [meta] = parseFrontmatter(candidate);
      return { relPath: rel, abs: candidate, previous: previousOf(meta), frontmatter: meta };
    }
  }
  throw new ExpirationTargetNotFoundError(id, searched);
}

/**
 * The signal or preference the store's folds hold under `id`. A signal
 * in any state but rejected, and a preference active or retired, can
 * carry a lifetime, as their pages could.
 */
function storeTarget(
  vault: string,
  kind: ExpirationTargetKind,
  id: string,
  opts: SetExpirationOptions,
): ExpirationTarget {
  if (kind === EXPIRATION_TARGET_KIND.signal) {
    const found = storeSignal(id);
    // The page the signal's state places it at, never an empty path.
    const rel = found === undefined ? null : signalPageRel(id, found.state);
    if (
      found === undefined ||
      rel === null ||
      found.state === "rejected" ||
      !readableRel(rel, opts)
    ) {
      throw new ExpirationTargetNotFoundError(id, [rel ?? id]);
    }
    return {
      relPath: rel,
      abs: join(vault, ...rel.split("/")),
      previous: previousOf(found.frontmatter),
      frontmatter: null,
    };
  }
  const slug = preferenceSlugOf(id);
  const page = storePreferenceMeta(slug);
  const rel = preferencePageRel(slug, page?.retired === true);
  if (page === null || page.retired !== id.startsWith("ret-") || !readableRel(rel, opts)) {
    throw new ExpirationTargetNotFoundError(id, [rel]);
  }
  return {
    relPath: rel,
    abs: join(vault, ...rel.split("/")),
    previous: previousOf(page.meta),
    frontmatter: null,
  };
}

/** The slug of a preference id, active (`pref-`) or retired (`ret-`). */
function preferenceSlugOf(id: string): string {
  return id.replace(/^(pref|ret)-/, "");
}

function readableRel(rel: string, opts: SetExpirationOptions): boolean {
  return opts.readable === undefined || opts.readable(rel);
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

  // Store-only (task 2.10): the artifact is found in the store's folds and
  // the change is one record; no page is rewritten.
  const storeOnly = preferencesStoreOnly(vault);
  const target = storeOnly
    ? storeTarget(vault, kind, trimmed, opts)
    : pageTarget(vault, trimmed, dirs, opts);
  const { relPath, previous, frontmatter } = target;
  if (comparableExpiration(previous) === normalized) {
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

  const legacy = (): void => {
    const [meta, body] = parseFrontmatter(target.abs);
    const nextMeta: FrontmatterMap = { ...meta };
    if (normalized === null) delete nextMeta[EXPIRATION_DATE_FIELD];
    else nextMeta[EXPIRATION_DATE_FIELD] = normalized;
    writeFrontmatterAtomic(target.abs, nextMeta, body, { overwrite: true });
  };
  const fields = { [EXPIRATION_DATE_FIELD]: normalized };
  const slug = preferenceSlugOf(trimmed);
  // One verdict for the whole operation (the state record and its log
  // event): the target is private when the fold holds it private once
  // switched, or when its page is private or names a private page before
  // the switch. The one-field patch alone would judge nothing private.
  const targetPrivate = (): boolean => {
    if (storeOnly) {
      return kind === EXPIRATION_TARGET_KIND.signal
        ? (storeSignal(trimmed)?.private ?? true)
        : (storePreferenceEntry(slug)?.private ?? true);
    }
    if (frontmatter === null) return true;
    const opaque =
      kind === EXPIRATION_TARGET_KIND.signal ? SIGNAL_OPAQUE_FIELDS : PREFERENCE_OPAQUE_FIELDS;
    return isPrivateFrontmatter(frontmatter) || rowNamesPrivatePage(vault, frontmatter, opaque);
  };
  const logChange = (): void => {
    appendLogEvent(vault, {
      timestamp: isoSecond(opts.now ?? new Date()),
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
  };
  withOperationPrivacy(targetPrivate, () => {
    if (kind === EXPIRATION_TARGET_KIND.signal) {
      routeSignalState({
        vault,
        id: trimmed,
        fields,
        ...(opts.agent?.trim() ? { agent: opts.agent.trim() } : {}),
        ...(frontmatter !== null ? { legacyFrontmatter: frontmatter } : {}),
        legacy,
      });
    } else {
      routePreferencePage({
        vault,
        slug,
        frontmatter: { [EXPIRATION_DATE_FIELD]: normalized ?? null } as FrontmatterMap,
        legacy,
      });
    }
    logChange();
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
