/**
 * The multi-lane pending queue (write-side trust, Task 9).
 *
 * One store, three review lanes. The A3 signals queue keeps its flat
 * `Brain/pending/sig-*.md` directory byte-compatibly; note creates stage
 * into `Brain/pending/notes/` and the ingest summary page into
 * `Brain/pending/ingest/`. Every lane shares the same rules:
 *
 *   - The staged document is BYTE-FOR-BYTE what the publish target would
 *     have received - staging is purely a change of directory, so apply
 *     moves the bytes verbatim (exclusive create, then unlink - the A3
 *     order, with {@link PendingApplyConflictError} on an occupied
 *     target and the exclusive create as the real race gate).
 *   - The pending id is self-describing. `sig-` ids keep the A3 grammar;
 *     a `note-` id carries the REVERSIBLE percent-encoding of the publish
 *     target, minus its final `.md` only where that suffix is exactly
 *     lowercase and nothing shorter would be ambiguous - any other
 *     spelling rides whole, so apply publishes into the caller's exact
 *     target (`Notes/Foo.MD` stays `Notes/Foo.MD`, the file createNote
 *     would have written); an `ing-` id carries the deterministic publish
 *     basename (the ingest publish path is a pure function of the source
 *     identity, so the basename suffices).
 *   - {@link listPendingLane} sorts deterministically and PARTITIONS
 *     unreadable entries: a corrupt or mis-named file is named with a
 *     reason instead of breaking the listing or vanishing.
 *   - Reject renders into `Brain/retired/` with the retire-shaped
 *     frontmatter, stamping `osb_pending_lane` at reject time only -
 *     reject transforms, publish never does.
 *
 * Dispositions resolve at {@link resolveWriteDisposition}: with no
 * permissions document the `write_approval.*` lane keys decide (on =
 * stage, off = publish); with one, the document is the only gate - its
 * rules decide through the permissions substrate, a deny refuses as a
 * typed {@link WriteRefusedError}, an ask stages, and every stage or
 * refuse lands exactly one decision-ledger row naming the rule.
 *
 * This module is the queue's engine; `../pending.ts` remains the
 * historical import surface and delegates here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  FileAlreadyExistsError,
} from "../../fs-atomic.ts";
import { discoverConfig, resolveAgentName } from "../../config.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import { requireNextStep } from "../next-step.ts";
import type { PermissionAction } from "../permissions/document.ts";
import { loadPermissionsDocument } from "../permissions/document.ts";
import { appendDecisionLedger } from "../permissions/ledger.ts";
import type { PermissionDecision, PermissionSubject } from "../permissions/resolve.ts";
import { resolvePermission } from "../permissions/resolve.ts";
import type { BrainDirs } from "../paths.ts";
import { BRAIN_INBOX_REL, BRAIN_SOURCES_REL, brainDirs, brainDirsForWrite } from "../paths.ts";
import { parseSignal } from "../signal.ts";
import type { BrainSignal } from "../types.ts";
import {
  WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  WRITE_APPROVAL_ENABLED_ENV_KEY,
  WRITE_APPROVAL_INGEST_CONFIG_KEY,
  WRITE_APPROVAL_INGEST_ENV_KEY,
  WRITE_APPROVAL_NOTES_CONFIG_KEY,
  WRITE_APPROVAL_NOTES_ENV_KEY,
  REVIEW_LANE,
  type ReviewLane,
  resolveWriteApprovalLane,
} from "../write-gate.ts";

// ----- Typed errors ---------------------------------------------------------

/**
 * The advisory-registry code a STAGED receipt names (see
 * `../diagnostics.ts`); it resolves to the queue command that publishes
 * the staged write. One spelling here so the CLI and MCP renderers
 * cannot drift.
 */
export const PENDING_STAGED_DIAGNOSTIC_CODE = "pending-staged";

/**
 * The closed vocabulary of write-side trust refusals (Task 12). Both are
 * registered in `../diagnostics.ts`, so every surface that carries one
 * resolves the same next command; the census pins the trio.
 */
export const WRITE_REFUSAL_CODES = Object.freeze({
  /** A permissions document rule denied the write itself. */
  documentDeny: "write-refused",
  /** `force_confirmed` requires an allow verdict; the document said ask or deny. */
  forceConfirmedRequiresAllow: "force-confirmed-requires-allow",
} as const);

