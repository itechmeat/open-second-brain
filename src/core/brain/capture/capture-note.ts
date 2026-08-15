/**
 * Capture-note contract (Knowledge intake suite, seam 1, t_f8f5ef6a).
 *
 * One module owning the inbound-capture staging vocabulary: the frontmatter
 * kind, provenance (source channel, sender identity, capture timestamp), the
 * staging and archive path helpers, and the read/write/list/archive
 * functions. The inbound Telegram bot writes captures ONLY through this
 * contract; the inbox-drain pass reads captures ONLY through it. That single
 * ownership is what lets the two features share one on-disk shape without
 * either reaching into the other.
 *
 * The layout mirrors the existing inbox-versus-processed distinction in
 * `governance/forget-plan.ts`: a capture lands in `Brain/captures/`
 * (staging) and moves to `Brain/captures/processed/` (archive) once a drain
 * routes it. The captures subtree is deliberately separate from the signal
 * inbox so the dream pass and signal machinery stay byte-identical for vaults
 * that never capture.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";

import type { FrontmatterMap } from "../../types.ts";
import { atomicWriteText } from "../../fs-atomic.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import {
  BRAIN_CAPTURES_PROCESSED_REL,
  BRAIN_CAPTURES_REL,
  allocateAndCreate,
  captureArchivePath,
  capturesDir,
  capturesProcessedDir,
  captureStagingPath,
  captureWatermarkPath,
  vaultRelative,
} from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

/** Frontmatter `kind:` marker of a staged inbound capture. */
export const BRAIN_CAPTURE_KIND = "brain-capture";

/** Filename prefix of every capture page (`cap-<date>-<time>-<hash>`). */
export const CAPTURE_ID_PREFIX = "cap";

/** Length of the content-hash suffix that keeps same-second captures distinct. */
const CAPTURE_HASH_LEN = 8;

/** Provenance of one inbound capture. */
export interface CaptureProvenance {
  /** Capture channel, e.g. `telegram`. */
  readonly source: string;
  /** Sender identity within the channel, e.g. the Telegram chat id. */
  readonly sender: string;
  /** ISO-8601 whole-second capture timestamp. */
  readonly capturedAt: string;
}

/** One capture note as read back from disk. */
export interface CaptureNote {
  /** Filename stem (also the frontmatter id): `cap-<date>-<time>-<hash>`. */
  readonly id: string;
  /** Vault-relative path (POSIX separators). */
  readonly path: string;
  /** The captured text body. */
  readonly body: string;
  readonly provenance: CaptureProvenance;
  /** `true` in the staging area, `false` once archived. */
  readonly staged: boolean;
}

export interface WriteCaptureInput {
  readonly body: string;
  readonly provenance: CaptureProvenance;
}

/** Typed failure raised by every contract refusal - never a silent skip. */
export class CaptureContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureContractError";
  }
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CaptureContractError(`capture ${label} must not be empty`);
  }
  return trimmed;
}

/**
 * Derive the filename stem from the capture timestamp plus a short content
 * hash. The date-then-time prefix makes lexical order match chronological
 * order; the hash keeps two same-second captures from the same sender
 * distinct before the allocator has to append a numeric suffix.
 */
function captureBaseId(
  body: string,
  provenance: CaptureProvenance,
): { prefix: string; slug: string } {
  const stamp = provenance.capturedAt.trim();
  const date = stamp.slice(0, 10);
  const time = stamp.slice(11, 19).replace(/:/g, "");
  const hash = createHash("sha256")
    .update(`${provenance.source}\0${provenance.sender}\0${body}`, "utf8")
    .digest("hex")
    .slice(0, CAPTURE_HASH_LEN);
  return { prefix: `${CAPTURE_ID_PREFIX}-${date}`, slug: `${time}-${hash}` };
}

/** Write one capture note into the staging area through the contract. */
export function writeCaptureNote(vault: string, input: WriteCaptureInput): CaptureNote {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const body = requireNonEmpty(input.body, "body");
  const source = requireNonEmpty(input.provenance.source, "source");
  const sender = requireNonEmpty(input.provenance.sender, "sender");
  const capturedAt = requireNonEmpty(input.provenance.capturedAt, "captured_at");

  const dir = capturesDir(vault);
  mkdirSync(dir, { recursive: true });
  const { prefix, slug } = captureBaseId(body, { source, sender, capturedAt });
  const provenance: CaptureProvenance = { source, sender, capturedAt };

  // Allocation and creation are one step: two captures that hash to the
  // same stem race for the name, and the loser of the exclusive create
  // must fall through to `-2` rather than drop the message (GitHub
  // #161). The `id` is derived per attempt because it has to equal the
  // filename it ships in.
  const { allocation: allocated, value: id } = allocateAndCreate(
    { vault, targetDir: dir, prefix, slug },
    (allocation) => {
      const captureId = `${prefix}-${allocation.slug}`;
      // The kind and the vault-relative path its two siblings already
      // pass: without them a collision here reported a raw errno naming
      // an absolute path, which leaks the operator's home directory into
      // CLI output and MCP envelopes and never says what collided.
      writeFrontmatterAtomic(allocation.path, captureFrontmatter(captureId, provenance), body, {
        overwrite: false,
        existsErrorKind: "capture",
        vaultForRelativePath: vault,
      });
      return captureId;
    },
  );
  return Object.freeze({
    id,
    path: vaultRelative(allocated.path, vault),
    body,
    provenance,
    staged: true,
  });
}

