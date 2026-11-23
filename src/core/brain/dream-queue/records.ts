/**
 * Record bodies of the dream work queue (design D1): their types, the
 * check each body passes before the fold applies it, and the item id.
 *
 * A body that fails its check is rejected by the fold, listed and never
 * applied. Fields a kind does not define are ignored.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../../integrity/digest.ts";
import { isAuthority } from "../../store/fold.ts";
import {
  DREAM_WORK_ANSWER_KIND,
  DREAM_WORK_APPLIED_KIND,
  DREAM_WORK_ATTEMPT_KIND,
  DREAM_WORK_CLOSED_KIND,
  DREAM_WORK_ITEM_KIND,
  DREAM_WORK_LEASE_KIND,
  DREAM_WORK_RECORD_KINDS,
  DREAM_WORK_RETRY_KIND,
} from "./constants.ts";

/** What identifies one piece of work. */
export interface DreamWorkIdentity {
  /** The operation that produced the item and applies its answer. */
  readonly operation: string;
  /** What the work is about (a rung and its target, a topic, a rule). */
  readonly subject: string;
  /** The window or logical event that produced it; sorts the queue. */
  readonly occurrence: string;
  /** Hash of the input the answer is produced for. */
  readonly input_hash: string;
  readonly prompt_version: string;
  readonly schema_version: string;
}

export interface DreamWorkItemBody extends DreamWorkIdentity {
  readonly id: string;
  /** JSON description of the answer's shape, shown to whoever answers. */
  readonly answer_schema: Readonly<Record<string, unknown>>;
  /** Items this one comes after. */
  readonly after: ReadonlyArray<string>;
  /** Ordering resources it touches (`topic:<id>`, `chain:<id>`, `rung:<name>`). */
  readonly resources: ReadonlyArray<string>;
  /** Opaque resource names held by an earlier private item, for shared-only folds. */
  readonly private_resource_barriers: ReadonlyArray<string>;
  /** Record ids and blob references the work is built from (bounded). */
  readonly evidence: ReadonlyArray<string>;
  /** What the executor is shown. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DreamWorkLeaseBody {
  readonly item: string;
  readonly generation: number;
  readonly lease_token: string;
  readonly run: string;
  readonly owner_revision: string;
  readonly expires_at: string;
}

export interface DreamWorkAnswerBody {
  readonly item: string;
  readonly generation: number;
  readonly lease_token: string;
  readonly input_hash: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly agent: string;
  readonly model: string;
  readonly receipt: string;
}

export type DreamWorkAttemptOutcome = "failed" | "refused" | "released";

export interface DreamWorkAttemptBody {
  readonly item: string;
  readonly generation: number;
  readonly lease_token: string;
  readonly outcome: DreamWorkAttemptOutcome;
  readonly reason: string;
  readonly retry_at: string | null;
  /** A release with a reason: the input it was given for (the item's own). */
  readonly input_hash?: string;
}

export interface DreamWorkAppliedBody {
  readonly item: string;
  readonly generation: number;
  readonly lease_token: string;
  readonly receipt: string;
  readonly effects: ReadonlyArray<string>;
}

export type DreamWorkClosedReason = "cancelled" | "superseded";

export interface DreamWorkClosedBody {
  readonly item: string;
  readonly reason: DreamWorkClosedReason;
  /** Why, in words (`subject gone`, the user's reason). */
  readonly note: string;
  readonly successor: string | null;
  readonly authority: "human" | "agent";
}

export interface DreamWorkRetryBody {
  readonly item: string;
  readonly authority: "human";
}

const KINDS: ReadonlySet<string> = new Set(DREAM_WORK_RECORD_KINDS);