/** Closed union over {@link WRITE_REFUSAL_CODES}. */
export type WriteRefusalCode = (typeof WRITE_REFUSAL_CODES)[keyof typeof WRITE_REFUSAL_CODES];

/** Membership list, in the order the checks are made. */
export const WRITE_REFUSAL_CODE_LIST: ReadonlyArray<WriteRefusalCode> = Object.freeze([
  WRITE_REFUSAL_CODES.documentDeny,
  WRITE_REFUSAL_CODES.forceConfirmedRequiresAllow,
]);

/** Narrow a refusal token read back off a wire or out of an error payload. */
export function isWriteRefusalCode(value: unknown): value is WriteRefusalCode {
  return (
    typeof value === "string" && (WRITE_REFUSAL_CODE_LIST as ReadonlyArray<string>).includes(value)
  );
}

/** The registered exit a document-deny refusal names. Resolved once, at import. */
const WRITE_REFUSED_EXIT = requireNextStep(WRITE_REFUSAL_CODES.documentDeny).nextCommand;

/** The fields a document-deny refusal carries beside its message. */
export interface WriteRefusedFields {
  readonly agent: string;
  readonly via: PermissionSubject["via"];
  readonly action: PermissionAction;
  /** The deciding rule: `entry:<id>` | `agent:<name>` | `role:<name>` | `default`. */
  readonly rule: string;
  readonly target: string;
}

/**
 * A permissions document rule DENIED one write (write-side trust,
 * Task 12). Names the principal, the action, the rule that decided and
 * the registered exit, so a refused agent can tell its operator exactly
 * what to review instead of guessing at a policy it cannot read.
 */
export class WriteRefusedError extends Error {
  /** Always {@link WRITE_REFUSAL_CODES.documentDeny}. */
  readonly code: WriteRefusalCode;
  readonly agent: string;
  readonly via: PermissionSubject["via"];
  readonly action: PermissionAction;
  readonly rule: string;
  readonly target: string;
  /** The registered exit: the operator command that inspects the policy. */
  readonly nextCommand: string;

  constructor(fields: WriteRefusedFields) {
    super(
      `write refused (${WRITE_REFUSAL_CODES.documentDeny}): agent ` +
        `${JSON.stringify(fields.agent)} (via ${fields.via}) may not ${fields.action} ` +
        `${JSON.stringify(fields.target)} - rule ${fields.rule} denied it. ` +
        `The operator can review the policy: ${WRITE_REFUSED_EXIT}`,
    );
    this.name = "WriteRefusedError";
    this.code = WRITE_REFUSAL_CODES.documentDeny;
    this.agent = fields.agent;
    this.via = fields.via;
    this.action = fields.action;
    this.rule = fields.rule;
    this.target = fields.target;
    this.nextCommand = WRITE_REFUSED_EXIT;
  }
}

/** Typed error for a missing / already-processed pending id (never a no-op). */
export class PendingSignalNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`pending signal not found: ${JSON.stringify(id)}`);
    this.name = "PendingSignalNotFoundError";
    this.id = id;
  }
}

/** Typed error for an id whose shape could not be a pending entry name. */
export class InvalidPendingIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`invalid pending id ${JSON.stringify(id)} - expected ${PENDING_LANE_ID_SOURCE}`);
    this.name = "InvalidPendingIdError";
    this.id = id;
  }
}

/**
 * The publish target this id would move into is already occupied.
 *
 * The exclusive create in {@link applyPendingLane} has always refused
 * this as a raw filesystem error on the signals lane; it is a named
 * error because the dry run has to refuse it too - a preview that
 * reported a move the apply would then reject would be a preview that
 * lied. The exclusive create stays as the actual race gate.
 */
export class PendingApplyConflictError extends Error {
  readonly id: string;
  readonly path: string;
  constructor(id: string, path: string) {
    super(`publish target already occupied for ${JSON.stringify(id)}: ${path}`);
    this.name = "PendingApplyConflictError";
    this.id = id;
    this.path = path;
  }
}