function captureFrontmatter(id: string, provenance: CaptureProvenance): FrontmatterMap {
  return {
    kind: BRAIN_CAPTURE_KIND,
    id,
    capture_source: provenance.source,
    capture_sender: provenance.sender,
    captured_at: provenance.capturedAt,
    tags: ["brain", "brain/capture"],
  };
}

function parseCaptureFile(absPath: string, relPath: string, staged: boolean): CaptureNote | null {
  let meta: FrontmatterMap;
  let body: string;
  try {
    [meta, body] = parseFrontmatter(absPath);
  } catch {
    return null;
  }
  if (meta["kind"] !== BRAIN_CAPTURE_KIND) return null;
  const id =
    typeof meta["id"] === "string" && meta["id"].length > 0 ? meta["id"] : basename(relPath);
  const source = typeof meta["capture_source"] === "string" ? meta["capture_source"] : "";
  const sender = typeof meta["capture_sender"] === "string" ? meta["capture_sender"] : "";
  const capturedAt = typeof meta["captured_at"] === "string" ? meta["captured_at"] : "";
  return Object.freeze({
    id,
    path: relPath,
    body: body.trim(),
    provenance: Object.freeze({ source, sender, capturedAt }),
    staged,
  });
}

function basename(relPath: string): string {
  const parts = relPath.split("/");
  return (parts[parts.length - 1] ?? "").replace(/\.md$/u, "");
}

function listCapturesIn(
  vault: string,
  dir: string,
  relRoot: string,
  staged: boolean,
): CaptureNote[] {
  if (!existsSync(dir)) return [];
  const out: CaptureNote[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const abs = `${dir}/${name}`;
    const note = parseCaptureFile(abs, `${relRoot}/${name}`, staged);
    if (note !== null) out.push(note);
  }
  return out;
}

function sortById(notes: CaptureNote[]): CaptureNote[] {
  return notes.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every staged (not-yet-drained) capture, sorted chronologically by id. */
export function listStagedCaptures(vault: string): CaptureNote[] {
  return sortById(listCapturesIn(vault, capturesDir(vault), BRAIN_CAPTURES_REL, true));
}

/** Every archived capture, sorted chronologically by id. */
export function listArchivedCaptures(vault: string): CaptureNote[] {
  return sortById(
    listCapturesIn(vault, capturesProcessedDir(vault), BRAIN_CAPTURES_PROCESSED_REL, false),
  );
}

/**
 * Every capture, staged or archived, sorted chronologically by id.
 * Archiving must never hide a capture from `/catchup`, so both areas are
 * unioned here.
 */
export function listAllCaptures(vault: string): CaptureNote[] {
  return sortById([...listStagedCaptures(vault), ...listArchivedCaptures(vault)]);
}

/** Read one capture by id from either the staging or archive area. */
export function readCaptureNote(vault: string, id: string): CaptureNote | null {
  const staging = captureStagingPath(vault, id);
  if (existsSync(staging)) return parseCaptureFile(staging, `${BRAIN_CAPTURES_REL}/${id}.md`, true);
  const archive = captureArchivePath(vault, id);
  if (existsSync(archive)) {
    return parseCaptureFile(archive, `${BRAIN_CAPTURES_PROCESSED_REL}/${id}.md`, false);
  }
  return null;
}

/** Move a staged capture into the processed archive through the contract. */
export function archiveCapture(vault: string, id: string): CaptureNote {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const staging = captureStagingPath(vault, id);
  if (!existsSync(staging)) {
    throw new CaptureContractError(`no staged capture to archive: ${id}`);
  }
  const dir = capturesProcessedDir(vault);
  mkdirSync(dir, { recursive: true });
  const archive = captureArchivePath(vault, id);
  try {
    renameSync(staging, archive);
  } catch {
    // Cross-device rename fallback: copy then remove the source.
    atomicWriteText(archive, readFileSync(staging, "utf8"));
    rmSync(staging, { force: true });
  }
  const note = parseCaptureFile(archive, `${BRAIN_CAPTURES_PROCESSED_REL}/${id}.md`, false);
  if (note === null) {
    throw new CaptureContractError(`archived capture is unreadable: ${id}`);
  }
  return note;
}

/** Captures newer than `watermark` (an id), staged or archived. */
export function capturesSince(vault: string, watermark: string | null): CaptureNote[] {
  const all = listAllCaptures(vault);
  if (watermark === null || watermark.length === 0) return all;
  return all.filter((c) => c.id > watermark);
}

interface WatermarkFile {
  readonly last_acknowledged: string;
}

/** Read the last capture id acknowledged by a `/catchup` reply, or null. */
export function readCatchupWatermark(vault: string): string | null {
  const path = captureWatermarkPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WatermarkFile>;
    return typeof parsed.last_acknowledged === "string" && parsed.last_acknowledged.length > 0
      ? parsed.last_acknowledged
      : null;
  } catch {
    return null;
  }
}

/** Advance the catchup watermark to `id`. */
export function writeCatchupWatermark(vault: string, id: string): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  mkdirSync(capturesDir(vault), { recursive: true });
  const payload: WatermarkFile = { last_acknowledged: id };
  atomicWriteText(captureWatermarkPath(vault), `${JSON.stringify(payload)}\n`);
}
