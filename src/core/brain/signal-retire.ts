/**
 * Fact signal retire lifecycle (A5 / t_66c12a67).
 *
 * `retireSignal` moves an extracted fact signal out of `Brain/inbox/` and
 * into `Brain/retired/`, rewriting its frontmatter with the retire
 * metadata. It mirrors two existing conventions:
 *
 *   - `preference.ts` `moveToRetired` - the retire frontmatter shape
 *     (`_status: "retired"`, `retired_at`, `retired_reason`, optional
 *     `superseded_by`, `retired_by`, old-id alias) and the write-then-
 *     unlink move with a dir-containment precondition.
 *   - `pending.ts` `rejectPending` - the signal-specific shape: the file
 *     KEEPS `kind: brain-signal` (a retired signal is still a signal,
 *     readable via `parseSignal`) and the `brain/signal` tag is swapped
 *     for `brain/retired`.
 *
 * Because the dream pass consumes `Brain/inbox/` only, the directory move
 * IS the exclusion mechanism - a retired signal stops being dream intake
 * yet stays readable in `Brain/retired/`.
 *
 * Signals have no per-signal audit file (only preferences do, via
 * `appendPrefAudit`), so the retire is recorded as a dedicated
 * `signal-retire` brain log event instead.
 *
 * Retiring a missing, already-retired, or non-signal id is a typed error,
 * never a silent no-op.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { appendLogEvent } from "./log.ts";
import { brainDirs, ensureInsideVault } from "./paths.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import type { FrontmatterMap } from "../types.ts";

/** A signal basename shape: `sig-<YYYY-MM-DD>-<slug>` (no path separators). */
const SIGNAL_ID_RE = /^sig-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Retired-preference id prefix; a `ret-*` id is already a retired artifact. */
const RETIRED_ID_PREFIX = "ret-";

/** Typed error for a signal id that could never be an inbox signal. */
export class InvalidSignalIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`invalid signal id ${JSON.stringify(id)} - expected sig-<date>-<slug>`);
    this.name = "InvalidSignalIdError";
    this.id = id;
  }
}

/** Typed error for a signal id absent from `Brain/inbox/` (never a no-op). */
export class SignalNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`signal not found in inbox: ${JSON.stringify(id)}`);
    this.name = "SignalNotFoundError";
    this.id = id;
  }
}

/** Typed error for a signal that is already retired (never a no-op). */
export class SignalAlreadyRetiredError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`signal already retired: ${JSON.stringify(id)}`);
    this.name = "SignalAlreadyRetiredError";
    this.id = id;
  }
}

export interface RetireSignalOptions {
  /** Free-form retirement reason (required). */
  readonly reason: string;
  /** Optional pointer to the signal / preference that supersedes this one. */
  readonly superseded_by?: string;
  /** Agent identity stamped as `retired_by` and onto the audit event. */
  readonly agent?: string;
  /** Injected clock for a deterministic `retired_at`. Defaults to now. */
  readonly now?: Date;
}

export interface RetireSignalResult {
  readonly id: string;
  readonly path: string;
}

/**
 * Retire an extracted fact signal by id. Moves `Brain/inbox/<id>.md` into
 * `Brain/retired/<id>.md` with retire frontmatter and appends a
 * `signal-retire` audit event. Throws a typed error when the id is not a
 * signal shape, is already retired, or is absent from the inbox.
 */
