/**
 * Write-session store (Agent Write Contract Suite, t_bc36a8a2).
 *
 * One JSON file per session under `Brain/.sessions/write/<id>.json`,
 * consistent with the `Brain/.payloads/` convention: dot-prefixed,
 * vault-synced, machine-owned. snake_case on disk, camelCase in TS,
 * atomic writes through `fs-atomic`.
 *
 * TTL is LAZY: expiry is evaluated on read (an expired non-terminal
 * session reads as terminal `failed`/`expired`), and
 * {@link sweepWriteSessions} deletes terminal and expired files. No
 * daemon, no background timer - the same pattern as every other OSB
 * maintenance surface.
 *
 * Tolerant reads: a corrupted session file surfaces as a probe error
 * (never a throw), mirroring `readGitState` / the log parser.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  isTerminalWriteSessionStatus,
  type WriteSessionError,
  type WriteSessionIntent,
  type WriteSessionKind,
  type WriteSessionPersona,
  type WriteSessionProbe,
  type WriteSessionRecord,
  type WriteSessionStatus,
} from "./types.ts";

/** Session ids are lowercase slugs - the grammar doubles as path safety. */
const SESSION_ID_RE = /^ws-[a-z0-9][a-z0-9-]*$/;

const STATUS_SET: ReadonlySet<string> = new Set([
  "needs-llm-step",
  "needs-correction",
  "needs-review",
  "done",
  "failed",
]);

const KIND_SET: ReadonlySet<string> = new Set(["artifact", "panel"]);
const INTENT_SET: ReadonlySet<string> = new Set(["create", "overwrite", "merge"]);

export function isWriteSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** Session directory inside the vault. */
export function writeSessionDir(vault: string): string {
  return join(vault, "Brain", ".sessions", "write");
}

/** Path of one session file; the id grammar is enforced first. */
export function writeSessionPath(vault: string, id: string): string {
  if (!isWriteSessionId(id)) {
    throw new Error(`invalid write-session id: ${JSON.stringify(id)}`);
  }
  return join(writeSessionDir(vault), `${id}.json`);
}

/**
 * Allocate a collision-free session id from the supplied timestamp.
 * `ws-<yyyymmdd>-<hhmmss>` with `-2`, `-3`, ... suffixes when a session
 * landed in the same second - deterministic for fixture callers.
 */
export function allocateWriteSessionId(vault: string, nowIso: string): string {
  const ts = Date.parse(nowIso);
  if (Number.isNaN(ts)) {
    throw new Error(`invalid session timestamp: ${nowIso}`);
  }
  const iso = new Date(ts).toISOString();
  const stem = `ws-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  if (!existsSync(join(writeSessionDir(vault), `${stem}.json`))) return stem;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem}-${n}`;
    if (!existsSync(join(writeSessionDir(vault), `${candidate}.json`))) return candidate;
  }
  throw new Error(`could not allocate a write-session id for ${stem}`);
}

function serializeRecord(record: WriteSessionRecord): string {
  return (
    JSON.stringify(
      {
        id: record.id,
        kind: record.kind,
        status: record.status,
        step: record.step,
        agent: record.agent,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        expires_at: record.expiresAt,
        attempts: record.attempts,
        retry_cap: record.retryCap,
        target_path: record.targetPath,
        intent: record.intent,
        require_review: record.requireReview,
        prompt: record.prompt,
        schema_type: record.schemaType,
        topic: record.topic,
        personas: record.personas.map((p) => ({ slug: p.slug, lens: p.lens, prompt: p.prompt })),
        responses: record.responses,
        pending_artifact: record.pendingArtifact,
        last_errors: record.lastErrors.map((e) => ({
          code: e.code,
          path: e.path,
          message: e.message,
        })),
        fail_reason: record.failReason,
      },
      null,
      2,
    ) + "\n"
  );
}

function str(rec: Record<string, unknown>, key: string): string {
  return typeof rec[key] === "string" ? (rec[key] as string) : "";
}

function parsePersonas(raw: unknown): ReadonlyArray<WriteSessionPersona> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const personas: WriteSessionPersona[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    if (typeof p["slug"] !== "string" || p["slug"] === "") continue;
    personas.push(
      Object.freeze({ slug: p["slug"], lens: str(p, "lens"), prompt: str(p, "prompt") }),
    );
  }
  return Object.freeze(personas);
}

function parseErrors(raw: unknown): ReadonlyArray<WriteSessionError> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const errors: WriteSessionError[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e["code"] !== "string") continue;
    errors.push(
      Object.freeze({ code: e["code"], path: str(e, "path"), message: str(e, "message") }),
    );
  }
  return Object.freeze(errors);
}

function parseResponses(raw: unknown): Readonly<Record<string, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return Object.freeze({});
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.freeze(out);
}