/**
 * A publish target (or its encoding) cannot be staged or applied: the
 * encoded name would exceed the filesystem's 255-character filename
 * bound, the encoding is malformed, or the decoded path escapes the
 * vault. Named rather than truncated - a target that cannot stage
 * refuses the write by name rather than colliding with a sibling.
 */
export class PendingTargetPathError extends Error {
  readonly target: string;
  constructor(message: string, target: string) {
    super(message);
    this.name = "PendingTargetPathError";
    this.target = target;
  }
}

// ----- Pending ids ----------------------------------------------------------

/**
 * One grammar for every lane's pending id. The `sig-` shape is
 * byte-compatible with the A3 queue (its previous grammar allowed
 * exactly `[A-Za-z0-9._-]`, all of which remain legal here); the
 * `note-` suffix adds `%` because it carries the percent-encoded publish
 * target, and the `ing-` suffix carries the publish basename.
 */
export const PENDING_LANE_ID_RE = /^(sig|note|ing)-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._%-]*$/;

/** Human-readable restatement of the grammar, for refusals. */
const PENDING_LANE_ID_SOURCE = "sig-|note-|ing-<YYYY-MM-DD>-<name>";

/** The lane a pending id belongs to, from its prefix. */
function laneOfId(id: string): ReviewLane {
  if (id.startsWith("sig-")) return REVIEW_LANE.signals;
  if (id.startsWith("note-")) return REVIEW_LANE.notes;
  return REVIEW_LANE.ingest;
}

// ----- Target path encoding -------------------------------------------------

/**
 * Longest publish-target suffix one pending filename can carry. The
 * classic filesystem bound is 255 bytes per filename component; the
 * longest composed name is `note-<YYYY-MM-DD>-<encoded>.md`, whose fixed
 * part is 19 bytes (`note-` + the 10-byte date + the separating dash +
 * `.md`), so the arithmetic allows 236. This bound sits conservatively
 * below that; the composed-name check in {@link stageForReview} is the
 * exact 255-byte gate.
 */
const MAX_ENCODED_SUFFIX_BYTES = 231;

/** The filename bound every composed pending name must fit, in bytes. */
export const PENDING_FILENAME_MAX_BYTES = 255;

/**
 * Encode a vault-relative publish target into the reversible,
 * Windows-legal suffix of a `note-` pending id.
 *
 * Unreserved characters (`A-Za-z0-9._-`) pass through; EVERY other byte
 * of the UTF-8 encoding - separators, spaces, CJK, the escape character
 * itself - becomes an uppercase `%XX` triplet. The output therefore
 * matches the pending-id grammar exactly, carries no character Windows
 * forbids in a filename, and decodes to exactly the input. An encoded
 * result past {@link MAX_ENCODED_SUFFIX_BYTES} refuses by name: a
 * target that cannot stage refuses the write rather than truncating
 * into a collision.
 */
export function encodePendingTargetPath(relPath: string): string {
  const bytes = new TextEncoder().encode(relPath);
  let out = "";
  for (const byte of bytes) {
    const chr = String.fromCharCode(byte);
    if (/[A-Za-z0-9._-]/.test(chr)) {
      out += chr;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  if (Buffer.byteLength(out, "utf8") > MAX_ENCODED_SUFFIX_BYTES) {
    throw new PendingTargetPathError(
      `publish target ${JSON.stringify(relPath)} encodes to ${Buffer.byteLength(out, "utf8")} ` +
        `bytes, past the ${MAX_ENCODED_SUFFIX_BYTES}-byte suffix bound (the 255-byte ` +
        "filesystem filename bound minus the id prefix); shorten the target path - " +
        "it is refused, not truncated",
      relPath,
    );
  }
  return out;
}

/**
 * The strict inverse of {@link encodePendingTargetPath}: decode a
 * percent-encoded suffix back into the publish target. A malformed
 * escape is a named error, never a silent passthrough - a hand-edited
 * queue must not apply into a path nobody meant.
 */
export function decodePendingTargetPath(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const chr = encoded[i]!;
    if (chr !== "%") {
      bytes.push(encoded.charCodeAt(i));
      continue;
    }
    const hex = encoded.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new PendingTargetPathError(
        `pending target encoding ${JSON.stringify(encoded)} has a malformed percent escape at ` +
          `offset ${i}; the queue entry is corrupt and must be rejected or removed by hand`,
        encoded,
      );
    }
    bytes.push(parseInt(hex, 16));
    i += 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new PendingTargetPathError(
      `pending target encoding ${JSON.stringify(encoded)} is not valid UTF-8; ` +
        "the queue entry is corrupt and must be rejected or removed by hand",
      encoded,
    );
  }
}

