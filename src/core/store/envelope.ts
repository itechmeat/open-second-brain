/**
 * The record envelope of the brain store (design D3), built and verified.
 *
 * Every line of every shard is one envelope:
 *
 * ```
 * { "v": 1, "id": <ulid>, "hlc": "<physical_ms>.<counter>", "device": <id>,
 *   "agent": <name>, "kind": <kind>, "scope": <scope|null>,
 *   "topic": <topic ulid|null>, "sum": <sha256 of body>, "body": { ... } }
 * ```
 *
 * `sum` is the lowercase hex sha256 of the body's canonical JSON (keys
 * sorted recursively, see `integrity/digest.ts`), so a body that another
 * implementation re-serialises with a different key order still verifies.
 * The body is normalised through JSON before it is hashed, so what is
 * hashed is exactly what a reader parses back.
 *
 * A body spilled into a blob is replaced on the line by a reference
 * `{ "$blob": <sha256>, "bytes": <n> }` whose hash equals `sum`: the blob
 * file is named by the hash of its content, and its content is the
 * canonical JSON of the body. See `blobs.ts`.
 */

import { isValidDeviceId } from "../config.ts";
import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import {
  BLOB_REF_BYTES_KEY,
  BLOB_REF_KEY,
  ENVELOPE_FIELDS,
  STORE_BODY_MAX_DEPTH,
  STORE_FORMAT_VERSION,
} from "./constants.ts";
import { compareHlc, formatHlc, parseHlc, type Hlc } from "./hlc.ts";
import { isUlid, newUlid } from "./ulid.ts";

/** A JSON object body. */
export type RecordBody = { readonly [key: string]: unknown };

/** One stored record, exactly as it appears on a line. */
export interface StoreRecord {
  readonly v: number;
  readonly id: string;
  readonly hlc: string;
  readonly device: string;
  readonly agent: string;
  readonly kind: string;
  readonly scope: string | null;
  readonly topic: string | null;
  readonly sum: string;
  readonly body: RecordBody;
}

/** What a writer supplies; the id, version and checksum are derived. */
export interface RecordInput {
  readonly hlc: Hlc;
  readonly device: string;
  readonly agent: string;
  readonly kind: string;
  readonly scope?: string | null;
  readonly topic?: string | null;
  readonly body: RecordBody;
  /** Explicit id; a fresh ULID when omitted. */
  readonly id?: string;
}

/** A refusal to build a record from invalid input. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Record kinds: lowercase words joined by hyphens. */
export const RECORD_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_LABEL_LENGTH = 200;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Canonical JSON text of a body: what `sum` hashes and what a blob holds. */
export function canonicalBodyText(body: RecordBody): string {
  return canonicalJson(body);
}

/** The checksum of a body: sha256 of its canonical JSON. */
export function bodyChecksum(body: RecordBody): string {
  return sha256Hex(canonicalBodyText(body));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `body` nests objects and arrays deeper than
 * {@link STORE_BODY_MAX_DEPTH}, the body itself counting as one level.
 * Iterative, so the check itself cannot exhaust the stack; it is made
 * before any recursive walk (the canonical JSON) touches the body.
 */
export function bodyTooDeep(body: unknown): boolean {
  const stack: Array<readonly [unknown, number]> = [[body, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (depth > STORE_BODY_MAX_DEPTH) return true;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** The corrupt-record reason for a body nested past the bound. */
export const BODY_TOO_DEEP_REASON = `body nests deeper than ${STORE_BODY_MAX_DEPTH} levels`;

/** Whether a line body is a blob reference rather than the body itself. */
export function isBlobRef(body: RecordBody): boolean {
  const bytes = body[BLOB_REF_BYTES_KEY];
  return (
    Object.keys(body).length === 2 &&
    typeof body[BLOB_REF_KEY] === "string" &&
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0
  );
}

/**
 * Why `value` is not a valid label (`agent`, `scope`): a non-empty,
 * one-line string of at most {@link MAX_LABEL_LENGTH} characters. `null`
 * when it is valid. One rule for building and for verifying.
 */
function labelProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_LABEL_LENGTH) {
    return `must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`;
  }
  if (/[\r\n]/.test(value)) return "must be one line";
  return null;
}

/** Whether `value` can stand as a record's `agent` or `scope`. */
export function isRecordLabel(value: unknown): value is string {
  return labelProblem(value) === null;
}

function label(name: string, value: string | null | undefined, nullable: boolean): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new EnvelopeError(`record ${name} is required`);
  }
  const problem = labelProblem(value);
  if (problem !== null) throw new EnvelopeError(`record ${name} ${problem}`);
  return value;
}