/** Whether `kind` is a record kind of the queue. */
export function isDreamWorkKind(kind: string): boolean {
  return KINDS.has(kind);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The id of an item: the hex sha256 of the canonical JSON of its identity. */
export function dreamWorkItemId(identity: DreamWorkIdentity): string {
  return sha256(
    canonicalJson([
      identity.operation,
      identity.subject,
      identity.occurrence,
      identity.input_hash,
      identity.prompt_version,
      identity.schema_version,
    ]),
  );
}

/** The receipt of an answer: the same answer under the same lease has the same receipt. */
export function dreamWorkReceipt(input: {
  readonly item: string;
  readonly generation: number;
  readonly input_hash: string;
  readonly value?: unknown;
  readonly text?: string;
}): string {
  return sha256(
    canonicalJson([
      input.item,
      input.generation,
      input.input_hash,
      input.value === undefined ? null : input.value,
      input.text ?? null,
    ]),
  );
}

/** The input hash of any JSON value (canonical JSON, sha256). */
export function dreamWorkInputHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Opaque key for a resource name, safe to copy across partitions. */
export function dreamWorkResourceBarrier(resource: string): string {
  return sha256(`dream-work-resource:${resource}`);
}

const HEX64 = /^[0-9a-f]{64}$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.length > 0);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isoTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Why `body` is not a valid body of `kind`, or `null` when it is. */
export function dreamWorkBodyRejection(kind: string, body: Record<string, unknown>): string | null {
  switch (kind) {
    case DREAM_WORK_ITEM_KIND: {
      for (const field of [
        "operation",
        "subject",
        "occurrence",
        "prompt_version",
        "schema_version",
      ]) {
        if (!nonEmpty(body[field])) return `missing ${field}`;
      }
      if (typeof body["input_hash"] !== "string" || !HEX64.test(body["input_hash"])) {
        return "missing or invalid input_hash";
      }
      if (!object(body["answer_schema"])) return "answer_schema must be an object";
      if (!object(body["payload"])) return "payload must be an object";
      for (const field of ["after", "resources", "evidence", "private_resource_barriers"]) {
        if (!strings(body[field])) return `${field} must be a list of strings`;
      }
      if (!(body["private_resource_barriers"] as string[]).every((key) => HEX64.test(key))) {
        return "private_resource_barriers must contain sha256 keys";
      }
      if (body["id"] !== dreamWorkItemId(body as unknown as DreamWorkIdentity)) {
        return "id does not match the item's identity";
      }
      return null;
    }
    case DREAM_WORK_LEASE_KIND:
      if (!nonEmpty(body["item"])) return "missing item";
      if (!generation(body["generation"])) return "generation must be a positive integer";
      if (!nonEmpty(body["lease_token"])) return "missing lease_token";
      if (!nonEmpty(body["run"])) return "missing run";
      if (typeof body["owner_revision"] !== "string") return "missing owner_revision";
      if (!isoTime(body["expires_at"])) return "missing or invalid expires_at";
      return null;
    case DREAM_WORK_ANSWER_KIND:
      if (!nonEmpty(body["item"])) return "missing item";
      if (!generation(body["generation"])) return "generation must be a positive integer";
      if (!nonEmpty(body["lease_token"])) return "missing lease_token";
      if (typeof body["input_hash"] !== "string" || !HEX64.test(body["input_hash"])) {
        return "missing or invalid input_hash";
      }
      if (body["value"] === undefined && typeof body["text"] !== "string") {
        return "an answer carries a value or a text";
      }
      if (!nonEmpty(body["agent"])) return "missing agent";
      if (!nonEmpty(body["model"])) return "missing model";
      if (body["receipt"] !== dreamWorkReceipt(body as unknown as DreamWorkAnswerBody)) {
        return "receipt does not match the answer";
      }
      return null;
    case DREAM_WORK_ATTEMPT_KIND:
      if (!nonEmpty(body["item"])) return "missing item";
      if (!generation(body["generation"])) return "generation must be a positive integer";
      if (!nonEmpty(body["lease_token"])) return "missing lease_token";
      if (!["failed", "refused", "released"].includes(body["outcome"] as string)) {
        return "outcome must be failed, refused or released";
      }
      if (typeof body["reason"] !== "string") return "missing reason";
      if (body["retry_at"] !== null && !isoTime(body["retry_at"])) {
        return "retry_at must be a time or null";
      }
      if (
        body["input_hash"] !== undefined &&
        (typeof body["input_hash"] !== "string" || !HEX64.test(body["input_hash"]))
      ) {
        return "input_hash must be a hash";
      }
      return null;
    case DREAM_WORK_APPLIED_KIND:
      if (!nonEmpty(body["item"])) return "missing item";
      if (!generation(body["generation"])) return "generation must be a positive integer";
      if (!nonEmpty(body["lease_token"])) return "missing lease_token";
      if (!nonEmpty(body["receipt"])) return "missing receipt";
      if (!strings(body["effects"])) return "effects must be a list of strings";
      return null;
    case DREAM_WORK_CLOSED_KIND:
      if (!nonEmpty(body["item"])) return "missing item";
      if (body["reason"] !== "cancelled" && body["reason"] !== "superseded") {
        return "reason must be cancelled or superseded";
      }
      if (typeof body["note"] !== "string") return "missing note";
      if (body["successor"] !== null && !nonEmpty(body["successor"])) {
        return "successor must be an item id or null";
      }
      if (body["authority"] !== "human" && body["authority"] !== "agent") {
        return "authority must be human or agent";
      }
      return null;
    case DREAM_WORK_RETRY_KIND:
      if (!nonEmpty(body["item"])) return "missing item";
      if (!isAuthority(body["authority"]) || body["authority"] !== "human") {
        return "a retry is made by a person (authority human)";
      }
      return null;
    default:
      return `not a dream work kind: ${kind}`;
  }
}