// ----- Lane registry --------------------------------------------------------

/** Absolute directory a lane stages into, under resolved Brain dirs. */
function pendingLaneDirIn(dirs: BrainDirs, lane: ReviewLane): string {
  if (lane === REVIEW_LANE.notes) return join(dirs.pending, REVIEW_LANE.notes);
  if (lane === REVIEW_LANE.ingest) return join(dirs.pending, REVIEW_LANE.ingest);
  return dirs.pending;
}

/** Absolute directory a lane stages into. Signals stay flat in `Brain/pending/`. */
export function pendingLaneDir(vault: string, lane: ReviewLane): string {
  return pendingLaneDirIn(brainDirs(vault), lane);
}

/**
 * The vault-relative publish target one pending id applies into. The
 * suffix starts after `<prefix><YYYY-MM-DD>-`, so the split is
 * width-based, not dash-search-based: encoded targets carry dashes of
 * their own.
 */
function publishTargetForId(vault: string, id: string): string {
  const lane = laneOfId(id);
  const prefix =
    lane === REVIEW_LANE.signals ? "sig-" : lane === REVIEW_LANE.notes ? "note-" : "ing-";
  const suffix = id.slice(prefix.length + "YYYY-MM-DD-".length);
  if (lane === REVIEW_LANE.signals) return `${BRAIN_INBOX_REL}/${id}.md`;
  if (lane === REVIEW_LANE.notes) {
    const decoded = decodePendingTargetPath(suffix);
    // Suffixes staged before the extension could ride the encoding - and
    // suffixes of exactly-lowercase targets today - carry the publish
    // target WITHOUT its `.md`; a decode that still ends in one, whatever
    // its case, is the caller's own spelling and publishes verbatim.
    return MARKDOWN_SUFFIX_RE.test(decoded) ? decoded : `${decoded}.md`;
  }
  return `${BRAIN_SOURCES_REL}/${suffix}.md`;
}

// ----- Dispositions ---------------------------------------------------------

/**
 * Who is writing. Since Task 12 this IS the permissions substrate's
 * subject type, re-exported under the queue's historical name - the
 * structural twin this module used to declare is gone, so there is one
 * subject shape and one resolver that reads it.
 */
export type { PermissionSubject };

/** How one write should proceed, with the rule that decided it. */
export interface WriteDisposition {
  readonly verdict: "publish" | "stage" | "refuse";
  /** The config key, env twin, or document rule that decided. */
  readonly source: string;
  /** Why, when the disposition is not the plain publish path. */
  readonly reason?: string;
  /** The pending id a stage would use, when deterministic. */
  readonly pendingId?: string;
}

/** Optional context a caller hands the disposition resolver. */
export interface ResolveWriteDispositionOptions {
  /**
   * Vault-relative path the write would publish at, when known. Target
   * entries in the permissions document match on it exactly, and the
   * decision-ledger row records it.
   */
  readonly target?: string;
  /** Injected clock for the ledger row's `ts`. Defaults to now. */
  readonly now?: Date;
}

/**
 * The config key or env twin that decided a lane's toggle, for the
 * disposition's `source`. Resolution is the gate's own (lane key, then
 * master, then off), re-read here so the source names the SAME link in
 * the chain the verdict came from.
 */