/**
 * Build a record from writer input. Throws {@link EnvelopeError} for a
 * device id the shard grammar refuses, a malformed kind, an empty agent,
 * a topic that is not a ULID, or a body that uses the reserved blob key.
 */
export function buildRecord(input: RecordInput): StoreRecord {
  if (!isValidDeviceId(input.device)) {
    throw new EnvelopeError(
      `record device "${input.device}" is not a valid device id (lowercase letters, digits and hyphens, not "sync-conflict")`,
    );
  }
  if (!RECORD_KIND_RE.test(input.kind)) {
    throw new EnvelopeError(`record kind "${input.kind}" must match ${RECORD_KIND_RE}`);
  }
  const agent = label("agent", input.agent, false)!;
  const scope = label("scope", input.scope, true);
  const topic = input.topic ?? null;
  if (topic !== null && !isUlid(topic)) {
    throw new EnvelopeError(`record topic "${topic}" must be a topic id (ULID) or null`);
  }
  if (!isPlainObject(input.body)) throw new EnvelopeError("record body must be a JSON object");
  if (bodyTooDeep(input.body)) throw new EnvelopeError(`record ${BODY_TOO_DEEP_REASON}`);
  if (BLOB_REF_KEY in input.body) {
    throw new EnvelopeError(`record body must not use the reserved key "${BLOB_REF_KEY}"`);
  }
  const id = input.id ?? newUlid(input.hlc.physical);
  if (!isUlid(id)) throw new EnvelopeError(`record id "${id}" must be a ULID`);
  const body = JSON.parse(JSON.stringify(input.body)) as RecordBody;
  return {
    v: STORE_FORMAT_VERSION,
    id,
    hlc: formatHlc(input.hlc),
    device: input.device,
    agent,
    kind: input.kind,
    scope,
    topic,
    sum: bodyChecksum(body),
    body,
  };
}

/** Outcome of {@link verifyEnvelope}. */
export type EnvelopeCheck =
  | { readonly ok: true; readonly record: StoreRecord }
  | { readonly ok: false; readonly reason: string; readonly unknownVersion?: number };

const fail = (reason: string): EnvelopeCheck => ({ ok: false, reason });

/**
 * Verify a parsed line: every field present with the right shape, a
 * known version, and a checksum that matches the body (for a blob
 * reference, a reference whose hash equals `sum`; the blob itself is
 * checked when it is read). A version newer than this build understands
 * is reported with `unknownVersion` so the caller can skip it apart from
 * corruption.
 */
export function verifyEnvelope(value: unknown): EnvelopeCheck {
  if (!isPlainObject(value)) return fail("line is not a JSON object");
  for (const field of ENVELOPE_FIELDS) {
    if (!(field in value)) return fail(`missing field "${field}"`);
  }
  const v = value["v"];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return fail("invalid version");
  if (v !== STORE_FORMAT_VERSION) {
    return { ok: false, reason: `unknown format version ${v}`, unknownVersion: v };
  }
  const { id, hlc, device, agent, kind, scope, topic, sum, body } = value;
  if (!isUlid(id)) return fail("invalid id");
  if (typeof hlc !== "string" || parseHlc(hlc) === null) return fail("invalid hlc");
  if (typeof device !== "string" || !isValidDeviceId(device)) return fail("invalid device");
  if (labelProblem(agent) !== null) return fail("invalid agent");
  if (typeof kind !== "string" || !RECORD_KIND_RE.test(kind)) return fail("invalid kind");
  if (scope !== null && labelProblem(scope) !== null) return fail("invalid scope");
  if (topic !== null && !isUlid(topic)) return fail("invalid topic");
  if (typeof sum !== "string" || !SHA256_RE.test(sum)) return fail("invalid sum");
  if (!isPlainObject(body)) return fail("invalid body");
  if (bodyTooDeep(body)) return fail(BODY_TOO_DEEP_REASON);
  if (isBlobRef(body)) {
    if (body[BLOB_REF_KEY] !== sum)
      return fail("checksum mismatch: blob reference does not match sum");
  } else if (bodyChecksum(body) !== sum) {
    return fail("checksum mismatch");
  }
  return { ok: true, record: value as unknown as StoreRecord };
}

/** Fold order (design D3): hlc, then device id, then record id. */
export function compareRecords(a: StoreRecord, b: StoreRecord): number {
  const byClock = compareHlc(parseHlc(a.hlc)!, parseHlc(b.hlc)!);
  if (byClock !== 0) return byClock;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