export function retireSignal(
  vault: string,
  id: string,
  opts: RetireSignalOptions,
): RetireSignalResult {
  const trimmed = id.trim();

  // A `ret-*` id is already a retired artifact - retiring it is a no-op we
  // refuse loudly.
  if (trimmed.startsWith(RETIRED_ID_PREFIX)) {
    throw new SignalAlreadyRetiredError(trimmed);
  }
  // Anything that is not a signal basename cannot be an inbox signal. The
  // regex also closes path traversal (no separators survive it), which is
  // the containment precondition before any filesystem path is formed.
  if (!SIGNAL_ID_RE.test(trimmed)) {
    throw new InvalidSignalIdError(trimmed);
  }

  const dirs = brainDirs(vault);
  const srcPath = ensureInsideVault(join(dirs.inbox, `${trimmed}.md`), vault);
  const destPath = ensureInsideVault(join(dirs.retired, `${trimmed}.md`), vault);

  if (!existsSync(srcPath)) {
    // Already moved into retired/ -> already retired; otherwise genuinely
    // missing. Both are typed errors, never a silent no-op.
    if (existsSync(destPath)) {
      throw new SignalAlreadyRetiredError(trimmed);
    }
    throw new SignalNotFoundError(trimmed);
  }

  const [meta, body] = parseFrontmatter(srcPath);
  if (meta["kind"] !== "brain-signal") {
    throw new InvalidSignalIdError(trimmed);
  }
  // Defensive: an inbox file already carrying retire metadata is retired.
  if (meta["_status"] === "retired") {
    throw new SignalAlreadyRetiredError(trimmed);
  }

  const now = opts.now ?? new Date();
  const nextMeta = rewriteToRetired(meta, trimmed, opts, now);

  // Write-then-unlink: the retired copy must land before the inbox copy is
  // removed, so a failed write leaves the source untouched. Exclusive
  // create (overwrite: false) never clobbers an existing retired file.
  writeFrontmatterAtomic(destPath, nextMeta, body, {
    overwrite: false,
    existsErrorKind: "retired",
    vaultForRelativePath: vault,
  });
  if (!existsSync(destPath)) {
    throw new Error(`retireSignal: write of ${destPath} reported success but file is absent`);
  }
  unlinkSync(srcPath);

  // Audit: signals have no per-signal audit file, so the retire lands as a
  // dedicated brain log event. Fail-soft - a log failure must not undo the
  // completed move.
  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.signalRetire,
      ...(opts.agent ? { agent: opts.agent } : {}),
      body: {
        signal: `[[${trimmed}]]`,
        reason: opts.reason,
        ...(opts.superseded_by?.trim() ? { superseded_by: opts.superseded_by.trim() } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
    });
  } catch (err) {
    process.stderr.write(`warning: append signal-retire log failed: ${(err as Error).message}\n`);
  }

  return { id: trimmed, path: destPath };
}

/**
 * Build the retired frontmatter from a signal's original frontmatter,
 * mirroring `rejectPending` (kind unchanged, `brain/signal` tag swapped)
 * and `moveToRetired` (retire metadata + old-id alias). Every inherited
 * signal field is preserved so the retired file stays a readable signal
 * and a faithful audit snapshot.
 */
function rewriteToRetired(
  meta: FrontmatterMap,
  id: string,
  opts: RetireSignalOptions,
  now: Date,
): FrontmatterMap {
  const nextMeta: FrontmatterMap = {};
  for (const [k, v] of Object.entries(meta)) {
    // Retire fields are stamped below; drop any pre-existing copies.
    if (
      k === "_status" ||
      k === "retired_at" ||
      k === "retired_reason" ||
      k === "retired_by" ||
      k === "superseded_by"
    ) {
      continue;
    }
    if (k === "tags") {
      const arr = Array.isArray(v) ? [...v] : [];
      nextMeta["tags"] = arr.map((t) => (t === "brain/signal" ? "brain/retired" : t));
      continue;
    }
    if (k === "aliases") {
      // Preserved and extended below.
      continue;
    }
    nextMeta[k] = v as never;
  }

  nextMeta["_status"] = "retired";
  nextMeta["retired_at"] = now.toISOString();
  nextMeta["retired_reason"] = opts.reason;
  if (opts.agent?.trim()) {
    nextMeta["retired_by"] = opts.agent.trim();
  }
  if (opts.superseded_by?.trim()) {
    nextMeta["superseded_by"] = opts.superseded_by.trim();
  }

  // Old-id alias so any `[[sig-...]]` wikilink keeps resolving after the
  // move, mirroring moveToRetired. The basename is unchanged (per
  // rejectPending), so this is belt-and-suspenders but keeps the retire
  // conventions uniform across preferences and signals.
  const existingAliases = Array.isArray(meta["aliases"])
    ? (meta["aliases"] as ReadonlyArray<string>)
    : [];
  if (!existingAliases.includes(id)) {
    nextMeta["aliases"] = [id, ...existingAliases];
  } else {
    nextMeta["aliases"] = [...existingAliases];
  }

  return nextMeta;
}