function decidingSource(lane: ReviewLane): string {
  const laneEnv =
    lane === REVIEW_LANE.notes
      ? WRITE_APPROVAL_NOTES_ENV_KEY
      : lane === REVIEW_LANE.ingest
        ? WRITE_APPROVAL_INGEST_ENV_KEY
        : undefined;
  const laneKey =
    lane === REVIEW_LANE.notes
      ? WRITE_APPROVAL_NOTES_CONFIG_KEY
      : lane === REVIEW_LANE.ingest
        ? WRITE_APPROVAL_INGEST_CONFIG_KEY
        : undefined;
  if (laneEnv !== undefined && process.env[laneEnv] !== undefined && process.env[laneEnv] !== "") {
    return laneEnv;
  }
  if (laneKey !== undefined) {
    const raw = discoverConfig().data[laneKey];
    if (typeof raw === "string" && raw.trim() !== "") return laneKey;
  }
  const masterEnv = process.env[WRITE_APPROVAL_ENABLED_ENV_KEY];
  if (masterEnv !== undefined && masterEnv !== "") return WRITE_APPROVAL_ENABLED_ENV_KEY;
  return WRITE_APPROVAL_ENABLED_CONFIG_KEY;
}

/** The document action a review lane's writes answer under. */
function documentActionFor(lane: ReviewLane): PermissionAction {
  return lane === REVIEW_LANE.ingest ? "ingest" : "write";
}

/**
 * Append the ONE decision-ledger row a stage or refuse disposition owes
 * (write-side trust, Task 12). Never throws: the append contract is the
 * substrate's, and a row that cannot be written comes back as an audit
 * reason rather than blocking the verdict it records.
 */
function recordDispositionRow(
  vault: string,
  subject: PermissionSubject,
  action: PermissionAction,
  opts: ResolveWriteDispositionOptions,
  decision: PermissionDecision,
): void {
  appendDecisionLedger(vault, {
    ts: (opts.now ?? new Date()).toISOString(),
    actor: subject.agent,
    via: subject.via,
    action,
    target: opts.target ?? "",
    verdict: decision.verdict,
    source: decision.source,
    reason: decision.reason,
  });
}

/**
 * Resolve the write disposition for one lane.
 *
 * ABSENT document (write-side trust, Task 9): the `write_approval.*`
 * lane keys decide - on = stage, off = publish. No ledger row is written.
 *
 * PRESENT document (Task 12): the document is the ONLY gate - the lane
 * keys cannot bypass it in either direction. Exactly one substrate rule
 * decides (target entry > agent override > role > default, deny > ask >
 * allow at equal specificity): `deny` records one ledger row and throws
 * {@link WriteRefusedError} naming the principal, action, rule and next
 * command; `ask` records one row and stages; `allow` publishes, with a
 * row only when the document's `ledger.record_allows` asks for it. An
 * unreadable document fails closed through the loader's own error.
 */
export function resolveWriteDisposition(
  vault: string,
  lane: ReviewLane,
  subject?: PermissionSubject,
  opts: ResolveWriteDispositionOptions = {},
): WriteDisposition {
  const { document } = loadPermissionsDocument(vault);
  if (document === null) {
    const on = resolveWriteApprovalLane(lane);
    return Object.freeze({
      verdict: on ? "stage" : "publish",
      source: decidingSource(lane),
    });
  }
  const effectiveSubject: PermissionSubject = subject ?? {
    agent: resolveAgentName(),
    via: "config",
  };
  const action = documentActionFor(lane);
  const decision = resolvePermission(document, effectiveSubject, action, opts.target);
  if (decision.verdict === "deny") {
    recordDispositionRow(vault, effectiveSubject, action, opts, decision);
    throw new WriteRefusedError({
      agent: effectiveSubject.agent,
      via: effectiveSubject.via,
      action,
      rule: decision.source,
      target: opts.target ?? "",
    });
  }
  if (decision.verdict === "ask") {
    recordDispositionRow(vault, effectiveSubject, action, opts, decision);
    return Object.freeze({
      verdict: "stage",
      source: decision.source,
      reason: decision.reason,
    });
  }
  if (document.ledger?.record_allows === true) {
    recordDispositionRow(vault, effectiveSubject, action, opts, decision);
  }
  return Object.freeze({
    verdict: "publish",
    source: decision.source,
    reason: decision.reason,
  });
}

// ----- Staging --------------------------------------------------------------

export interface StageForReviewResult {
  readonly pendingId: string;
  readonly path: string;
}

/**
 * Stage one write for review: write `render()`'s bytes VERBATIM into the
 * lane's pending directory under the vault-identity write guard, named
 * by the lane's deterministic pending id. Re-staging the same target
 * replaces the staged bytes - the pending document always holds the
 * latest proposed bytes, and apply publishes exactly what is on disk.
 */