function parseRecord(raw: unknown): WriteSessionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (!isWriteSessionId(rec["id"])) return null;
  if (!KIND_SET.has(String(rec["kind"]))) return null;
  if (!STATUS_SET.has(String(rec["status"]))) return null;
  const intent = INTENT_SET.has(String(rec["intent"]))
    ? (rec["intent"] as WriteSessionIntent)
    : "create";
  return Object.freeze({
    id: rec["id"] as string,
    kind: rec["kind"] as WriteSessionKind,
    status: rec["status"] as WriteSessionStatus,
    step: str(rec, "step"),
    agent: str(rec, "agent"),
    createdAt: str(rec, "created_at"),
    updatedAt: str(rec, "updated_at"),
    expiresAt: str(rec, "expires_at"),
    attempts: typeof rec["attempts"] === "number" ? rec["attempts"] : 0,
    retryCap: typeof rec["retry_cap"] === "number" ? rec["retry_cap"] : 0,
    targetPath: str(rec, "target_path"),
    intent,
    requireReview: rec["require_review"] === true,
    prompt: str(rec, "prompt"),
    schemaType: typeof rec["schema_type"] === "string" ? rec["schema_type"] : null,
    topic: typeof rec["topic"] === "string" ? rec["topic"] : null,
    personas: parsePersonas(rec["personas"]),
    responses: parseResponses(rec["responses"]),
    pendingArtifact: typeof rec["pending_artifact"] === "string" ? rec["pending_artifact"] : null,
    lastErrors: parseErrors(rec["last_errors"]),
    failReason: typeof rec["fail_reason"] === "string" ? rec["fail_reason"] : null,
  });
}

/**
 * Lazy-TTL view: a non-terminal session whose `expiresAt` is in the
 * past reads as terminal `failed`/`expired`. The transform is pure -
 * the file is not rewritten on read; `sweepWriteSessions` owns cleanup.
 */
function applyTtl(record: WriteSessionRecord, nowIso: string): WriteSessionRecord {
  if (isTerminalWriteSessionStatus(record.status)) return record;
  const expires = Date.parse(record.expiresAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now) || now < expires) return record;
  return Object.freeze({ ...record, status: "failed" as const, failReason: "expired" });
}

/** Persist a session record atomically. */
export function saveWriteSession(vault: string, record: WriteSessionRecord): void {
  mkdirSync(writeSessionDir(vault), { recursive: true });
  atomicWriteFileSync(writeSessionPath(vault, record.id), serializeRecord(record));
}

/**
 * Read one session. Missing file: `{session: null, error: null}`.
 * Malformed JSON or an invalid record: `{session: null, error}` so the
 * engine can report the corruption instead of crashing.
 */
export function readWriteSession(vault: string, id: string, nowIso: string): WriteSessionProbe {
  if (!isWriteSessionId(id)) {
    return Object.freeze({
      session: null,
      error: `invalid write-session id: ${id}`,
      expiredOnRead: false,
    });
  }
  const path = writeSessionPath(vault, id);
  if (!existsSync(path)) {
    return Object.freeze({ session: null, error: null, expiredOnRead: false });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    return Object.freeze({
      session: null,
      error: `write-session file is not valid JSON: ${(exc as Error).message}`,
      expiredOnRead: false,
    });
  }
  const record = parseRecord(raw);
  if (record === null) {
    return Object.freeze({
      session: null,
      error: `write-session record is malformed (${id})`,
      expiredOnRead: false,
    });
  }
  const view = applyTtl(record, nowIso);
  return Object.freeze({ session: view, error: null, expiredOnRead: view !== record });
}

/** All readable sessions, sorted by created_at then id. Corrupt files are skipped. */
export function listWriteSessions(
  vault: string,
  nowIso: string,
): ReadonlyArray<WriteSessionRecord> {
  const dir = writeSessionDir(vault);
  if (!existsSync(dir)) return [];
  const sessions: WriteSessionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const probe = readWriteSession(vault, name.slice(0, -".json".length), nowIso);
    if (probe.session !== null) sessions.push(probe.session);
  }
  sessions.sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );
  return Object.freeze(sessions);
}

/** Remove one session file (idempotent). */
export function deleteWriteSession(vault: string, id: string): void {
  rmSync(writeSessionPath(vault, id), { force: true });
}

export interface SweepWriteSessionsResult {
  readonly removed: number;
  readonly kept: number;
}

/**
 * Delete terminal (done/failed) and expired session files. Corrupt
 * files are also removed - they can never transition anywhere.
 */
export function sweepWriteSessions(vault: string, nowIso: string): SweepWriteSessionsResult {
  const dir = writeSessionDir(vault);
  if (!existsSync(dir)) return Object.freeze({ removed: 0, kept: 0 });
  let removed = 0;
  let kept = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isWriteSessionId(id)) continue;
    const probe = readWriteSession(vault, id, nowIso);
    if (probe.session === null || isTerminalWriteSessionStatus(probe.session.status)) {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    } else {
      kept += 1;
    }
  }
  return Object.freeze({ removed, kept });
}