export function stageForReview(
  vault: string,
  lane: ReviewLane,
  publishTarget: string,
  render: () => string,
): StageForReviewResult {
  if (lane === REVIEW_LANE.signals) {
    throw new PendingTargetPathError(
      "the signals lane stages through the writeSignal allocator " +
        "(stagePendingSignal); its pending ids carry collision suffixes a " +
        "deterministic id cannot express",
      publishTarget,
    );
  }
  // Write intent: the vault-identity assertion runs here, in the queue,
  // so a staged write is guarded exactly like a published one.
  const laneDir = pendingLaneDirIn(brainDirsForWrite(vault), lane);
  const suffix =
    lane === REVIEW_LANE.notes
      ? encodePendingTargetPath(stripMarkdownSuffix(publishTarget))
      : basename(publishTarget).replace(/\.md$/i, "");
  const date = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const prefix = lane === REVIEW_LANE.notes ? "note-" : "ing-";
  const pendingId = `${prefix}${date}-${suffix}`;
  if (!PENDING_LANE_ID_RE.test(pendingId)) {
    throw new PendingTargetPathError(
      `publish target ${JSON.stringify(publishTarget)} produces the pending id ` +
        `${JSON.stringify(pendingId)}, which the queue grammar ` +
        `(${PENDING_LANE_ID_SOURCE}) cannot carry; refusing rather than writing a name ` +
        "the queue could not list or apply",
      publishTarget,
    );
  }
  const stagedPath = ensureInsideVault(join(laneDir, `${pendingId}.md`), vault);
  const composed = `${pendingId}.md`;
  if (Buffer.byteLength(composed, "utf8") > PENDING_FILENAME_MAX_BYTES) {
    throw new PendingTargetPathError(
      `pending filename ${JSON.stringify(composed)} is ${Buffer.byteLength(composed, "utf8")} ` +
        `bytes, past the ${PENDING_FILENAME_MAX_BYTES}-byte filesystem bound`,
      publishTarget,
    );
  }
  mkdirSync(laneDir, { recursive: true });
  atomicWriteFileSync(stagedPath, render(), { skipIfUnchanged: false });
  return { pendingId, path: stagedPath };
}

/** A trailing `.md` in any casing - the extension a note target ends in. */
const MARKDOWN_SUFFIX_RE = /\.md$/i;

/**
 * Strip the publish target's trailing `.md` before it encodes into a
 * `note-` pending id - but only where the strip is REVERSIBLE at publish
 * time: exactly-lowercase, and only when the remainder cannot itself be
 * read as ending in a `.md` (any casing), which would be ambiguous with a
 * target carried whole. Every other spelling stays in the id verbatim,
 * so `Notes/Foo.MD` applies into `Notes/Foo.MD` - the file createNote
 * would have written - instead of folding into a different `Notes/Foo.md`
 * on a case-sensitive vault.
 */
function stripMarkdownSuffix(target: string): string {
  if (!target.endsWith(".md")) return target;
  const stripped = target.slice(0, -".md".length);
  return MARKDOWN_SUFFIX_RE.test(stripped) ? target : stripped;
}

// ----- Listing --------------------------------------------------------------

/** One staged entry, or one named unreadable file, in the queue. */
export interface PendingLaneEntry {
  readonly lane: ReviewLane;
  readonly id: string;
  /** Absolute path of the staged document. */
  readonly path: string;
  /** Vault-relative path this entry applies into. */
  readonly publishTarget?: string;
  /** Parsed signal, for the signals lane. */
  readonly signal?: BrainSignal;
  /** Parsed frontmatter, for the notes and ingest lanes. */
  readonly frontmatter?: FrontmatterMap;
  /** Body below the frontmatter, for the notes and ingest lanes. */
  readonly body?: string;
  /**
   * Present when the file could not be read as a queue entry; the
   * content fields are then absent. Named, never silently skipped.
   */
  readonly unreadableReason?: string;
}

export interface PendingLaneListing {
  /** Every readable entry, sorted by id. */
  readonly entries: ReadonlyArray<PendingLaneEntry>;
  /** Files in a lane directory that could not be read as entries. */
  readonly unreadable: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/** List one lane's `.md` files (the directory may not exist yet). */
function laneDirFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  return out;
}

/** Read one staged file into an entry, or into a named-unreadable row. */
function readLaneEntry(vault: string, lane: ReviewLane, path: string): PendingLaneEntry {
  const id = basename(path).slice(0, -".md".length);
  const base: PendingLaneEntry = { lane, id, path };
  if (!PENDING_LANE_ID_RE.test(id)) {
    return { ...base, unreadableReason: "name does not match the pending id grammar" };
  }
  try {
    if (lane === REVIEW_LANE.signals) {
      return { ...base, ...signalFields(path), publishTarget: publishTargetForId(vault, id) };
    }
    const [meta, body] = parseFrontmatter(path);
    return {
      ...base,
      frontmatter: meta,
      body,
      publishTarget: publishTargetForId(vault, id),
    };
  } catch (err) {
    return {
      ...base,
      unreadableReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The signals lane parses its documents through the signal reader. */
function signalFields(path: string): { readonly signal: BrainSignal } {
  return { signal: parseSignal(path) };
}

/**
 * List the queue. `lane` selects one lane or `"all"`. Deterministic:
 * sorted by id, with unreadable files partitioned into a named list
 * rather than skipped silently or allowed to break the listing.
 */
export function listPendingLane(vault: string, lane: ReviewLane | "all"): PendingLaneListing {
  const lanes: ReadonlyArray<ReviewLane> =
    lane === "all" ? [REVIEW_LANE.signals, REVIEW_LANE.notes, REVIEW_LANE.ingest] : [lane];
  const entries: PendingLaneEntry[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  for (const one of lanes) {
    for (const path of laneDirFiles(pendingLaneDir(vault, one))) {
      const entry = readLaneEntry(vault, one, path);
      if (entry.unreadableReason !== undefined) {
        unreadable.push({ path, reason: entry.unreadableReason });
      } else {
        entries.push(entry);
      }
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, unreadable: unreadable };
}

// ----- Apply / reject -------------------------------------------------------

export interface PendingLaneApplyOptions {
  /** True previews the move and writes nothing; false performs it. */
  readonly dryRun?: boolean;
}

export interface PendingLaneApplyResult {
  readonly id: string;
  readonly path: string;
  /** True when this was a preview and nothing moved. */
  readonly dryRun: boolean;
}

export interface PendingLaneRejectOptions {
  /** True previews the retire render and writes nothing. */
  readonly dryRun?: boolean;
  /** Injected clock for a deterministic `retired_at`. Defaults to now. */
  readonly now?: Date;
}

export interface PendingLaneRejectResult {
  readonly id: string;
  readonly path: string;
  /** True when this was a preview and nothing moved. */
  readonly dryRun?: boolean;
}

/**
 * Resolve a pending id to its staged file without writing. `forWrite`
 * selects the guarded directory resolver, following the one rule the
 * appliers share: the vault-identity assertion runs only when the call
 * will write. A dry run resolves the same paths ungated, because gating
 * a preview refuses the surface an operator reaches for to find out
 * what is wrong.
 */
function pendingLaneFilePath(vault: string, id: string, forWrite: boolean): string {
  if (!PENDING_LANE_ID_RE.test(id)) throw new InvalidPendingIdError(id);
  const dirs = forWrite ? brainDirsForWrite(vault) : brainDirs(vault);
  const laneDir = pendingLaneDirIn(dirs, laneOfId(id));
  return ensureInsideVault(join(laneDir, `${id}.md`), vault);
}

/**
 * Apply a staged entry: move it into its decoded publish target
 * UNCHANGED. The bytes are copied verbatim and the staged copy is
 * removed only after the target copy lands, behind an exclusive create
 * that refuses an occupied target. A missing id is a typed error.
 *
 * `dryRun` reports the move and writes nothing. The preview runs every
 * check the apply runs - id shape, staged file present, target free,
 * decoded target inside the vault - and stops before the two calls that
 * touch disk, so the report it gives is the move the apply would make
 * rather than a guess at it.
 */
export function applyPendingLane(
  vault: string,
  id: string,
  opts: PendingLaneApplyOptions = {},
): PendingLaneApplyResult {
  const dryRun = opts.dryRun === true;
  const src = pendingLaneFilePath(vault, id, !dryRun);
  if (!existsSync(src)) throw new PendingSignalNotFoundError(id);
  const target = publishTargetForId(vault, id);
  let dest: string;
  try {
    dest = ensureInsideVault(join(vault, target), vault);
  } catch (err) {
    throw new PendingTargetPathError(
      `pending id ${JSON.stringify(id)} decodes to ${JSON.stringify(target)}, which resolves ` +
        `outside the vault: ${err instanceof Error ? err.message : String(err)}`,
      target,
    );
  }
  if (existsSync(dest)) throw new PendingApplyConflictError(id, dest);
  if (dryRun) return { id, path: dest, dryRun: true };

  const contents = readFileSync(src, "utf8");
  mkdirSync(dirname(dest), { recursive: true });
  // Exclusive create: never clobber an existing target with the same
  // name. This is the real gate - the check above makes the preview
  // honest, it does not replace the atomic one.
  atomicCreateFileSyncExclusive(dest, contents);
  unlinkSync(src);
  return { id, path: dest, dryRun: false };
}

/**
 * Reject a staged entry: render it into `Brain/retired/` with
 * retire-shaped frontmatter (`_status: "retired"`, `retired_at`,
 * `retired_reason`), keeping the original fields for the audit trail and
 * stamping `osb_pending_lane` with the lane the entry came from - at
 * reject time only; publish never transforms. A missing id is a typed
 * error. `dryRun` runs the same checks and writes nothing, the occupied
 * retire target included: the real run's exclusive create refuses one,
 * so the preview refuses it too rather than forecasting a retire the
 * reject would then reject.
 */
export function rejectPendingLane(
  vault: string,
  id: string,
  reason: string,
  opts: PendingLaneRejectOptions = {},
): PendingLaneRejectResult {
  const dryRun = opts.dryRun === true;
  const src = pendingLaneFilePath(vault, id, !dryRun);
  if (!existsSync(src)) throw new PendingSignalNotFoundError(id);
  const lane = laneOfId(id);
  const now = opts.now ?? new Date();

  const [meta, body] = parseFrontmatter(src);
  const nextMeta: FrontmatterMap = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "_status" || k === "retired_at" || k === "retired_reason") continue;
    if (k === "osb_pending_lane") continue;
    if (k === "tags") {
      const arr = Array.isArray(v) ? [...v] : [];
      nextMeta["tags"] = arr.map((t) => (t === "brain/signal" ? "brain/retired" : t));
      continue;
    }
    nextMeta[k] = v as never;
  }
  nextMeta["_status"] = "retired";
  nextMeta["retired_at"] = now.toISOString();
  nextMeta["retired_reason"] = reason;
  nextMeta["osb_pending_lane"] = lane;

  const retiredDir = (dryRun ? brainDirs(vault) : brainDirsForWrite(vault)).retired;
  const dest = ensureInsideVault(join(retiredDir, `${id}.md`), vault);
  // The same occupancy refusal the real run's exclusive create raises,
  // checked in the preview too. The exclusive create below stays the
  // actual race gate - this makes the preview honest, it does not
  // replace the atomic one.
  if (existsSync(dest)) throw new FileAlreadyExistsError(dest);
  if (dryRun) return { id, path: dest, dryRun: true };

  writeFrontmatterAtomic(dest, nextMeta, body, {
    overwrite: false,
    vaultForRelativePath: vault,
  });
  unlinkSync(src);
  return { id, path: dest };
}

/** The disposition source names, kept next to the resolvers that read them. */
export const WRITE_APPROVAL_SOURCES = Object.freeze({
  masterConfig: WRITE_APPROVAL_ENABLED_CONFIG_KEY,
  masterEnv: WRITE_APPROVAL_ENABLED_ENV_KEY,
  notesConfig: WRITE_APPROVAL_NOTES_CONFIG_KEY,
  notesEnv: WRITE_APPROVAL_NOTES_ENV_KEY,
  ingestConfig: WRITE_APPROVAL_INGEST_CONFIG_KEY,
  ingestEnv: WRITE_APPROVAL_INGEST_ENV_KEY,
});
